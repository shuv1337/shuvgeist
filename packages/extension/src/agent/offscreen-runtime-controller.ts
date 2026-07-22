import type {
	AgentRuntimeAbortIntent,
	AgentRuntimeCheckpointMessage,
	AgentRuntimeConnectionDescriptor,
	AgentRuntimeHostStreamMessage,
	AgentRuntimePageCancelMessage,
	AgentRuntimePageOperationMessage,
} from "../bridge/internal-messages.js";
import {
	type OffscreenPrivilegedPageOperationTransport,
	OffscreenRuntimeHost,
	type OffscreenRuntimeHostOptions,
	type OffscreenRuntimeHostState,
	type OffscreenRuntimeOperationContext,
} from "./offscreen-runtime-host.js";
import { correlateRuntimeResponse } from "./runtime-channel.js";
import { runtimeClientRouteKey, sameRuntimeTarget as sameTarget } from "./runtime-identity.js";
import {
	isRuntimeRequestEnvelope,
	isRuntimeResponseEnvelope,
	isRuntimeStreamEnvelope,
	isRuntimeWireValue,
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeRequestEnvelope,
	type RuntimeResponseEnvelope,
	type RuntimeStreamEnvelope,
	type RuntimeTargetIdentity,
	type RuntimeValue,
} from "./runtime-protocol.js";

type PageOperationName = AgentRuntimePageOperationMessage["operation"];
type ControllerOutboundMessage =
	| AgentRuntimeHostStreamMessage
	| AgentRuntimeCheckpointMessage
	| AgentRuntimePageOperationMessage
	| AgentRuntimePageCancelMessage;

export type AgentRuntimePageOperationResponse = { ok: true; result: RuntimeValue } | { ok: false; error: string };

export interface OffscreenRuntimeControllerHost {
	readonly runtimeEpoch: string;
	handle(request: RuntimeRequestEnvelope): Promise<RuntimeResponseEnvelope>;
	emitHello(
		clientId: string,
		windowId: number,
		mode?: "fresh" | "resumed" | "restarted",
		previousRuntimeEpoch?: string,
	): RuntimeStreamEnvelope;
	exportState(): OffscreenRuntimeHostState;
	restoreState(state: OffscreenRuntimeHostState): Promise<void>;
	dispose(): Promise<void>;
}

export interface OffscreenRuntimeControllerOptions
	extends Pick<OffscreenRuntimeHostOptions, "sessionFactory" | "artifacts" | "repl" | "promptPreparation" | "now"> {
	sendToBackground(message: ControllerOutboundMessage): Promise<unknown>;
	runtimeEpoch?: string;
	createId?: () => string;
	checkpointDelayMs?: number;
	checkpointRetryDelayMs?: number;
	maxCompletedRequests?: number;
	createHost?: (options: OffscreenRuntimeHostOptions) => OffscreenRuntimeControllerHost;
	reportError?(error: unknown, context: string): void;
}

export type OffscreenRuntimeControllerResult =
	| { ok: true; kind: "init"; initialized: boolean; runtimeEpoch: string }
	| {
			ok: true;
			kind: "connect";
			runtimeEpoch: string;
			recoveryMode: "fresh" | "resumed" | "restarted";
	  }
	| RuntimeResponseEnvelope;

interface PendingPageOperation {
	cancel(reason: string): void;
}

export type OffscreenToolPageOperationContext = Omit<OffscreenRuntimeOperationContext, "session" | "executionId"> & {
	executionId: string;
};

type PageOperationContext = Omit<OffscreenRuntimeOperationContext, "session">;

const PAGE_OPERATIONS: readonly PageOperationName[] = [
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message;
	const message = String(error);
	return message.trim() ? message : "Unknown offscreen runtime error";
}

function abortError(reason: string): Error {
	const error = new Error(reason);
	error.name = "AbortError";
	return error;
}

function cloneWireValue<T>(value: T, label: string): T {
	if (!isRuntimeWireValue(value)) throw new Error(`${label} is not plain runtime data`);
	return structuredClone(value);
}

function routeKey(clientId: string, windowId: number): string {
	return runtimeClientRouteKey(clientId, windowId);
}

function sessionIdentityKey(clientId: string, windowId: number, sessionId: string): string {
	return JSON.stringify([clientId, windowId, sessionId]);
}

function isCheckpointState(value: unknown): value is OffscreenRuntimeHostState {
	return (
		isPlainRecord(value) &&
		isRuntimeWireValue(value) &&
		nonEmptyString(value.runtimeEpoch) &&
		Array.isArray(value.sessions) &&
		Array.isArray(value.requests)
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

function isConnectionDescriptor(value: unknown): value is AgentRuntimeConnectionDescriptor {
	if (!isPlainRecord(value) || !isRuntimeWireValue(value)) return false;
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
	if (
		!nonEmptyString(value.clientId) ||
		!Number.isSafeInteger(value.windowId) ||
		(value.windowId as number) < 0 ||
		!nonEmptyString(value.sessionId) ||
		(value.mode !== "create" && value.mode !== "load") ||
		typeof value.systemPrompt !== "string"
	) {
		return false;
	}
	return isRuntimeRequestEnvelope(descriptorValidationRequest(value as unknown as AgentRuntimeConnectionDescriptor));
}

function isAbortIntent(value: unknown): value is AgentRuntimeAbortIntent {
	if (!isPlainRecord(value) || !isRuntimeWireValue(value)) return false;
	if (
		!hasOnlyKeys(value, ["clientId", "windowId", "sessionId", "target", "executionId", "targetRequestId", "reason"])
	) {
		return false;
	}
	return (
		nonEmptyString(value.clientId) &&
		Number.isSafeInteger(value.windowId) &&
		(value.windowId as number) >= 0 &&
		nonEmptyString(value.sessionId) &&
		nonEmptyString(value.executionId) &&
		nonEmptyString(value.targetRequestId) &&
		nonEmptyString(value.reason)
	);
}

function pageOperationResponse(value: unknown): AgentRuntimePageOperationResponse | undefined {
	if (!isPlainRecord(value) || !isRuntimeWireValue(value)) return undefined;
	if (value.ok === true && hasOnlyKeys(value, ["ok", "result"]) && "result" in value) {
		return value as unknown as AgentRuntimePageOperationResponse;
	}
	if (value.ok === false && hasOnlyKeys(value, ["ok", "error"]) && nonEmptyString(value.error)) {
		return value as unknown as AgentRuntimePageOperationResponse;
	}
	return undefined;
}

function negativeAcknowledgement(value: unknown): string | undefined {
	if (!isPlainRecord(value) || value.ok !== false) return undefined;
	return nonEmptyString(value.error) ? value.error : "Background rejected the runtime message";
}

function defaultId(): string {
	return globalThis.crypto.randomUUID();
}

/**
 * Owns the offscreen host lifecycle and the only privileged-page transport the
 * host or its tools may use. Chrome listeners remain outside this class so the
 * protocol can be tested without browser globals.
 */
export class OffscreenRuntimeController {
	readonly runtimeEpoch: string;
	readonly pageOperations: OffscreenPrivilegedPageOperationTransport;

	private readonly host: OffscreenRuntimeControllerHost;
	private readonly sendToBackground: (message: ControllerOutboundMessage) => Promise<unknown>;
	private readonly createId: () => string;
	private readonly checkpointDelayMs: number;
	private readonly checkpointRetryDelayMs: number;
	private readonly reportError?: (error: unknown, context: string) => void;
	private readonly restoredRoutes = new Set<string>();
	private readonly connectedRoutes = new Set<string>();
	private readonly knownSessionTargets = new Map<string, RuntimeTargetIdentity>();
	private readonly pendingPageOperations = new Map<string, PendingPageOperation>();
	private streamTail: Promise<void> = Promise.resolve();
	private checkpointTail: Promise<void> = Promise.resolve();
	private checkpointTimer?: ReturnType<typeof globalThis.setTimeout>;
	private checkpointGeneration = 0;
	private checkpointDirty = false;
	private initialization?: Promise<OffscreenRuntimeControllerResult>;
	private initialized = false;
	private previousRuntimeEpoch?: string;
	private disposePromise?: Promise<void>;
	private disposed = false;

	constructor(options: OffscreenRuntimeControllerOptions) {
		this.sendToBackground = options.sendToBackground;
		this.createId = options.createId ?? defaultId;
		this.checkpointDelayMs = options.checkpointDelayMs ?? 200;
		this.checkpointRetryDelayMs = options.checkpointRetryDelayMs ?? 1_000;
		this.reportError = options.reportError;
		if (!Number.isSafeInteger(this.checkpointDelayMs) || this.checkpointDelayMs < 0) {
			throw new Error("checkpointDelayMs must be a non-negative safe integer");
		}
		if (!Number.isSafeInteger(this.checkpointRetryDelayMs) || this.checkpointRetryDelayMs < 0) {
			throw new Error("checkpointRetryDelayMs must be a non-negative safe integer");
		}
		this.runtimeEpoch = options.runtimeEpoch ?? this.uniqueId("runtime epoch");
		if (!this.runtimeEpoch.trim()) throw new Error("runtimeEpoch must be non-empty");
		this.pageOperations = {
			execute: (operation, params, context) => this.executePageOperation(operation, params, context),
		};
		const createHost = options.createHost ?? ((hostOptions) => new OffscreenRuntimeHost(hostOptions));
		this.host = createHost({
			runtimeEpoch: this.runtimeEpoch,
			sessionFactory: options.sessionFactory,
			emit: (envelope) => this.enqueueStream(envelope),
			onStateChanged: () => this.markCheckpointDirty(),
			maxCompletedRequests: options.maxCompletedRequests,
			...(options.artifacts ? { artifacts: options.artifacts } : {}),
			...(options.repl ? { repl: options.repl } : {}),
			...(options.promptPreparation ? { promptPreparation: options.promptPreparation } : {}),
			pageOperations: this.pageOperations,
			...(options.now ? { now: options.now } : {}),
		});
		if (this.host.runtimeEpoch !== this.runtimeEpoch) {
			throw new Error("Offscreen runtime host epoch does not match its controller");
		}
	}

	handleMessage(message: unknown): Promise<OffscreenRuntimeControllerResult> | undefined {
		if (!isPlainRecord(message) || typeof message.type !== "string") return undefined;
		if (message.type === "agent-runtime-init") return this.handleInitMessage(message);
		if (message.type === "agent-runtime-connect") return this.handleConnectMessage(message);
		if (message.type === "agent-runtime-request") return this.handleRequestMessage(message);
		if (message.type === "agent-runtime-abort-intent") return this.handleAbortIntentMessage(message);
		return undefined;
	}

	dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		this.disposePromise = this.performDispose();
		return this.disposePromise;
	}

	executeToolPageOperation(
		operation: PageOperationName,
		params: { [key: string]: RuntimeValue },
		context: OffscreenToolPageOperationContext,
	): Promise<RuntimeValue> {
		this.assertReady();
		return this.executePageOperation(operation, params, {
			runtimeEpoch: context.runtimeEpoch,
			clientId: context.clientId,
			windowId: context.windowId,
			sessionId: context.sessionId,
			target: context.target,
			requestId: context.requestId,
			executionId: context.executionId,
			...(context.trace ? { trace: context.trace } : {}),
			signal: context.signal,
		});
	}

	private handleInitMessage(message: Record<string, unknown>): Promise<OffscreenRuntimeControllerResult> {
		if (!hasOnlyKeys(message, ["type", "state"])) return Promise.reject(new Error("Malformed runtime init message"));
		if ("state" in message && !isCheckpointState(message.state)) {
			return Promise.reject(new Error("Malformed runtime checkpoint"));
		}
		if (this.disposed) return Promise.reject(new Error("Offscreen runtime controller is disposed"));
		if (this.initialized) {
			return Promise.resolve({
				ok: true,
				kind: "init",
				initialized: false,
				runtimeEpoch: this.runtimeEpoch,
			});
		}
		if (this.initialization) return this.initialization;
		const state =
			"state" in message && isCheckpointState(message.state)
				? cloneWireValue(message.state, "Runtime checkpoint")
				: undefined;
		const initialization = (async (): Promise<OffscreenRuntimeControllerResult> => {
			if (state) {
				await this.host.restoreState(state);
				this.previousRuntimeEpoch = state.runtimeEpoch;
				for (const session of state.sessions) {
					this.restoredRoutes.add(routeKey(session.clientId, session.windowId));
					this.knownSessionTargets.set(
						sessionIdentityKey(session.clientId, session.windowId, session.sessionId),
						cloneWireValue(session.target, "Restored session target"),
					);
				}
			}
			this.initialized = true;
			if (state) this.markCheckpointDirty();
			return { ok: true, kind: "init", initialized: true, runtimeEpoch: this.runtimeEpoch };
		})();
		this.initialization = initialization;
		void initialization.catch(() => {
			if (this.initialization === initialization) this.initialization = undefined;
		});
		return initialization;
	}

	private async handleConnectMessage(message: Record<string, unknown>): Promise<OffscreenRuntimeControllerResult> {
		if (!hasOnlyKeys(message, ["type", "descriptor"]) || !isConnectionDescriptor(message.descriptor)) {
			throw new Error("Malformed runtime connection descriptor");
		}
		this.assertReady();
		const descriptor = cloneWireValue(message.descriptor, "Runtime connection descriptor");
		const sessionKey = sessionIdentityKey(descriptor.clientId, descriptor.windowId, descriptor.sessionId);
		const knownTarget = this.knownSessionTargets.get(sessionKey);
		if (knownTarget && !sameTarget(knownTarget, descriptor.target)) {
			throw new Error("Runtime connection target does not match the existing session");
		}
		const key = routeKey(descriptor.clientId, descriptor.windowId);
		const recoveryMode = this.connectedRoutes.has(key)
			? "resumed"
			: this.restoredRoutes.has(key) && this.previousRuntimeEpoch !== undefined
				? "restarted"
				: "fresh";
		this.connectedRoutes.add(key);
		this.host.emitHello(
			descriptor.clientId,
			descriptor.windowId,
			recoveryMode,
			recoveryMode === "restarted" ? this.previousRuntimeEpoch : undefined,
		);
		await this.streamTail;
		return { ok: true, kind: "connect", runtimeEpoch: this.runtimeEpoch, recoveryMode };
	}

	private handleRequestMessage(message: Record<string, unknown>): Promise<OffscreenRuntimeControllerResult> {
		if (!hasOnlyKeys(message, ["type", "request"]) || !isRuntimeRequestEnvelope(message.request)) {
			return Promise.reject(new Error("Malformed runtime request message"));
		}
		return this.forwardRequest(message.request);
	}

	private handleAbortIntentMessage(message: Record<string, unknown>): Promise<OffscreenRuntimeControllerResult> {
		if (!hasOnlyKeys(message, ["type", "intent"]) || !isAbortIntent(message.intent)) {
			return Promise.reject(new Error("Malformed runtime abort intent"));
		}
		this.assertReady();
		const intent = cloneWireValue(message.intent, "Runtime abort intent");
		const request: RuntimeRequestEnvelope = {
			kind: "request",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: this.runtimeEpoch,
			clientId: intent.clientId,
			windowId: intent.windowId,
			sessionId: intent.sessionId,
			target: intent.target,
			requestId: this.uniqueId("abort request"),
			operation: {
				type: "abort",
				executionId: intent.executionId,
				targetRequestId: intent.targetRequestId,
				reason: intent.reason,
			},
		};
		if (!isRuntimeRequestEnvelope(request)) return Promise.reject(new Error("Runtime abort intent is invalid"));
		return this.forwardRequest(request);
	}

	private async forwardRequest(requestValue: RuntimeRequestEnvelope): Promise<RuntimeResponseEnvelope> {
		this.assertReady();
		const request = cloneWireValue(requestValue, "Runtime request");
		const responseValue = await this.host.handle(request);
		if (!isRuntimeResponseEnvelope(responseValue)) throw new Error("Runtime host returned a malformed response");
		const response = cloneWireValue(responseValue, "Runtime response");
		const correlation = correlateRuntimeResponse(request, response);
		if (!correlation.ok) {
			throw new Error(`Runtime host response identity mismatch: ${correlation.mismatches.join(", ")}`);
		}
		if (response.ok) {
			const key = sessionIdentityKey(request.clientId, request.windowId, request.sessionId);
			if (request.operation.type === "release") this.knownSessionTargets.delete(key);
			else this.knownSessionTargets.set(key, cloneWireValue(request.target, "Runtime session target"));
		}
		const terminalStreamTail = this.streamTail;
		await terminalStreamTail;
		this.markCheckpointDirty();
		return response;
	}

	private enqueueStream(envelopeValue: RuntimeStreamEnvelope): void {
		if (this.disposed) return;
		if (!isRuntimeStreamEnvelope(envelopeValue)) throw new Error("Runtime host emitted a malformed stream");
		const envelope = cloneWireValue(envelopeValue, "Runtime stream");
		const delivery = this.streamTail
			.catch(() => undefined)
			.then(async () => {
				const acknowledgement = await this.sendToBackground({ type: "agent-runtime-host-stream", envelope });
				const rejection = negativeAcknowledgement(acknowledgement);
				if (rejection) throw new Error(rejection);
			});
		this.streamTail = delivery;
		void delivery.catch((error: unknown) => this.report(error, "stream-forward"));
	}

	private markCheckpointDirty(): void {
		if (this.disposed || !this.initialized) return;
		this.checkpointDirty = true;
		this.checkpointGeneration++;
		this.armCheckpoint(this.checkpointDelayMs);
	}

	private armCheckpoint(delayMs: number): void {
		if (this.disposed || !this.checkpointDirty) return;
		if (this.checkpointTimer !== undefined) globalThis.clearTimeout(this.checkpointTimer);
		this.checkpointTimer = globalThis.setTimeout(() => {
			this.checkpointTimer = undefined;
			const checkpoint = this.checkpointTail.catch(() => undefined).then(() => this.flushCheckpoint());
			this.checkpointTail = checkpoint;
			void checkpoint.catch((error: unknown) => this.report(error, "checkpoint"));
		}, delayMs);
	}

	private async flushCheckpoint(): Promise<void> {
		if (this.disposed || !this.checkpointDirty) return;
		const generation = this.checkpointGeneration;
		let state: OffscreenRuntimeHostState;
		try {
			state = this.host.exportState();
			cloneWireValue(state, "Runtime checkpoint");
		} catch (error) {
			this.report(error, "checkpoint-export");
			this.armCheckpoint(this.checkpointRetryDelayMs);
			return;
		}
		await this.streamTail.catch(() => undefined);
		try {
			const acknowledgement = await this.sendToBackground({
				type: "agent-runtime-checkpoint",
				state: cloneWireValue(state, "Runtime checkpoint"),
			});
			const rejection = negativeAcknowledgement(acknowledgement);
			if (rejection) throw new Error(rejection);
		} catch (error) {
			this.report(error, "checkpoint-save");
			this.armCheckpoint(this.checkpointRetryDelayMs);
			return;
		}
		if (generation === this.checkpointGeneration) this.checkpointDirty = false;
		else this.armCheckpoint(this.checkpointDelayMs);
	}

	private executePageOperation(
		operation: string,
		params: { [key: string]: RuntimeValue },
		context: PageOperationContext,
	): Promise<RuntimeValue> {
		this.assertReady();
		if (!PAGE_OPERATIONS.includes(operation as PageOperationName)) {
			return Promise.reject(new Error(`Unsupported privileged page operation: ${operation}`));
		}
		if (!context.executionId) return Promise.reject(new Error("Privileged page operation has no parent execution"));
		const executionId = context.executionId;
		if (!isRuntimeWireValue(params))
			return Promise.reject(new Error("Page operation payload is not plain runtime data"));
		const operationId = this.uniquePageOperationId();
		const message: AgentRuntimePageOperationMessage = {
			type: "agent-runtime-page-operation",
			operationId,
			runtimeEpoch: context.runtimeEpoch,
			clientId: context.clientId,
			windowId: context.windowId,
			sessionId: context.sessionId,
			target: cloneWireValue(context.target, "Page operation target"),
			operation: operation as PageOperationName,
			payload: cloneWireValue(params, "Page operation payload"),
			...(context.trace ? { trace: cloneWireValue(context.trace, "Page operation trace") } : {}),
			executionId,
			executionRequestId: context.requestId,
		};

		return new Promise<RuntimeValue>((resolve, reject) => {
			let settled = false;
			let dispatched = false;
			const cleanup = (): void => {
				context.signal.removeEventListener("abort", cancelForAbort);
				this.pendingPageOperations.delete(operationId);
			};
			const settle = (work: () => void): void => {
				if (settled) return;
				settled = true;
				cleanup();
				work();
			};
			const cancel = (reason: string): void => {
				if (settled) return;
				const shouldCancelBackground = dispatched;
				settle(() => reject(abortError(reason)));
				if (shouldCancelBackground) {
					void Promise.resolve()
						.then(() =>
							this.sendToBackground({
								type: "agent-runtime-page-cancel",
								operationId,
								runtimeEpoch: context.runtimeEpoch,
								clientId: context.clientId,
								windowId: context.windowId,
								sessionId: context.sessionId,
								target: cloneWireValue(context.target, "Page operation cancel target"),
								executionId,
								executionRequestId: context.requestId,
							}),
						)
						.catch((error: unknown) => {
							this.report(error, "page-operation-cancel");
						});
				}
			};
			const cancelForAbort = (): void => cancel(errorMessage(context.signal.reason || "Page operation aborted"));
			this.pendingPageOperations.set(operationId, { cancel });
			if (context.signal.aborted) {
				cancelForAbort();
				return;
			}
			context.signal.addEventListener("abort", cancelForAbort, { once: true });
			void Promise.resolve()
				.then(async () => {
					if (settled) return undefined;
					dispatched = true;
					return this.sendToBackground(message);
				})
				.then((responseValue) => {
					if (settled) return;
					const response = pageOperationResponse(responseValue);
					if (!response) {
						settle(() => reject(new Error("Background returned a malformed page operation response")));
						return;
					}
					if (!response.ok) {
						settle(() => reject(new Error(response.error)));
						return;
					}
					settle(() => resolve(cloneWireValue(response.result, "Page operation result")));
				})
				.catch((error: unknown) => {
					if (!settled) settle(() => reject(error));
				});
		});
	}

	private uniquePageOperationId(): string {
		for (let attempt = 0; attempt < 16; attempt++) {
			const candidate = this.uniqueId("page operation");
			if (!this.pendingPageOperations.has(candidate)) return candidate;
		}
		throw new Error("Could not allocate a unique page operation id");
	}

	private uniqueId(label: string): string {
		const value = this.createId();
		if (!nonEmptyString(value)) throw new Error(`${label} id must be non-empty`);
		return value;
	}

	private assertReady(): void {
		if (this.disposed) throw new Error("Offscreen runtime controller is disposed");
		if (!this.initialized) throw new Error("Offscreen runtime controller is not initialized");
	}

	private async performDispose(): Promise<void> {
		this.disposed = true;
		if (this.checkpointTimer !== undefined) {
			globalThis.clearTimeout(this.checkpointTimer);
			this.checkpointTimer = undefined;
		}
		for (const operation of [...this.pendingPageOperations.values()]) {
			operation.cancel("Offscreen runtime controller disposed");
		}
		await this.host.dispose();
		await Promise.allSettled([this.streamTail, this.checkpointTail]);
		this.pendingPageOperations.clear();
		this.connectedRoutes.clear();
		this.restoredRoutes.clear();
		this.knownSessionTargets.clear();
	}

	private report(error: unknown, context: string): void {
		this.reportError?.(error, context);
	}
}
