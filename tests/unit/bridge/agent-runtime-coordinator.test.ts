import { describe, expect, it, vi } from "vitest";

import type { OffscreenRuntimeHostState } from "@shuvgeist/extension/agent/offscreen-runtime-host";
import {
	parseAgentRuntimePortName,
	parseSidepanelTrackingPortName,
	sidepanelDocumentNonce,
} from "@shuvgeist/extension/agent/sidepanel-context-identity";
import {
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeHelloEnvelope,
	type RuntimeRequestEnvelope,
	type RuntimeResponseEnvelope,
	type RuntimeSessionSnapshot,
	type RuntimeStreamEnvelope,
	type RuntimeTargetIdentity,
} from "@shuvgeist/extension/agent/runtime-protocol";
import {
	AgentRuntimeCoordinator,
	AgentRuntimeSidepanelTrackingRegistry,
	authenticateAndAcceptAgentRuntimePort,
	authenticateAndAcceptSidepanelTrackingPort,
	authenticateAgentRuntimePort,
	type AgentRuntimeAuthenticatedPort,
	type AgentRuntimeCoordinatorOptions,
	type AgentRuntimeCoordinatorPort,
	type AgentRuntimeExtensionContext,
	type AgentRuntimePortSender,
} from "@shuvgeist/extension/bridge/agent-runtime-coordinator";
import type {
	AgentRuntimeConnectionDescriptor,
	AgentRuntimePageCancelMessage,
	AgentRuntimePageOperationMessage,
	AgentRuntimePortResponse,
	BridgeToOffscreenMessage,
} from "@shuvgeist/extension/bridge/internal-messages";

const documentNonce = "00000000-0000-4000-8000-000000000007";
const otherDocumentNonce = "00000000-0000-4000-8000-000000000008";
const continuationToken = "a".repeat(64);
const transactionId = "00000000-0000-4000-8000-000000000017";
const leaseId = "00000000-0000-4000-8000-000000000027";
const staleSessionId = "00000000-0000-4000-8000-000000000037";
const portCapability = { continuationToken, transactionId, leaseId };
const sidepanelBaseUrl = "chrome-extension://extension-id/sidepanel.html";
const sidepanelDocumentUrl = `${sidepanelBaseUrl}?shuvgeistContext=${documentNonce}`;

function capabilityIdForCoordinator(index: number): string {
	return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function normalizeTestPortName(name: string): string {
	if (/^agent-runtime:[^:]+:(0|[1-9]\d*)$/u.test(name)) {
		return `${name}:${documentNonce}:${continuationToken}:${transactionId}:${leaseId}`;
	}
	if (/^sidepanel:(0|[1-9]\d*)$/u.test(name)) {
		return `${name}:${documentNonce}:${continuationToken}:${transactionId}:${leaseId}`;
	}
	return name;
}

function chromePortIsStructurallyCompatible(port: chrome.runtime.Port): AgentRuntimeCoordinatorPort {
	return port;
}

void chromePortIsStructurallyCompatible;

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
	let resolve: Deferred<T>["resolve"] = () => {};
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

class FakePort implements AgentRuntimeCoordinatorPort {
	readonly name: string;
	readonly messages: AgentRuntimePortResponse[] = [];
	disconnectCalls = 0;
	throwOnConnectedAck = false;
	private readonly messageListeners = new Set<(message: unknown) => void>();
	private readonly disconnectListeners = new Set<() => void>();
	readonly onMessage = {
		addListener: (listener: (message: unknown) => void) => {
			this.messageListeners.add(listener);
		},
		removeListener: (listener: (message: unknown) => void) => {
			this.messageListeners.delete(listener);
		},
	};
	readonly onDisconnect = {
		addListener: (listener: () => void) => {
			this.disconnectListeners.add(listener);
		},
		removeListener: (listener: () => void) => {
			this.disconnectListeners.delete(listener);
		},
	};

	constructor(
		name: string,
		readonly sender: AgentRuntimePortSender = trustedSender(),
		private readonly onDisconnectCall?: () => void,
		normalizeName = true,
	) {
		this.name = normalizeName ? normalizeTestPortName(name) : name;
	}

	postMessage(message: AgentRuntimePortResponse): void {
		if (this.throwOnConnectedAck && message.type === "agent-runtime-port-connected") {
			this.throwOnConnectedAck = false;
			throw new Error("connection acknowledgement dropped");
		}
		this.messages.push(structuredClone(message));
	}

	disconnect(): void {
		this.disconnectCalls++;
		this.onDisconnectCall?.();
		this.emitDisconnect();
	}

	emitMessage(message: unknown): void {
		for (const listener of [...this.messageListeners]) listener(message);
	}

	emitDisconnect(): void {
		for (const listener of [...this.disconnectListeners]) listener();
	}

	get messageListenerCount(): number {
		return this.messageListeners.size;
	}

	get disconnectListenerCount(): number {
		return this.disconnectListeners.size;
	}
}

function trustedSender(overrides: Partial<AgentRuntimePortSender> = {}): AgentRuntimePortSender {
	return {
		id: "extension-id",
		url: sidepanelBaseUrl,
		origin: "chrome-extension://extension-id",
		...overrides,
	};
}

function authenticatedPort(
	port: FakePort,
	overrides: Partial<AgentRuntimeAuthenticatedPort> = {},
): AgentRuntimeAuthenticatedPort {
	const identity = parseAgentRuntimePortName(port.name);
	const clientId = identity?.clientId ?? "sidepanel";
	const windowId = identity?.windowId ?? 7;
	const contextId = `sidepanel-context-${windowId}`;
	const documentId = port.sender.documentId ?? "sidepanel-document";
	const resolvedDocumentNonce = identity?.documentNonce ?? documentNonce;
	return {
		clientId,
		windowId,
		extensionId: port.sender.id ?? "extension-id",
		documentId,
		documentUrl: port.sender.url ?? sidepanelDocumentUrl,
		documentOrigin: port.sender.origin ?? "chrome-extension://extension-id",
		contextId,
		contextType: "SIDE_PANEL",
		documentNonce: resolvedDocumentNonce,
		lease: {
			windowId,
			contextId,
			documentId,
			documentNonce: resolvedDocumentNonce,
			transactionId: identity?.transactionId ?? transactionId,
			leaseId: identity?.leaseId ?? leaseId,
		},
		...overrides,
	};
}

function acceptPort(coordinator: AgentRuntimeCoordinator, port: FakePort): boolean {
	return coordinator.acceptPort(port, authenticatedPort(port));
}

function sidepanelContext(overrides: Partial<AgentRuntimeExtensionContext> = {}): AgentRuntimeExtensionContext {
	return {
		contextId: "sidepanel-context-7",
		contextType: "SIDE_PANEL",
		documentId: "sidepanel-document",
		documentOrigin: "chrome-extension://extension-id",
		documentUrl: sidepanelDocumentUrl,
		frameId: -1,
		tabId: -1,
		windowId: 7,
		...overrides,
	};
}

function authorizedContext(
	context: AgentRuntimeExtensionContext = sidepanelContext(),
	nonce = documentNonce,
) {
	if (!context.documentId) throw new Error("test context requires a documentId");
	return {
		...context,
		lease: {
			windowId: context.windowId,
			contextId: context.contextId,
			documentId: context.documentId,
			documentNonce: nonce,
			transactionId,
			leaseId,
		},
	};
}

function authenticationOptions(
	contexts: AgentRuntimeExtensionContext[],
) {
	return {
		extensionId: "extension-id",
		sidepanelUrl: sidepanelBaseUrl,
		sidePanelContextType: "SIDE_PANEL",
		resolveSidepanelLease: async (nonce: string) => {
			const matches = contexts.filter((context) => sidepanelDocumentNonce(context.documentUrl ?? "") === nonce);
			const context = matches.length === 1 ? matches[0] : undefined;
			if (!context?.documentId) return undefined;
			return {
				...context,
				lease: {
					windowId: context.windowId,
					contextId: context.contextId,
					documentId: context.documentId,
					documentNonce: nonce,
					transactionId,
					leaseId,
				},
			};
		},
		isSidepanelLeaseCurrent: async () => true,
	};
}

async function registerTrackingPort(
	registry: AgentRuntimeSidepanelTrackingRegistry,
	port: FakePort,
	context: AgentRuntimeExtensionContext = sidepanelContext(),
): Promise<void> {
	const accepted = vi.fn(() => true);
	expect(
		authenticateAndAcceptSidepanelTrackingPort(
			port,
			registry,
			{ acceptPort: (_port, lease) => accepted(lease.windowId) },
			authenticationOptions([context]),
		),
	).toBe(true);
	await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(1));
}

const target7: RuntimeTargetIdentity = { kind: "chrome-tab", tabRef: "window:7" };
const target8: RuntimeTargetIdentity = { kind: "chrome-tab", tabRef: "window:8" };

function descriptor(
	windowId = 7,
	sessionId = `session-${windowId}`,
	target: RuntimeTargetIdentity = windowId === 7 ? target7 : target8,
): AgentRuntimeConnectionDescriptor {
	return {
		clientId: "sidepanel",
		windowId,
		sessionId,
		target,
		mode: "load",
		systemPrompt: "System prompt",
	};
}

function request(
	windowId = 7,
	sessionId = `session-${windowId}`,
	target: RuntimeTargetIdentity = windowId === 7 ? target7 : target8,
	requestId = `request-${windowId}`,
): RuntimeRequestEnvelope {
	return {
		kind: "request",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "sidepanel",
		windowId,
		sessionId,
		target,
		requestId,
		operation: { type: "load" },
	};
}

function responseFor(input: RuntimeRequestEnvelope): RuntimeResponseEnvelope {
	return {
		kind: "response",
		protocolVersion: input.protocolVersion,
		runtimeEpoch: input.runtimeEpoch,
		clientId: input.clientId,
		windowId: input.windowId,
		sessionId: input.sessionId,
		target: input.target,
		requestId: input.requestId,
		...(input.trace ? { trace: structuredClone(input.trace) } : {}),
		operation: input.operation.type,
		ok: true,
		result: { forwarded: true },
	};
}

function pageOperation(
	overrides: Partial<AgentRuntimePageOperationMessage> = {},
): AgentRuntimePageOperationMessage {
	return {
		type: "agent-runtime-page-operation",
		operationId: "page-operation-1",
		runtimeEpoch: "epoch-1",
		clientId: "sidepanel",
		windowId: 7,
		sessionId: "session-7",
		target: target7,
		operation: "browser-js",
		payload: { code: "return document.title" },
		executionId: "parent-execution",
		executionRequestId: "parent-request",
		...overrides,
	};
}

function pageCancel(
	overrides: Partial<AgentRuntimePageCancelMessage> = {},
): AgentRuntimePageCancelMessage {
	const operation = pageOperation();
	return {
		type: "agent-runtime-page-cancel",
		operationId: operation.operationId,
		runtimeEpoch: operation.runtimeEpoch,
		clientId: operation.clientId,
		windowId: operation.windowId,
		sessionId: operation.sessionId,
		target: operation.target,
		executionId: operation.executionId,
		executionRequestId: operation.executionRequestId,
		...overrides,
	};
}

function emptyCheckpoint(runtimeEpoch = "epoch-1"): OffscreenRuntimeHostState {
	return { runtimeEpoch, sessions: [], requests: [] };
}

function snapshot(sessionId: string, target: RuntimeTargetIdentity, revision = 1): RuntimeSessionSnapshot {
	return {
		sessionId,
		target,
		revision,
		systemPrompt: "System prompt",
		model: null,
		thinkingLevel: "off",
		messages: [],
		tools: [],
		pendingToolCallIds: [],
		isStreaming: false,
		activeExecutions: [],
		artifacts: [],
	};
}

function snapshotStream(
	windowId: number,
	sessionId: string,
	target: RuntimeTargetIdentity,
	eventSeq = 1,
): RuntimeStreamEnvelope {
	return {
		kind: "stream",
		streamType: "session-snapshot",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "sidepanel",
		windowId,
		sessionId,
		target,
		revision: 1,
		eventSeq,
		snapshot: snapshot(sessionId, target),
	};
}

function helloStream(
	windowId = 7,
	sessions: RuntimeHelloEnvelope["recovery"]["sessions"] = [],
	runtimeEpoch = "epoch-1",
): RuntimeHelloEnvelope {
	return {
		kind: "stream",
		streamType: "hello",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch,
		clientId: "sidepanel",
		windowId,
		recovery: { mode: "fresh", sessions },
	};
}

interface Harness {
	coordinator: AgentRuntimeCoordinator;
	ensureOffscreen: ReturnType<typeof vi.fn<() => Promise<void>>>;
	sendToOffscreen: ReturnType<typeof vi.fn<(message: BridgeToOffscreenMessage) => Promise<unknown>>>;
	load: ReturnType<typeof vi.fn<() => Promise<OffscreenRuntimeHostState | undefined>>>;
	save: ReturnType<typeof vi.fn<(state: OffscreenRuntimeHostState) => Promise<void>>>;
	pageControl: ReturnType<typeof vi.fn<(message: unknown) => Promise<unknown>>>;
}

function createHarness(overrides: Partial<AgentRuntimeCoordinatorOptions> = {}): Harness {
	const ensureOffscreen = vi.fn<() => Promise<void>>(async () => undefined);
	const load = vi.fn<() => Promise<OffscreenRuntimeHostState | undefined>>(async () => emptyCheckpoint());
	const save = vi.fn<(state: OffscreenRuntimeHostState) => Promise<void>>(async () => undefined);
	const pageControl = vi.fn<(message: unknown) => Promise<unknown>>(async () => ({ ok: true }));
	const sendToOffscreen = vi.fn<(message: BridgeToOffscreenMessage) => Promise<unknown>>(async (message) => {
		if (message.type === "agent-runtime-request") return responseFor(message.request);
		return { ok: true };
	});
	const options: AgentRuntimeCoordinatorOptions = {
		ensureOffscreen,
		sendToOffscreen,
		checkpointStorage: { load, save },
		isSidepanelLeaseCurrent: async () => true,
		handlePageControlMessage: pageControl,
		...overrides,
	};
	return { coordinator: new AgentRuntimeCoordinator(options), ensureOffscreen, sendToOffscreen, load, save, pageControl };
}

async function connect(port: FakePort, value = descriptor()): Promise<void> {
	const previousAcks = port.messages.filter((message) => message.type === "agent-runtime-port-connected").length;
	port.emitMessage({ type: "agent-runtime-port-connect", descriptor: value });
	await vi.waitFor(() => {
		expect(port.messages.filter((message) => message.type === "agent-runtime-port-connected")).toHaveLength(
			previousAcks + 1,
		);
	});
}

	describe("AgentRuntimeCoordinator", () => {
	it("authenticates only the exact live side-panel document and window route before admission", async () => {
		const port = new FakePort("agent-runtime:sidepanel:7");
		const resolveSidepanelLease = vi.fn(async () => authorizedContext());
		const options = {
			extensionId: "extension-id",
			sidepanelUrl: sidepanelBaseUrl,
			sidePanelContextType: "SIDE_PANEL",
			resolveSidepanelLease,
			isSidepanelLeaseCurrent: async () => true,
		};
		const authentication = await authenticateAgentRuntimePort(port, options);
		expect(resolveSidepanelLease).toHaveBeenCalledWith(documentNonce, portCapability, undefined);
		expect(authentication).toEqual(authenticatedPort(port));
		const harness = createHarness();
		expect(authentication && harness.coordinator.acceptPort(port, authentication)).toBe(true);

		const invalidCases: Array<{
			name: string;
			port: FakePort;
			contexts: AgentRuntimeExtensionContext[];
		}> = [
			{
				name: "content script",
				port: new FakePort(
					"agent-runtime:sidepanel:7",
					trustedSender({
						url: "https://example.com/page",
						origin: "https://example.com",
						tab: { id: 4, windowId: 7 },
						frameId: 0,
					}),
				),
				contexts: [sidepanelContext()],
			},
			{
				name: "offscreen document",
				port: new FakePort("agent-runtime:sidepanel:7"),
				contexts: [sidepanelContext({ contextType: "OFFSCREEN_DOCUMENT", windowId: -1 })],
			},
			{
				name: "another extension",
				port: new FakePort(
					"agent-runtime:sidepanel:7",
					trustedSender({
						id: "other-extension",
						url: "chrome-extension://other-extension/sidepanel.html",
						origin: "chrome-extension://other-extension",
					}),
				),
				contexts: [sidepanelContext()],
			},
			{
				name: "unrelated extension page",
				port: new FakePort(
					"agent-runtime:sidepanel:7",
					trustedSender({ url: "chrome-extension://extension-id/settings.html" }),
				),
				contexts: [sidepanelContext({ documentUrl: "chrome-extension://extension-id/settings.html" })],
			},
			{
				name: "sidepanel sender with forged query state",
				port: new FakePort(
					"agent-runtime:sidepanel:7",
					trustedSender({ url: `${sidepanelBaseUrl}?forged=1` }),
				),
				contexts: [sidepanelContext()],
			},
			{
				name: "sidepanel sender with forged fragment state",
				port: new FakePort(
					"agent-runtime:sidepanel:7",
					trustedSender({ url: `${sidepanelBaseUrl}#forged` }),
				),
				contexts: [sidepanelContext()],
			},
			{
				name: "sidepanel sender with duplicated route state",
				port: new FakePort(
					"agent-runtime:sidepanel:7",
					trustedSender({
						url: `${sidepanelBaseUrl}?shuvgeistContext=${documentNonce}&shuvgeistContext=${otherDocumentNonce}`,
					}),
				),
				contexts: [sidepanelContext()],
			},
			{
				name: "sidepanel sender with mismatched optional document id",
				port: new FakePort(
					"agent-runtime:sidepanel:7",
					trustedSender({ documentId: "forged-document" }),
				),
				contexts: [sidepanelContext()],
			},
			{
				name: "sidepanel without document nonce",
				port: new FakePort(
					"agent-runtime:sidepanel:7",
					trustedSender({ url: "chrome-extension://extension-id/sidepanel.html" }),
				),
				contexts: [sidepanelContext({ documentUrl: "chrome-extension://extension-id/sidepanel.html" })],
			},
			{
				name: "mismatched document nonce",
				port: new FakePort("agent-runtime:sidepanel:7"),
				contexts: [
					sidepanelContext({
						documentUrl:
							`${sidepanelBaseUrl}?shuvgeistContext=${otherDocumentNonce}`,
					}),
				],
			},
			{
				name: "mismatched window route",
				port: new FakePort("agent-runtime:sidepanel:7"),
				contexts: [sidepanelContext({ windowId: 8 })],
			},
			{
				name: "ambiguous document contexts",
				port: new FakePort("agent-runtime:sidepanel:7"),
				contexts: [sidepanelContext(), sidepanelContext({ contextId: "duplicate-context" })],
			},
		];

		for (const invalid of invalidCases) {
			const invalidHarness = createHarness();
			const accept = vi.spyOn(invalidHarness.coordinator, "acceptPort");
			const candidate = await authenticateAgentRuntimePort(invalid.port, authenticationOptions(invalid.contexts));
			if (candidate) invalidHarness.coordinator.acceptPort(invalid.port, candidate);
			expect(candidate, invalid.name).toBeUndefined();
			expect(accept, invalid.name).not.toHaveBeenCalled();
		}
	});

	it("authenticates a nonce-bearing port when Chrome freezes the sender URL at the queryless path", async () => {
		const port = new FakePort("agent-runtime:sidepanel:7", trustedSender({ url: sidepanelBaseUrl }));
		const resolveSidepanelLease = vi.fn(async () =>
			authorizedContext(sidepanelContext({ documentUrl: sidepanelDocumentUrl })),
		);

		await expect(
			authenticateAgentRuntimePort(port, {
				extensionId: "extension-id",
				sidepanelUrl: sidepanelBaseUrl,
				sidePanelContextType: "SIDE_PANEL",
				resolveSidepanelLease,
				isSidepanelLeaseCurrent: async () => true,
			}),
		).resolves.toEqual(authenticatedPort(port));
		expect(resolveSidepanelLease).toHaveBeenCalledWith(documentNonce, portCapability, undefined);
	});

	it("authenticates runtime and tracking ports from a canonical committed reload URL with stale route state", async () => {
		const senderUrl = `${sidepanelBaseUrl}?session=${staleSessionId}&shuvgeistContext=${otherDocumentNonce}`;
		const options = authenticationOptions([sidepanelContext({ documentUrl: sidepanelDocumentUrl })]);
		const resolveSidepanelLease = vi.spyOn(options, "resolveSidepanelLease");
		const runtimePort = new FakePort("agent-runtime:sidepanel:7", trustedSender({ url: senderUrl }));
		await expect(authenticateAgentRuntimePort(runtimePort, options)).resolves.toEqual(authenticatedPort(runtimePort));
		expect(resolveSidepanelLease).toHaveBeenCalledWith(documentNonce, portCapability, undefined);

		const trackingPort = new FakePort("sidepanel:7", trustedSender({ url: senderUrl }));
		const registry = new AgentRuntimeSidepanelTrackingRegistry();
		const accepted = vi.fn(() => true);
		expect(
			authenticateAndAcceptSidepanelTrackingPort(
				trackingPort,
				registry,
				{ acceptPort: accepted },
				options,
			),
		).toBe(true);
		await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(1));
		expect(trackingPort.disconnectCalls).toBe(0);
	});

	it("rejects an unbound -1 context and an exact mapped-window mismatch without fallback authority", async () => {
		const runtimePort = new FakePort("agent-runtime:sidepanel:7");
		await expect(
			authenticateAgentRuntimePort(runtimePort, authenticationOptions([sidepanelContext({ windowId: -1 })])),
		).resolves.toBeUndefined();
		await expect(
			authenticateAgentRuntimePort(runtimePort, authenticationOptions([sidepanelContext({ windowId: 8 })])),
		).resolves.toBeUndefined();
	});

	it("authenticates the tracking port itself before registering its claimed route", async () => {
		const registry = new AgentRuntimeSidepanelTrackingRegistry();
		const accept = vi.fn(() => true);
		const unrelatedPage = new FakePort(
			"sidepanel:7",
			trustedSender({ url: "chrome-extension://extension-id/settings.html" }),
		);
		expect(
			authenticateAndAcceptSidepanelTrackingPort(
				unrelatedPage,
				registry,
				{ acceptPort: accept },
				authenticationOptions([sidepanelContext()]),
			),
		).toBe(true);
		expect(unrelatedPage.disconnectCalls).toBe(1);
		expect(accept).not.toHaveBeenCalled();

		const mismatchedWindow = new FakePort("sidepanel:7");
		authenticateAndAcceptSidepanelTrackingPort(
			mismatchedWindow,
			registry,
			{ acceptPort: accept },
			authenticationOptions([sidepanelContext({ windowId: 8 })]),
		);
		await vi.waitFor(() => expect(mismatchedWindow.disconnectCalls).toBe(1));
		expect(accept).not.toHaveBeenCalled();

		const wrongNonce = new FakePort(`sidepanel:7:${otherDocumentNonce}`);
		authenticateAndAcceptSidepanelTrackingPort(
			wrongNonce,
			registry,
			{ acceptPort: accept },
			authenticationOptions([sidepanelContext()]),
		);
		await vi.waitFor(() => expect(wrongNonce.disconnectCalls).toBe(1));
		expect(accept).not.toHaveBeenCalled();

		for (const forgedUrl of [
			`${sidepanelBaseUrl}?forged=1`,
			`${sidepanelBaseUrl}?shuvgeistContext=${documentNonce}&shuvgeistContext=${otherDocumentNonce}`,
			`${sidepanelBaseUrl}#forged`,
		]) {
			const forgedSender = new FakePort("sidepanel:7", trustedSender({ url: forgedUrl }));
			authenticateAndAcceptSidepanelTrackingPort(
				forgedSender,
				registry,
				{ acceptPort: accept },
				authenticationOptions([sidepanelContext()]),
			);
			expect(forgedSender.disconnectCalls, forgedUrl).toBe(1);
		}
		expect(accept).not.toHaveBeenCalled();
	});

	it("installs a replacement lifetime port before disconnecting the superseded one", async () => {
		const registry = new AgentRuntimeSidepanelTrackingRegistry();
		const currentCloses: string[] = [];
		const accept = vi.fn((acceptedPort: AgentRuntimeCoordinatorPort, acceptedLease: AgentRuntimeAuthenticatedPort["lease"]) => {
			acceptedPort.onDisconnect.addListener(() => {
				if (!registry.isCurrent(acceptedPort, acceptedLease)) return;
				currentCloses.push(acceptedLease.leaseId);
				registry.remove(acceptedPort);
			});
			return true;
		});
		const options = authenticationOptions([sidepanelContext()]);
		const first = new FakePort("sidepanel:7");
		const duplicate = new FakePort("sidepanel:7");
		authenticateAndAcceptSidepanelTrackingPort(first, registry, { acceptPort: accept }, options);
		await vi.waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
		authenticateAndAcceptSidepanelTrackingPort(duplicate, registry, { acceptPort: accept }, options);
		await vi.waitFor(() => expect(accept).toHaveBeenCalledTimes(2));
		expect(first.disconnectCalls).toBe(1);
		expect(duplicate.disconnectCalls).toBe(0);
		expect(currentCloses).toEqual([]);
		duplicate.emitDisconnect();
		expect(currentCloses).toEqual([leaseId]);
	});

	it("abandons and bounds lifetime-port admission while the authority join is pending", async () => {
		const registry = new AgentRuntimeSidepanelTrackingRegistry();
		const accepted = vi.fn(() => true);
		const disconnectedContext = deferred<ReturnType<typeof authorizedContext> | undefined>();
		const disconnected = new FakePort("sidepanel:7");
		authenticateAndAcceptSidepanelTrackingPort(
			disconnected,
			registry,
			{ acceptPort: accepted },
			{
				...authenticationOptions([]),
				resolveSidepanelLease: () => disconnectedContext.promise,
			},
		);
		disconnected.emitDisconnect();
		disconnectedContext.resolve(authorizedContext());
		await Promise.resolve();
		await Promise.resolve();
		expect(accepted).not.toHaveBeenCalled();

		const bufferedContext = deferred<ReturnType<typeof authorizedContext> | undefined>();
		const overflow = new FakePort("sidepanel:7");
		authenticateAndAcceptSidepanelTrackingPort(
			overflow,
			registry,
			{ acceptPort: accepted },
			{
				...authenticationOptions([]),
				resolveSidepanelLease: () => bufferedContext.promise,
				maxBufferedMessages: 1,
			},
		);
		overflow.emitMessage({ type: "getLockedSessions" });
		overflow.emitMessage({ type: "getLockedSessions" });
		expect(overflow.disconnectCalls).toBe(1);
		bufferedContext.resolve(authorizedContext());
		await Promise.resolve();
		await Promise.resolve();
		expect(accepted).not.toHaveBeenCalled();
	});

	it("buffers the handshake exactly once while Chrome authenticates the side-panel context", async () => {
		const harness = createHarness();
		const context = deferred<ReturnType<typeof authorizedContext> | undefined>();
		const port = new FakePort("agent-runtime:sidepanel:7");
		expect(
			authenticateAndAcceptAgentRuntimePort(port, harness.coordinator, {
				extensionId: "extension-id",
				sidepanelUrl: "chrome-extension://extension-id/sidepanel.html",
				sidePanelContextType: "SIDE_PANEL",
				resolveSidepanelLease: () => context.promise,
				isSidepanelLeaseCurrent: async () => true,
			}),
		).toBe(true);

		const bufferedRequest = request();
		port.emitMessage({ type: "agent-runtime-port-connect", descriptor: descriptor() });
		port.emitMessage({ type: "agent-runtime-port-request", request: bufferedRequest });
		expect(harness.coordinator.getDescriptor("sidepanel", 7)).toBeUndefined();
		expect(port.messageListenerCount).toBe(1);
		expect(port.disconnectListenerCount).toBe(1);

		context.resolve(authorizedContext());
		await vi.waitFor(() => {
			expect(port.messages).toContainEqual({ type: "agent-runtime-port-connected", ok: true });
			expect(port.messages).toContainEqual({
				type: "agent-runtime-port-response",
				response: responseFor(bufferedRequest),
			});
		});
		expect(harness.coordinator.getDescriptor("sidepanel", 7)).toEqual(descriptor());
		expect(port.messageListenerCount).toBe(1);
		expect(port.disconnectListenerCount).toBe(1);
		expect(
			harness.sendToOffscreen.mock.calls.filter(([message]) => message.type === "agent-runtime-connect"),
		).toHaveLength(1);
		expect(
			harness.sendToOffscreen.mock.calls.filter(([message]) => message.type === "agent-runtime-request"),
		).toHaveLength(1);

		const liveRequest = request(7, "session-7", target7, "request-after-authentication");
		port.emitMessage({ type: "agent-runtime-port-request", request: liveRequest });
		await vi.waitFor(() => {
			expect(port.messages).toContainEqual({
				type: "agent-runtime-port-response",
				response: responseFor(liveRequest),
			});
		});
		expect(
			harness.sendToOffscreen.mock.calls.filter(([message]) => message.type === "agent-runtime-request"),
		).toHaveLength(2);
	});

	it("abandons authentication if the sender disconnects and actively rejects malformed reserved names", async () => {
		const harness = createHarness();
		const context = deferred<ReturnType<typeof authorizedContext> | undefined>();
		const port = new FakePort("agent-runtime:sidepanel:7");
		authenticateAndAcceptAgentRuntimePort(port, harness.coordinator, {
			extensionId: "extension-id",
			sidepanelUrl: "chrome-extension://extension-id/sidepanel.html",
			sidePanelContextType: "SIDE_PANEL",
			resolveSidepanelLease: () => context.promise,
			isSidepanelLeaseCurrent: async () => true,
		});
		port.emitMessage({ type: "agent-runtime-port-connect", descriptor: descriptor() });
		port.emitDisconnect();
		expect(port.messageListenerCount).toBe(0);
		expect(port.disconnectListenerCount).toBe(0);
		context.resolve(authorizedContext());
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.coordinator.getDescriptor("sidepanel", 7)).toBeUndefined();
		expect(harness.sendToOffscreen).not.toHaveBeenCalled();

		const resolveSidepanelLease = vi.fn(async () => authorizedContext());
		const malformed = new FakePort("agent-runtime:sidepanel:07");
		expect(
			authenticateAndAcceptAgentRuntimePort(malformed, harness.coordinator, {
				extensionId: "extension-id",
				sidepanelUrl: "chrome-extension://extension-id/sidepanel.html",
				sidePanelContextType: "SIDE_PANEL",
				resolveSidepanelLease,
				isSidepanelLeaseCurrent: async () => true,
			}),
		).toBe(true);
		expect(malformed.disconnectCalls).toBe(1);
		expect(resolveSidepanelLease).not.toHaveBeenCalled();
	});

	it("rejects a forged authentication scope even for a canonical runtime port", () => {
		const harness = createHarness();
		const port = new FakePort("agent-runtime:sidepanel:7");
		expect(
			harness.coordinator.acceptPort(port, authenticatedPort(port, { windowId: 8 })),
		).toBe(false);
		expect(
			harness.coordinator.acceptPort(
				port,
				authenticatedPort(port, {
					documentUrl:
						"chrome-extension://extension-id/sidepanel.html?shuvgeistContext=00000000-0000-4000-8000-000000000008",
				}),
			),
		).toBe(false);
		expect(
			harness.coordinator.acceptPort(port, authenticatedPort(port, { documentNonce: otherDocumentNonce })),
		).toBe(false);
	});

	it("processes the descriptor buffered while Chrome resolves the side-panel context", async () => {
		const harness = createHarness();
		const port = new FakePort("agent-runtime:sidepanel:7");
		expect(
			harness.coordinator.acceptPort(port, authenticatedPort(port), [
				{ type: "agent-runtime-port-connect", descriptor: descriptor() },
			]),
		).toBe(true);
		await vi.waitFor(() => {
			expect(port.messages).toContainEqual({ type: "agent-runtime-port-connected", ok: true });
		});
		expect(harness.coordinator.getDescriptor("sidepanel", 7)).toEqual(descriptor());
	});

	it("accepts only canonical dedicated port names and rejects unconnected or mismatched identities", async () => {
		const harness = createHarness();
		expect(acceptPort(harness.coordinator, new FakePort("sidepanel:7"))).toBe(false);
		expect(acceptPort(harness.coordinator, new FakePort("agent-runtime:sidepanel:07"))).toBe(false);

		const port = new FakePort("agent-runtime:sidepanel:7");
		expect(acceptPort(harness.coordinator, port)).toBe(true);
		port.emitMessage({ type: "agent-runtime-port-request", request: request() });
		await vi.waitFor(() => {
			expect(port.messages).toContainEqual({
				type: "agent-runtime-port-error",
				requestId: "request-7",
				error: "Agent runtime port is not connected",
			});
		});

		port.emitMessage({
			type: "agent-runtime-port-connect",
			descriptor: { ...descriptor(), clientId: "another-client" },
		});
		await vi.waitFor(() => {
			expect(port.messages).toContainEqual({
				type: "agent-runtime-port-connected",
				ok: false,
				error: "Runtime descriptor does not match the port identity",
			});
		});
		expect(harness.ensureOffscreen).not.toHaveBeenCalled();
	});

	it("rejects missing, extra, noncanonical, and leading-zero port identity fields", () => {
		const uppercaseNonce = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAA7";
		for (const name of [
			"agent-runtime:sidepanel:7",
			`agent-runtime:sidepanel:7:${documentNonce}:extra`,
			`agent-runtime:sidepanel:7:${uppercaseNonce}`,
			`agent-runtime:sidepanel:07:${documentNonce}`,
		]) {
			expect(parseAgentRuntimePortName(name), name).toBeUndefined();
		}
		for (const name of [
			"sidepanel:7",
			`sidepanel:7:${documentNonce}:extra`,
			`sidepanel:7:${uppercaseNonce}`,
			`sidepanel:07:${documentNonce}`,
		]) {
			expect(parseSidepanelTrackingPortName(name), name).toBeUndefined();
		}
	});

	it("initializes from one typed checkpoint and forwards exactly correlated requests and responses", async () => {
		const checkpoint = emptyCheckpoint("epoch-1");
		const harness = createHarness();
		harness.load.mockResolvedValue(checkpoint);
		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		await connect(port);

		expect(harness.ensureOffscreen).toHaveBeenCalledTimes(1);
		expect(harness.load).toHaveBeenCalledTimes(1);
		expect(harness.sendToOffscreen).toHaveBeenNthCalledWith(1, {
			type: "agent-runtime-init",
			state: checkpoint,
		});
		expect(harness.sendToOffscreen).toHaveBeenNthCalledWith(2, {
			type: "agent-runtime-connect",
			descriptor: descriptor(),
		});

		const runtimeRequest = request();
		port.emitMessage({ type: "agent-runtime-port-request", request: runtimeRequest });
		await vi.waitFor(() => {
			expect(port.messages).toContainEqual({
				type: "agent-runtime-port-response",
				response: responseFor(runtimeRequest),
			});
		});
		expect(harness.sendToOffscreen).toHaveBeenNthCalledWith(3, {
			type: "agent-runtime-request",
			request: runtimeRequest,
		});

		port.emitMessage({ type: "agent-runtime-port-connect", descriptor: descriptor() });
		await vi.waitFor(() => {
			expect(port.messages.filter((message) => message.type === "agent-runtime-port-connected")).toHaveLength(2);
		});
		expect(harness.ensureOffscreen).toHaveBeenCalledTimes(1);
		expect(harness.sendToOffscreen).toHaveBeenCalledTimes(3);
	});

	it("retries a failed worker initialization and rejects malformed or uncorrelated responses", async () => {
		const harness = createHarness();
		harness.ensureOffscreen.mockRejectedValueOnce(new Error("offscreen unavailable"));
		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		await connect(port);
		expect(port.messages.at(-1)).toEqual({
			type: "agent-runtime-port-connected",
			ok: false,
			error: "Could not initialize the offscreen runtime: offscreen unavailable",
		});

		await connect(port);
		expect(port.messages.at(-1)).toEqual({ type: "agent-runtime-port-connected", ok: true });
		expect(harness.ensureOffscreen).toHaveBeenCalledTimes(2);

		harness.sendToOffscreen.mockImplementationOnce(async (message) => {
			if (message.type !== "agent-runtime-request") return { ok: true };
			return { ...responseFor(message.request), sessionId: "wrong-session" };
		});
		port.emitMessage({ type: "agent-runtime-port-request", request: request() });
		await vi.waitFor(() => {
			expect(port.messages.at(-1)).toEqual({
				type: "agent-runtime-port-error",
				requestId: "request-7",
				error: "Offscreen runtime response identity mismatch: sessionId",
			});
		});
	});

	it("routes streams only to the exact active window and session while suppressing duplicates", async () => {
		const harness = createHarness();
		const port7 = new FakePort("agent-runtime:sidepanel:7");
		const port8 = new FakePort("agent-runtime:sidepanel:8");
		acceptPort(harness.coordinator, port7);
		acceptPort(harness.coordinator, port8);
		await Promise.all([connect(port7, descriptor(7)), connect(port8, descriptor(8))]);
		port7.messages.length = 0;
		port8.messages.length = 0;

		const hello: RuntimeStreamEnvelope = {
			kind: "stream",
			streamType: "hello",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: "epoch-1",
			clientId: "sidepanel",
			windowId: 7,
			recovery: { mode: "fresh", sessions: [] },
		};
		await harness.coordinator.handleOffscreenMessage({ type: "agent-runtime-host-stream", envelope: hello });
		await harness.coordinator.handleOffscreenMessage({ type: "agent-runtime-host-stream", envelope: hello });
		const session7 = snapshotStream(7, "session-7", target7);
		await harness.coordinator.handleOffscreenMessage({ type: "agent-runtime-host-stream", envelope: session7 });
		await harness.coordinator.handleOffscreenMessage({ type: "agent-runtime-host-stream", envelope: session7 });
		await harness.coordinator.handleOffscreenMessage({
			type: "agent-runtime-host-stream",
			envelope: snapshotStream(7, "wrong-session", target7),
		});
		const hello8 = helloStream(8);
		await harness.coordinator.handleOffscreenMessage({ type: "agent-runtime-host-stream", envelope: hello8 });
		const session8 = snapshotStream(8, "session-8", target8);
		await harness.coordinator.handleOffscreenMessage({ type: "agent-runtime-host-stream", envelope: session8 });

		expect(port7.messages).toEqual([
			{ type: "agent-runtime-port-stream", envelope: hello },
			{ type: "agent-runtime-port-stream", envelope: session7 },
		]);
		expect(port8.messages).toEqual([
			{ type: "agent-runtime-port-stream", envelope: hello8 },
			{ type: "agent-runtime-port-stream", envelope: session8 },
		]);
	});

	it("keeps an accepted descriptor unready until its exact current-epoch snapshot arrives", async () => {
		const readinessChanged = vi.fn<(value: AgentRuntimeConnectionDescriptor, ready: boolean) => void>();
		const harness = createHarness({ onSessionReadinessChanged: readinessChanged });
		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		await connect(port);
		expect(harness.coordinator.getAcceptedDescriptors()).toEqual([descriptor()]);
		expect(harness.coordinator.getReadyDescriptors()).toEqual([]);

		const ready = harness.coordinator.waitForSessionReady(descriptor(), { timeoutMs: 1_000 });
		await harness.coordinator.handleOffscreenMessage({
			type: "agent-runtime-host-stream",
			envelope: helloStream(),
		});
		expect(harness.coordinator.getReadyDescriptors()).toEqual([]);
		const firstSnapshot = snapshotStream(7, "session-7", target7);
		await harness.coordinator.handleOffscreenMessage({
			type: "agent-runtime-host-stream",
			envelope: firstSnapshot,
		});
		await expect(ready).resolves.toEqual(firstSnapshot.snapshot);
		expect(harness.coordinator.getReadyDescriptors()).toEqual([descriptor()]);
		await vi.waitFor(() => expect(readinessChanged).toHaveBeenCalledWith(descriptor(), true));

		await harness.coordinator.handleOffscreenMessage({
			type: "agent-runtime-host-stream",
			envelope: helloStream(7, [], "epoch-2"),
		});
		expect(harness.coordinator.getReadyDescriptors()).toEqual([]);
		await vi.waitFor(() => expect(readinessChanged).toHaveBeenCalledWith(descriptor(), false));

		const currentSnapshot = { ...snapshotStream(7, "session-7", target7, 1), runtimeEpoch: "epoch-2" };
		await harness.coordinator.handleOffscreenMessage({
			type: "agent-runtime-host-stream",
			envelope: currentSnapshot,
		});
		expect(harness.coordinator.getReadyDescriptors()).toEqual([descriptor()]);
		const readinessCallsBeforeStale = readinessChanged.mock.calls.length;
		const staleSnapshot = {
			...snapshotStream(7, "session-7", target7, 99),
			revision: 99,
			snapshot: { ...snapshot("session-7", target7, 99), systemPrompt: "stale epoch" },
		};
		await expect(
			harness.coordinator.handleOffscreenMessage({
				type: "agent-runtime-host-stream",
				envelope: staleSnapshot,
			}),
		).resolves.toEqual({ ok: true, kind: "stream", routed: false });
		expect(harness.coordinator.getLatestSnapshot("sidepanel", 7)).toEqual(currentSnapshot.snapshot);
		expect(harness.coordinator.getReadyDescriptors()).toEqual([descriptor()]);
		expect(readinessChanged).toHaveBeenCalledTimes(readinessCallsBeforeStale);
		expect(port.messages).not.toContainEqual({ type: "agent-runtime-port-stream", envelope: staleSnapshot });
	});

	it("publishes readiness only after the descriptor is durably accepted", async () => {
		const descriptorBound = deferred<void>();
		const streamsDelivered = deferred<void>();
		const readinessObservations: Array<{
			descriptor: AgentRuntimeConnectionDescriptor;
			ready: boolean;
			readyDescriptors: AgentRuntimeConnectionDescriptor[];
		}> = [];
		let coordinator: AgentRuntimeCoordinator | undefined;
		const harness = createHarness({
			onDescriptorBound: () => descriptorBound.promise,
			onSessionReadinessChanged: (value, ready) => {
				readinessObservations.push({
					descriptor: structuredClone(value),
					ready,
					readyDescriptors: coordinator?.getReadyDescriptors() ?? [],
				});
			},
		});
		coordinator = harness.coordinator;
		harness.sendToOffscreen.mockImplementation(async (message) => {
			if (message.type === "agent-runtime-connect") {
				await harness.coordinator.handleOffscreenMessage({
					type: "agent-runtime-host-stream",
					envelope: helloStream(),
				});
				await harness.coordinator.handleOffscreenMessage({
					type: "agent-runtime-host-stream",
					envelope: snapshotStream(7, "session-7", target7),
				});
				streamsDelivered.resolve();
			}
			if (message.type === "agent-runtime-request") return responseFor(message.request);
			return { ok: true };
		});

		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		port.emitMessage({ type: "agent-runtime-port-connect", descriptor: descriptor() });
		await streamsDelivered.promise;

		expect(harness.coordinator.getAcceptedDescriptors()).toEqual([]);
		expect(harness.coordinator.getReadyDescriptors()).toEqual([]);
		expect(readinessObservations).toEqual([]);

		descriptorBound.resolve();
		await vi.waitFor(() => {
			expect(port.messages).toContainEqual({ type: "agent-runtime-port-connected", ok: true });
		});
		expect(readinessObservations).toEqual([
			{
				descriptor: descriptor(),
				ready: true,
				readyDescriptors: [descriptor()],
			},
		]);
	});

	it("does not publish cached readiness when durable descriptor acceptance fails", async () => {
		const readinessChanged = vi.fn<(value: AgentRuntimeConnectionDescriptor, ready: boolean) => void>();
		const harness = createHarness({
			onDescriptorBound: async () => {
				throw new Error("descriptor persistence failed");
			},
			onSessionReadinessChanged: readinessChanged,
		});
		harness.sendToOffscreen.mockImplementation(async (message) => {
			if (message.type === "agent-runtime-connect") {
				await harness.coordinator.handleOffscreenMessage({
					type: "agent-runtime-host-stream",
					envelope: helloStream(),
				});
				await harness.coordinator.handleOffscreenMessage({
					type: "agent-runtime-host-stream",
					envelope: snapshotStream(7, "session-7", target7),
				});
			}
			return { ok: true };
		});

		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		await connect(port);

		expect(port.messages.at(-1)).toEqual({
			type: "agent-runtime-port-connected",
			ok: false,
			error: "Could not connect to the offscreen runtime: descriptor persistence failed",
		});
		expect(harness.coordinator.getAcceptedDescriptors()).toEqual([]);
		expect(harness.coordinator.getReadyDescriptors()).toEqual([]);
		expect(readinessChanged).not.toHaveBeenCalled();
	});

	it("times out a bounded readiness wait and rejects it on replacement", async () => {
		const harness = createHarness();
		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		await connect(port);
		await expect(harness.coordinator.waitForSessionReady(descriptor(), { timeoutMs: 1 })).rejects.toThrow(
			"Timed out waiting for agent runtime session session-7 to become ready",
		);

		await harness.coordinator.handleOffscreenMessage({
			type: "agent-runtime-host-stream",
			envelope: helloStream(),
		});
		const waiting = harness.coordinator.waitForSessionReady(descriptor(), { timeoutMs: 1_000 });
		const replacement = { ...descriptor(7, "replacement-session"), mode: "create" as const };
		await harness.coordinator.replaceSession(replacement, "test-replacement");
		await expect(waiting).rejects.toThrow("session-7 was released before becoming ready");
		expect(harness.coordinator.getReadyDescriptors()).toEqual([]);
	});

	it("rejects outstanding readiness waits when disposed", async () => {
		const harness = createHarness();
		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		await connect(port);
		const waiting = harness.coordinator.waitForSessionReady(descriptor(), { timeoutMs: 1_000 });
		await Promise.resolve();
		await Promise.resolve();
		harness.coordinator.dispose();
		await expect(waiting).rejects.toThrow("disposed before session readiness");
	});

	it("atomically replaces a reconnecting route and cleans it on disconnect", async () => {
		const harness = createHarness();
		const original = new FakePort("agent-runtime:sidepanel:7");
		const replacement = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, original);
		await connect(original);
		original.messages.length = 0;

		acceptPort(harness.coordinator, replacement);
		await connect(replacement);
		expect(original.disconnectCalls).toBe(1);
		await harness.coordinator.handleOffscreenMessage({
			type: "agent-runtime-host-stream",
			envelope: helloStream(),
		});
		const session = snapshotStream(7, "session-7", target7);
		await harness.coordinator.handleOffscreenMessage({ type: "agent-runtime-host-stream", envelope: session });
		expect(original.messages).toEqual([]);
		expect(replacement.messages.at(-1)).toEqual({ type: "agent-runtime-port-stream", envelope: session });

		replacement.emitDisconnect();
		expect(
			await harness.coordinator.handleOffscreenMessage({
				type: "agent-runtime-host-stream",
				envelope: { ...session, eventSeq: 2 },
			}),
		).toEqual({ ok: true, kind: "stream", routed: false });
	});

	it("cannot let a stale transport reconnect undo an atomic bridge descriptor replacement", async () => {
		const bound = vi.fn<(value: AgentRuntimeConnectionDescriptor) => Promise<void>>(async () => undefined);
		const released = vi.fn<(value: AgentRuntimeConnectionDescriptor, reason: string) => Promise<void>>(
			async () => undefined,
		);
		const harness = createHarness({
			onDescriptorBound: bound,
			onDescriptorReleased: released,
			createRequestId: () => "replace-release-request",
		});
		let staleReconnect: FakePort | undefined;
		const oldPort = new FakePort("agent-runtime:sidepanel:7", trustedSender(), () => {
			staleReconnect = new FakePort("agent-runtime:sidepanel:7");
			acceptPort(harness.coordinator, staleReconnect);
			staleReconnect.emitMessage({ type: "agent-runtime-port-connect", descriptor: descriptor() });
		});
		acceptPort(harness.coordinator, oldPort);
		await connect(oldPort);
		await harness.coordinator.handleOffscreenMessage({
			type: "agent-runtime-host-stream",
			envelope: {
				kind: "stream",
				streamType: "hello",
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				runtimeEpoch: "epoch-1",
				clientId: "sidepanel",
				windowId: 7,
				recovery: {
					mode: "resumed",
					sessions: [{ sessionId: "session-7", target: target7, revision: 1, eventSeq: 1 }],
				},
			},
		});
		const nextDescriptor: AgentRuntimeConnectionDescriptor = {
			...descriptor(7, "session-replacement"),
			mode: "create",
		};

		await harness.coordinator.replaceSession(nextDescriptor, "bridge-new-session");
		await vi.waitFor(() => {
			expect(staleReconnect?.messages.at(-1)).toEqual({
				type: "agent-runtime-port-connected",
				ok: false,
				error: "Runtime route is owned by a different agent session",
			});
		});

		expect(harness.coordinator.getDescriptor("sidepanel", 7)).toEqual(nextDescriptor);
		expect(bound).toHaveBeenLastCalledWith(nextDescriptor);
		expect(released).toHaveBeenCalledWith(descriptor(), "bridge-new-session");
		const connectedDescriptors = harness.sendToOffscreen.mock.calls.flatMap(([message]) =>
			message.type === "agent-runtime-connect" ? [message.descriptor] : [],
		);
		expect(connectedDescriptors.filter((value) => value.sessionId === "session-7")).toHaveLength(1);
		expect(connectedDescriptors.at(-1)).toEqual(nextDescriptor);
	});

	it("acknowledges an exact create-descriptor replay without repeating its accepted offscreen side effect", async () => {
		const harness = createHarness();
		const createDescriptor: AgentRuntimeConnectionDescriptor = {
			...descriptor(),
			mode: "create",
			initialMessages: [{ role: "user", content: "hello" }],
		};
		const droppedAckPort = new FakePort("agent-runtime:sidepanel:7");
		droppedAckPort.throwOnConnectedAck = true;
		acceptPort(harness.coordinator, droppedAckPort);
		droppedAckPort.emitMessage({ type: "agent-runtime-port-connect", descriptor: createDescriptor });
		await vi.waitFor(() => {
			expect(
				harness.sendToOffscreen.mock.calls.filter(([message]) => message.type === "agent-runtime-connect"),
			).toHaveLength(1);
		});
		expect(droppedAckPort.messages).toEqual([]);
		const recoveredHello: RuntimeStreamEnvelope = {
			kind: "stream",
			streamType: "hello",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: "epoch-1",
			clientId: "sidepanel",
			windowId: 7,
			recovery: {
				mode: "fresh",
				sessions: [{ sessionId: "session-7", target: target7, revision: 1, eventSeq: 1 }],
			},
		};
		expect(
			await harness.coordinator.handleOffscreenMessage({
				type: "agent-runtime-host-stream",
				envelope: recoveredHello,
			}),
		).toEqual({ ok: true, kind: "stream", routed: false });

		const replayPort = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, replayPort);
		await connect(replayPort, createDescriptor);
		expect(replayPort.messages).toEqual([
			{ type: "agent-runtime-port-connected", ok: true },
			{ type: "agent-runtime-port-stream", envelope: recoveredHello },
		]);
		expect(harness.sendToOffscreen.mock.calls.filter(([message]) => message.type === "agent-runtime-connect")).toHaveLength(
			1,
		);
	});

	it("persists validated checkpoints in arrival order and rejects uncorrelated page controls", async () => {
		const saved: string[] = [];
		const harness = createHarness();
		harness.save.mockImplementation(async (state) => {
			saved.push(state.runtimeEpoch);
		});
		const first = harness.coordinator.handleOffscreenMessage({
			type: "agent-runtime-checkpoint",
			state: emptyCheckpoint("epoch-1"),
		});
		const second = harness.coordinator.handleOffscreenMessage({
			type: "agent-runtime-checkpoint",
			state: emptyCheckpoint("epoch-2"),
		});
		await Promise.all([first, second]);
		expect(saved).toEqual(["epoch-1", "epoch-2"]);
		expect(
			harness.coordinator.handleOffscreenMessage({
				type: "agent-runtime-checkpoint",
				state: { runtimeEpoch: "epoch-bad", sessions: "not-an-array", requests: [] },
			}),
		).toBeUndefined();

		expect(harness.coordinator.handleOffscreenMessage({ type: "agent-runtime-page-cancel", operationId: "operation-1" })).toBeUndefined();
		await expect(harness.coordinator.handleOffscreenMessage(pageCancel())).resolves.toEqual({
			ok: false,
			error: "Privileged page operation does not match an accepted runtime session",
		});
		expect(harness.pageControl).not.toHaveBeenCalled();
	});

	it("authorizes page operations and cancellation only for the exact accepted current parent execution", async () => {
		const harness = createHarness({ createRequestId: () => "parent-request" });
		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		await connect(port);
		await harness.coordinator.handleOffscreenMessage({
			type: "agent-runtime-host-stream",
			envelope: helloStream(),
		});

		const parentResponse = deferred<RuntimeResponseEnvelope>();
		let parentRequest: RuntimeRequestEnvelope | undefined;
		harness.sendToOffscreen.mockImplementation(async (message) => {
			if (message.type === "agent-runtime-request" && message.request.operation.type === "repl-execute") {
				parentRequest = structuredClone(message.request);
				return parentResponse.promise;
			}
			if (message.type === "agent-runtime-request") return responseFor(message.request);
			return { ok: true };
		});
		const pageWork = deferred<unknown>();
		harness.pageControl.mockImplementation(async (message) => {
			if ((message as AgentRuntimePageCancelMessage).type === "agent-runtime-page-cancel") return { ok: true };
			return pageWork.promise;
		});

		const parent = harness.coordinator.requestSession(descriptor(), {
			type: "repl-execute",
			executionId: "parent-execution",
			code: "return browserjs(() => document.title)",
		});
		await vi.waitFor(() => expect(parentRequest).toBeDefined());

		await expect(
			harness.coordinator.handleOffscreenMessage(pageOperation({ runtimeEpoch: "stale-epoch" })),
		).resolves.toEqual({ ok: false, error: "Privileged page operation targets a stale or unknown runtime epoch" });
		await expect(
			harness.coordinator.handleOffscreenMessage(pageOperation({ executionId: "forged-execution" })),
		).resolves.toEqual({
			ok: false,
			error: "Privileged page operation does not match a current parent execution",
		});

		const page = harness.coordinator.handleOffscreenMessage(pageOperation());
		if (!page) throw new Error("page operation was not recognized");
		await vi.waitFor(() => expect(harness.pageControl).toHaveBeenCalledWith(pageOperation()));
		await expect(
			harness.coordinator.handleOffscreenMessage(pageCancel({ operationId: "forged-operation" })),
		).resolves.toEqual({
			ok: false,
			error: "Page cancellation does not match an active authorized operation",
		});
		await expect(harness.coordinator.handleOffscreenMessage(pageCancel())).resolves.toEqual({ ok: true });

		pageWork.resolve({ ok: true, result: "page-result" });
		await expect(page).resolves.toEqual({ ok: true, result: "page-result" });
		if (!parentRequest) throw new Error("parent request was not captured");
		parentResponse.resolve(responseFor(parentRequest));
		await expect(parent).resolves.toEqual({ forwarded: true });
		await expect(harness.coordinator.handleOffscreenMessage(pageOperation())).resolves.toEqual({
			ok: false,
			error: "Privileged page operation does not match a current parent execution",
		});
	});

	it("waits for cold recovery before authorizing an operation from the recovered active snapshot", async () => {
		const offscreenReady = deferred<void>();
		const harness = createHarness({
			ensureOffscreen: () => offscreenReady.promise,
			loadAcceptedDescriptors: async () => [descriptor()],
		});
		harness.sendToOffscreen.mockImplementation(async (message) => {
			if (message.type === "agent-runtime-connect") {
				await harness.coordinator.handleOffscreenMessage({
					type: "agent-runtime-host-stream",
					envelope: helloStream(7, [{ sessionId: "session-7", target: target7, revision: 1, eventSeq: 1 }]),
				});
				return { ok: true };
			}
			if (message.type === "agent-runtime-request") {
				const recovered = snapshotStream(7, "session-7", target7, 2);
				if (recovered.streamType !== "session-snapshot") throw new Error("expected session snapshot");
				recovered.snapshot.activeExecutions = [
					{
						executionId: "parent-execution",
						requestId: "parent-request",
						kind: "repl",
						status: "running",
					},
				];
				await harness.coordinator.handleOffscreenMessage({
					type: "agent-runtime-host-stream",
					envelope: recovered,
				});
				return responseFor(message.request);
			}
			return { ok: true };
		});

		const pending = harness.coordinator.handleOffscreenMessage(pageOperation());
		if (!pending) throw new Error("page operation was not recognized");
		await Promise.resolve();
		expect(harness.pageControl).not.toHaveBeenCalled();
		offscreenReady.resolve();

		await expect(pending).resolves.toEqual({ ok: true });
		expect(harness.pageControl).toHaveBeenCalledWith(pageOperation());
	});

	it("keeps descriptor ownership across panel detach and releases only the exact window", async () => {
		const bound = vi.fn<(value: AgentRuntimeConnectionDescriptor) => Promise<void>>(async () => undefined);
		const released = vi.fn<(value: AgentRuntimeConnectionDescriptor, reason: string) => Promise<void>>(
			async () => undefined,
		);
		const harness = createHarness({
			onDescriptorBound: bound,
			onDescriptorReleased: released,
			createRequestId: () => "release-request",
		});
		const port7 = new FakePort("agent-runtime:sidepanel:7");
		const port8 = new FakePort("agent-runtime:sidepanel:8");
		acceptPort(harness.coordinator, port7);
		acceptPort(harness.coordinator, port8);
		await Promise.all([connect(port7, descriptor(7)), connect(port8, descriptor(8))]);
		expect(bound).toHaveBeenCalledTimes(2);

		const hello7: RuntimeStreamEnvelope = {
			kind: "stream",
			streamType: "hello",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: "epoch-1",
			clientId: "sidepanel",
			windowId: 7,
			recovery: { mode: "resumed", sessions: [] },
		};
		await harness.coordinator.handleOffscreenMessage({ type: "agent-runtime-host-stream", envelope: hello7 });
		port7.emitDisconnect();

		const owned = harness.coordinator.getDescriptor("sidepanel", 7);
		expect(owned).toEqual(descriptor(7));
		if (!owned) throw new Error("missing accepted descriptor");
		owned.systemPrompt = "mutated clone";
		expect(harness.coordinator.getDescriptor("sidepanel", 7)).toEqual(descriptor(7));

		await expect(harness.coordinator.releaseWindow(7, "window-removed")).resolves.toBe(1);
		expect(harness.coordinator.getDescriptor("sidepanel", 7)).toBeUndefined();
		expect(harness.coordinator.getDescriptor("sidepanel", 8)).toEqual(descriptor(8));
		expect(port8.disconnectCalls).toBe(0);
		expect(released).toHaveBeenCalledWith(descriptor(7), "window-removed");
		expect(harness.sendToOffscreen).toHaveBeenCalledWith({
			type: "agent-runtime-request",
			request: {
				kind: "request",
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				runtimeEpoch: "epoch-1",
				clientId: "sidepanel",
				windowId: 7,
				sessionId: "session-7",
				target: target7,
				requestId: "release-request",
				operation: { type: "release", force: true, reason: "window-removed" },
			},
		});
	});

	it("waits for cold worker initialization before releasing a window", async () => {
		const descriptors = deferred<AgentRuntimeConnectionDescriptor[]>();
		const released = vi.fn<(value: AgentRuntimeConnectionDescriptor, reason: string) => Promise<void>>(
			async () => undefined,
		);
		const harness = createHarness({
			loadAcceptedDescriptors: () => descriptors.promise,
			onDescriptorReleased: released,
			createRequestId: () => "cold-release-request",
		});
		harness.sendToOffscreen.mockImplementation(async (message) => {
			if (message.type === "agent-runtime-connect") {
				await harness.coordinator.handleOffscreenMessage({
					type: "agent-runtime-host-stream",
					envelope: helloStream(),
				});
				return { ok: true };
			}
			if (message.type === "agent-runtime-request") return responseFor(message.request);
			return { ok: true };
		});

		const release = harness.coordinator.releaseWindow(7, "cold-window-removed");
		await Promise.resolve();
		expect(released).not.toHaveBeenCalled();
		descriptors.resolve([descriptor()]);

		await expect(release).resolves.toBe(1);
		expect(released).toHaveBeenCalledWith(descriptor(), "cold-window-removed");
		expect(
			harness.sendToOffscreen.mock.calls.some(
				([message]) =>
					message.type === "agent-runtime-request" &&
					message.request.operation.type === "release" &&
					message.request.requestId === "cold-release-request",
			),
		).toBe(true);
		expect(harness.coordinator.getDescriptor("sidepanel", 7)).toBeUndefined();
	});

	it("keeps snapshots and direct session requests available after the panel detaches", async () => {
		const harness = createHarness({ createRequestId: () => "background-request" });
		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		await connect(port);
		await harness.coordinator.handleOffscreenMessage({
			type: "agent-runtime-host-stream",
			envelope: {
				kind: "stream",
				streamType: "hello",
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				runtimeEpoch: "epoch-1",
				clientId: "sidepanel",
				windowId: 7,
				recovery: { mode: "resumed", sessions: [] },
			},
		});
		const session = snapshotStream(7, "session-7", target7);
		await harness.coordinator.handleOffscreenMessage({ type: "agent-runtime-host-stream", envelope: session });
		port.emitDisconnect();

		expect(harness.coordinator.getLatestSnapshot("sidepanel", 7)).toEqual(session.snapshot);
		await expect(
			harness.coordinator.requestSession(descriptor(), { type: "set-thinking", thinkingLevel: "high" }),
		).resolves.toEqual({ forwarded: true });
		expect(harness.sendToOffscreen).toHaveBeenCalledWith({
			type: "agent-runtime-request",
			request: expect.objectContaining({
				requestId: "background-request",
				operation: { type: "set-thinking", thinkingLevel: "high" },
			}),
		});
	});

	it("does not dispatch a direct request aborted during cold initialization", async () => {
		const offscreenReady = deferred<void>();
		const harness = createHarness({
			ensureOffscreen: () => offscreenReady.promise,
			loadAcceptedDescriptors: async () => [descriptor()],
		});
		harness.sendToOffscreen.mockImplementation(async (message) => {
			if (message.type === "agent-runtime-connect") {
				await harness.coordinator.handleOffscreenMessage({
					type: "agent-runtime-host-stream",
					envelope: helloStream(),
				});
				return { ok: true };
			}
			if (message.type === "agent-runtime-request") return responseFor(message.request);
			return { ok: true };
		});
		const abort = new AbortController();
		const pending = harness.coordinator.requestSession(
			descriptor(),
			{ type: "repl-execute", executionId: "direct-repl", code: "return 1" },
			{ signal: abort.signal },
		);
		abort.abort("cancelled during initialization");
		offscreenReady.resolve();

		await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "cancelled during initialization" });
		expect(
			harness.sendToOffscreen.mock.calls.some(
				([message]) =>
					message.type === "agent-runtime-request" && message.request.operation.type === "repl-execute",
			),
		).toBe(false);
	});

	it("dispatches a direct parent request before an immediate abort follow-up", async () => {
		const harness = createHarness({ createRequestId: () => "generated-request" });
		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		await connect(port);
		await harness.coordinator.handleOffscreenMessage({
			type: "agent-runtime-host-stream",
			envelope: helloStream(),
		});
		const abort = new AbortController();
		const operationOrder: string[] = [];
		harness.sendToOffscreen.mockImplementation(async (message) => {
			if (message.type !== "agent-runtime-request") return { ok: true };
			operationOrder.push(message.request.operation.type);
			if (message.request.operation.type === "repl-execute") abort.abort("stop-now");
			return responseFor(message.request);
		});

		await expect(
			harness.coordinator.requestSession(
				descriptor(),
				{ type: "repl-execute", executionId: "direct-repl", code: "return 1" },
				{ signal: abort.signal },
			),
		).resolves.toEqual({ forwarded: true });
		await vi.waitFor(() => expect(operationOrder).toEqual(["repl-execute", "abort"]));
	});

	it("normalizes an absent tracestate before strict direct-response correlation", async () => {
		const harness = createHarness({ createRequestId: () => "trace-normalized-request" });
		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		await connect(port);
		await harness.coordinator.handleOffscreenMessage({
			type: "agent-runtime-host-stream",
			envelope: helloStream(),
		});
		harness.sendToOffscreen.mockImplementation(async (message) => {
			if (message.type !== "agent-runtime-request") return { ok: true };
			const wireRequest = structuredClone(message.request);
			if (wireRequest.trace) delete wireRequest.trace.tracestate;
			return responseFor(wireRequest);
		});

		await expect(
			harness.coordinator.requestSession(
				descriptor(),
				{ type: "repl-execute", executionId: "trace-normalized-execution", code: "return 1" },
				{
					trace: {
						traceId: "a".repeat(32),
						spanId: "b".repeat(16),
						traceFlags: "01",
						tracestate: undefined,
					},
				},
			),
		).resolves.toEqual({ forwarded: true });
		const direct = harness.sendToOffscreen.mock.calls.find(
			([message]) => message.type === "agent-runtime-request" && message.request.operation.type === "repl-execute",
		)?.[0];
		if (!direct || direct.type !== "agent-runtime-request") throw new Error("missing direct request");
		expect(direct.request.trace).toEqual({
			traceId: "a".repeat(32),
			spanId: "b".repeat(16),
			traceFlags: "01",
		});
	});

	it("forgets an accepted descriptor after a client-forwarded release succeeds", async () => {
		const released = vi.fn<(value: AgentRuntimeConnectionDescriptor, reason: string) => Promise<void>>(
			async () => undefined,
		);
		const harness = createHarness({ onDescriptorReleased: released });
		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		await connect(port);
		const release = request();
		release.operation = { type: "release", force: true, reason: "session-switch" };
		port.emitMessage({ type: "agent-runtime-port-request", request: release });
		await vi.waitFor(() => expect(harness.coordinator.getDescriptor("sidepanel", 7)).toBeUndefined());

		expect(port.messages).toContainEqual({
			type: "agent-runtime-port-response",
			response: responseFor(release),
		});
		expect(released).toHaveBeenCalledWith(descriptor(), "session-switch");
	});

	it("does not forget ownership when an explicit release fails", async () => {
		const harness = createHarness({ createRequestId: () => "release-request" });
		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		await connect(port);
		await harness.coordinator.handleOffscreenMessage({
			type: "agent-runtime-host-stream",
			envelope: {
				kind: "stream",
				streamType: "hello",
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				runtimeEpoch: "epoch-1",
				clientId: "sidepanel",
				windowId: 7,
				recovery: { mode: "fresh", sessions: [] },
			},
		});
		harness.sendToOffscreen.mockImplementationOnce(async (message) => {
			if (message.type !== "agent-runtime-request") return { ok: true };
			return {
				kind: "response",
				protocolVersion: message.request.protocolVersion,
				runtimeEpoch: message.request.runtimeEpoch,
				clientId: message.request.clientId,
				windowId: message.request.windowId,
				sessionId: message.request.sessionId,
				target: message.request.target,
				requestId: message.request.requestId,
				operation: message.request.operation.type,
				ok: false,
				error: { code: "SESSION_BUSY", message: "still running", retryable: true },
			};
		});

		await expect(harness.coordinator.releaseSession("sidepanel", 7, "window-removed")).rejects.toThrow(
			"still running",
		);
		expect(harness.coordinator.getDescriptor("sidepanel", 7)).toEqual(descriptor(7));
		expect(port.disconnectCalls).toBe(0);
	});

	it("proactively restores an originally-created accepted session before reconnecting after worker restart", async () => {
		const restoredDescriptor: AgentRuntimeConnectionDescriptor = { ...descriptor(), mode: "create" };
		const recoveredSnapshot: RuntimeSessionSnapshot = {
			...snapshot("session-7", target7, 4),
			model: { provider: "anthropic", id: "restored-model" },
			messages: [{ role: "user", content: "persisted transcript" }],
			artifacts: [
				{
					filename: "report.html",
					mimeType: "text/html",
					size: 42,
					createdAt: "2026-07-22T00:00:00.000Z",
					updatedAt: "2026-07-22T00:00:01.000Z",
				},
			],
		};
		const onBound = vi.fn<(value: AgentRuntimeConnectionDescriptor) => Promise<void>>(async () => undefined);
		const loadAcceptedDescriptors = vi.fn<() => Promise<AgentRuntimeConnectionDescriptor[]>>(async () => [
			restoredDescriptor,
		]);
		const harness = createHarness({ onDescriptorBound: onBound, loadAcceptedDescriptors });
		harness.sendToOffscreen.mockImplementation(async (message) => {
			if (message.type === "agent-runtime-connect") {
				await harness.coordinator.handleOffscreenMessage({
					type: "agent-runtime-host-stream",
					envelope: helloStream(7, [
						{ sessionId: "session-7", target: target7, revision: 4, eventSeq: 2 },
					]),
				});
				return { ok: true };
			}
			if (message.type === "agent-runtime-request") {
				expect(message.request.operation).toEqual({ type: "attach", lastRevision: 4, lastEventSeq: 2 });
				await harness.coordinator.handleOffscreenMessage({
					type: "agent-runtime-host-stream",
					envelope: {
						...snapshotStream(7, "session-7", target7, 3),
						revision: recoveredSnapshot.revision,
						snapshot: recoveredSnapshot,
					},
				});
				return responseFor(message.request);
			}
			return { ok: true };
		});
		await harness.coordinator.initialize();
		await expect(harness.coordinator.waitForSessionReady(restoredDescriptor)).resolves.toEqual(recoveredSnapshot);
		expect(harness.coordinator.getReadyDescriptors()).toEqual([restoredDescriptor]);

		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		await connect(port, restoredDescriptor);

		expect(loadAcceptedDescriptors).toHaveBeenCalledTimes(1);
		expect(onBound).not.toHaveBeenCalled();
		expect(harness.coordinator.getDescriptor("sidepanel", 7)).toEqual(restoredDescriptor);
		expect(harness.sendToOffscreen.mock.calls.filter(([message]) => message.type === "agent-runtime-connect")).toHaveLength(
			1,
		);
		expect(
			harness.sendToOffscreen.mock.calls.filter(
				([message]) => message.type === "agent-runtime-request" && message.request.operation.type === "create",
			),
		).toHaveLength(0);
	});

	it("rechecks the lease after asynchronous admission before handing a port to the coordinator", async () => {
		let current = true;
		const context = deferred<ReturnType<typeof authorizedContext> | undefined>();
		const port = new FakePort("agent-runtime:sidepanel:7");
		const accept = vi.fn(() => true);
		expect(
			authenticateAndAcceptAgentRuntimePort(port, { acceptPort: accept }, {
				extensionId: "extension-id",
				sidepanelUrl: sidepanelBaseUrl,
				sidePanelContextType: "SIDE_PANEL",
				resolveSidepanelLease: () => context.promise,
				isSidepanelLeaseCurrent: async () => current,
			}),
		).toBe(true);
		current = false;
		context.resolve(authorizedContext());
		await vi.waitFor(() => expect(port.disconnectCalls).toBe(1));
		expect(accept).not.toHaveBeenCalled();
	});

	it("completes durable descriptor ownership but suppresses a stale ack when the lease rotates during persistence", async () => {
		let current = true;
		const descriptorBound = deferred<void>();
		const onDescriptorBound = vi.fn(() => descriptorBound.promise);
		const harness = createHarness({
			onDescriptorBound,
			isSidepanelLeaseCurrent: async () => current,
		});
		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		port.emitMessage({ type: "agent-runtime-port-connect", descriptor: descriptor() });
		await vi.waitFor(() => expect(onDescriptorBound).toHaveBeenCalledTimes(1));
		current = false;
		descriptorBound.resolve();
		await vi.waitFor(() => expect(port.disconnectCalls).toBe(1));
		expect(harness.coordinator.getDescriptor("sidepanel", 7)).toEqual(descriptor());
		expect(port.messages).not.toContainEqual({ type: "agent-runtime-port-connected", ok: true });
	});

	it("drops an offscreen response when its presentation lease rotates during dispatch", async () => {
		let current = true;
		const response = deferred<RuntimeResponseEnvelope>();
		const harness = createHarness({ isSidepanelLeaseCurrent: async () => current });
		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		await connect(port);
		const forwarded = request();
		harness.sendToOffscreen.mockImplementation(async (message) => {
			if (message.type === "agent-runtime-request") return response.promise;
			return { ok: true };
		});
		port.emitMessage({ type: "agent-runtime-port-request", request: forwarded });
		await vi.waitFor(() =>
			expect(
				harness.sendToOffscreen.mock.calls.some(
					([message]) => message.type === "agent-runtime-request" && message.request.requestId === forwarded.requestId,
				),
			).toBe(true),
		);
		current = false;
		response.resolve(responseFor(forwarded));
		await vi.waitFor(() => expect(port.disconnectCalls).toBe(1));
		expect(port.messages).not.toContainEqual({ type: "agent-runtime-port-response", response: responseFor(forwarded) });
	});

	it("fences stale stream delivery and keeps a replacement tracking lease current after the old disconnect", async () => {
		let current = true;
		const harness = createHarness({ isSidepanelLeaseCurrent: async () => current });
		const port = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(harness.coordinator, port);
		await connect(port);
		await harness.coordinator.handleOffscreenMessage({ type: "agent-runtime-host-stream", envelope: helloStream() });
		current = false;
		await expect(
			harness.coordinator.handleOffscreenMessage({
				type: "agent-runtime-host-stream",
				envelope: snapshotStream(7, "session-7", target7),
			}),
		).resolves.toEqual({ ok: true, kind: "stream", routed: false });
		expect(port.disconnectCalls).toBe(1);

		const registry = new AgentRuntimeSidepanelTrackingRegistry();
		const oldPort = new FakePort("sidepanel:7");
		const newPort = new FakePort("sidepanel:7");
		const oldLease = authenticatedPort(new FakePort("agent-runtime:sidepanel:7")).lease;
		const newLease = { ...oldLease, transactionId: capabilityIdForCoordinator(18), leaseId: capabilityIdForCoordinator(28) };
		expect(registry.install(oldPort, oldLease)).toBe(true);
		expect(registry.install(newPort, newLease)).toBe(true);
		registry.remove(oldPort);
		expect(registry.isCurrent(newPort, newLease)).toBe(true);
	});

	it("reinitializes idempotently after a service-worker restart", async () => {
		const ensureOffscreen = vi.fn<() => Promise<void>>(async () => undefined);
		const load = vi.fn<() => Promise<OffscreenRuntimeHostState | undefined>>(async () => emptyCheckpoint());
		const save = vi.fn<(state: OffscreenRuntimeHostState) => Promise<void>>(async () => undefined);
		const sendToOffscreen = vi.fn<(message: BridgeToOffscreenMessage) => Promise<unknown>>(async () => ({ ok: true }));
		const options: AgentRuntimeCoordinatorOptions = {
			ensureOffscreen,
			sendToOffscreen,
			checkpointStorage: { load, save },
			isSidepanelLeaseCurrent: async () => true,
		};

		const firstWorker = new AgentRuntimeCoordinator(options);
		const firstPort = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(firstWorker, firstPort);
		await connect(firstPort);
		firstWorker.dispose();

		const restartedWorker = new AgentRuntimeCoordinator(options);
		const restartedPort = new FakePort("agent-runtime:sidepanel:7");
		acceptPort(restartedWorker, restartedPort);
		await connect(restartedPort);

		expect(ensureOffscreen).toHaveBeenCalledTimes(2);
		expect(load).toHaveBeenCalledTimes(2);
		expect(sendToOffscreen.mock.calls.filter(([message]) => message.type === "agent-runtime-init")).toHaveLength(2);
		expect(restartedPort.messages.at(-1)).toEqual({ type: "agent-runtime-port-connected", ok: true });
	});
});
