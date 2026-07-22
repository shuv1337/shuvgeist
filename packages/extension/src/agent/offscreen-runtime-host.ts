import {
	correlateRuntimeResponse,
	executionReferenceFor,
	type RuntimeLedgerCancelResult,
	RuntimeRequestLedger,
	type RuntimeRequestLedgerEntry,
} from "./runtime-channel.js";
import { canonicalRuntimeValue as canonical, sameRuntimeTarget as sameTarget } from "./runtime-identity.js";
import {
	isRuntimeRequestEnvelope,
	isRuntimeResponseEnvelope,
	isRuntimeStreamEnvelope,
	isRuntimeWireValue,
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeAgentEvent,
	type RuntimeAgentMessage,
	type RuntimeArtifactsPayload,
	type RuntimeErrorDescriptor,
	type RuntimeExecutionDescriptor,
	type RuntimeModelDescriptor,
	type RuntimeRequestEnvelope,
	type RuntimeResponseEnvelope,
	type RuntimeSessionSnapshot,
	type RuntimeStreamEnvelope,
	type RuntimeTargetIdentity,
	type RuntimeThinkingLevel,
	type RuntimeTraceContext,
	type RuntimeValue,
} from "./runtime-protocol.js";

export type OffscreenRuntimeSessionState = Omit<
	RuntimeSessionSnapshot,
	"sessionId" | "target" | "revision" | "activeExecutions"
>;

export interface OffscreenRuntimeSessionAdapter {
	getState(): OffscreenRuntimeSessionState;
	subscribe(listener: (event: RuntimeAgentEvent) => void): () => void;
	prompt(message: RuntimeAgentMessage, context: OffscreenRuntimeOperationContext): Promise<void>;
	abort?(executionId: string): Promise<void> | void;
	setModel(model: RuntimeModelDescriptor, signal: AbortSignal): Promise<void> | void;
	setThinkingLevel(thinkingLevel: RuntimeThinkingLevel, signal: AbortSignal): Promise<void> | void;
	steer(message: RuntimeAgentMessage, signal: AbortSignal): Promise<void> | void;
	replaceOrAppendMessage(
		message: RuntimeAgentMessage,
		messageIndex: number | undefined,
		signal: AbortSignal,
	): Promise<void> | void;
	dispose?(): Promise<void> | void;
}

export interface OffscreenRuntimeSessionScope {
	clientId: string;
	windowId: number;
	sessionId: string;
	target: RuntimeTargetIdentity;
}

export interface OffscreenRuntimeCreateSessionInput extends OffscreenRuntimeSessionScope {
	systemPrompt: string;
	model?: RuntimeModelDescriptor;
	thinkingLevel?: RuntimeThinkingLevel;
	initialMessages?: RuntimeAgentMessage[];
	signal: AbortSignal;
}

export interface OffscreenRuntimeLoadSessionInput extends OffscreenRuntimeSessionScope {
	signal: AbortSignal;
}

export interface OffscreenRuntimeRestoreSessionInput extends OffscreenRuntimeSessionScope {
	snapshot: RuntimeSessionSnapshot;
	signal: AbortSignal;
}

export interface OffscreenRuntimeSessionFactory {
	create(input: OffscreenRuntimeCreateSessionInput): Promise<OffscreenRuntimeSessionAdapter>;
	load(input: OffscreenRuntimeLoadSessionInput): Promise<OffscreenRuntimeSessionAdapter>;
	restore?(input: OffscreenRuntimeRestoreSessionInput): Promise<OffscreenRuntimeSessionAdapter>;
}

export interface OffscreenRuntimeOperationContext extends OffscreenRuntimeSessionScope {
	runtimeEpoch: string;
	requestId: string;
	executionId?: string;
	trace?: RuntimeTraceContext;
	signal: AbortSignal;
	session: OffscreenRuntimeSessionAdapter;
}

export interface OffscreenRuntimeArtifactsDelegate {
	execute(payload: RuntimeArtifactsPayload, context: OffscreenRuntimeOperationContext): Promise<RuntimeValue>;
}

export interface OffscreenRuntimeReplDelegate {
	execute(code: string, context: OffscreenRuntimeOperationContext): Promise<RuntimeValue>;
}

export interface OffscreenRuntimePromptPreparationDelegate {
	prepare(context: OffscreenRuntimeOperationContext): Promise<RuntimeAgentMessage | undefined>;
}

export interface OffscreenPrivilegedPageOperationTransport {
	execute(
		operation: string,
		params: { [key: string]: RuntimeValue },
		context: OffscreenRuntimeOperationContext,
	): Promise<RuntimeValue>;
}

export interface OffscreenRuntimeHostOptions {
	runtimeEpoch: string;
	sessionFactory: OffscreenRuntimeSessionFactory;
	emit(envelope: RuntimeStreamEnvelope): void;
	/** Called after durable host state changes. Errors are isolated from runtime work. */
	onStateChanged?(): void;
	/** Number of completed requests retained for idempotent replay. Defaults to 256. */
	maxCompletedRequests?: number;
	artifacts?: OffscreenRuntimeArtifactsDelegate;
	repl?: OffscreenRuntimeReplDelegate;
	promptPreparation?: OffscreenRuntimePromptPreparationDelegate;
	pageOperations?: OffscreenPrivilegedPageOperationTransport;
	now?: () => number;
}

export interface OffscreenRuntimePersistedSession extends OffscreenRuntimeSessionScope {
	revision: number;
	eventSeq: number;
	snapshot: RuntimeSessionSnapshot;
}

export interface OffscreenRuntimeHostState {
	runtimeEpoch: string;
	sessions: OffscreenRuntimePersistedSession[];
	requests: OffscreenRuntimePersistedRequest[];
}

export interface OffscreenRuntimePersistedRequest {
	request: RuntimeRequestEnvelope;
	response?: RuntimeResponseEnvelope;
}

interface ActiveExecution {
	descriptor: RuntimeExecutionDescriptor;
	controller: AbortController;
	trace?: RuntimeTraceContext;
}

interface HostSessionRecord extends OffscreenRuntimeSessionScope {
	adapter: OffscreenRuntimeSessionAdapter;
	revision: number;
	eventSeq: number;
	activeExecutions: Map<string, ActiveExecution>;
	activePromptExecutionId?: string;
	mutationTail: Promise<void>;
	pendingMutationCount: number;
	initializing: boolean;
	unsubscribe: () => void;
}

interface RestoredSessionResult {
	session: HostSessionRecord;
	orphaned: RuntimeExecutionDescriptor[];
}

class OffscreenRuntimeHostError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable = false,
		readonly details?: RuntimeValue,
	) {
		super(message);
		this.name = "OffscreenRuntimeHostError";
	}
}

function sessionKey(scope: Pick<OffscreenRuntimeSessionScope, "clientId" | "windowId" | "sessionId">): string {
	return JSON.stringify([scope.clientId, scope.windowId, scope.sessionId]);
}

function requestKey(request: RuntimeRequestEnvelope): string {
	return JSON.stringify([request.clientId, request.windowId, request.sessionId, request.requestId]);
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.trim() ? message : "Unknown runtime error";
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
	return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function isAbortRequest(request: RuntimeRequestEnvelope): request is RuntimeRequestEnvelope & {
	operation: Extract<RuntimeRequestEnvelope["operation"], { type: "abort" }>;
} {
	return request.operation.type === "abort";
}

function cloneWireValue<T>(value: T, label: string): T {
	if (!isRuntimeWireValue(value)) {
		throw new OffscreenRuntimeHostError("NON_SERIALIZABLE_STATE", `${label} is not plain runtime data`);
	}
	return structuredClone(value);
}

function assertSnapshotProtocol(
	scope: OffscreenRuntimeSessionScope,
	runtimeEpoch: string,
	eventSeq: number,
	snapshot: RuntimeSessionSnapshot,
): void {
	const envelope = {
		kind: "stream",
		streamType: "session-snapshot",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch,
		clientId: scope.clientId,
		windowId: scope.windowId,
		sessionId: scope.sessionId,
		target: scope.target,
		revision: snapshot.revision,
		eventSeq: Math.max(1, eventSeq),
		snapshot,
	};
	if (!isRuntimeStreamEnvelope(envelope) || !sameTarget(scope.target, snapshot.target)) {
		throw new OffscreenRuntimeHostError("INVALID_SESSION_STATE", "Session snapshot violates the runtime protocol");
	}
}

function cleanupResult(cleanup: () => Promise<void> | void): Promise<void> {
	try {
		return Promise.resolve(cleanup());
	} catch (error) {
		return Promise.reject(error);
	}
}

export class OffscreenRuntimeHost {
	readonly runtimeEpoch: string;

	private readonly sessionFactory: OffscreenRuntimeSessionFactory;
	private readonly emitEnvelope: (envelope: RuntimeStreamEnvelope) => void;
	private readonly artifacts?: OffscreenRuntimeArtifactsDelegate;
	private readonly repl?: OffscreenRuntimeReplDelegate;
	private readonly promptPreparation?: OffscreenRuntimePromptPreparationDelegate;
	private readonly pageOperations?: OffscreenPrivilegedPageOperationTransport;
	private readonly now: () => number;
	private readonly onStateChanged?: () => void;
	private readonly maxCompletedRequests: number;
	private readonly ledgers = new Map<string, RuntimeRequestLedger>();
	private readonly sessions = new Map<string, HostSessionRecord>();
	private readonly inFlightRequests = new Map<string, Promise<RuntimeResponseEnvelope>>();
	private readonly responseCache = new Map<string, RuntimeResponseEnvelope>();
	private readonly requestHistory = new Map<string, RuntimeRequestEnvelope>();
	private readonly requestControllers = new Map<string, AbortController>();
	private readonly completedRequestKeys: string[] = [];
	private readonly sessionAcquisitions = new Map<string, Promise<void>>();
	private readonly restoreControllers = new Set<AbortController>();
	private readonly restoreTasks = new Set<Promise<unknown>>();
	private readonly restoreDirtySessions = new Set<HostSessionRecord>();
	private restoreEmissionBuffer?: RuntimeStreamEnvelope[];
	private restoredFromRuntimeEpoch?: string;
	private restoreInProgress = false;
	private disposePromise?: Promise<void>;
	private disposed = false;

	constructor(options: OffscreenRuntimeHostOptions) {
		if (!options.runtimeEpoch.trim()) throw new Error("runtimeEpoch must be non-empty");
		this.runtimeEpoch = options.runtimeEpoch;
		this.sessionFactory = options.sessionFactory;
		this.emitEnvelope = options.emit;
		this.artifacts = options.artifacts;
		this.repl = options.repl;
		this.promptPreparation = options.promptPreparation;
		this.pageOperations = options.pageOperations;
		this.now = options.now ?? Date.now;
		this.onStateChanged = options.onStateChanged;
		this.maxCompletedRequests = options.maxCompletedRequests ?? 256;
		if (!Number.isSafeInteger(this.maxCompletedRequests) || this.maxCompletedRequests < 1) {
			throw new Error("maxCompletedRequests must be a positive safe integer");
		}
	}

	handle(request: RuntimeRequestEnvelope): Promise<RuntimeResponseEnvelope> {
		if (!isRuntimeRequestEnvelope(request)) {
			try {
				const response = this.errorResponse(
					request,
					"MALFORMED_REQUEST",
					"Runtime request is not valid plain wire data",
				);
				if (isRuntimeResponseEnvelope(response)) return Promise.resolve(response);
			} catch {
				// A malformed base cannot support a correlated response.
			}
			return Promise.reject(
				new OffscreenRuntimeHostError("MALFORMED_REQUEST", "Runtime request envelope is invalid"),
			);
		}
		const ownedRequest = cloneWireValue(request, "Runtime request");
		if (this.disposed)
			return Promise.resolve(this.errorResponse(ownedRequest, "HOST_DISPOSED", "Runtime host is disposed"));
		const key = requestKey(ownedRequest);
		if (this.restoreInProgress) {
			const restoredRequest = this.requestHistory.get(key);
			const restoredResponse = this.responseCache.get(key);
			if (
				restoredRequest &&
				restoredResponse &&
				canonical(restoredRequest as unknown as RuntimeValue) === canonical(ownedRequest as unknown as RuntimeValue)
			) {
				return Promise.resolve(cloneWireValue(restoredResponse, "Cached runtime response"));
			}
			return Promise.resolve(
				this.errorResponse(ownedRequest, "HOST_RESTORING", "Runtime host is restoring persisted state", true),
			);
		}
		if (isAbortRequest(ownedRequest)) return this.handleAbort(ownedRequest);

		const ledger = this.ledgerFor(ownedRequest);
		const begun = ledger.begin(ownedRequest);
		if (begun.kind === "duplicate") {
			const duplicateInFlight = this.inFlightRequests.get(key);
			if (duplicateInFlight) return duplicateInFlight;
			const duplicateCached = this.responseCache.get(key);
			if (duplicateCached) return Promise.resolve(cloneWireValue(duplicateCached, "Cached runtime response"));
			return Promise.resolve(
				this.errorResponse(ownedRequest, "DUPLICATE_INCOMPLETE", "Duplicate request has no result"),
			);
		}
		if (begun.kind === "stale-epoch") {
			return Promise.resolve(
				this.errorResponse(ownedRequest, "STALE_RUNTIME_EPOCH", "Request targets a stale runtime epoch", false, {
					expectedRuntimeEpoch: begun.expectedRuntimeEpoch,
					receivedRuntimeEpoch: begun.receivedRuntimeEpoch,
				}),
			);
		}
		if (begun.kind === "request-conflict") {
			return Promise.resolve(
				this.errorResponse(ownedRequest, "REQUEST_ID_CONFLICT", "Request id was reused with different data"),
			);
		}
		if (begun.kind === "execution-conflict") {
			return Promise.resolve(
				this.errorResponse(
					ownedRequest,
					"EXECUTION_ID_CONFLICT",
					"Execution id is already owned by another request",
				),
			);
		}

		const controller = new AbortController();
		this.requestHistory.set(key, ownedRequest);
		this.requestControllers.set(key, controller);
		const processing = Promise.resolve()
			.then(() => this.processAccepted(ownedRequest, begun.entry, controller))
			.catch((error: unknown) => this.errorFromUnknown(ownedRequest, error))
			.then((response) => {
				if (!this.disposed) this.responseCache.set(key, cloneWireValue(response, "Cached runtime response"));
				return cloneWireValue(response, "Runtime response");
			})
			.finally(() => {
				this.inFlightRequests.delete(key);
				this.requestControllers.delete(key);
				this.rememberCompletedRequest(key);
			});
		this.inFlightRequests.set(key, processing);
		return processing;
	}

	emitHello(
		clientId: string,
		windowId: number,
		mode: "fresh" | "resumed" | "restarted" = "fresh",
		previousRuntimeEpoch = this.restoredFromRuntimeEpoch,
		trace?: RuntimeTraceContext,
	): RuntimeStreamEnvelope {
		if (this.restoreInProgress) throw new Error("Runtime hello cannot be emitted while state is restoring");
		if (mode === "restarted" && !previousRuntimeEpoch) {
			throw new Error("A restarted hello requires the previous runtime epoch");
		}
		const envelope: RuntimeStreamEnvelope = {
			kind: "stream",
			streamType: "hello",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: this.runtimeEpoch,
			clientId,
			windowId,
			...(trace ? { trace } : {}),
			recovery: {
				mode,
				...(previousRuntimeEpoch ? { previousRuntimeEpoch } : {}),
				sessions: [...this.sessions.values()]
					.filter((session) => session.clientId === clientId && session.windowId === windowId)
					.map((session) => ({
						sessionId: session.sessionId,
						target: session.target,
						revision: session.revision,
						eventSeq: session.eventSeq,
					})),
			},
		};
		this.emit(envelope);
		return cloneWireValue(envelope, "Runtime hello envelope");
	}

	exportState(): OffscreenRuntimeHostState {
		if (this.restoreInProgress) throw new Error("Runtime state cannot be exported while restoration is in progress");
		if ([...this.sessions.values()].some((session) => session.pendingMutationCount > 0)) {
			throw new Error("Runtime state cannot be exported while a session mutation is pending");
		}
		const state: OffscreenRuntimeHostState = {
			runtimeEpoch: this.runtimeEpoch,
			sessions: [...this.sessions.values()].map((session) => ({
				clientId: session.clientId,
				windowId: session.windowId,
				sessionId: session.sessionId,
				target: session.target,
				revision: session.revision,
				eventSeq: session.eventSeq,
				snapshot: this.snapshot(session),
			})),
			requests: [...this.requestHistory.entries()].map(([key, request]) => ({
				request: cloneWireValue(request, "Persisted request"),
				...(this.responseCache.has(key)
					? { response: cloneWireValue(this.responseCache.get(key), "Persisted response") }
					: {}),
			})),
		};
		return cloneWireValue(state, "Runtime host state");
	}

	async restoreState(state: OffscreenRuntimeHostState): Promise<void> {
		if (this.disposed) throw new Error("Runtime host is disposed");
		if (this.restoreInProgress) throw new Error("Runtime state restoration is already in progress");
		if (this.inFlightRequests.size > 0 || this.sessionAcquisitions.size > 0) {
			throw new Error("Runtime state cannot be restored while requests are active");
		}
		if (this.sessions.size > 0) throw new Error("Runtime state can only be restored into an empty host");
		if (!this.sessionFactory.restore) throw new Error("Session factory does not support restore");
		this.restoreEmissionBuffer = [];
		this.restoreDirtySessions.clear();
		this.restoreInProgress = true;
		const priorRequestHistory = new Map(this.requestHistory);
		const priorResponseCache = new Map(this.responseCache);
		const priorLedgers = new Map(this.ledgers);
		const priorCompletedRequestKeys = this.completedRequestKeys.slice();
		const priorRestoredFromRuntimeEpoch = this.restoredFromRuntimeEpoch;
		const restored: RestoredSessionResult[] = [];
		let committedEmissions: RuntimeStreamEnvelope[] | undefined;
		try {
			const ownedState = cloneWireValue(state, "Runtime host state");
			this.validateRestoreState(ownedState);
			this.responseCache.clear();
			this.requestHistory.clear();
			this.ledgers.clear();
			this.completedRequestKeys.length = 0;
			const preserveSequence = ownedState.runtimeEpoch === this.runtimeEpoch;
			for (const persisted of ownedState.sessions) {
				const controller = new AbortController();
				this.restoreControllers.add(controller);
				const restore = this.restoreSession(persisted, controller, preserveSequence);
				this.restoreTasks.add(restore);
				try {
					restored.push(await restore);
				} finally {
					this.restoreControllers.delete(controller);
					this.restoreTasks.delete(restore);
				}
			}
			if (preserveSequence) this.restoreRequestHistory(ownedState.requests);
			for (const result of restored) this.settleRestoredExecutions(result);
			for (const session of this.restoreDirtySessions) {
				if (this.sessions.get(sessionKey(session)) !== session) continue;
				session.revision++;
				this.emitSnapshot(session);
			}
			this.restoredFromRuntimeEpoch = ownedState.runtimeEpoch;
			committedEmissions = this.restoreEmissionBuffer?.slice() ?? [];
		} catch (error) {
			await this.rollbackRestoredState();
			if (!this.disposed) {
				for (const [key, request] of priorRequestHistory) this.requestHistory.set(key, request);
				for (const [key, response] of priorResponseCache) this.responseCache.set(key, response);
				for (const [key, ledger] of priorLedgers) this.ledgers.set(key, ledger);
				this.completedRequestKeys.push(...priorCompletedRequestKeys);
				this.restoredFromRuntimeEpoch = priorRestoredFromRuntimeEpoch;
			}
			throw error;
		} finally {
			this.restoreInProgress = false;
			this.restoreEmissionBuffer = undefined;
			this.restoreDirtySessions.clear();
		}
		for (const envelope of committedEmissions ?? []) this.emit(envelope);
		this.notifyStateChanged();
	}

	dispose(): Promise<void> {
		if (this.disposePromise) return this.disposePromise;
		let resolveDisposal: () => void = () => {};
		let rejectDisposal: (error: unknown) => void = () => {};
		this.disposePromise = new Promise<void>((resolve, reject) => {
			resolveDisposal = resolve;
			rejectDisposal = reject;
		});
		void this.performDispose().then(resolveDisposal, rejectDisposal);
		return this.disposePromise;
	}

	private async performDispose(): Promise<void> {
		this.disposed = true;
		for (const controller of this.requestControllers.values()) controller.abort("runtime-host-disposed");
		for (const controller of this.restoreControllers) controller.abort("runtime-host-disposed");
		const disposals: Array<Promise<void>> = [];
		for (const session of this.sessions.values()) {
			disposals.push(cleanupResult(session.unsubscribe));
			for (const active of session.activeExecutions.values()) active.controller.abort("runtime-host-disposed");
			if (session.adapter.dispose) disposals.push(cleanupResult(() => session.adapter.dispose?.()));
		}
		this.sessions.clear();
		this.requestControllers.clear();
		this.inFlightRequests.clear();
		this.responseCache.clear();
		this.requestHistory.clear();
		this.completedRequestKeys.length = 0;
		await Promise.allSettled([...this.sessionAcquisitions.values(), ...this.restoreTasks]);
		for (const session of this.sessions.values()) {
			disposals.push(cleanupResult(session.unsubscribe));
			for (const active of session.activeExecutions.values()) active.controller.abort("runtime-host-disposed");
			if (session.adapter.dispose) disposals.push(cleanupResult(() => session.adapter.dispose?.()));
		}
		this.sessions.clear();
		this.sessionAcquisitions.clear();
		this.restoreControllers.clear();
		this.restoreTasks.clear();
		await Promise.allSettled(disposals);
	}

	private async processAccepted(
		request: RuntimeRequestEnvelope,
		entry: RuntimeRequestLedgerEntry,
		controller: AbortController,
	): Promise<RuntimeResponseEnvelope> {
		const cancelledBeforePreflight = this.cancelledBeforePreflight(request, entry);
		if (cancelledBeforePreflight) return cancelledBeforePreflight;
		try {
			this.assertRequestActive(controller.signal);
			switch (request.operation.type) {
				case "attach": {
					const session = this.requireSession(request);
					await session.mutationTail;
					this.assertRequestActive(controller.signal);
					this.assertSessionPublished(session);
					this.emitSnapshot(session, request.trace);
					this.assertRequestActive(controller.signal);
					return this.successResponse(request, { attached: true, revision: session.revision });
				}
				case "create": {
					const operation = request.operation;
					const session = await this.withSessionAcquisition(request, async () => {
						this.assertAcquisitionActive(controller.signal);
						if (this.sessions.has(sessionKey(request))) {
							throw new OffscreenRuntimeHostError("SESSION_EXISTS", "Session already exists");
						}
						const adapter = await this.sessionFactory.create({
							clientId: request.clientId,
							windowId: request.windowId,
							sessionId: request.sessionId,
							target: cloneWireValue(request.target, "Session target"),
							systemPrompt: operation.systemPrompt,
							model: operation.model ? cloneWireValue(operation.model, "Initial model") : undefined,
							thinkingLevel: operation.thinkingLevel,
							initialMessages: operation.initialMessages
								? cloneWireValue(operation.initialMessages, "Initial messages")
								: undefined,
							signal: controller.signal,
						});
						await this.assertAdapterAcquisitionActive(adapter, controller.signal);
						return this.addSession(adapter, request, 1, 0, controller.signal);
					});
					this.assertRequestActive(controller.signal);
					this.assertSessionPublished(session);
					try {
						this.emitSnapshot(session, request.trace);
					} catch (error) {
						await this.removeSession(session);
						throw error;
					}
					this.assertRequestActive(controller.signal);
					this.assertSessionPublished(session);
					return this.successResponse(request, { created: true, revision: session.revision });
				}
				case "load": {
					const loaded = await this.withSessionAcquisition(request, async () => {
						this.assertAcquisitionActive(controller.signal);
						const existing = this.sessions.get(sessionKey(request));
						if (existing && !sameTarget(existing.target, request.target)) {
							throw new OffscreenRuntimeHostError("TARGET_MISMATCH", "Session target does not match");
						}
						if (existing) return { session: existing, acquired: false };
						const adapter = await this.sessionFactory.load({
							clientId: request.clientId,
							windowId: request.windowId,
							sessionId: request.sessionId,
							target: cloneWireValue(request.target, "Session target"),
							signal: controller.signal,
						});
						await this.assertAdapterAcquisitionActive(adapter, controller.signal);
						return {
							session: await this.addSession(adapter, request, 0, 0, controller.signal),
							acquired: true,
						};
					});
					const { session } = loaded;
					await session.mutationTail;
					this.assertRequestActive(controller.signal);
					this.assertSessionPublished(session);
					try {
						this.emitSnapshot(session, request.trace);
					} catch (error) {
						if (loaded.acquired) await this.removeSession(session);
						throw error;
					}
					this.assertRequestActive(controller.signal);
					this.assertSessionPublished(session);
					return this.successResponse(request, { loaded: true, revision: session.revision });
				}
				case "prompt": {
					const operation = request.operation;
					const session = this.requireSession(request);
					if (session.activePromptExecutionId) {
						return this.rejectExecution(request, entry, session, "SESSION_BUSY", "A prompt is already active");
					}
					session.activePromptExecutionId = operation.executionId;
					return this.executeLongRequest(request, entry, session, controller, "prompt", async (context) => {
						if (this.promptPreparation) {
							const preparedMessage = await this.promptPreparation.prepare(context);
							if (preparedMessage) {
								await this.withSessionMutation(session, async () => {
									this.assertRequestActive(context.signal);
									this.assertSessionPublished(session);
									await session.adapter.replaceOrAppendMessage(
										cloneWireValue(preparedMessage, "Prepared prompt context"),
										undefined,
										context.signal,
									);
									this.assertRequestActive(context.signal);
									this.assertSessionPublished(session);
									session.revision++;
									this.emitSnapshot(session, request.trace);
								});
							}
						}
						await session.adapter.prompt(cloneWireValue(operation.message, "Prompt message"), context);
						await this.withSessionMutation(session, () => {
							this.assertRequestActive(context.signal);
							this.assertSessionPublished(session);
							session.revision++;
						});
						return { completed: true, executionId: operation.executionId };
					});
				}
				case "set-model": {
					const operation = request.operation;
					const session = this.requireSession(request);
					await this.withSessionMutation(session, async () => {
						this.assertRequestActive(controller.signal);
						this.assertSessionPublished(session);
						await session.adapter.setModel(cloneWireValue(operation.model, "Model update"), controller.signal);
						this.assertRequestActive(controller.signal);
						this.assertSessionPublished(session);
						session.revision++;
						this.emitSnapshot(session, request.trace);
						this.assertRequestActive(controller.signal);
						this.assertSessionPublished(session);
					});
					return this.successResponse(request, { updated: true });
				}
				case "set-thinking": {
					const operation = request.operation;
					const session = this.requireSession(request);
					await this.withSessionMutation(session, async () => {
						this.assertRequestActive(controller.signal);
						this.assertSessionPublished(session);
						await session.adapter.setThinkingLevel(operation.thinkingLevel, controller.signal);
						this.assertRequestActive(controller.signal);
						this.assertSessionPublished(session);
						session.revision++;
						this.emitSnapshot(session, request.trace);
						this.assertRequestActive(controller.signal);
						this.assertSessionPublished(session);
					});
					return this.successResponse(request, { thinkingLevel: operation.thinkingLevel });
				}
				case "steer": {
					const operation = request.operation;
					const session = this.requireSession(request);
					await this.withSessionMutation(session, async () => {
						this.assertRequestActive(controller.signal);
						this.assertSessionPublished(session);
						await session.adapter.steer(cloneWireValue(operation.message, "Steering message"), controller.signal);
						this.assertRequestActive(controller.signal);
						this.assertSessionPublished(session);
						session.revision++;
						this.emitSnapshot(session, request.trace);
						this.assertRequestActive(controller.signal);
						this.assertSessionPublished(session);
					});
					return this.successResponse(request, { queued: true, revision: session.revision });
				}
				case "replace-or-append-message": {
					const operation = request.operation;
					const session = this.requireSession(request);
					await this.withSessionMutation(session, async () => {
						this.assertRequestActive(controller.signal);
						this.assertSessionPublished(session);
						if (operation.expectedRevision !== session.revision) {
							throw new OffscreenRuntimeHostError("REVISION_CONFLICT", "Session revision changed", true, {
								expectedRevision: operation.expectedRevision,
								actualRevision: session.revision,
							});
						}
						await session.adapter.replaceOrAppendMessage(
							cloneWireValue(operation.message, "Message update"),
							operation.messageIndex,
							controller.signal,
						);
						this.assertRequestActive(controller.signal);
						this.assertSessionPublished(session);
						session.revision++;
						this.emitSnapshot(session, request.trace);
						this.assertRequestActive(controller.signal);
						this.assertSessionPublished(session);
					});
					return this.successResponse(request, { revision: session.revision });
				}
				case "artifacts": {
					const operation = request.operation;
					const session = this.requireSession(request);
					if (!this.artifacts)
						throw new OffscreenRuntimeHostError("UNSUPPORTED", "Artifacts delegate is unavailable");
					const mutates = operation.payload.action === "put" || operation.payload.action === "delete";
					const executeArtifacts = async (): Promise<RuntimeValue> => {
						this.assertRequestActive(controller.signal);
						this.assertSessionPublished(session);
						const result = await this.artifacts?.execute(
							cloneWireValue(operation.payload, "Artifacts payload"),
							this.operationContext(request, session, controller.signal),
						);
						this.assertRequestActive(controller.signal);
						this.assertSessionPublished(session);
						if (result === undefined) {
							throw new OffscreenRuntimeHostError("UNSUPPORTED", "Artifacts delegate is unavailable");
						}
						if (mutates) {
							session.revision++;
							this.emitSnapshot(session, request.trace);
							this.assertRequestActive(controller.signal);
							this.assertSessionPublished(session);
						}
						return result;
					};
					const result = mutates
						? await this.withSessionMutation(session, executeArtifacts)
						: await executeArtifacts();
					return this.successResponse(request, result);
				}
				case "release": {
					const session = this.requireSession(request);
					if (session.activeExecutions.size > 0 && request.operation.force !== true) {
						throw new OffscreenRuntimeHostError("SESSION_BUSY", "Session still owns active executions", true);
					}
					await session.mutationTail;
					this.assertRequestActive(controller.signal);
					this.assertSessionPublished(session);
					await this.removeSession(session);
					return this.successResponse(request, {
						released: true,
						...(request.operation.reason ? { reason: request.operation.reason } : {}),
					});
				}
				case "repl-execute": {
					const operation = request.operation;
					const session = this.requireSession(request);
					const repl = this.repl;
					if (!repl) throw new OffscreenRuntimeHostError("UNSUPPORTED", "REPL delegate is unavailable");
					return this.executeLongRequest(request, entry, session, controller, "repl", (context) =>
						repl.execute(operation.code, context),
					);
				}
				case "page-operation": {
					const operation = request.operation;
					const session = this.requireSession(request);
					const pageOperations = this.pageOperations;
					if (!pageOperations) {
						throw new OffscreenRuntimeHostError(
							"UNSUPPORTED",
							"Privileged page operation transport is unavailable",
						);
					}
					return this.executeLongRequest(request, entry, session, controller, "page-operation", (context) =>
						pageOperations.execute(
							operation.operation,
							cloneWireValue(operation.params, "Page operation params"),
							context,
						),
					);
				}
				case "resync": {
					const session = this.requireSession(request);
					await session.mutationTail;
					this.assertRequestActive(controller.signal);
					this.assertSessionPublished(session);
					this.emitSnapshot(session, request.trace);
					this.assertRequestActive(controller.signal);
					this.assertSessionPublished(session);
					return this.successResponse(request, {
						resynced: true,
						revision: session.revision,
						eventSeq: session.eventSeq,
					});
				}
				case "abort":
					throw new OffscreenRuntimeHostError("INTERNAL", "Abort must use the cancellation path");
			}
		} catch (error) {
			const failure = isAbortError(error, controller.signal)
				? new OffscreenRuntimeHostError("ABORTED", "Runtime operation was aborted")
				: error;
			return this.failAcceptedRequest(request, entry, failure);
		}
	}

	private cancelledBeforePreflight(
		request: RuntimeRequestEnvelope,
		entry: RuntimeRequestLedgerEntry,
	): RuntimeResponseEnvelope | undefined {
		const reference = executionReferenceFor(entry);
		if (!reference || entry.status !== "cancelled") return undefined;
		const error: RuntimeErrorDescriptor = {
			code: "ABORTED",
			message: "Execution was cancelled before it started",
			retryable: false,
		};
		const session = this.sessions.get(sessionKey(request));
		if (session && sameTarget(session.target, request.target)) {
			if (session.activePromptExecutionId === reference.executionId) session.activePromptExecutionId = undefined;
			session.activeExecutions.delete(reference.executionId);
			this.emitExecution(
				session,
				{
					executionId: reference.executionId,
					requestId: reference.requestId,
					kind: entry.executionKind ?? "prompt",
					status: "cancelled",
					finishedAt: new Date(this.now()).toISOString(),
					error,
				},
				request.trace,
			);
		}
		return this.errorResponse(request, error.code, error.message, error.retryable);
	}

	private failAcceptedRequest(
		request: RuntimeRequestEnvelope,
		entry: RuntimeRequestLedgerEntry,
		error: unknown,
	): RuntimeResponseEnvelope {
		const serialized = this.serializeError(error, "RUNTIME_OPERATION_FAILED");
		const reference = executionReferenceFor(entry);
		if (reference) {
			this.ledgerFor(request).markTerminal(reference, "failed");
			const session = this.sessions.get(sessionKey(request));
			if (session && sameTarget(session.target, request.target)) {
				if (session.activePromptExecutionId === reference.executionId) session.activePromptExecutionId = undefined;
				session.activeExecutions.delete(reference.executionId);
				this.emitExecution(
					session,
					{
						executionId: reference.executionId,
						requestId: reference.requestId,
						kind: entry.executionKind ?? "prompt",
						status: "failed",
						finishedAt: new Date(this.now()).toISOString(),
						error: serialized,
					},
					request.trace,
				);
			}
		}
		return this.errorResponse(request, serialized.code, serialized.message, serialized.retryable, serialized.details);
	}

	private executeLongRequest(
		request: RuntimeRequestEnvelope,
		entry: RuntimeRequestLedgerEntry,
		session: HostSessionRecord,
		controller: AbortController,
		kind: RuntimeExecutionDescriptor["kind"],
		execute: (context: OffscreenRuntimeOperationContext) => Promise<RuntimeValue>,
	): Promise<RuntimeResponseEnvelope> {
		const reference = executionReferenceFor(entry);
		if (!reference) return Promise.resolve(this.errorResponse(request, "INTERNAL", "Execution identity is missing"));
		const ledger = this.ledgerFor(request);
		const start = ledger.markStarted(reference);
		if (start.kind === "cancelled-before-start" || controller.signal.aborted) {
			const error: RuntimeErrorDescriptor = {
				code: "ABORTED",
				message: "Execution was cancelled before it started",
				retryable: false,
			};
			if (session.activePromptExecutionId === reference.executionId) session.activePromptExecutionId = undefined;
			session.activeExecutions.delete(reference.executionId);
			this.emitExecution(
				session,
				{
					executionId: reference.executionId,
					requestId: reference.requestId,
					kind,
					status: "cancelled",
					finishedAt: new Date(this.now()).toISOString(),
					error,
				},
				request.trace,
			);
			this.emitSnapshot(session, request.trace);
			return Promise.resolve(this.errorResponse(request, error.code, error.message, error.retryable));
		}
		const startedAt = new Date(this.now()).toISOString();
		const descriptor: RuntimeExecutionDescriptor = {
			executionId: reference.executionId,
			requestId: reference.requestId,
			kind,
			status: "running",
			startedAt,
		};
		const active: ActiveExecution = { descriptor, controller, trace: request.trace };
		session.activeExecutions.set(reference.executionId, active);
		this.emitExecution(session, descriptor, request.trace);

		return (async () => {
			try {
				this.assertRequestActive(controller.signal);
				this.assertSessionPublished(session);
				const result = await execute(
					this.operationContext(request, session, controller.signal, reference.executionId),
				);
				if (!isRuntimeWireValue(result)) {
					throw new OffscreenRuntimeHostError(
						"NON_SERIALIZABLE_RESULT",
						"Runtime operation returned data that cannot cross the transport boundary",
					);
				}
				if (controller.signal.aborted) {
					const aborted = new Error("Execution aborted");
					aborted.name = "AbortError";
					throw aborted;
				}
				const terminalDescriptor: RuntimeExecutionDescriptor = {
					...descriptor,
					status: "succeeded",
					finishedAt: new Date(this.now()).toISOString(),
				};
				active.descriptor = terminalDescriptor;
				session.activeExecutions.delete(reference.executionId);
				if (session.activePromptExecutionId === reference.executionId) session.activePromptExecutionId = undefined;
				this.emitExecution(session, terminalDescriptor, request.trace);
				this.emitSnapshot(session, request.trace);
				this.assertRequestActive(controller.signal);
				this.assertSessionPublished(session);
				ledger.markTerminal(reference, "succeeded");
				return this.successResponse(request, result);
			} catch (error) {
				const cancelled = isAbortError(error, controller.signal);
				const status = cancelled ? "cancelled" : "failed";
				ledger.markTerminal(reference, status);
				const serialized = this.serializeError(error, cancelled ? "ABORTED" : "EXECUTION_FAILED");
				const terminalDescriptor: RuntimeExecutionDescriptor = {
					...descriptor,
					status,
					finishedAt: new Date(this.now()).toISOString(),
					error: serialized,
				};
				active.descriptor = terminalDescriptor;
				session.activeExecutions.delete(reference.executionId);
				if (session.activePromptExecutionId === reference.executionId) session.activePromptExecutionId = undefined;
				this.emitExecution(session, terminalDescriptor, request.trace);
				this.emitSnapshot(session, request.trace);
				return this.errorResponse(
					request,
					serialized.code,
					serialized.message,
					serialized.retryable,
					serialized.details,
				);
			} finally {
				if (session.activePromptExecutionId === reference.executionId) session.activePromptExecutionId = undefined;
			}
		})();
	}

	private async restoreSession(
		persisted: OffscreenRuntimePersistedSession,
		controller: AbortController,
		preserveSequence: boolean,
	): Promise<RestoredSessionResult> {
		const factory = this.sessionFactory;
		if (!factory.restore) throw new Error("Session factory does not support restore");
		this.assertAcquisitionActive(controller.signal);
		const orphaned = persisted.snapshot.activeExecutions.filter(
			(execution) =>
				execution.status === "queued" || execution.status === "running" || execution.status === "cancel-requested",
		);
		const restoredSnapshot = cloneWireValue(persisted.snapshot, "Restored session snapshot");
		assertSnapshotProtocol(persisted, this.runtimeEpoch, persisted.eventSeq + 1, restoredSnapshot);
		if (orphaned.length > 0) {
			restoredSnapshot.activeExecutions = [];
			restoredSnapshot.pendingToolCallIds = [];
			restoredSnapshot.isStreaming = false;
			delete restoredSnapshot.streamingMessage;
			restoredSnapshot.errorMessage = "Runtime resumed after active execution state was lost";
		}
		const adapter = await factory.restore({
			clientId: persisted.clientId,
			windowId: persisted.windowId,
			sessionId: persisted.sessionId,
			target: cloneWireValue(persisted.target, "Restored session target"),
			snapshot: cloneWireValue(restoredSnapshot, "Restored session snapshot"),
			signal: controller.signal,
		});
		await this.assertAdapterAcquisitionActive(adapter, controller.signal);
		const session = await this.addSession(
			adapter,
			persisted,
			persisted.revision,
			preserveSequence ? persisted.eventSeq : 0,
			controller.signal,
		);
		return { session, orphaned };
	}

	private settleRestoredExecutions(result: RestoredSessionResult): void {
		if (result.orphaned.length === 0) return;
		result.session.revision++;
		for (const execution of result.orphaned) {
			this.emitExecution(result.session, {
				...execution,
				status: "cancelled",
				finishedAt: new Date(this.now()).toISOString(),
				error: {
					code: "RUNTIME_RESTORED",
					message: "Execution could not continue after runtime restoration",
					retryable: true,
				},
			});
		}
		this.emitSnapshot(result.session);
	}

	private validateRestoreState(state: OffscreenRuntimeHostState): void {
		cloneWireValue(state, "Runtime host state");
		if (typeof state.runtimeEpoch !== "string" || !state.runtimeEpoch.trim()) {
			throw new Error("Persisted runtime epoch must be non-empty");
		}
		if (!Array.isArray(state.sessions) || !Array.isArray(state.requests)) {
			throw new Error("Persisted runtime state must contain session and request arrays");
		}
		const sessionKeys = new Set<string>();
		for (const persisted of state.sessions) {
			if (!Number.isInteger(persisted.revision) || persisted.revision < 0) {
				throw new Error("Persisted session revision must be a non-negative integer");
			}
			if (!Number.isInteger(persisted.eventSeq) || persisted.eventSeq < 0) {
				throw new Error("Persisted session event sequence must be a non-negative integer");
			}
			if (persisted.revision !== persisted.snapshot.revision) {
				throw new Error("Persisted session revision does not match its snapshot");
			}
			const key = sessionKey(persisted);
			if (sessionKeys.has(key)) throw new Error("Persisted runtime state contains duplicate sessions");
			sessionKeys.add(key);
			const snapshot = cloneWireValue(persisted.snapshot, "Restored session snapshot");
			assertSnapshotProtocol(persisted, this.runtimeEpoch, persisted.eventSeq + 1, snapshot);
		}
		this.validateRequestHistory(state.requests, state.runtimeEpoch);
		this.validateActiveExecutionHistory(state);
	}

	private validateActiveExecutionHistory(state: OffscreenRuntimeHostState): void {
		for (const persisted of state.sessions) {
			const executionIds = new Set<string>();
			const requestIds = new Set<string>();
			for (const execution of persisted.snapshot.activeExecutions) {
				if (executionIds.has(execution.executionId) || requestIds.has(execution.requestId)) {
					throw new Error("Persisted active execution identity is duplicated");
				}
				executionIds.add(execution.executionId);
				requestIds.add(execution.requestId);
				if (
					execution.status !== "queued" &&
					execution.status !== "running" &&
					execution.status !== "cancel-requested"
				) {
					throw new Error("Persisted active execution is already terminal");
				}
				const owner = state.requests.find((record) => {
					const request = record.request;
					if (
						request.clientId !== persisted.clientId ||
						request.windowId !== persisted.windowId ||
						request.sessionId !== persisted.sessionId ||
						request.requestId !== execution.requestId ||
						!sameTarget(request.target, persisted.target) ||
						record.response !== undefined
					) {
						return false;
					}
					if (request.operation.type === "prompt") {
						return execution.kind === "prompt" && request.operation.executionId === execution.executionId;
					}
					if (request.operation.type === "repl-execute") {
						return execution.kind === "repl" && request.operation.executionId === execution.executionId;
					}
					if (request.operation.type === "page-operation") {
						return execution.kind === "page-operation" && request.operation.executionId === execution.executionId;
					}
					return false;
				});
				if (!owner) throw new Error("Persisted active execution has no unfinished request owner");
			}
		}
	}

	private validateRequestHistory(records: OffscreenRuntimePersistedRequest[], runtimeEpoch: string): void {
		const ledger = new RuntimeRequestLedger(runtimeEpoch);
		for (const record of this.orderedRequestHistory(records)) {
			if (!isRuntimeRequestEnvelope(record.request)) throw new Error("Persisted runtime request is malformed");
			if (record.request.runtimeEpoch !== runtimeEpoch) {
				throw new Error("Persisted request targets another runtime epoch");
			}
			if (record.response) {
				if (!isRuntimeResponseEnvelope(record.response)) throw new Error("Persisted runtime response is malformed");
				const correlation = correlateRuntimeResponse(record.request, record.response);
				if (!correlation.ok) {
					throw new Error(`Persisted response is not correlated: ${correlation.mismatches.join(", ")}`);
				}
			}
			const begun = ledger.begin(record.request);
			if (begun.kind !== "accepted") throw new Error(`Persisted request ledger is invalid: ${begun.kind}`);
		}
	}

	private orderedRequestHistory(records: OffscreenRuntimePersistedRequest[]): OffscreenRuntimePersistedRequest[] {
		return records.slice().sort((left, right) => {
			if (left.request.operation.type === "abort") return 1;
			if (right.request.operation.type === "abort") return -1;
			return 0;
		});
	}

	private async rollbackRestoredState(): Promise<void> {
		await Promise.allSettled([...this.sessions.values()].map((session) => this.removeSession(session)));
		this.sessions.clear();
		this.responseCache.clear();
		this.requestHistory.clear();
		this.ledgers.clear();
		this.completedRequestKeys.length = 0;
		this.restoredFromRuntimeEpoch = undefined;
	}

	private restoreRequestHistory(records: OffscreenRuntimePersistedRequest[]): void {
		for (const record of this.orderedRequestHistory(records)) {
			if (!isRuntimeRequestEnvelope(record.request)) {
				throw new Error("Persisted runtime request is malformed");
			}
			if (record.response && !isRuntimeResponseEnvelope(record.response)) {
				throw new Error("Persisted runtime response is malformed");
			}
			if (record.response) {
				const correlation = correlateRuntimeResponse(record.request, record.response);
				if (!correlation.ok) {
					throw new Error(`Persisted response is not correlated: ${correlation.mismatches.join(", ")}`);
				}
			}
			if (record.request.runtimeEpoch !== this.runtimeEpoch) {
				throw new Error("Same-epoch runtime state contains a request for another epoch");
			}
			const ledger = this.ledgerFor(record.request);
			const begun = ledger.begin(record.request);
			if (begun.kind !== "accepted") throw new Error(`Could not restore request ledger entry: ${begun.kind}`);
			const reference = executionReferenceFor(begun.entry);
			if (reference) {
				ledger.markStarted(reference);
				const status = !record.response
					? "cancelled"
					: record.response.ok
						? "succeeded"
						: record.response.error.code === "ABORTED" || record.response.error.code === "RUNTIME_RESTORED"
							? "cancelled"
							: "failed";
				ledger.markTerminal(reference, status);
			}
			const response =
				record.response ??
				this.errorResponse(
					record.request,
					"RUNTIME_RESTORED",
					"Request was interrupted by runtime restoration",
					true,
				);
			const key = requestKey(record.request);
			this.requestHistory.set(key, record.request);
			this.responseCache.set(key, response);
		}
		for (const record of records) this.rememberCompletedRequest(requestKey(record.request), false);
		this.pruneCompletedRequests();
	}

	private rememberCompletedRequest(key: string, prune = true): void {
		if (!this.requestHistory.has(key) || !this.responseCache.has(key)) return;
		const previousIndex = this.completedRequestKeys.indexOf(key);
		if (previousIndex >= 0) this.completedRequestKeys.splice(previousIndex, 1);
		this.completedRequestKeys.push(key);
		if (prune) this.pruneCompletedRequests();
		this.notifyStateChanged();
	}

	private pruneCompletedRequests(): void {
		while (this.completedRequestKeys.length > this.maxCompletedRequests) {
			const key = this.completedRequestKeys.shift();
			if (key === undefined) return;
			const request = this.requestHistory.get(key);
			if (!request) continue;
			this.requestHistory.delete(key);
			this.responseCache.delete(key);
			const ledgerKey = sessionKey(request);
			this.ledgers.get(ledgerKey)?.forget(request);
			const hasRetainedRequest = [...this.requestHistory.values()].some(
				(candidate) => sessionKey(candidate) === ledgerKey,
			);
			if (!hasRetainedRequest && !this.sessions.has(ledgerKey)) this.ledgers.delete(ledgerKey);
		}
	}

	private notifyStateChanged(): void {
		try {
			this.onStateChanged?.();
		} catch {
			// Persistence observers must never interfere with runtime execution.
		}
	}

	private ledgerFor(
		scope: Pick<OffscreenRuntimeSessionScope, "clientId" | "windowId" | "sessionId">,
	): RuntimeRequestLedger {
		const key = sessionKey(scope);
		let ledger = this.ledgers.get(key);
		if (!ledger) {
			ledger = new RuntimeRequestLedger(this.runtimeEpoch);
			this.ledgers.set(key, ledger);
		}
		return ledger;
	}

	private withSessionMutation<T>(session: HostSessionRecord, mutate: () => Promise<T> | T): Promise<T> {
		session.pendingMutationCount++;
		const operation = session.mutationTail.then(mutate).finally(() => {
			session.pendingMutationCount--;
		});
		session.mutationTail = operation.then(
			() => {},
			() => {},
		);
		return operation;
	}

	private async withSessionAcquisition<T>(
		scope: Pick<OffscreenRuntimeSessionScope, "clientId" | "windowId" | "sessionId">,
		acquire: () => Promise<T>,
	): Promise<T> {
		const key = sessionKey(scope);
		const previous = this.sessionAcquisitions.get(key);
		let release: () => void = () => {};
		const turn = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.sessionAcquisitions.set(key, turn);
		if (previous) await previous;
		try {
			return await acquire();
		} finally {
			release();
			if (this.sessionAcquisitions.get(key) === turn) this.sessionAcquisitions.delete(key);
		}
	}

	private assertAcquisitionActive(signal: AbortSignal): void {
		if (this.disposed) throw new OffscreenRuntimeHostError("HOST_DISPOSED", "Runtime host is disposed");
		if (signal.aborted) throw new OffscreenRuntimeHostError("ABORTED", "Runtime operation was aborted");
	}

	private assertRequestActive(signal: AbortSignal): void {
		if (signal.aborted) throw new OffscreenRuntimeHostError("ABORTED", "Runtime operation was aborted");
		if (this.disposed) throw new OffscreenRuntimeHostError("HOST_DISPOSED", "Runtime host is disposed");
	}

	private assertSessionPublished(session: HostSessionRecord): void {
		if (this.sessions.get(sessionKey(session)) !== session) {
			throw new OffscreenRuntimeHostError("SESSION_NOT_FOUND", "Session is no longer published");
		}
	}

	private async assertAdapterAcquisitionActive(
		adapter: OffscreenRuntimeSessionAdapter,
		signal: AbortSignal,
	): Promise<void> {
		if (!this.disposed && !signal.aborted) return;
		await adapter.dispose?.();
		this.assertAcquisitionActive(signal);
	}

	private rejectExecution(
		request: RuntimeRequestEnvelope,
		entry: RuntimeRequestLedgerEntry,
		session: HostSessionRecord,
		code: string,
		message: string,
	): RuntimeResponseEnvelope {
		const reference = executionReferenceFor(entry);
		if (reference) this.ledgerFor(request).markTerminal(reference, "failed");
		const descriptor: RuntimeExecutionDescriptor = {
			executionId: entry.executionId ?? "missing",
			requestId: request.requestId,
			kind: entry.executionKind ?? "prompt",
			status: "failed",
			finishedAt: new Date(this.now()).toISOString(),
			error: { code, message, retryable: true },
		};
		this.emitExecution(session, descriptor, request.trace);
		return this.errorResponse(request, code, message, true);
	}

	private handleAbort(
		request: RuntimeRequestEnvelope & { operation: Extract<RuntimeRequestEnvelope["operation"], { type: "abort" }> },
	): Promise<RuntimeResponseEnvelope> {
		const key = requestKey(request);
		const cancellation = this.ledgerFor(request).cancel(request);
		if (cancellation.kind === "cancel-requested") {
			const session = this.sessions.get(sessionKey(request));
			const active = session?.activeExecutions.get(request.operation.executionId);
			if (active?.descriptor.requestId === request.operation.targetRequestId) {
				active.controller.abort(request.operation.reason ?? "runtime-abort");
			}
		}
		if (cancellation.kind === "duplicate-abort") {
			const inFlight = this.inFlightRequests.get(key);
			if (inFlight) return inFlight;
			const cached = this.responseCache.get(key);
			if (cached) return Promise.resolve(cloneWireValue(cached, "Cached runtime response"));
		}
		if (
			cancellation.kind !== "stale-epoch" &&
			cancellation.kind !== "request-conflict" &&
			cancellation.kind !== "execution-conflict" &&
			cancellation.kind !== "duplicate-abort"
		) {
			this.requestHistory.set(key, request);
		}
		const processing = Promise.resolve()
			.then(() => this.processCancellation(request, cancellation))
			.catch((error: unknown) => this.errorFromUnknown(request, error))
			.then((response) => {
				if (!this.disposed) this.responseCache.set(key, cloneWireValue(response, "Cached runtime response"));
				return cloneWireValue(response, "Runtime response");
			})
			.finally(() => {
				this.inFlightRequests.delete(key);
				this.rememberCompletedRequest(key);
			});
		this.inFlightRequests.set(key, processing);
		return processing;
	}

	private async processCancellation(
		request: RuntimeRequestEnvelope & {
			operation: Extract<RuntimeRequestEnvelope["operation"], { type: "abort" }>;
		},
		cancellation: RuntimeLedgerCancelResult,
	): Promise<RuntimeResponseEnvelope> {
		if (cancellation.kind === "stale-epoch") {
			return this.errorResponse(request, "STALE_RUNTIME_EPOCH", "Abort targets a stale runtime epoch");
		}
		if (cancellation.kind === "request-conflict" || cancellation.kind === "execution-conflict") {
			return this.errorResponse(request, "REQUEST_ID_CONFLICT", "Abort request identity conflicts");
		}
		if (cancellation.kind === "duplicate-abort") {
			return this.successResponse(request, { status: "duplicate" });
		}
		if (cancellation.kind === "not-found") {
			return this.errorResponse(request, "EXECUTION_NOT_FOUND", "Execution was not found");
		}
		if (cancellation.kind === "identity-mismatch") {
			return this.errorResponse(request, "EXECUTION_IDENTITY_MISMATCH", "Abort did not exactly match the execution");
		}
		if (cancellation.kind === "cancelled-before-start") {
			this.requestControllers
				.get(requestKey(cancellation.targetEntry.request))
				?.abort(request.operation.reason ?? "runtime-abort-before-start");
			return this.successResponse(request, { status: cancellation.kind });
		}
		if (cancellation.kind === "already-terminal") {
			return this.successResponse(request, { status: cancellation.kind });
		}
		if (
			(cancellation.kind === "cancel-requested" || cancellation.kind === "already-cancel-requested") &&
			(cancellation.targetEntry.status === "succeeded" ||
				cancellation.targetEntry.status === "failed" ||
				cancellation.targetEntry.status === "cancelled")
		) {
			return this.successResponse(request, { status: "already-terminal" });
		}
		if (this.disposed) return this.errorResponse(request, "HOST_DISPOSED", "Runtime host is disposed");

		const session = this.requireSession(request);
		const active = session.activeExecutions.get(request.operation.executionId);
		if (!active || active.descriptor.requestId !== request.operation.targetRequestId) {
			return this.errorResponse(request, "EXECUTION_NOT_FOUND", "Active execution was not found");
		}
		if (cancellation.kind === "cancel-requested") {
			active.descriptor = { ...active.descriptor, status: "cancel-requested" };
			this.emitExecution(session, active.descriptor, request.trace);
			if (this.disposed) return this.errorResponse(request, "HOST_DISPOSED", "Runtime host is disposed");
			active.controller.abort(request.operation.reason ?? "runtime-abort");
			if (active.descriptor.kind === "prompt") await session.adapter.abort?.(active.descriptor.executionId);
			if (this.disposed) return this.errorResponse(request, "HOST_DISPOSED", "Runtime host is disposed");
		}
		return this.successResponse(request, { status: cancellation.kind });
	}

	private requireSession(request: RuntimeRequestEnvelope): HostSessionRecord {
		const session = this.sessions.get(sessionKey(request));
		if (!session) throw new OffscreenRuntimeHostError("SESSION_NOT_FOUND", "Session was not found");
		if (!sameTarget(session.target, request.target)) {
			throw new OffscreenRuntimeHostError("TARGET_MISMATCH", "Session target does not match");
		}
		return session;
	}

	private async addSession(
		adapter: OffscreenRuntimeSessionAdapter,
		scope: OffscreenRuntimeSessionScope,
		revision: number,
		eventSeq: number,
		signal: AbortSignal,
	): Promise<HostSessionRecord> {
		if (this.sessions.has(sessionKey(scope))) {
			void cleanupResult(() => adapter.dispose?.()).catch(() => {});
			throw new OffscreenRuntimeHostError("SESSION_EXISTS", "Session already exists");
		}
		const record: HostSessionRecord = {
			clientId: scope.clientId,
			windowId: scope.windowId,
			sessionId: scope.sessionId,
			target: scope.target,
			adapter,
			revision,
			eventSeq,
			activeExecutions: new Map(),
			mutationTail: Promise.resolve(),
			pendingMutationCount: 0,
			initializing: true,
			unsubscribe: () => {},
		};
		try {
			this.snapshot(record);
			record.unsubscribe = adapter.subscribe((event) => this.onAgentEvent(record, event));
			this.assertAcquisitionActive(signal);
		} catch (error) {
			record.initializing = false;
			await Promise.allSettled([cleanupResult(record.unsubscribe), cleanupResult(() => adapter.dispose?.())]);
			throw error;
		}
		this.sessions.set(sessionKey(record), record);
		record.initializing = false;
		if (this.disposed || signal.aborted) {
			await this.removeSession(record);
			this.assertAcquisitionActive(signal);
		}
		return record;
	}

	private async removeSession(session: HostSessionRecord): Promise<void> {
		if (this.sessions.get(sessionKey(session)) === session) this.sessions.delete(sessionKey(session));
		for (const active of session.activeExecutions.values()) active.controller.abort("runtime-session-removed");
		session.activeExecutions.clear();
		await Promise.allSettled([cleanupResult(session.unsubscribe), cleanupResult(() => session.adapter.dispose?.())]);
	}

	private onAgentEvent(session: HostSessionRecord, event: RuntimeAgentEvent): void {
		if (this.disposed) return;
		const isPublished = this.sessions.get(sessionKey(session)) === session;
		if (!isPublished && !(this.restoreInProgress && session.initializing)) return;
		let ownedEvent: RuntimeAgentEvent;
		try {
			ownedEvent = cloneWireValue(event, "Agent event");
		} catch {
			return;
		}
		const validationEnvelope = {
			kind: "stream" as const,
			streamType: "agent-event" as const,
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: this.runtimeEpoch,
			clientId: session.clientId,
			windowId: session.windowId,
			sessionId: session.sessionId,
			target: session.target,
			revision: session.revision,
			eventSeq: Math.max(1, session.eventSeq + 1),
			agentEvent: ownedEvent,
		};
		if (!isRuntimeStreamEnvelope(validationEnvelope)) return;
		if (this.restoreInProgress) {
			this.restoreDirtySessions.add(session);
			return;
		}
		const emission = this.withSessionMutation(session, () => {
			if (this.disposed || this.sessions.get(sessionKey(session)) !== session) return;
			session.revision++;
			const activePrompt = session.activePromptExecutionId
				? session.activeExecutions.get(session.activePromptExecutionId)
				: undefined;
			this.emitSession(session, {
				streamType: "agent-event",
				agentEvent: ownedEvent,
				trace: activePrompt?.trace,
			});
		});
		void emission.catch(() => {});
	}

	private snapshot(session: HostSessionRecord): RuntimeSessionSnapshot {
		const state = session.adapter.getState();
		const model = state.model ? cloneWireValue(state.model, "Session model") : null;
		const snapshot: RuntimeSessionSnapshot = {
			sessionId: session.sessionId,
			target: session.target,
			revision: session.revision,
			systemPrompt: state.systemPrompt,
			model,
			thinkingLevel: state.thinkingLevel,
			messages: cloneWireValue(state.messages, "Session messages"),
			tools: state.tools.map((tool) => ({
				name: tool.name,
				label: tool.label,
				...(tool.description !== undefined ? { description: tool.description } : {}),
			})),
			pendingToolCallIds: state.pendingToolCallIds.slice(),
			isStreaming: state.isStreaming,
			...(state.streamingMessage
				? { streamingMessage: cloneWireValue(state.streamingMessage, "Streaming message") }
				: {}),
			activeExecutions: [...session.activeExecutions.values()].map((active) =>
				cloneWireValue(active.descriptor, "Execution descriptor"),
			),
			artifacts: state.artifacts.map((artifact) => ({
				filename: artifact.filename,
				...(artifact.mimeType !== undefined ? { mimeType: artifact.mimeType } : {}),
				...(artifact.size !== undefined ? { size: artifact.size } : {}),
				...(artifact.createdAt !== undefined ? { createdAt: artifact.createdAt } : {}),
				...(artifact.updatedAt !== undefined ? { updatedAt: artifact.updatedAt } : {}),
			})),
			...(state.errorMessage ? { errorMessage: state.errorMessage } : {}),
		};
		const cloned = cloneWireValue(snapshot, "Session snapshot");
		assertSnapshotProtocol(session, this.runtimeEpoch, session.eventSeq + 1, cloned);
		return cloned;
	}

	private emitSnapshot(session: HostSessionRecord, trace?: RuntimeTraceContext): void {
		this.emitSession(session, { streamType: "session-snapshot", snapshot: this.snapshot(session), trace });
	}

	private emitExecution(
		session: HostSessionRecord,
		execution: RuntimeExecutionDescriptor,
		trace?: RuntimeTraceContext,
	): void {
		this.emitSession(session, { streamType: "execution", execution, trace });
	}

	private emitSession(
		session: HostSessionRecord,
		payload:
			| { streamType: "session-snapshot"; snapshot: RuntimeSessionSnapshot; trace?: RuntimeTraceContext }
			| { streamType: "agent-event"; agentEvent: RuntimeAgentEvent; trace?: RuntimeTraceContext }
			| { streamType: "execution"; execution: RuntimeExecutionDescriptor; trace?: RuntimeTraceContext },
	): void {
		session.eventSeq++;
		const common = {
			kind: "stream" as const,
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: this.runtimeEpoch,
			clientId: session.clientId,
			windowId: session.windowId,
			sessionId: session.sessionId,
			target: session.target,
			revision: session.revision,
			eventSeq: session.eventSeq,
		};
		if (payload.streamType === "session-snapshot") {
			this.emit({
				...common,
				streamType: payload.streamType,
				snapshot: payload.snapshot,
				...(payload.trace ? { trace: payload.trace } : {}),
			});
			this.notifyStateChanged();
			return;
		}
		if (payload.streamType === "agent-event") {
			this.emit({
				...common,
				streamType: payload.streamType,
				agentEvent: payload.agentEvent,
				...(payload.trace ? { trace: payload.trace } : {}),
			});
			this.notifyStateChanged();
			return;
		}
		this.emit({
			...common,
			streamType: payload.streamType,
			execution: payload.execution,
			...(payload.trace ? { trace: payload.trace } : {}),
		});
		this.notifyStateChanged();
	}

	private emit(envelope: RuntimeStreamEnvelope): void {
		if (this.disposed) return;
		if (!isRuntimeStreamEnvelope(envelope)) throw new Error("Runtime host attempted to emit a malformed envelope");
		const ownedEnvelope = cloneWireValue(envelope, "Runtime stream envelope");
		if (this.restoreInProgress) {
			this.restoreEmissionBuffer?.push(ownedEnvelope);
			return;
		}
		this.emitEnvelope(ownedEnvelope);
	}

	private operationContext(
		request: RuntimeRequestEnvelope,
		session: HostSessionRecord,
		signal: AbortSignal,
		executionId?: string,
	): OffscreenRuntimeOperationContext {
		return {
			runtimeEpoch: request.runtimeEpoch,
			clientId: request.clientId,
			windowId: request.windowId,
			sessionId: request.sessionId,
			target: cloneWireValue(request.target, "Operation target"),
			requestId: request.requestId,
			...(executionId ? { executionId } : {}),
			...(request.trace ? { trace: cloneWireValue(request.trace, "Operation trace") } : {}),
			signal,
			session: session.adapter,
		};
	}

	private successResponse(request: RuntimeRequestEnvelope, result: RuntimeValue): RuntimeResponseEnvelope {
		if (!isRuntimeWireValue(result)) {
			return this.errorResponse(
				request,
				"NON_SERIALIZABLE_RESULT",
				"Runtime operation returned data that cannot cross the transport boundary",
			);
		}
		const response: RuntimeResponseEnvelope = {
			kind: "response",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: request.runtimeEpoch,
			clientId: request.clientId,
			windowId: request.windowId,
			sessionId: request.sessionId,
			target: request.target,
			requestId: request.requestId,
			operation: request.operation.type,
			...(request.trace ? { trace: request.trace } : {}),
			ok: true,
			result,
		};
		if (!isRuntimeResponseEnvelope(response)) {
			return this.errorResponse(request, "MALFORMED_RESPONSE", "Runtime operation produced a malformed response");
		}
		return response;
	}

	private errorResponse(
		request: RuntimeRequestEnvelope,
		code: string,
		message: string,
		retryable = false,
		details?: RuntimeValue,
	): RuntimeResponseEnvelope {
		return {
			kind: "response",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: request.runtimeEpoch,
			clientId: request.clientId,
			windowId: request.windowId,
			sessionId: request.sessionId,
			target: request.target,
			requestId: request.requestId,
			operation: request.operation.type,
			...(request.trace ? { trace: request.trace } : {}),
			ok: false,
			error: { code, message, retryable, ...(details !== undefined ? { details } : {}) },
		};
	}

	private serializeError(error: unknown, fallbackCode: string): RuntimeErrorDescriptor {
		if (error instanceof OffscreenRuntimeHostError) {
			return {
				code: error.code,
				message: error.message,
				retryable: error.retryable,
				...(error.details !== undefined ? { details: error.details } : {}),
			};
		}
		return { code: fallbackCode, message: errorMessage(error), retryable: false };
	}

	private errorFromUnknown(request: RuntimeRequestEnvelope, error: unknown): RuntimeResponseEnvelope {
		const serialized = this.serializeError(error, "RUNTIME_OPERATION_FAILED");
		return this.errorResponse(request, serialized.code, serialized.message, serialized.retryable, serialized.details);
	}
}
