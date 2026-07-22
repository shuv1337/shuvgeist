import type { OffscreenRuntimeHostState } from "../agent/offscreen-runtime-host.js";
import { correlateRuntimeResponse } from "../agent/runtime-channel.js";
import {
	canonicalRuntimeValue as canonical,
	runtimeClientRouteKey,
	sameRuntimeTarget as sameTarget,
} from "../agent/runtime-identity.js";
import {
	isRuntimeRequestEnvelope,
	isRuntimeResponseEnvelope,
	isRuntimeStreamEnvelope,
	isRuntimeWireValue,
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeHelloEnvelope,
	type RuntimeRequestEnvelope,
	type RuntimeRequestOperation,
	type RuntimeSessionSnapshot,
	type RuntimeSnapshotEnvelope,
	type RuntimeStreamEnvelope,
	type RuntimeTraceContext,
	type RuntimeValue,
} from "../agent/runtime-protocol.js";
import {
	AGENT_RUNTIME_PORT_PREFIX,
	type AgentRuntimePortIdentity,
	isCanonicalSidepanelSenderUrl,
	parseAgentRuntimePortName,
	parseSidepanelTrackingPortName,
	type SidepanelCapabilityMaterial,
	type SidepanelLeaseIdentity,
	sidepanelDocumentNonce,
} from "../agent/sidepanel-context-identity.js";
import type {
	AgentRuntimeCheckpointMessage,
	AgentRuntimeConnectionDescriptor,
	AgentRuntimeHostStreamMessage,
	AgentRuntimePageCancelMessage,
	AgentRuntimePageOperationMessage,
	AgentRuntimePortResponse,
	BridgeToOffscreenMessage,
} from "./internal-messages.js";

type AgentRuntimePageControlMessage = AgentRuntimePageOperationMessage | AgentRuntimePageCancelMessage;

interface AgentRuntimePortMessageEvent {
	addListener(listener: (message: unknown) => void): void;
	removeListener(listener: (message: unknown) => void): void;
}

interface AgentRuntimePortDisconnectEvent {
	addListener(listener: () => void): void;
	removeListener(listener: () => void): void;
}

export interface AgentRuntimePortSender {
	id?: string;
	url?: string;
	origin?: string;
	documentId?: string;
	documentLifecycle?: string;
	frameId?: number;
	tab?: { id?: number; windowId?: number };
}

/** The Chrome port surface used by the coordinator, kept structural for unit tests. */
export interface AgentRuntimeCoordinatorPort {
	readonly name: string;
	readonly sender?: AgentRuntimePortSender;
	readonly onMessage: AgentRuntimePortMessageEvent;
	readonly onDisconnect: AgentRuntimePortDisconnectEvent;
	postMessage(message: AgentRuntimePortResponse): void;
	disconnect?(): void;
}

export interface AgentRuntimeExtensionContext {
	contextId: string;
	contextType: string;
	documentId?: string;
	documentOrigin?: string;
	documentUrl?: string;
	frameId: number;
	tabId: number;
	windowId: number;
}

export interface AgentRuntimePortAuthenticationOptions {
	extensionId: string;
	sidepanelUrl: string;
	sidePanelContextType: string;
	resolveSidepanelLease(
		documentNonce: string,
		material: SidepanelCapabilityMaterial,
		documentId?: string,
	): Promise<(AgentRuntimeExtensionContext & { lease: SidepanelLeaseIdentity }) | undefined>;
	isSidepanelLeaseCurrent(lease: SidepanelLeaseIdentity): Promise<boolean>;
}

export interface AgentRuntimePortAdmissionOptions extends AgentRuntimePortAuthenticationOptions {
	maxBufferedMessages?: number;
	reportError?(error: unknown, context: string): void;
}

export interface AgentRuntimeAuthenticatedPort {
	clientId: string;
	windowId: number;
	extensionId: string;
	documentId: string;
	documentUrl: string;
	documentOrigin: string;
	contextId: string;
	contextType: string;
	documentNonce: string;
	lease: SidepanelLeaseIdentity;
}

export interface AgentRuntimePortAcceptor {
	acceptPort(
		port: AgentRuntimeCoordinatorPort,
		authentication: AgentRuntimeAuthenticatedPort,
		initialMessages?: readonly unknown[],
	): boolean;
}

export interface AgentRuntimeSidepanelTrackingPortAcceptor {
	acceptPort(
		port: AgentRuntimeCoordinatorPort,
		lease: SidepanelLeaseIdentity,
		initialMessages?: readonly unknown[],
	): boolean;
}

interface SidepanelTrackingEntry {
	readonly port: AgentRuntimeCoordinatorPort;
	readonly lease: SidepanelLeaseIdentity;
}

/**
 * Prevents one sidepanel document nonce from owning multiple simultaneous
 * lifetime ports. Browser-window authority remains exclusively on the
 * nonce-to-live-context join; this registry is only connection lifecycle state.
 */
export class AgentRuntimeSidepanelTrackingRegistry {
	private readonly entriesByWindow = new Map<number, SidepanelTrackingEntry>();
	private readonly entriesByPort = new Map<AgentRuntimeCoordinatorPort, SidepanelTrackingEntry>();

	install(port: AgentRuntimeCoordinatorPort, lease: SidepanelLeaseIdentity): boolean {
		if (this.entriesByPort.has(port)) return this.isCurrent(port, lease);
		const entry: SidepanelTrackingEntry = { port, lease: clone(lease) };
		const previous = this.entriesByWindow.get(lease.windowId);
		// Install the replacement first. A lagging disconnect from the previous
		// document can then remove only its own stale entry.
		this.entriesByWindow.set(lease.windowId, entry);
		this.entriesByPort.set(port, entry);
		if (previous && previous.port !== port) {
			this.entriesByPort.delete(previous.port);
			try {
				previous.port.disconnect?.();
			} catch {
				// The superseded document may already have disconnected.
			}
		}
		return true;
	}

	isCurrent(port: AgentRuntimeCoordinatorPort, lease: SidepanelLeaseIdentity): boolean {
		const entry = this.entriesByPort.get(port);
		return (
			entry !== undefined &&
			this.entriesByWindow.get(lease.windowId) === entry &&
			entry.lease.leaseId === lease.leaseId &&
			entry.lease.transactionId === lease.transactionId &&
			entry.lease.contextId === lease.contextId &&
			entry.lease.documentId === lease.documentId &&
			entry.lease.documentNonce === lease.documentNonce
		);
	}

	remove(port: AgentRuntimeCoordinatorPort): void {
		const entry = this.entriesByPort.get(port);
		if (!entry) return;
		this.entriesByPort.delete(port);
		if (this.entriesByWindow.get(entry.lease.windowId) === entry) this.entriesByWindow.delete(entry.lease.windowId);
	}

	revokeWindow(windowId: number): void {
		const entry = this.entriesByWindow.get(windowId);
		if (!entry) return;
		this.entriesByWindow.delete(windowId);
		this.entriesByPort.delete(entry.port);
		try {
			entry.port.disconnect?.();
		} catch {
			// The revoked document may already have disconnected.
		}
	}
}

export interface AgentRuntimeCheckpointStorage {
	load(): Promise<OffscreenRuntimeHostState | undefined>;
	save(state: OffscreenRuntimeHostState): Promise<void>;
}

export interface AgentRuntimeCoordinatorOptions {
	/** Ensures the offscreen document exists and is ready to receive messages. */
	ensureOffscreen(): Promise<void>;
	/** Sends one typed command to the offscreen document. Runtime requests return a raw response envelope. */
	sendToOffscreen(message: BridgeToOffscreenMessage): Promise<unknown>;
	checkpointStorage: AgentRuntimeCheckpointStorage;
	/** Fences every presentation handoff against the current persisted sidepanel lease. */
	isSidepanelLeaseCurrent(lease: SidepanelLeaseIdentity): Promise<boolean>;
	/** Restores accepted window bindings after a service-worker restart. */
	loadAcceptedDescriptors?(): Promise<AgentRuntimeConnectionDescriptor[]>;
	/** Narrow seam for privileged page operations that remain owned by the service worker. */
	handlePageControlMessage?(message: AgentRuntimePageControlMessage): Promise<unknown> | unknown;
	/** Persist one accepted browser-window binding before it is acknowledged. */
	onDescriptorBound?(descriptor: AgentRuntimeConnectionDescriptor): Promise<void> | void;
	/** Remove one explicit binding after its offscreen session has been released. */
	onDescriptorReleased?(descriptor: AgentRuntimeConnectionDescriptor, reason: string): Promise<void> | void;
	/** Notifies capability/status owners when an accepted descriptor becomes ready or is invalidated by a new runtime epoch. */
	onSessionReadinessChanged?(descriptor: AgentRuntimeConnectionDescriptor, ready: boolean): Promise<void> | void;
	sessionReadyTimeoutMs?: number;
	createRequestId?(): string;
	reportError?(error: unknown, context: string): void;
}

export interface AgentRuntimeDirectRequestOptions {
	signal?: AbortSignal;
	trace?: RuntimeTraceContext;
}

export interface AgentRuntimeSessionReadyOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

interface PortIdentity {
	clientId: string;
	windowId: number;
}

interface PortConnection {
	readonly port: AgentRuntimeCoordinatorPort;
	readonly identity: PortIdentity;
	readonly lease: SidepanelLeaseIdentity;
	descriptor?: AgentRuntimeConnectionDescriptor;
	descriptorFingerprint?: string;
	connected: boolean;
	closed: boolean;
	messageTail: Promise<void>;
	helloEpochs: Set<string>;
	lastEventSeqBySessionEpoch: Map<string, number>;
}

interface AcceptedDescriptor {
	descriptor: AgentRuntimeConnectionDescriptor;
	fingerprint: string;
}

interface ActiveExecutionRequest {
	request: RuntimeRequestEnvelope;
	references: number;
}

interface ActivePageControlOperation {
	fingerprint: string;
	message: AgentRuntimePageOperationMessage;
	references: number;
}

interface SessionReadyWaiter {
	settled: boolean;
	timeout: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
	resolve(snapshot: RuntimeSessionSnapshot): void;
	reject(error: Error): void;
}

export type AgentRuntimeOffscreenMessageResult =
	| { ok: true; kind: "stream"; routed: boolean }
	| { ok: true; kind: "checkpoint" }
	| { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message;
	const message = String(error);
	return message.trim() ? message : "Unknown runtime coordinator error";
}

function routeKey(identity: Pick<PortIdentity, "clientId" | "windowId">): string {
	return runtimeClientRouteKey(identity.clientId, identity.windowId);
}

function sessionEpochKey(envelope: Exclude<RuntimeStreamEnvelope, { streamType: "hello" }>): string {
	return JSON.stringify([envelope.runtimeEpoch, envelope.sessionId]);
}

function helloMatchesDescriptor(envelope: RuntimeHelloEnvelope, descriptor: AgentRuntimeConnectionDescriptor): boolean {
	const cursor = envelope.recovery.sessions.find((entry) => entry.sessionId === descriptor.sessionId);
	return cursor === undefined || sameTarget(cursor.target, descriptor.target);
}

export function isAgentRuntimePortName(name: string): boolean {
	return parseAgentRuntimePortName(name) !== undefined;
}

function sameExtensionPage(actualValue: string, expectedValue: string): boolean {
	try {
		const actual = new URL(actualValue);
		const expected = new URL(expectedValue);
		return (
			actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname
		);
	} catch {
		return false;
	}
}

function urlOrigin(value: string): string | undefined {
	try {
		const url = new URL(value);
		return url.protocol === "chrome-extension:" ? `${url.protocol}//${url.host}` : url.origin;
	} catch {
		return undefined;
	}
}

interface AuthenticatedSidepanelDocument {
	documentId: string;
	documentNonce: string;
	documentUrl: string;
	documentOrigin: string;
	context: AgentRuntimeExtensionContext;
	lease: SidepanelLeaseIdentity;
}

interface ValidatedSidepanelSender {
	documentId?: string;
	documentUrl: string;
	documentOrigin: string;
}

function validatedSidepanelSender(
	port: Pick<AgentRuntimeCoordinatorPort, "sender">,
	options: AgentRuntimePortAuthenticationOptions,
): ValidatedSidepanelSender | undefined {
	const sender = port.sender;
	if (!sender) return undefined;
	if (
		sender.id !== options.extensionId ||
		!nonEmptyString(sender.url) ||
		!nonEmptyString(sender.origin) ||
		sender.tab !== undefined ||
		sender.frameId !== undefined ||
		(sender.documentLifecycle !== undefined && sender.documentLifecycle !== "active")
	) {
		return undefined;
	}
	const expectedOrigin = urlOrigin(options.sidepanelUrl);
	if (!expectedOrigin) return undefined;
	if (
		sender.origin !== expectedOrigin ||
		!isCanonicalSidepanelSenderUrl(sender.url, options.sidepanelUrl) ||
		!nonEmptyString(options.sidePanelContextType)
	) {
		return undefined;
	}
	return {
		...(nonEmptyString(sender.documentId) ? { documentId: sender.documentId } : {}),
		documentUrl: sender.url,
		documentOrigin: sender.origin,
	};
}

async function authenticateSidepanelDocument(
	port: Pick<AgentRuntimeCoordinatorPort, "sender">,
	documentNonce: string,
	material: SidepanelCapabilityMaterial,
	options: AgentRuntimePortAuthenticationOptions,
): Promise<AuthenticatedSidepanelDocument | undefined> {
	const sender = validatedSidepanelSender(port, options);
	if (!sender) return undefined;
	const expectedOrigin = urlOrigin(options.sidepanelUrl);
	if (!expectedOrigin) return undefined;
	const context = await options.resolveSidepanelLease(documentNonce, material, sender.documentId);
	if (
		!context ||
		context.contextType !== options.sidePanelContextType ||
		context.documentOrigin !== expectedOrigin ||
		!nonEmptyString(context.documentId) ||
		!nonEmptyString(context.documentUrl) ||
		!sameExtensionPage(context.documentUrl, options.sidepanelUrl) ||
		sidepanelDocumentNonce(context.documentUrl) !== documentNonce ||
		(sender.documentId !== undefined && context.documentId !== sender.documentId) ||
		!Number.isSafeInteger(context.windowId) ||
		context.windowId < 0 ||
		!nonEmptyString(context.contextId)
	) {
		return undefined;
	}
	return { ...sender, documentId: context.documentId, documentNonce, context, lease: clone(context.lease) };
}

/**
 * Authenticates a nonce-bearing runtime port by joining its canonical nonce to
 * one raw-live, onOpened-bound SIDE_PANEL context. The name's window remains a
 * claim and must equal that authority mapping; Chrome's `-1` is never trusted.
 */
export async function authenticateAgentRuntimePort(
	port: Pick<AgentRuntimeCoordinatorPort, "name" | "sender">,
	options: AgentRuntimePortAuthenticationOptions,
): Promise<AgentRuntimeAuthenticatedPort | undefined> {
	const identity = parseAgentRuntimePortName(port.name);
	if (!identity) return undefined;
	const authenticated = await authenticateSidepanelDocument(
		port,
		identity.documentNonce,
		{
			continuationToken: identity.continuationToken,
			transactionId: identity.transactionId,
			leaseId: identity.leaseId,
		},
		options,
	);
	if (!authenticated) return undefined;
	if (authenticated.context.windowId !== identity.windowId) return undefined;
	return {
		clientId: identity.clientId,
		windowId: identity.windowId,
		extensionId: options.extensionId,
		documentId: authenticated.documentId,
		documentUrl: authenticated.documentUrl,
		documentOrigin: authenticated.documentOrigin,
		contextId: authenticated.context.contextId,
		contextType: authenticated.context.contextType,
		documentNonce: identity.documentNonce,
		lease: clone(authenticated.lease),
	};
}

/**
 * Claims the dedicated runtime-port namespace and asynchronously authenticates
 * its Chrome document before handing the port to the coordinator. Messages
 * posted during that lookup are bounded, cloned, and delivered exactly once in
 * arrival order after the coordinator installs its permanent listeners.
 */
export function authenticateAndAcceptAgentRuntimePort(
	port: AgentRuntimeCoordinatorPort,
	acceptor: AgentRuntimePortAcceptor,
	options: AgentRuntimePortAdmissionOptions,
): boolean {
	if (!port.name.startsWith(`${AGENT_RUNTIME_PORT_PREFIX}:`)) return false;
	if (!isAgentRuntimePortName(port.name)) {
		try {
			port.disconnect?.();
		} catch {
			// The malformed sender may already have disconnected.
		}
		return true;
	}
	const maxBufferedMessages = options.maxBufferedMessages ?? 16;
	if (!Number.isSafeInteger(maxBufferedMessages) || maxBufferedMessages < 1) {
		throw new Error("maxBufferedMessages must be a positive safe integer");
	}

	const initialMessages: unknown[] = [];
	let disconnected = false;
	const cleanup = (): void => {
		port.onMessage.removeListener(onMessage);
		port.onDisconnect.removeListener(onDisconnect);
	};
	const reject = (): void => {
		if (disconnected) return;
		disconnected = true;
		cleanup();
		try {
			port.disconnect?.();
		} catch {
			// The sender may have disconnected while its context was authenticated.
		}
	};
	const onMessage = (message: unknown): void => {
		if (initialMessages.length >= maxBufferedMessages) {
			reject();
			return;
		}
		try {
			initialMessages.push(structuredClone(message));
		} catch {
			reject();
		}
	};
	const onDisconnect = (): void => {
		disconnected = true;
		cleanup();
	};
	port.onMessage.addListener(onMessage);
	port.onDisconnect.addListener(onDisconnect);

	void authenticateAgentRuntimePort(port, options)
		.then(async (authentication) => {
			if (disconnected) return;
			if (!authentication || !(await options.isSidepanelLeaseCurrent(authentication.lease)) || disconnected) {
				reject();
				return;
			}
			let accepted = false;
			try {
				accepted = acceptor.acceptPort(port, authentication, initialMessages);
			} catch (error) {
				options.reportError?.(error, "port-admission");
			}
			cleanup();
			if (!accepted) reject();
		})
		.catch((error: unknown) => {
			options.reportError?.(error, "port-authentication");
			reject();
		});
	return true;
}

/** Authenticates and records the ordinary nonce-bearing sidepanel lifetime port. */
export function authenticateAndAcceptSidepanelTrackingPort(
	port: AgentRuntimeCoordinatorPort,
	registry: AgentRuntimeSidepanelTrackingRegistry,
	acceptor: AgentRuntimeSidepanelTrackingPortAcceptor,
	options: AgentRuntimePortAdmissionOptions,
): boolean {
	if (!port.name.startsWith("sidepanel:")) return false;
	const identity = parseSidepanelTrackingPortName(port.name);
	const sender = validatedSidepanelSender(port, options);
	if (!identity || !sender) {
		try {
			port.disconnect?.();
		} catch {
			// The invalid sender may already have disconnected.
		}
		return true;
	}
	const maxBufferedMessages = options.maxBufferedMessages ?? 16;
	if (!Number.isSafeInteger(maxBufferedMessages) || maxBufferedMessages < 1) {
		throw new Error("maxBufferedMessages must be a positive safe integer");
	}

	const initialMessages: unknown[] = [];
	let disconnected = false;
	const cleanup = (): void => {
		port.onMessage.removeListener(onMessage);
		port.onDisconnect.removeListener(onDisconnect);
	};
	const reject = (): void => {
		if (disconnected) return;
		disconnected = true;
		registry.remove(port);
		cleanup();
		try {
			port.disconnect?.();
		} catch {
			// The sender may have disconnected while its context was authenticated.
		}
	};
	const onMessage = (message: unknown): void => {
		if (initialMessages.length >= maxBufferedMessages) {
			reject();
			return;
		}
		try {
			initialMessages.push(structuredClone(message));
		} catch {
			reject();
		}
	};
	const onDisconnect = (): void => {
		disconnected = true;
		registry.remove(port);
		cleanup();
	};
	port.onMessage.addListener(onMessage);
	port.onDisconnect.addListener(onDisconnect);

	void authenticateSidepanelDocument(
		port,
		identity.documentNonce,
		{
			continuationToken: identity.continuationToken,
			transactionId: identity.transactionId,
			leaseId: identity.leaseId,
		},
		options,
	)
		.then(async (authenticated) => {
			if (disconnected) return;
			if (
				!authenticated ||
				authenticated.context.windowId !== identity.windowId ||
				!(await options.isSidepanelLeaseCurrent(authenticated.lease)) ||
				disconnected
			) {
				reject();
				return;
			}
			if (!registry.install(port, authenticated.lease)) {
				reject();
				return;
			}
			let accepted = false;
			try {
				accepted = acceptor.acceptPort(port, authenticated.lease, initialMessages);
			} catch (error) {
				options.reportError?.(error, "sidepanel-tracking-admission");
			}
			cleanup();
			if (!accepted) reject();
		})
		.catch((error: unknown) => {
			options.reportError?.(error, "sidepanel-tracking-authentication");
			reject();
		});
	return true;
}

function authenticationMatchesPort(
	port: AgentRuntimeCoordinatorPort,
	identity: AgentRuntimePortIdentity,
	authentication: AgentRuntimeAuthenticatedPort,
): boolean {
	const sender = port.sender;
	return (
		identity.clientId === authentication.clientId &&
		identity.windowId === authentication.windowId &&
		identity.documentNonce === authentication.documentNonce &&
		identity.transactionId === authentication.lease.transactionId &&
		identity.leaseId === authentication.lease.leaseId &&
		authentication.lease.windowId === authentication.windowId &&
		authentication.lease.documentNonce === authentication.documentNonce &&
		authentication.lease.contextId === authentication.contextId &&
		authentication.lease.documentId === authentication.documentId &&
		nonEmptyString(authentication.contextId) &&
		nonEmptyString(authentication.contextType) &&
		sender?.id === authentication.extensionId &&
		(sender.documentId === undefined || sender.documentId === authentication.documentId) &&
		sender.url === authentication.documentUrl &&
		sender.origin === authentication.documentOrigin &&
		sender.tab === undefined &&
		sender.frameId === undefined
	);
}

function descriptorValidationRequest(descriptor: AgentRuntimeConnectionDescriptor): RuntimeRequestEnvelope {
	return {
		kind: "request",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "descriptor-validation",
		clientId: descriptor.clientId,
		windowId: descriptor.windowId,
		sessionId: descriptor.sessionId,
		target: descriptor.target,
		requestId: "descriptor-validation",
		operation: {
			type: "create",
			systemPrompt: descriptor.systemPrompt,
			...(descriptor.model !== undefined ? { model: descriptor.model } : {}),
			...(descriptor.thinkingLevel !== undefined ? { thinkingLevel: descriptor.thinkingLevel } : {}),
			...(descriptor.initialMessages !== undefined ? { initialMessages: descriptor.initialMessages } : {}),
		},
	};
}

function validConnectionDescriptor(value: unknown): value is AgentRuntimeConnectionDescriptor {
	if (!isRecord(value) || !isRuntimeWireValue(value)) return false;
	if (
		!hasOnlyKeys(value, [
			"clientId",
			"windowId",
			"sessionId",
			"target",
			"mode",
			"systemPrompt",
			"model",
			"thinkingLevel",
			"initialMessages",
		])
	) {
		return false;
	}
	if (!nonEmptyString(value.clientId) || !Number.isSafeInteger(value.windowId) || (value.windowId as number) < 0) {
		return false;
	}
	if (!nonEmptyString(value.sessionId) || (value.mode !== "create" && value.mode !== "load")) return false;
	if (typeof value.systemPrompt !== "string") return false;
	return isRuntimeRequestEnvelope(descriptorValidationRequest(value as unknown as AgentRuntimeConnectionDescriptor));
}

function isPortConnectMessage(
	value: unknown,
): value is { type: "agent-runtime-port-connect"; descriptor: AgentRuntimeConnectionDescriptor } {
	return isRecord(value) && value.type === "agent-runtime-port-connect" && validConnectionDescriptor(value.descriptor);
}

function requestIdFromUnknown(value: unknown): string {
	if (!isRecord(value) || !isRecord(value.request) || !nonEmptyString(value.request.requestId)) {
		return "unidentified-request";
	}
	return value.request.requestId;
}

function validPersistedState(value: unknown): value is OffscreenRuntimeHostState {
	if (!isRecord(value) || !isRuntimeWireValue(value) || !nonEmptyString(value.runtimeEpoch)) return false;
	if (!Array.isArray(value.sessions) || !Array.isArray(value.requests)) return false;
	const sessionKeys = new Set<string>();
	for (const entry of value.sessions) {
		if (!isRecord(entry)) return false;
		if (
			!nonEmptyString(entry.clientId) ||
			!Number.isSafeInteger(entry.windowId) ||
			(entry.windowId as number) < 0 ||
			!nonEmptyString(entry.sessionId) ||
			!Number.isSafeInteger(entry.revision) ||
			(entry.revision as number) < 0 ||
			!Number.isSafeInteger(entry.eventSeq) ||
			(entry.eventSeq as number) < 0
		) {
			return false;
		}
		const key = JSON.stringify([entry.clientId, entry.windowId, entry.sessionId]);
		if (sessionKeys.has(key)) return false;
		sessionKeys.add(key);
		const envelope = {
			kind: "stream",
			streamType: "session-snapshot",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: value.runtimeEpoch,
			clientId: entry.clientId,
			windowId: entry.windowId,
			sessionId: entry.sessionId,
			target: entry.target,
			revision: entry.revision,
			eventSeq: Math.max(1, entry.eventSeq as number),
			snapshot: entry.snapshot,
		};
		if (!isRuntimeStreamEnvelope(envelope)) return false;
	}
	const requestKeys = new Set<string>();
	for (const entry of value.requests) {
		if (!isRecord(entry) || !isRuntimeRequestEnvelope(entry.request)) return false;
		if (entry.request.runtimeEpoch !== value.runtimeEpoch) return false;
		const key = JSON.stringify([
			entry.request.clientId,
			entry.request.windowId,
			entry.request.sessionId,
			entry.request.requestId,
		]);
		if (requestKeys.has(key)) return false;
		requestKeys.add(key);
		if (entry.response !== undefined) {
			if (
				!isRuntimeResponseEnvelope(entry.response) ||
				!correlateRuntimeResponse(entry.request, entry.response).ok
			) {
				return false;
			}
		}
	}
	return true;
}

function checkpointMessage(value: unknown): AgentRuntimeCheckpointMessage | undefined {
	if (!isRecord(value) || value.type !== "agent-runtime-checkpoint" || !validPersistedState(value.state)) {
		return undefined;
	}
	return value as unknown as AgentRuntimeCheckpointMessage;
}

function hostStreamMessage(value: unknown): AgentRuntimeHostStreamMessage | undefined {
	if (!isRecord(value) || value.type !== "agent-runtime-host-stream" || !isRuntimeStreamEnvelope(value.envelope)) {
		return undefined;
	}
	return value as unknown as AgentRuntimeHostStreamMessage;
}

function pageControlMessage(value: unknown): AgentRuntimePageControlMessage | undefined {
	if (!isRecord(value)) return undefined;
	if (value.type === "agent-runtime-page-cancel") {
		if (
			!isRuntimeWireValue(value) ||
			!hasOnlyKeys(value, [
				"type",
				"operationId",
				"runtimeEpoch",
				"clientId",
				"windowId",
				"sessionId",
				"target",
				"executionId",
				"executionRequestId",
			]) ||
			!nonEmptyString(value.operationId) ||
			!nonEmptyString(value.runtimeEpoch) ||
			!nonEmptyString(value.clientId) ||
			!Number.isSafeInteger(value.windowId) ||
			(value.windowId as number) < 0 ||
			!nonEmptyString(value.sessionId) ||
			!nonEmptyString(value.executionId) ||
			!nonEmptyString(value.executionRequestId)
		) {
			return undefined;
		}
		const validationRequest = {
			kind: "request",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: value.runtimeEpoch,
			clientId: value.clientId,
			windowId: value.windowId,
			sessionId: value.sessionId,
			target: value.target,
			requestId: value.operationId,
			operation: {
				type: "abort",
				executionId: value.executionId,
				targetRequestId: value.executionRequestId,
			},
		};
		return isRuntimeRequestEnvelope(validationRequest)
			? (value as unknown as AgentRuntimePageCancelMessage)
			: undefined;
	}
	if (value.type !== "agent-runtime-page-operation" || !isRuntimeWireValue(value)) return undefined;
	if (
		!hasOnlyKeys(value, [
			"type",
			"operationId",
			"runtimeEpoch",
			"clientId",
			"windowId",
			"sessionId",
			"target",
			"operation",
			"payload",
			"trace",
			"executionId",
			"executionRequestId",
		])
	) {
		return undefined;
	}
	const operations: AgentRuntimePageOperationMessage["operation"][] = [
		"browser-js",
		"navigate",
		"native-input",
		"navigation-context",
		"page-snapshot",
		"select-element",
		"screenshot",
		"extract-image-source",
		"debugger",
		"repl-overlay-show",
		"repl-overlay-remove",
	];
	if (
		!nonEmptyString(value.operationId) ||
		!nonEmptyString(value.runtimeEpoch) ||
		!nonEmptyString(value.clientId) ||
		!Number.isSafeInteger(value.windowId) ||
		(value.windowId as number) < 0 ||
		!nonEmptyString(value.sessionId) ||
		!nonEmptyString(value.executionId) ||
		!nonEmptyString(value.executionRequestId) ||
		!nonEmptyString(value.operation) ||
		!operations.includes(value.operation as AgentRuntimePageOperationMessage["operation"]) ||
		!isRecord(value.payload)
	) {
		return undefined;
	}
	const validationRequest = {
		kind: "request",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: value.runtimeEpoch,
		clientId: value.clientId,
		windowId: value.windowId,
		sessionId: value.sessionId,
		target: value.target,
		requestId: value.executionRequestId,
		...(value.trace !== undefined ? { trace: value.trace } : {}),
		operation: {
			type: "page-operation",
			executionId: value.executionId,
			operation: value.operation,
			params: value.payload,
		},
	};
	return isRuntimeRequestEnvelope(validationRequest)
		? (value as unknown as AgentRuntimePageOperationMessage)
		: undefined;
}

function executionIdentityKey(
	value: Pick<
		AgentRuntimePageOperationMessage,
		"runtimeEpoch" | "clientId" | "windowId" | "sessionId" | "target" | "executionId" | "executionRequestId"
	>,
): string {
	return canonical({
		runtimeEpoch: value.runtimeEpoch,
		clientId: value.clientId,
		windowId: value.windowId,
		sessionId: value.sessionId,
		target: value.target,
		executionId: value.executionId,
		executionRequestId: value.executionRequestId,
	});
}

function requestExecutionIdentity(request: RuntimeRequestEnvelope): string | undefined {
	const operation = request.operation;
	if (operation.type !== "prompt" && operation.type !== "repl-execute" && operation.type !== "page-operation") {
		return undefined;
	}
	return executionIdentityKey({
		runtimeEpoch: request.runtimeEpoch,
		clientId: request.clientId,
		windowId: request.windowId,
		sessionId: request.sessionId,
		target: request.target,
		executionId: operation.executionId,
		executionRequestId: request.requestId,
	});
}

function pageControlOperationFingerprint(message: AgentRuntimePageControlMessage): string {
	return JSON.stringify([message.operationId, executionIdentityKey(message)]);
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function cloneTrace(trace: RuntimeTraceContext): RuntimeTraceContext {
	return {
		traceId: trace.traceId,
		spanId: trace.spanId,
		traceFlags: trace.traceFlags,
		...(typeof trace.tracestate === "string" ? { tracestate: trace.tracestate } : {}),
	};
}

/**
 * Coordinates sidepanel runtime clients without owning an Agent instance. The
 * offscreen document owns sessions; this class only binds identities, relays
 * envelopes, persists checkpoints, and routes each stream to one active port.
 */
export class AgentRuntimeCoordinator {
	private readonly connections = new Map<AgentRuntimeCoordinatorPort, PortConnection>();
	private readonly activeRoutes = new Map<string, PortConnection>();
	private readonly acceptedDescriptors = new Map<string, AcceptedDescriptor>();
	private readonly latestHellos = new Map<string, RuntimeHelloEnvelope>();
	private readonly latestSnapshots = new Map<string, RuntimeSnapshotEnvelope>();
	private readonly activeExecutionRequests = new Map<string, ActiveExecutionRequest>();
	private readonly activePageControlOperations = new Map<string, ActivePageControlOperation>();
	private readonly sessionReadyWaiters = new Map<string, Set<SessionReadyWaiter>>();
	private readonly routeTails = new Map<string, Promise<void>>();
	private readonly sessionReadyTimeoutMs: number;
	private initialization?: Promise<void>;
	private checkpointTail: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(private readonly options: AgentRuntimeCoordinatorOptions) {
		this.sessionReadyTimeoutMs = options.sessionReadyTimeoutMs ?? 15_000;
		if (!Number.isSafeInteger(this.sessionReadyTimeoutMs) || this.sessionReadyTimeoutMs < 0) {
			throw new Error("sessionReadyTimeoutMs must be a non-negative safe integer");
		}
	}

	initialize(): Promise<void> {
		return this.ensureInitialized();
	}

	getDescriptor(clientId: string, windowId: number): AgentRuntimeConnectionDescriptor | undefined {
		const accepted = this.acceptedDescriptors.get(routeKey({ clientId, windowId }));
		return accepted ? clone(accepted.descriptor) : undefined;
	}

	getAcceptedDescriptors(): AgentRuntimeConnectionDescriptor[] {
		return [...this.acceptedDescriptors.values()].map(({ descriptor }) => clone(descriptor));
	}

	getReadyDescriptors(): AgentRuntimeConnectionDescriptor[] {
		return [...this.acceptedDescriptors.values()]
			.filter(({ descriptor }) => this.readySnapshot(descriptor) !== undefined)
			.map(({ descriptor }) => clone(descriptor));
	}

	async getDescriptorsForWindow(windowId: number): Promise<AgentRuntimeConnectionDescriptor[]> {
		await this.ensureInitialized();
		return this.getAcceptedDescriptors().filter((descriptor) => descriptor.windowId === windowId);
	}

	async getReadyDescriptorsForWindow(windowId: number): Promise<AgentRuntimeConnectionDescriptor[]> {
		await this.ensureInitialized();
		return this.getReadyDescriptors().filter((descriptor) => descriptor.windowId === windowId);
	}

	isSessionReady(descriptorValue: AgentRuntimeConnectionDescriptor): boolean {
		if (!validConnectionDescriptor(descriptorValue)) return false;
		const accepted = this.acceptedDescriptors.get(routeKey(descriptorValue));
		const fingerprint = canonical(descriptorValue as unknown as RuntimeValue);
		return accepted?.fingerprint === fingerprint && this.readySnapshot(descriptorValue) !== undefined;
	}

	async waitForSessionReady(
		descriptorValue: AgentRuntimeConnectionDescriptor,
		options: AgentRuntimeSessionReadyOptions = {},
	): Promise<RuntimeSessionSnapshot> {
		if (!validConnectionDescriptor(descriptorValue)) throw new Error("Agent runtime descriptor is malformed");
		if (options.signal?.aborted) throw this.sessionReadyAbortError(options.signal.reason);
		const timeoutMs = options.timeoutMs ?? this.sessionReadyTimeoutMs;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
			throw new Error("Session ready timeout must be a non-negative safe integer");
		}
		const descriptor = clone(descriptorValue);
		await this.ensureInitialized();
		const accepted = this.acceptedDescriptors.get(routeKey(descriptor));
		const fingerprint = canonical(descriptor as unknown as RuntimeValue);
		if (!accepted || accepted.fingerprint !== fingerprint) {
			throw new Error("Agent runtime session descriptor is not accepted");
		}
		const ready = this.readySnapshot(descriptor);
		if (ready) return clone(ready.snapshot);
		const key = this.snapshotKey(descriptor);
		return new Promise<RuntimeSessionSnapshot>((resolve, reject) => {
			const waiter: SessionReadyWaiter = {
				settled: false,
				timeout: setTimeout(() => {
					this.rejectSessionReadyWaiter(
						key,
						waiter,
						new Error(`Timed out waiting for agent runtime session ${descriptor.sessionId} to become ready`),
					);
				}, timeoutMs),
				...(options.signal ? { signal: options.signal } : {}),
				resolve,
				reject,
			};
			if (options.signal) {
				waiter.onAbort = () =>
					this.rejectSessionReadyWaiter(key, waiter, this.sessionReadyAbortError(options.signal?.reason));
				options.signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			const waiters = this.sessionReadyWaiters.get(key) ?? new Set<SessionReadyWaiter>();
			waiters.add(waiter);
			this.sessionReadyWaiters.set(key, waiters);
		});
	}

	async bindSession(descriptorValue: AgentRuntimeConnectionDescriptor): Promise<void> {
		if (!validConnectionDescriptor(descriptorValue)) throw new Error("Agent runtime descriptor is malformed");
		const descriptor = clone(descriptorValue);
		await this.ensureInitialized();
		const key = routeKey(descriptor);
		await this.withRouteLock(key, () => this.bindSessionLocked(key, descriptor));
	}

	/**
	 * Replaces one browser-window binding without exposing an unowned route to
	 * a reconnecting stale sidepanel. The route lock covers old-session release,
	 * persistence, and the new offscreen bind as one coordinator transition.
	 */
	async replaceSession(descriptorValue: AgentRuntimeConnectionDescriptor, reason: string): Promise<void> {
		if (!validConnectionDescriptor(descriptorValue)) throw new Error("Agent runtime descriptor is malformed");
		if (!reason.trim()) throw new Error("Agent runtime replacement reason must be non-empty");
		const descriptor = clone(descriptorValue);
		await this.ensureInitialized();
		const key = routeKey(descriptor);
		await this.withRouteLock(key, async () => {
			const existing = this.acceptedDescriptors.get(key);
			const fingerprint = canonical(descriptor as unknown as RuntimeValue);
			if (existing?.fingerprint === fingerprint) return;
			if (existing) await this.releaseSessionLocked(key, clone(existing.descriptor), reason);
			await this.bindSessionLocked(key, descriptor);
		});
	}

	getLatestSnapshot(clientId: string, windowId: number): RuntimeSessionSnapshot | undefined {
		const descriptor = this.getDescriptor(clientId, windowId);
		if (!descriptor) return undefined;
		const envelope = this.latestSnapshots.get(this.snapshotKey(descriptor));
		return envelope ? clone(envelope.snapshot) : undefined;
	}

	async refreshSnapshot(descriptorValue: AgentRuntimeConnectionDescriptor): Promise<RuntimeSessionSnapshot> {
		const descriptor = clone(descriptorValue);
		await this.ensureInitialized();
		const cached = this.latestSnapshots.get(this.snapshotKey(descriptor));
		await this.requestSession(descriptor, {
			type: "resync",
			knownRevision: cached?.revision ?? 0,
			lastEventSeq: cached?.eventSeq ?? 0,
			reason: "explicit",
		});
		const refreshed = this.latestSnapshots.get(this.snapshotKey(descriptor));
		if (!refreshed) throw new Error("Offscreen runtime did not publish a session snapshot");
		return clone(refreshed.snapshot);
	}

	async requestSession(
		descriptorValue: AgentRuntimeConnectionDescriptor,
		operation: RuntimeRequestOperation,
		options: AgentRuntimeDirectRequestOptions = {},
	): Promise<RuntimeValue> {
		if (options.signal?.aborted) throw this.directRequestAbortError(options.signal.reason);
		const descriptor = clone(descriptorValue);
		await this.ensureInitialized();
		if (options.signal?.aborted) throw this.directRequestAbortError(options.signal.reason);
		const key = routeKey(descriptor);
		const accepted = this.acceptedDescriptors.get(key);
		const fingerprint = canonical(descriptor as unknown as RuntimeValue);
		if (!accepted || accepted.fingerprint !== fingerprint) {
			throw new Error("Agent runtime session descriptor is not accepted");
		}
		const hello = await this.ensureReleaseHello(key, descriptor);
		if (options.signal?.aborted) throw this.directRequestAbortError(options.signal.reason);
		const request: RuntimeRequestEnvelope = {
			kind: "request",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: hello.runtimeEpoch,
			clientId: descriptor.clientId,
			windowId: descriptor.windowId,
			sessionId: descriptor.sessionId,
			target: clone(descriptor.target),
			requestId: this.options.createRequestId?.() ?? crypto.randomUUID(),
			...(options.trace ? { trace: cloneTrace(options.trace) } : {}),
			operation: clone(operation),
		};
		const cancellableExecutionId =
			operation.type === "prompt" || operation.type === "repl-execute" || operation.type === "page-operation"
				? operation.executionId
				: undefined;
		const onAbort = () => {
			if (!cancellableExecutionId) return;
			const abortRequest: RuntimeRequestEnvelope = {
				kind: "request",
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				runtimeEpoch: hello.runtimeEpoch,
				clientId: descriptor.clientId,
				windowId: descriptor.windowId,
				sessionId: descriptor.sessionId,
				target: clone(descriptor.target),
				requestId: this.options.createRequestId?.() ?? crypto.randomUUID(),
				...(options.trace ? { trace: cloneTrace(options.trace) } : {}),
				operation: {
					type: "abort",
					executionId: cancellableExecutionId,
					targetRequestId: request.requestId,
					reason: typeof options.signal?.reason === "string" ? options.signal.reason : "request-aborted",
				},
			};
			void this.options
				.sendToOffscreen({ type: "agent-runtime-request", request: abortRequest })
				.catch((error: unknown) => this.report(error, "direct-request-abort"));
		};
		// Start dispatching the parent before arming its abort follow-up. This
		// preserves the host's request-before-abort ordering even if cancellation
		// happens immediately after this call returns its promise.
		const releaseExecutionAuthorization = this.beginActiveExecutionRequest(request);
		let responsePromise: Promise<unknown>;
		try {
			responsePromise = this.options.sendToOffscreen({ type: "agent-runtime-request", request });
		} catch (error) {
			releaseExecutionAuthorization();
			throw error;
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
		let responseValue: unknown;
		try {
			responseValue = await responsePromise;
		} finally {
			options.signal?.removeEventListener("abort", onAbort);
			releaseExecutionAuthorization();
		}
		if (!isRuntimeResponseEnvelope(responseValue)) {
			throw new Error("Offscreen runtime returned a malformed direct response");
		}
		const response = clone(responseValue);
		const correlation = correlateRuntimeResponse(request, response);
		if (!correlation.ok) {
			throw new Error(`Offscreen runtime direct response identity mismatch: ${correlation.mismatches.join(", ")}`);
		}
		if (!response.ok) {
			const error = new Error(response.error.message);
			if (response.error.code === "ABORTED") error.name = "AbortError";
			throw error;
		}
		return clone(response.result);
	}

	async releaseSession(clientId: string, windowId: number, reason: string): Promise<boolean> {
		await this.ensureInitialized();
		const key = routeKey({ clientId, windowId });
		return this.withRouteLock(key, async () => {
			const accepted = this.acceptedDescriptors.get(key);
			if (!accepted) return false;
			await this.releaseSessionLocked(key, clone(accepted.descriptor), reason);
			return true;
		});
	}

	async releaseWindow(windowId: number, reason: string): Promise<number> {
		await this.ensureInitialized();
		const descriptors = this.getAcceptedDescriptors().filter((descriptor) => descriptor.windowId === windowId);
		const results = await Promise.all(
			descriptors.map((descriptor) => this.releaseSession(descriptor.clientId, descriptor.windowId, reason)),
		);
		return results.filter(Boolean).length;
	}

	acceptPort(
		port: AgentRuntimeCoordinatorPort,
		authentication: AgentRuntimeAuthenticatedPort,
		initialMessages: readonly unknown[] = [],
	): boolean {
		if (this.disposed) return false;
		const identity = parseAgentRuntimePortName(port.name);
		if (!identity) return false;
		if (!authenticationMatchesPort(port, identity, authentication)) return false;
		if (this.connections.has(port)) return true;
		const connection: PortConnection = {
			port,
			identity: { clientId: identity.clientId, windowId: identity.windowId },
			lease: clone(authentication.lease),
			connected: false,
			closed: false,
			messageTail: Promise.resolve(),
			helloEpochs: new Set(),
			lastEventSeqBySessionEpoch: new Map(),
		};
		this.connections.set(port, connection);
		port.onMessage.addListener((message) => this.enqueuePortMessage(connection, message));
		port.onDisconnect.addListener(() => {
			this.closeConnection(connection, false);
		});
		for (const message of initialMessages) this.enqueuePortMessage(connection, clone(message));
		return true;
	}

	/**
	 * Handles an unsolicited message from the offscreen document. Returning
	 * undefined means the message is outside this coordinator's protocol.
	 */
	handleOffscreenMessage(message: unknown): Promise<unknown> | undefined {
		if (this.disposed) return undefined;
		const stream = hostStreamMessage(message);
		if (stream) {
			return this.routeStream(stream.envelope).then(
				(routed) =>
					({
						ok: true,
						kind: "stream",
						routed,
					}) satisfies AgentRuntimeOffscreenMessageResult,
			);
		}
		const checkpoint = checkpointMessage(message);
		if (checkpoint) {
			const state = clone(checkpoint.state);
			const write = this.checkpointTail
				.catch(() => undefined)
				.then(() => this.options.checkpointStorage.save(state));
			this.checkpointTail = write;
			return write.then(
				() => ({ ok: true, kind: "checkpoint" }) satisfies AgentRuntimeOffscreenMessageResult,
				(error: unknown) => {
					this.report(error, "checkpoint-save");
					return { ok: false, error: errorMessage(error) } satisfies AgentRuntimeOffscreenMessageResult;
				},
			);
		}
		const control = pageControlMessage(message);
		if (!control) return undefined;
		return this.handleAuthorizedPageControl(control);
	}

	private async handleAuthorizedPageControl(controlValue: AgentRuntimePageControlMessage): Promise<unknown> {
		if (!this.options.handlePageControlMessage) {
			return { ok: false, error: "Privileged page operation handler is unavailable" };
		}
		try {
			// A service worker may receive the first nested tool operation while its
			// descriptor/hello recovery is still in flight. Recover first, then
			// authorize against the freshly re-established epoch and session state.
			await this.ensureInitialized();
			const control = clone(controlValue);
			const authorizationError = this.pageControlAuthorizationError(control);
			if (authorizationError) return { ok: false, error: authorizationError };
			const fingerprint = pageControlOperationFingerprint(control);
			if (control.type === "agent-runtime-page-cancel") {
				const active = this.activePageControlOperations.get(control.operationId);
				if (!active || active.fingerprint !== fingerprint) {
					return { ok: false, error: "Page cancellation does not match an active authorized operation" };
				}
				return await this.options.handlePageControlMessage(control);
			}

			const active = this.activePageControlOperations.get(control.operationId);
			if (active && active.fingerprint !== fingerprint) {
				return { ok: false, error: "Page operation id is active with different correlation data" };
			}
			if (active) active.references++;
			else {
				this.activePageControlOperations.set(control.operationId, {
					fingerprint,
					message: clone(control),
					references: 1,
				});
			}
			try {
				return await this.options.handlePageControlMessage(control);
			} finally {
				const current = this.activePageControlOperations.get(control.operationId);
				if (current?.fingerprint === fingerprint) {
					current.references--;
					if (current.references === 0) this.activePageControlOperations.delete(control.operationId);
				}
			}
		} catch (error) {
			this.report(error, "page-control");
			return { ok: false, error: errorMessage(error) };
		}
	}

	private pageControlAuthorizationError(control: AgentRuntimePageControlMessage): string | undefined {
		const accepted = this.acceptedDescriptors.get(routeKey(control));
		if (
			!accepted ||
			accepted.descriptor.sessionId !== control.sessionId ||
			!sameTarget(accepted.descriptor.target, control.target)
		) {
			return "Privileged page operation does not match an accepted runtime session";
		}
		const hello = this.latestHellos.get(routeKey(control));
		if (
			!hello ||
			hello.runtimeEpoch !== control.runtimeEpoch ||
			!helloMatchesDescriptor(hello, accepted.descriptor)
		) {
			return "Privileged page operation targets a stale or unknown runtime epoch";
		}
		const identity = executionIdentityKey(control);
		if (this.activeExecutionRequests.has(identity)) return undefined;
		const snapshot = this.readySnapshot(accepted.descriptor)?.snapshot;
		const recoveredExecution = snapshot?.activeExecutions.some(
			(execution) =>
				execution.executionId === control.executionId &&
				execution.requestId === control.executionRequestId &&
				(execution.status === "queued" ||
					execution.status === "running" ||
					execution.status === "cancel-requested"),
		);
		return recoveredExecution ? undefined : "Privileged page operation does not match a current parent execution";
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.rejectAllSessionReadyWaiters(new Error("Agent runtime coordinator was disposed before session readiness"));
		for (const connection of this.connections.values()) this.closeConnection(connection, true);
		this.connections.clear();
		this.activeRoutes.clear();
		this.acceptedDescriptors.clear();
		this.latestHellos.clear();
		this.latestSnapshots.clear();
		this.activeExecutionRequests.clear();
		this.activePageControlOperations.clear();
		this.sessionReadyWaiters.clear();
		this.routeTails.clear();
	}

	private async handlePortMessage(connection: PortConnection, message: unknown): Promise<void> {
		if (!(await this.fenceConnection(connection))) return;
		if (isPortConnectMessage(message)) return this.connect(connection, message.descriptor);
		if (isRecord(message) && message.type === "agent-runtime-port-connect") {
			this.safePost(connection, {
				type: "agent-runtime-port-connected",
				ok: false,
				error: "Malformed agent runtime connection descriptor",
			});
			return;
		}
		if (!isRecord(message) || message.type !== "agent-runtime-port-request") {
			this.rejectRequest(connection, requestIdFromUnknown(message), "Malformed agent runtime port message");
			return;
		}
		if (!connection.connected || !connection.descriptor || !this.isActive(connection)) {
			this.rejectRequest(connection, requestIdFromUnknown(message), "Agent runtime port is not connected");
			return;
		}
		if (!isRuntimeRequestEnvelope(message.request)) {
			this.rejectRequest(connection, requestIdFromUnknown(message), "Malformed runtime request envelope");
			return;
		}
		return this.forwardRequest(connection, message.request);
	}

	private enqueuePortMessage(connection: PortConnection, message: unknown): void {
		connection.messageTail = connection.messageTail
			.then(() => this.handlePortMessage(connection, message))
			.catch((error: unknown) => {
				this.report(error, "port-message");
			});
	}

	private async connect(connection: PortConnection, descriptorValue: AgentRuntimeConnectionDescriptor): Promise<void> {
		const descriptor = clone(descriptorValue);
		if (!(await this.fenceConnection(connection))) return;
		if (
			descriptor.clientId !== connection.identity.clientId ||
			descriptor.windowId !== connection.identity.windowId
		) {
			this.safePost(connection, {
				type: "agent-runtime-port-connected",
				ok: false,
				error: "Runtime descriptor does not match the port identity",
			});
			return;
		}
		const fingerprint = canonical(descriptor as unknown as RuntimeValue);
		if (connection.descriptor) {
			if (connection.descriptorFingerprint === fingerprint && connection.connected && this.isActive(connection)) {
				this.safePost(connection, { type: "agent-runtime-port-connected", ok: true });
			} else {
				this.safePost(connection, {
					type: "agent-runtime-port-connected",
					ok: false,
					error: "Agent runtime port is already bound to a different session",
				});
			}
			return;
		}
		connection.descriptor = descriptor;
		connection.descriptorFingerprint = fingerprint;
		const key = routeKey(connection.identity);
		await this.withRouteLock(key, async () => {
			if (!(await this.fenceConnection(connection))) return;
			try {
				await this.ensureInitialized();
			} catch (error) {
				connection.descriptor = undefined;
				connection.descriptorFingerprint = undefined;
				this.safePost(connection, {
					type: "agent-runtime-port-connected",
					ok: false,
					error: `Could not initialize the offscreen runtime: ${errorMessage(error)}`,
				});
				return;
			}
			if (!(await this.fenceConnection(connection))) return;
			let previous = this.activeRoutes.get(key);
			if (previous && previous !== connection && previous.lease.leaseId !== connection.lease.leaseId) {
				this.closeConnection(previous, true);
				previous = undefined;
			}
			const accepted = this.acceptedDescriptors.get(key);
			if (accepted && accepted.fingerprint !== fingerprint) {
				connection.descriptor = undefined;
				connection.descriptorFingerprint = undefined;
				this.safePost(connection, {
					type: "agent-runtime-port-connected",
					ok: false,
					error: "Runtime route is owned by a different agent session",
				});
				return;
			}
			this.activeRoutes.set(key, connection);
			if (accepted?.fingerprint === fingerprint) {
				if (!this.latestHellos.has(key)) {
					await this.options.sendToOffscreen({ type: "agent-runtime-connect", descriptor: clone(descriptor) });
					if (!(await this.fenceConnection(connection)) || this.activeRoutes.get(key) !== connection) {
						if (this.activeRoutes.get(key) === connection) await this.restoreActiveRoute(key, previous);
						return;
					}
				}
				connection.connected = true;
				if (!this.safePost(connection, { type: "agent-runtime-port-connected", ok: true })) {
					await this.restoreActiveRoute(key, previous);
					return;
				}
				const latestHello = this.latestHellos.get(key);
				if (latestHello && helloMatchesDescriptor(latestHello, descriptor)) {
					connection.helloEpochs.add(latestHello.runtimeEpoch);
					this.safePost(connection, { type: "agent-runtime-port-stream", envelope: clone(latestHello) });
				}
				if (previous && previous !== connection) this.closeConnection(previous, true);
				return;
			}
			try {
				await this.options.sendToOffscreen({ type: "agent-runtime-connect", descriptor: clone(descriptor) });
				if (!(await this.fenceConnection(connection)) || this.activeRoutes.get(key) !== connection) {
					if (this.activeRoutes.get(key) === connection) await this.restoreActiveRoute(key, previous);
					return;
				}
				await this.options.onDescriptorBound?.(clone(descriptor));
				// The persistence boundary owns the session independently of this
				// replaceable presentation lease. Complete the in-memory bind even if
				// the document is superseded while that durable write is pending.
				this.acceptedDescriptors.set(key, { descriptor: clone(descriptor), fingerprint });
				const ready = this.readySnapshot(descriptor);
				if (ready) {
					this.resolveSessionReadyWaiters(descriptor, ready);
					this.notifySessionReadiness(descriptor, true);
				}
				if (!(await this.fenceConnection(connection)) || this.activeRoutes.get(key) !== connection) {
					if (this.activeRoutes.get(key) === connection) await this.restoreActiveRoute(key, previous);
					return;
				}
				connection.connected = true;
				if (!this.safePost(connection, { type: "agent-runtime-port-connected", ok: true })) {
					await this.restoreActiveRoute(key, previous);
					return;
				}
				if (previous && previous !== connection) this.closeConnection(previous, true);
			} catch (error) {
				if (this.activeRoutes.get(key) === connection) await this.restoreActiveRoute(key, previous);
				connection.descriptor = undefined;
				connection.descriptorFingerprint = undefined;
				this.safePost(connection, {
					type: "agent-runtime-port-connected",
					ok: false,
					error: `Could not connect to the offscreen runtime: ${errorMessage(error)}`,
				});
			}
		});
	}

	private async forwardRequest(connection: PortConnection, requestValue: RuntimeRequestEnvelope): Promise<void> {
		if (!(await this.fenceConnection(connection))) return;
		const request = clone(requestValue);
		const descriptor = connection.descriptor;
		if (
			!descriptor ||
			request.clientId !== descriptor.clientId ||
			request.windowId !== descriptor.windowId ||
			request.sessionId !== descriptor.sessionId ||
			!sameTarget(request.target, descriptor.target)
		) {
			this.rejectRequest(connection, request.requestId, "Runtime request does not match the connected session");
			return;
		}
		let responseValue: unknown;
		const releaseExecutionAuthorization = this.beginActiveExecutionRequest(request);
		try {
			if (!(await this.fenceConnection(connection))) return;
			responseValue = await this.options.sendToOffscreen({ type: "agent-runtime-request", request });
		} catch (error) {
			this.rejectRequest(connection, request.requestId, `Offscreen runtime request failed: ${errorMessage(error)}`);
			return;
		} finally {
			releaseExecutionAuthorization();
		}
		if (!(await this.fenceConnection(connection)) || !this.isActive(connection)) return;
		if (!isRuntimeResponseEnvelope(responseValue)) {
			this.rejectRequest(connection, request.requestId, "Offscreen runtime returned a malformed response");
			return;
		}
		const response = clone(responseValue);
		const correlation = correlateRuntimeResponse(request, response);
		if (!correlation.ok) {
			this.rejectRequest(
				connection,
				request.requestId,
				`Offscreen runtime response identity mismatch: ${correlation.mismatches.join(", ")}`,
			);
			return;
		}
		this.safePost(connection, { type: "agent-runtime-port-response", response });
		if (request.operation.type === "release" && response.ok) {
			const key = routeKey(connection.identity);
			const descriptor = connection.descriptor;
			if (descriptor) {
				try {
					await this.forgetAcceptedDescriptor(
						key,
						descriptor,
						request.operation.reason ?? "client-release",
						false,
					);
				} catch (error) {
					this.report(error, "descriptor-release");
				}
			}
		}
	}

	private beginActiveExecutionRequest(request: RuntimeRequestEnvelope): () => void {
		const identity = requestExecutionIdentity(request);
		if (!identity) return () => {};
		const active = this.activeExecutionRequests.get(identity);
		if (active) active.references++;
		else this.activeExecutionRequests.set(identity, { request: clone(request), references: 1 });
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const current = this.activeExecutionRequests.get(identity);
			if (!current) return;
			current.references--;
			if (current.references === 0) this.activeExecutionRequests.delete(identity);
		};
	}

	private clearActivePageAuthorizationForRoute(route: string, retainedRuntimeEpoch?: string): void {
		for (const [identity, active] of this.activeExecutionRequests) {
			if (
				routeKey(active.request) === route &&
				(retainedRuntimeEpoch === undefined || active.request.runtimeEpoch !== retainedRuntimeEpoch)
			) {
				this.activeExecutionRequests.delete(identity);
			}
		}
		for (const [operationId, active] of this.activePageControlOperations) {
			if (
				routeKey(active.message) === route &&
				(retainedRuntimeEpoch === undefined || active.message.runtimeEpoch !== retainedRuntimeEpoch)
			) {
				this.activePageControlOperations.delete(operationId);
			}
		}
	}

	private async routeStream(envelopeValue: RuntimeStreamEnvelope): Promise<boolean> {
		const envelope = clone(envelopeValue);
		const route = routeKey(envelope);
		const connection = this.activeRoutes.get(route);
		if (envelope.streamType === "hello") {
			const descriptor = connection?.descriptor ?? this.acceptedDescriptors.get(route)?.descriptor;
			if (!descriptor || !helloMatchesDescriptor(envelope, descriptor)) return false;
			const descriptorIsAccepted = this.isAcceptedDescriptor(descriptor);
			const wasReady = this.readySnapshot(descriptor) !== undefined;
			this.clearActivePageAuthorizationForRoute(route, envelope.runtimeEpoch);
			this.latestHellos.set(route, clone(envelope));
			const snapshotKey = this.snapshotKey(descriptor);
			const snapshot = this.latestSnapshots.get(snapshotKey);
			if (snapshot && snapshot.runtimeEpoch !== envelope.runtimeEpoch) this.latestSnapshots.delete(snapshotKey);
			if (descriptorIsAccepted && wasReady && this.readySnapshot(descriptor) === undefined) {
				this.notifySessionReadiness(descriptor, false);
			}
			if (!connection || !(await this.fenceConnection(connection))) return false;
			if (this.activeRoutes.get(route) !== connection) return false;
			if (connection.helloEpochs.has(envelope.runtimeEpoch)) return false;
			connection.helloEpochs.add(envelope.runtimeEpoch);
			return this.safePost(connection, { type: "agent-runtime-port-stream", envelope });
		}
		const descriptor = connection?.descriptor ?? this.acceptedDescriptors.get(route)?.descriptor;
		if (!descriptor) return false;
		if (envelope.sessionId !== descriptor.sessionId || !sameTarget(envelope.target, descriptor.target)) return false;
		const authoritativeHello = this.latestHellos.get(route);
		if (!authoritativeHello || envelope.runtimeEpoch !== authoritativeHello.runtimeEpoch) return false;
		if (envelope.streamType === "session-snapshot") {
			const wasReady = this.readySnapshot(descriptor) !== undefined;
			const key = this.snapshotKey(descriptor);
			const previous = this.latestSnapshots.get(key);
			if (!previous || previous.runtimeEpoch !== envelope.runtimeEpoch || envelope.eventSeq > previous.eventSeq) {
				this.latestSnapshots.set(key, clone(envelope));
			}
			const ready = this.readySnapshot(descriptor);
			if (!wasReady && ready && this.isAcceptedDescriptor(descriptor)) {
				this.resolveSessionReadyWaiters(descriptor, ready);
				this.notifySessionReadiness(descriptor, true);
			}
		}
		if (!connection || !connection.descriptor || !(await this.fenceConnection(connection))) return false;
		if (this.activeRoutes.get(route) !== connection) return false;
		const sessionEpoch = sessionEpochKey(envelope);
		const lastEventSeq = connection.lastEventSeqBySessionEpoch.get(sessionEpoch) ?? 0;
		if (envelope.eventSeq <= lastEventSeq) return false;
		connection.lastEventSeqBySessionEpoch.set(sessionEpoch, envelope.eventSeq);
		return this.safePost(connection, { type: "agent-runtime-port-stream", envelope });
	}

	private ensureInitialized(): Promise<void> {
		if (this.initialization) return this.initialization;
		const initialization = (async () => {
			await this.options.ensureOffscreen();
			const descriptors = (await this.options.loadAcceptedDescriptors?.()) ?? [];
			for (const descriptorValue of descriptors) {
				if (!validConnectionDescriptor(descriptorValue)) {
					throw new Error("Stored agent runtime connection descriptor is malformed");
				}
				const descriptor = clone(descriptorValue);
				const key = routeKey(descriptor);
				const fingerprint = canonical(descriptor as unknown as RuntimeValue);
				const existing = this.acceptedDescriptors.get(key);
				if (existing && existing.fingerprint !== fingerprint) {
					throw new Error("Stored agent runtime connection descriptors conflict");
				}
				this.acceptedDescriptors.set(key, { descriptor, fingerprint });
			}
			const checkpoint = await this.options.checkpointStorage.load();
			if (checkpoint !== undefined && !validPersistedState(checkpoint)) {
				throw new Error("Stored offscreen runtime checkpoint is malformed");
			}
			await this.options.sendToOffscreen({
				type: "agent-runtime-init",
				...(checkpoint ? { state: clone(checkpoint) } : {}),
			});
			for (const descriptor of this.getAcceptedDescriptors()) {
				try {
					await this.recoverAcceptedSession(descriptor);
				} catch (error) {
					this.report(error, "accepted-session-recovery");
				}
			}
		})();
		this.initialization = initialization;
		void initialization.catch(() => {
			if (this.initialization === initialization) this.initialization = undefined;
		});
		return initialization;
	}

	private async recoverAcceptedSession(descriptor: AgentRuntimeConnectionDescriptor): Promise<void> {
		await this.options.sendToOffscreen({ type: "agent-runtime-connect", descriptor: clone(descriptor) });
		const hello = this.latestHellos.get(routeKey(descriptor));
		if (!hello || !helloMatchesDescriptor(hello, descriptor)) {
			throw new Error("Offscreen runtime did not provide an authoritative hello for accepted-session recovery");
		}
		const cursor = hello.recovery.sessions.find((session) => session.sessionId === descriptor.sessionId);
		const operation: RuntimeRequestOperation = cursor
			? { type: "attach", lastRevision: cursor.revision, lastEventSeq: cursor.eventSeq }
			: { type: "load" };
		const request: RuntimeRequestEnvelope = {
			kind: "request",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: hello.runtimeEpoch,
			clientId: descriptor.clientId,
			windowId: descriptor.windowId,
			sessionId: descriptor.sessionId,
			target: clone(descriptor.target),
			requestId: this.options.createRequestId?.() ?? crypto.randomUUID(),
			operation,
		};
		const responseValue = await this.options.sendToOffscreen({ type: "agent-runtime-request", request });
		if (!isRuntimeResponseEnvelope(responseValue)) {
			throw new Error("Offscreen runtime returned a malformed accepted-session recovery response");
		}
		const response = clone(responseValue);
		const correlation = correlateRuntimeResponse(request, response);
		if (!correlation.ok) {
			throw new Error(`Offscreen runtime recovery response identity mismatch: ${correlation.mismatches.join(", ")}`);
		}
		if (!response.ok) throw new Error(response.error.message);
		if (!this.readySnapshot(descriptor)) {
			throw new Error("Offscreen runtime recovery completed without an exact session snapshot");
		}
	}

	private async bindSessionLocked(key: string, descriptor: AgentRuntimeConnectionDescriptor): Promise<void> {
		const fingerprint = canonical(descriptor as unknown as RuntimeValue);
		const existing = this.acceptedDescriptors.get(key);
		if (existing) {
			if (existing.fingerprint !== fingerprint) {
				throw new Error("Browser window is already bound to a different agent session");
			}
			return;
		}
		await this.options.onDescriptorBound?.(clone(descriptor));
		this.acceptedDescriptors.set(key, { descriptor: clone(descriptor), fingerprint });
		try {
			const response = await this.options.sendToOffscreen({
				type: "agent-runtime-connect",
				descriptor: clone(descriptor),
			});
			if (isRuntimeStreamEnvelope(response) && response.streamType === "hello") await this.routeStream(response);
		} catch (error) {
			this.rejectSessionReadyWaiters(
				descriptor,
				new Error(`Agent runtime session ${descriptor.sessionId} failed to bind before becoming ready`),
			);
			this.acceptedDescriptors.delete(key);
			await this.options.onDescriptorReleased?.(clone(descriptor), "bind-failed");
			throw error;
		}
	}

	private async releaseSessionLocked(
		key: string,
		descriptor: AgentRuntimeConnectionDescriptor,
		reason: string,
	): Promise<void> {
		const accepted = this.acceptedDescriptors.get(key);
		if (!accepted || accepted.fingerprint !== canonical(descriptor as unknown as RuntimeValue)) {
			throw new Error("Agent runtime session descriptor changed before release");
		}
		const hello = await this.ensureReleaseHello(key, descriptor);
		const request: RuntimeRequestEnvelope = {
			kind: "request",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: hello.runtimeEpoch,
			clientId: descriptor.clientId,
			windowId: descriptor.windowId,
			sessionId: descriptor.sessionId,
			target: clone(descriptor.target),
			requestId: this.options.createRequestId?.() ?? crypto.randomUUID(),
			operation: { type: "release", force: true, reason },
		};
		const responseValue = await this.options.sendToOffscreen({ type: "agent-runtime-request", request });
		if (!isRuntimeResponseEnvelope(responseValue)) {
			throw new Error("Offscreen runtime returned a malformed release response");
		}
		const response = clone(responseValue);
		const correlation = correlateRuntimeResponse(request, response);
		if (!correlation.ok) {
			throw new Error(`Offscreen runtime release identity mismatch: ${correlation.mismatches.join(", ")}`);
		}
		if (!response.ok) throw new Error(response.error.message);
		await this.forgetAcceptedDescriptor(key, descriptor, reason, true);
	}

	private async ensureReleaseHello(
		key: string,
		descriptor: AgentRuntimeConnectionDescriptor,
	): Promise<RuntimeHelloEnvelope> {
		await this.ensureInitialized();
		let hello = this.latestHellos.get(key);
		if (!hello || !helloMatchesDescriptor(hello, descriptor)) {
			const response = await this.options.sendToOffscreen({
				type: "agent-runtime-connect",
				descriptor: clone(descriptor),
			});
			if (isRuntimeStreamEnvelope(response) && response.streamType === "hello") {
				await this.routeStream(response);
			}
			hello = this.latestHellos.get(key);
		}
		if (!hello || !helloMatchesDescriptor(hello, descriptor)) {
			throw new Error("Offscreen runtime did not provide an authoritative hello for release");
		}
		return clone(hello);
	}

	private async forgetAcceptedDescriptor(
		key: string,
		descriptor: AgentRuntimeConnectionDescriptor,
		reason: string,
		disconnect: boolean,
	): Promise<void> {
		const accepted = this.acceptedDescriptors.get(key);
		if (!accepted || accepted.fingerprint !== canonical(descriptor as unknown as RuntimeValue)) return;
		this.rejectSessionReadyWaiters(
			descriptor,
			new Error(`Agent runtime session ${descriptor.sessionId} was released before becoming ready`),
		);
		this.acceptedDescriptors.delete(key);
		this.latestHellos.delete(key);
		this.latestSnapshots.delete(this.snapshotKey(descriptor));
		this.clearActivePageAuthorizationForRoute(key);
		const matchingConnections = [...this.connections.values()].filter(
			(connection) => routeKey(connection.identity) === key,
		);
		this.activeRoutes.delete(key);
		for (const connection of matchingConnections) {
			connection.connected = false;
			if (disconnect) this.closeConnection(connection, true);
		}
		await this.options.onDescriptorReleased?.(clone(descriptor), reason);
	}

	private snapshotKey(
		descriptor: Pick<AgentRuntimeConnectionDescriptor, "clientId" | "windowId" | "sessionId">,
	): string {
		return JSON.stringify([descriptor.clientId, descriptor.windowId, descriptor.sessionId]);
	}

	private readySnapshot(descriptor: AgentRuntimeConnectionDescriptor): RuntimeSnapshotEnvelope | undefined {
		const hello = this.latestHellos.get(routeKey(descriptor));
		const snapshot = this.latestSnapshots.get(this.snapshotKey(descriptor));
		return hello && snapshot?.runtimeEpoch === hello.runtimeEpoch ? snapshot : undefined;
	}

	private isAcceptedDescriptor(descriptor: AgentRuntimeConnectionDescriptor): boolean {
		const accepted = this.acceptedDescriptors.get(routeKey(descriptor));
		return accepted?.fingerprint === canonical(descriptor as unknown as RuntimeValue);
	}

	private resolveSessionReadyWaiters(
		descriptor: AgentRuntimeConnectionDescriptor,
		envelope: RuntimeSnapshotEnvelope,
	): void {
		const key = this.snapshotKey(descriptor);
		const waiters = this.sessionReadyWaiters.get(key);
		if (!waiters) return;
		this.sessionReadyWaiters.delete(key);
		for (const waiter of waiters) {
			if (waiter.settled) continue;
			waiter.settled = true;
			clearTimeout(waiter.timeout);
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.resolve(clone(envelope.snapshot));
		}
	}

	private rejectSessionReadyWaiter(key: string, waiter: SessionReadyWaiter, error: Error): void {
		if (waiter.settled) return;
		waiter.settled = true;
		clearTimeout(waiter.timeout);
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		const waiters = this.sessionReadyWaiters.get(key);
		waiters?.delete(waiter);
		if (waiters?.size === 0) this.sessionReadyWaiters.delete(key);
		waiter.reject(error);
	}

	private rejectSessionReadyWaiters(descriptor: AgentRuntimeConnectionDescriptor, error: Error): void {
		const key = this.snapshotKey(descriptor);
		const waiters = [...(this.sessionReadyWaiters.get(key) ?? [])];
		for (const waiter of waiters) this.rejectSessionReadyWaiter(key, waiter, error);
	}

	private rejectAllSessionReadyWaiters(error: Error): void {
		for (const [key, waiters] of [...this.sessionReadyWaiters]) {
			for (const waiter of [...waiters]) this.rejectSessionReadyWaiter(key, waiter, error);
		}
	}

	private sessionReadyAbortError(reason: unknown): Error {
		const error = new Error(
			typeof reason === "string" && reason.trim() ? reason : "Session readiness wait was aborted",
		);
		error.name = "AbortError";
		return error;
	}

	private directRequestAbortError(reason: unknown): Error {
		const error = new Error(
			typeof reason === "string" && reason.trim() ? reason : "Agent runtime request was aborted",
		);
		error.name = "AbortError";
		return error;
	}

	private notifySessionReadiness(descriptor: AgentRuntimeConnectionDescriptor, ready: boolean): void {
		void Promise.resolve(this.options.onSessionReadinessChanged?.(clone(descriptor), ready)).catch((error: unknown) =>
			this.report(error, "session-readiness-change"),
		);
	}

	private withRouteLock<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = this.routeTails.get(key) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(work);
		const tail = current.then(
			() => undefined,
			() => undefined,
		);
		this.routeTails.set(key, tail);
		const cleanup = () => {
			if (this.routeTails.get(key) === tail) this.routeTails.delete(key);
		};
		void tail.then(cleanup);
		return current;
	}

	private async restoreActiveRoute(key: string, previous: PortConnection | undefined): Promise<void> {
		if (previous?.connected && (await this.fenceConnection(previous, false))) {
			this.activeRoutes.set(key, previous);
		} else {
			this.activeRoutes.delete(key);
		}
	}

	private isActive(connection: PortConnection): boolean {
		return this.activeRoutes.get(routeKey(connection.identity)) === connection;
	}

	private async fenceConnection(connection: PortConnection, disconnect = true): Promise<boolean> {
		if (connection.closed || this.disposed) return false;
		let current = false;
		try {
			current = await this.options.isSidepanelLeaseCurrent(clone(connection.lease));
		} catch (error) {
			this.report(error, "lease-fence");
		}
		if (current && !connection.closed && !this.disposed) return true;
		this.closeConnection(connection, disconnect);
		return false;
	}

	revokeWindowPorts(windowId: number): void {
		for (const connection of [...this.connections.values()]) {
			if (connection.identity.windowId === windowId) this.closeConnection(connection, true);
		}
	}

	private closeConnection(connection: PortConnection, disconnect: boolean): void {
		if (connection.closed) return;
		connection.closed = true;
		connection.connected = false;
		this.connections.delete(connection.port);
		const key = routeKey(connection.identity);
		if (this.activeRoutes.get(key) === connection) this.activeRoutes.delete(key);
		if (!disconnect || !connection.port.disconnect) return;
		try {
			connection.port.disconnect();
		} catch (error) {
			this.report(error, "port-disconnect");
		}
	}

	private rejectRequest(connection: PortConnection, requestId: string, error: string): void {
		this.safePost(connection, { type: "agent-runtime-port-error", requestId, error });
	}

	private safePost(connection: PortConnection, message: AgentRuntimePortResponse): boolean {
		if (connection.closed) return false;
		try {
			connection.port.postMessage(message);
			return true;
		} catch (error) {
			this.report(error, "port-post");
			this.closeConnection(connection, false);
			return false;
		}
	}

	private report(error: unknown, context: string): void {
		this.options.reportError?.(error, context);
	}
}
