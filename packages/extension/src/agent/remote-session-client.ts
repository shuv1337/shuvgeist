import {
	correlateRuntimeResponse,
	createRuntimeChannelState,
	createRuntimeResyncRequest,
	type RuntimeChannelEffect,
	type RuntimeChannelState,
	reduceRuntimeStream,
} from "./runtime-channel.js";
import { sameRuntimeTarget as sameTarget } from "./runtime-identity.js";
import {
	isRuntimeRequestEnvelope,
	isRuntimeResponseEnvelope,
	isRuntimeStreamEnvelope,
	isRuntimeWireValue,
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeAgentEvent,
	type RuntimeAgentMessage,
	type RuntimeArtifactDescriptor,
	type RuntimeArtifactsPayload,
	type RuntimeExecutionDescriptor,
	type RuntimeModelDescriptor,
	type RuntimeRecord,
	type RuntimeRequestEnvelope,
	type RuntimeRequestOperation,
	type RuntimeResponseEnvelope,
	type RuntimeSessionSnapshot,
	type RuntimeStreamEnvelope,
	type RuntimeTargetIdentity,
	type RuntimeThinkingLevel,
	type RuntimeToolDescriptor,
	type RuntimeTraceContext,
	type RuntimeValue,
} from "./runtime-protocol.js";

export interface RemoteSessionTransport {
	send(request: RuntimeRequestEnvelope): Promise<RuntimeResponseEnvelope>;
	subscribe(listener: (envelope: RuntimeStreamEnvelope) => void): () => void;
}

export type RemoteSessionListener = (event: RuntimeAgentEvent, signal: AbortSignal) => Promise<void> | void;
export type RemoteSessionStateListener = (snapshot: RuntimeSessionSnapshot) => void;

export interface RemoteAgentStateView {
	systemPrompt: string;
	model: RuntimeModelDescriptor | null;
	thinkingLevel: RuntimeThinkingLevel;
	tools: object[];
	messages: RuntimeAgentMessage[];
	readonly isStreaming: boolean;
	readonly streamingMessage?: RuntimeAgentMessage;
	readonly pendingToolCalls: ReadonlySet<string>;
	readonly errorMessage?: string;
	readonly toolDescriptors: readonly RuntimeToolDescriptor[];
	readonly artifacts: readonly RuntimeArtifactDescriptor[];
}

export interface StructuralRemoteAgentSession {
	readonly state: RemoteAgentStateView;
	prompt(input: string | RuntimeAgentMessage): Promise<void>;
	subscribe(listener: RemoteSessionListener): () => void;
	abort(): void;
}

export interface RemoteSessionClientOptions {
	transport: RemoteSessionTransport;
	clientId: string;
	windowId: number;
	sessionId: string;
	target: RuntimeTargetIdentity;
	initialRuntimeEpoch?: string;
	trace?: RuntimeTraceContext;
	createRequestId?: (operation: RuntimeRequestOperation["type"], sequence: number) => string;
	createExecutionId?: (kind: RuntimeExecutionDescriptor["kind"], sequence: number) => string;
	now?: () => number;
	onError?: (error: unknown) => void;
	resyncTimeoutMs?: number;
	bootstrap?: RemoteSessionBootstrap;
}

export type RemoteSessionBootstrap =
	| { mode: "attach" }
	| { mode: "load" }
	| {
			mode: "create";
			systemPrompt: string;
			model?: RuntimeModelDescriptor;
			thinkingLevel?: RuntimeThinkingLevel;
			initialMessages?: RuntimeAgentMessage[];
	  };

export class RemoteSessionError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly details?: RuntimeValue;
	readonly correlatedResponse: boolean;

	constructor(code: string, message: string, retryable = false, details?: RuntimeValue, correlatedResponse = false) {
		super(message);
		this.name = "RemoteSessionError";
		this.code = code;
		this.retryable = retryable;
		this.details = details;
		this.correlatedResponse = correlatedResponse;
	}
}

function sameModel(left: RuntimeModelDescriptor | null, right: RuntimeModelDescriptor | null): boolean {
	if (left === null || right === null) return left === right;
	return left.provider === right.provider && left.id === right.id;
}

function terminal(status: RuntimeExecutionDescriptor["status"]): boolean {
	return status === "succeeded" || status === "failed" || status === "cancelled";
}

function terminalAbortResult(result: RuntimeValue): boolean {
	if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
	return result.status === "cancelled-before-start" || result.status === "already-terminal";
}

class RemoteAgentState implements RemoteAgentStateView {
	private systemPromptValue = "";
	private modelValue: RuntimeModelDescriptor | null = null;
	private thinkingLevelValue: RuntimeThinkingLevel = "medium";
	private toolsValue: object[] = [];
	private messagesValue: RuntimeAgentMessage[] = [];
	private streaming = false;
	private streamingMessageValue?: RuntimeAgentMessage;
	private pendingToolCallIds = new Set<string>();
	private errorMessageValue?: string;
	private remoteToolDescriptors: RuntimeToolDescriptor[] = [];
	private artifactDescriptors: RuntimeArtifactDescriptor[] = [];

	constructor(
		private readonly setModel: (model: RuntimeModelDescriptor) => void,
		private readonly setThinkingLevel: (thinkingLevel: RuntimeThinkingLevel) => void,
	) {}

	get systemPrompt(): string {
		return this.systemPromptValue;
	}

	set systemPrompt(value: string) {
		this.systemPromptValue = value;
	}

	get model(): RuntimeModelDescriptor | null {
		return this.modelValue;
	}

	set model(value: RuntimeModelDescriptor | null) {
		if (value === null) {
			this.modelValue = null;
			return;
		}
		this.setModel(value);
	}

	get thinkingLevel(): RuntimeThinkingLevel {
		return this.thinkingLevelValue;
	}

	set thinkingLevel(value: RuntimeThinkingLevel) {
		this.setThinkingLevel(value);
	}

	get tools(): object[] {
		return this.toolsValue;
	}

	set tools(value: object[]) {
		// Executable local tools deliberately never enter a request or snapshot.
		this.toolsValue = value.slice();
	}

	get messages(): RuntimeAgentMessage[] {
		// Never expose the authoritative transcript by reference. pi-web-ui 0.78
		// only reads this property; all mutations must cross an explicit remote
		// operation so a closed sidepanel observes the same state.
		return structuredClone(this.messagesValue);
	}

	get isStreaming(): boolean {
		return this.streaming;
	}

	get streamingMessage(): RuntimeAgentMessage | undefined {
		return this.streamingMessageValue;
	}

	get pendingToolCalls(): ReadonlySet<string> {
		return this.pendingToolCallIds;
	}

	get errorMessage(): string | undefined {
		return this.errorMessageValue;
	}

	get toolDescriptors(): readonly RuntimeToolDescriptor[] {
		return this.remoteToolDescriptors;
	}

	get artifacts(): readonly RuntimeArtifactDescriptor[] {
		return this.artifactDescriptors;
	}

	applySnapshot(
		snapshot: RuntimeSessionSnapshot,
		options: { preserveModel: boolean; preserveThinkingLevel: boolean },
	): void {
		this.systemPromptValue = snapshot.systemPrompt;
		if (!options.preserveModel) this.modelValue = snapshot.model;
		if (!options.preserveThinkingLevel) this.thinkingLevelValue = snapshot.thinkingLevel;
		this.messagesValue = snapshot.messages.slice();
		this.streaming = snapshot.isStreaming;
		this.streamingMessageValue = snapshot.streamingMessage;
		this.pendingToolCallIds = new Set(snapshot.pendingToolCallIds);
		this.errorMessageValue = snapshot.errorMessage;
		this.remoteToolDescriptors = snapshot.tools.slice();
		this.artifactDescriptors = snapshot.artifacts.slice();
	}

	applyAgentEvent(event: RuntimeAgentEvent): void {
		switch (event.type) {
			case "agent_start":
				this.streaming = true;
				this.streamingMessageValue = undefined;
				this.errorMessageValue = undefined;
				return;
			case "agent_end":
				this.streaming = false;
				this.streamingMessageValue = undefined;
				this.pendingToolCallIds = new Set();
				return;
			case "message_start":
			case "message_update":
				this.streamingMessageValue = event.message;
				return;
			case "message_end":
				this.streamingMessageValue = undefined;
				this.messagesValue = [...this.messagesValue, event.message];
				return;
			case "tool_execution_start": {
				const next = new Set(this.pendingToolCallIds);
				next.add(event.toolCallId);
				this.pendingToolCallIds = next;
				return;
			}
			case "tool_execution_end": {
				const next = new Set(this.pendingToolCallIds);
				next.delete(event.toolCallId);
				this.pendingToolCallIds = next;
				return;
			}
			case "turn_end":
				if (event.message.errorMessage && typeof event.message.errorMessage === "string") {
					this.errorMessageValue = event.message.errorMessage;
				}
				return;
			case "turn_start":
			case "tool_execution_update":
				return;
		}
	}

	applyOptimisticModel(model: RuntimeModelDescriptor): void {
		this.modelValue = model;
	}

	applyOptimisticThinkingLevel(thinkingLevel: RuntimeThinkingLevel): void {
		this.thinkingLevelValue = thinkingLevel;
	}

	setError(message: string | undefined): void {
		this.errorMessageValue = message;
	}
}

interface PendingModelMutation {
	token: number;
	epoch: string;
	authoritativeGeneration: number;
	optimistic: RuntimeModelDescriptor;
}

interface PendingThinkingMutation {
	token: number;
	epoch: string;
	authoritativeGeneration: number;
	optimistic: RuntimeThinkingLevel;
}

interface RecoveryCycle {
	epoch: string;
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
	responseReceived: boolean;
	snapshotReceived: boolean;
	timeout: ReturnType<typeof setTimeout>;
}

interface ResyncCycle {
	epoch: string;
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
	responseReceived: boolean;
	snapshotReceived: boolean;
	timeout: ReturnType<typeof setTimeout>;
}

export class RemoteSessionClient implements StructuralRemoteAgentSession {
	readonly state: RemoteAgentStateView;

	private readonly transport: RemoteSessionTransport;
	private readonly clientId: string;
	private readonly windowId: number;
	private readonly sessionId: string;
	private readonly target: RuntimeTargetIdentity;
	private readonly trace?: RuntimeTraceContext;
	private readonly requestIdFactory: NonNullable<RemoteSessionClientOptions["createRequestId"]>;
	private readonly executionIdFactory: NonNullable<RemoteSessionClientOptions["createExecutionId"]>;
	private readonly now: () => number;
	private readonly onError?: (error: unknown) => void;
	private readonly resyncTimeoutMs: number;
	private readonly bootstrap: RemoteSessionBootstrap;
	private readonly listeners = new Set<RemoteSessionListener>();
	private readonly stateListeners = new Set<RemoteSessionStateListener>();
	private readonly listenerController = new AbortController();
	private readonly pendingOperations = new Set<Promise<unknown>>();
	private readonly unsubscribeTransport: () => void;
	private readonly stateView: RemoteAgentState;
	private channelState: RuntimeChannelState;
	private requestSequence = 0;
	private executionSequence = 0;
	private mutationSequence = 0;
	private authoritativeGeneration = 0;
	private pendingModelMutation?: PendingModelMutation;
	private pendingThinkingMutation?: PendingThinkingMutation;
	private confirmedModel: RuntimeModelDescriptor | null = null;
	private confirmedThinkingLevel: RuntimeThinkingLevel = "medium";
	private modelMutationTail = Promise.resolve();
	private thinkingMutationTail = Promise.resolve();
	private activePrompt?: RuntimeExecutionDescriptor;
	private activePromptEpoch?: string;
	private readonly pendingPromptRequestIds = new Set<string>();
	private recovery?: RecoveryCycle;
	private observedRecovery?: Promise<void>;
	private resync?: ResyncCycle;
	private readonly listenerQueues = new Map<RemoteSessionListener, Promise<void>>();
	private epochController?: { epoch: string; controller: AbortController };
	private attachedEpoch?: string;
	private connectionRequested = false;
	private helloSessionPresence?: { epoch: string; present: boolean; hadPriorSession: boolean };
	private helloConnection?: {
		promise: Promise<void>;
		resolve: () => void;
		reject: (error: unknown) => void;
	};
	private disposed = false;

	constructor(options: RemoteSessionClientOptions) {
		if (!options.sessionId.trim()) throw new Error("sessionId must be non-empty");
		this.transport = options.transport;
		this.clientId = options.clientId;
		this.windowId = options.windowId;
		this.sessionId = options.sessionId;
		this.target = structuredClone(options.target);
		this.trace = options.trace ? structuredClone(options.trace) : undefined;
		this.requestIdFactory =
			options.createRequestId ??
			((operation, sequence) => `${this.clientId}:${this.windowId}:${this.sessionId}:${operation}:${sequence}`);
		this.executionIdFactory =
			options.createExecutionId ??
			((_kind, sequence) => `${this.clientId}:${this.windowId}:${this.sessionId}:execution:${sequence}`);
		this.now = options.now ?? Date.now;
		this.onError = options.onError;
		this.resyncTimeoutMs = options.resyncTimeoutMs ?? 5_000;
		this.bootstrap = structuredClone(options.bootstrap ?? { mode: "attach" });
		if (!Number.isFinite(this.resyncTimeoutMs) || this.resyncTimeoutMs <= 0) {
			throw new Error("resyncTimeoutMs must be a positive finite number");
		}
		this.channelState = createRuntimeChannelState(this.clientId, this.windowId);
		if (options.initialRuntimeEpoch) {
			this.channelState = { ...this.channelState, runtimeEpoch: options.initialRuntimeEpoch };
			this.epochController = { epoch: options.initialRuntimeEpoch, controller: new AbortController() };
		}
		this.stateView = new RemoteAgentState(
			(model) => {
				void this.track(this.setModel(model)).catch((error: unknown) => this.onError?.(error));
			},
			(thinkingLevel) => {
				void this.track(this.setThinkingLevel(thinkingLevel)).catch((error: unknown) => this.onError?.(error));
			},
		);
		this.state = this.stateView;
		this.unsubscribeTransport = this.transport.subscribe((envelope) => this.receive(envelope));
	}

	connect(): Promise<void> {
		this.assertUsable();
		this.connectionRequested = true;
		if (!this.channelState.runtimeEpoch) {
			if (!this.helloConnection) {
				let resolveConnection: () => void = () => {};
				let rejectConnection: (error: unknown) => void = () => {};
				const promise = new Promise<void>((resolve, reject) => {
					resolveConnection = resolve;
					rejectConnection = reject;
				});
				this.helloConnection = { promise, resolve: resolveConnection, reject: rejectConnection };
			}
			return this.track(this.helloConnection.promise);
		}
		return this.track(this.recoverAfterHello());
	}

	async prompt(input: string | RuntimeAgentMessage): Promise<void> {
		this.assertUsable();
		const candidate: RuntimeAgentMessage =
			typeof input === "string" ? { role: "user", content: input, timestamp: this.now() } : input;
		if (!isRuntimeWireValue(candidate)) {
			throw new RemoteSessionError("NON_SERIALIZABLE_REQUEST", "Prompt message is not valid plain wire data");
		}
		const message = structuredClone(candidate);
		await this.ensureConnected();
		if (this.activePrompt && !terminal(this.activePrompt.status)) {
			throw new RemoteSessionError("SESSION_BUSY", "A prompt execution is already active");
		}
		const requestId = this.nextRequestId("prompt");
		const executionId = this.executionIdFactory("prompt", ++this.executionSequence);
		const epoch = this.requireRuntimeEpoch();
		this.activePrompt = { executionId, requestId, kind: "prompt", status: "queued" };
		this.activePromptEpoch = epoch;
		this.pendingPromptRequestIds.add(requestId);
		try {
			await this.track(this.sendOperation({ type: "prompt", executionId, message }, requestId, epoch));
			if (this.activePrompt?.executionId === executionId && this.activePrompt.requestId === requestId) {
				this.activePrompt = undefined;
				this.activePromptEpoch = undefined;
			}
		} catch (error) {
			if (
				this.activePrompt?.executionId === executionId &&
				this.activePrompt.requestId === requestId &&
				error instanceof RemoteSessionError &&
				(error.correlatedResponse || error.code === "NON_SERIALIZABLE_REQUEST")
			) {
				this.activePrompt = undefined;
				this.activePromptEpoch = undefined;
			}
			throw error;
		} finally {
			this.pendingPromptRequestIds.delete(requestId);
		}
	}

	abort(): void {
		void this.track(this.abortActive()).catch((error: unknown) => this.onError?.(error));
	}

	async abortActive(): Promise<void> {
		this.assertUsable();
		const active = this.activePrompt;
		const activeEpoch = this.activePromptEpoch;
		if (!active || terminal(active.status)) return;
		await this.ensureConnected();
		if (!activeEpoch || this.channelState.runtimeEpoch !== activeEpoch || this.activePromptEpoch !== activeEpoch) {
			throw new RemoteSessionError("STALE_REQUEST_EPOCH", "Prompt execution belongs to an obsolete runtime epoch");
		}
		if (
			this.activePrompt?.executionId !== active.executionId ||
			this.activePrompt.requestId !== active.requestId ||
			terminal(this.activePrompt.status)
		) {
			return;
		}
		try {
			const result = await this.track(
				this.sendOperation(
					{
						type: "abort",
						executionId: active.executionId,
						targetRequestId: active.requestId,
						reason: "remote-client-abort",
					},
					this.nextRequestId("abort"),
					activeEpoch,
				),
			);
			if (terminalAbortResult(result)) this.clearActivePrompt(active, activeEpoch);
		} catch (error) {
			if (error instanceof RemoteSessionError && error.correlatedResponse && error.code === "EXECUTION_NOT_FOUND") {
				this.clearActivePrompt(active, activeEpoch);
			}
			throw error;
		}
	}

	subscribe(listener: RemoteSessionListener): () => void {
		this.assertUsable();
		if (!this.listeners.has(listener)) {
			this.listeners.add(listener);
			this.listenerQueues.set(listener, Promise.resolve());
		}
		return () => {
			this.listeners.delete(listener);
			this.listenerQueues.delete(listener);
		};
	}

	subscribeState(listener: RemoteSessionStateListener): () => void {
		this.assertUsable();
		this.stateListeners.add(listener);
		return () => this.stateListeners.delete(listener);
	}

	async steer(message: RuntimeAgentMessage): Promise<void> {
		this.assertUsable();
		if (!isRuntimeWireValue(message)) {
			throw new RemoteSessionError("NON_SERIALIZABLE_REQUEST", "Steering message is not valid plain wire data");
		}
		await this.ensureConnected();
		await this.track(this.sendOperation({ type: "steer", message: structuredClone(message) }));
	}

	async replaceOrAppendMessage(message: RuntimeAgentMessage, messageIndex?: number): Promise<void> {
		this.assertUsable();
		if (!isRuntimeWireValue(message)) {
			throw new RemoteSessionError("NON_SERIALIZABLE_REQUEST", "Message update is not valid plain wire data");
		}
		const ownedMessage = structuredClone(message);
		await this.ensureConnected();
		const session = this.channelState.sessions[this.sessionId];
		if (!session) throw new RemoteSessionError("SESSION_NOT_FOUND", "Remote session has no authoritative snapshot");
		await this.track(
			this.sendOperation({
				type: "replace-or-append-message",
				expectedRevision: session.revision,
				...(messageIndex !== undefined ? { messageIndex } : {}),
				message: ownedMessage,
			}),
		);
	}

	async executeArtifacts(payload: RuntimeArtifactsPayload): Promise<RuntimeValue> {
		this.assertUsable();
		if (!isRuntimeWireValue(payload)) {
			throw new RemoteSessionError("NON_SERIALIZABLE_REQUEST", "Artifact operation is not valid plain wire data");
		}
		await this.ensureConnected();
		return this.track(this.sendOperation({ type: "artifacts", payload: structuredClone(payload) }));
	}

	async executePageOperation(operation: string, params: RuntimeRecord): Promise<RuntimeValue> {
		this.assertUsable();
		if (!operation.trim()) {
			throw new RemoteSessionError("NON_SERIALIZABLE_REQUEST", "Page operation name must be non-empty");
		}
		if (!isRuntimeWireValue(params)) {
			throw new RemoteSessionError("NON_SERIALIZABLE_REQUEST", "Page operation parameters are not plain wire data");
		}
		await this.ensureConnected();
		const requestId = this.nextRequestId("page-operation");
		const executionId = this.executionIdFactory("page-operation", ++this.executionSequence);
		return this.track(
			this.sendOperation(
				{
					type: "page-operation",
					executionId,
					operation,
					params: structuredClone(params),
				},
				requestId,
			),
		);
	}

	async release(options: { force?: boolean; reason?: string } = {}): Promise<void> {
		this.assertUsable();
		await this.ensureConnected();
		await this.track(
			this.sendOperation({
				type: "release",
				...(options.force !== undefined ? { force: options.force } : {}),
				...(options.reason ? { reason: options.reason } : {}),
			}),
		);
		this.attachedEpoch = undefined;
	}

	async setModel(model: RuntimeModelDescriptor): Promise<void> {
		this.assertUsable();
		if (!isRuntimeWireValue(model)) {
			throw new RemoteSessionError("NON_SERIALIZABLE_REQUEST", "Model is not valid plain wire data");
		}
		const ownedModel = structuredClone(model);
		await this.ensureConnected();
		const epoch = this.requireRuntimeEpoch();
		const mutation: PendingModelMutation = {
			token: ++this.mutationSequence,
			epoch,
			authoritativeGeneration: this.authoritativeGeneration,
			optimistic: ownedModel,
		};
		this.pendingModelMutation = mutation;
		this.stateView.applyOptimisticModel(ownedModel);
		const operation = this.modelMutationTail.then(() => {
			this.assertMutationEpoch(epoch);
			return this.sendOperation({ type: "set-model", model: ownedModel }, undefined, epoch);
		});
		this.modelMutationTail = operation.then(
			() => {},
			() => {},
		);
		try {
			await this.track(operation);
			if (this.channelState.runtimeEpoch !== epoch) {
				throw new RemoteSessionError("STALE_REQUEST_EPOCH", "Model update completed for an obsolete runtime");
			}
			const authoritativeChanged = this.authoritativeGeneration !== mutation.authoritativeGeneration;
			if (!authoritativeChanged) this.confirmedModel = ownedModel;
			if (this.pendingModelMutation?.token === mutation.token) {
				this.pendingModelMutation = undefined;
				if (authoritativeChanged) {
					if (this.confirmedModel) this.stateView.applyOptimisticModel(this.confirmedModel);
					else this.stateView.model = null;
				}
			}
		} catch (error) {
			if (this.pendingModelMutation?.token === mutation.token && this.channelState.runtimeEpoch === epoch) {
				this.pendingModelMutation = undefined;
				if (this.confirmedModel) this.stateView.applyOptimisticModel(this.confirmedModel);
				else this.stateView.model = null;
				this.stateView.setError(error instanceof Error ? error.message : String(error));
			}
			throw error;
		}
	}

	async setThinkingLevel(thinkingLevel: RuntimeThinkingLevel): Promise<void> {
		this.assertUsable();
		await this.ensureConnected();
		const epoch = this.requireRuntimeEpoch();
		const mutation: PendingThinkingMutation = {
			token: ++this.mutationSequence,
			epoch,
			authoritativeGeneration: this.authoritativeGeneration,
			optimistic: thinkingLevel,
		};
		this.pendingThinkingMutation = mutation;
		this.stateView.applyOptimisticThinkingLevel(thinkingLevel);
		const operation = this.thinkingMutationTail.then(() => {
			this.assertMutationEpoch(epoch);
			return this.sendOperation({ type: "set-thinking", thinkingLevel }, undefined, epoch);
		});
		this.thinkingMutationTail = operation.then(
			() => {},
			() => {},
		);
		try {
			await this.track(operation);
			if (this.channelState.runtimeEpoch !== epoch) {
				throw new RemoteSessionError("STALE_REQUEST_EPOCH", "Thinking update completed for an obsolete runtime");
			}
			const authoritativeChanged = this.authoritativeGeneration !== mutation.authoritativeGeneration;
			if (!authoritativeChanged) {
				this.confirmedThinkingLevel = thinkingLevel;
			}
			if (this.pendingThinkingMutation?.token === mutation.token) {
				this.pendingThinkingMutation = undefined;
				if (authoritativeChanged) {
					this.stateView.applyOptimisticThinkingLevel(this.confirmedThinkingLevel);
				}
			}
		} catch (error) {
			if (this.pendingThinkingMutation?.token === mutation.token && this.channelState.runtimeEpoch === epoch) {
				this.pendingThinkingMutation = undefined;
				this.stateView.applyOptimisticThinkingLevel(this.confirmedThinkingLevel);
				this.stateView.setError(error instanceof Error ? error.message : String(error));
			}
			throw error;
		}
	}

	async waitForIdle(): Promise<void> {
		await Promise.allSettled([...this.pendingOperations]);
		await Promise.allSettled([...this.listenerQueues.values()]);
	}

	dispose(options: { abortActive?: boolean } = {}): void {
		if (this.disposed) return;
		const active = this.activePrompt;
		const epoch = this.channelState.runtimeEpoch;
		let abortCleanup: Promise<RuntimeValue> | undefined;
		if (options.abortActive === true && active && !terminal(active.status) && epoch) {
			abortCleanup = this.sendOperation(
				{
					type: "abort",
					executionId: active.executionId,
					targetRequestId: active.requestId,
					reason: "remote-client-dispose",
				},
				this.nextRequestId("abort"),
				epoch,
				{ allowDisposed: true, allowEpochChange: true },
			);
		}
		this.disposed = true;
		this.connectionRequested = false;
		this.rejectRecovery(this.recovery, new RemoteSessionError("DISPOSED", "Remote session client was disposed"));
		this.finishResync(this.resync);
		try {
			this.unsubscribeTransport();
		} catch (error) {
			this.onError?.(error);
		}
		this.helloConnection?.reject(new RemoteSessionError("DISPOSED", "Remote session client was disposed"));
		this.helloConnection = undefined;
		this.listenerController.abort("remote-session-disposed");
		this.epochController?.controller.abort("remote-session-disposed");
		this.listeners.clear();
		this.stateListeners.clear();
		this.listenerQueues.clear();
		this.pendingOperations.clear();
		this.pendingPromptRequestIds.clear();
		this.activePrompt = undefined;
		this.activePromptEpoch = undefined;
		if (abortCleanup) void abortCleanup.catch((error: unknown) => this.onError?.(error));
	}

	private receive(envelope: RuntimeStreamEnvelope): void {
		if (this.disposed) return;
		if (!isRuntimeStreamEnvelope(envelope)) {
			this.onError?.(new RemoteSessionError("MALFORMED_STREAM", "Transport delivered a malformed runtime stream"));
			return;
		}
		envelope = structuredClone(envelope);
		if (envelope.clientId !== this.clientId || envelope.windowId !== this.windowId) return;
		const hadPriorSession = this.channelState.sessions[this.sessionId] !== undefined;
		if (envelope.streamType === "hello") {
			const hasMismatchedCursor = envelope.recovery.sessions.some(
				(cursor) => cursor.sessionId === this.sessionId && !sameTarget(cursor.target, this.target),
			);
			if (hasMismatchedCursor) {
				this.onError?.(
					new RemoteSessionError("TARGET_MISMATCH", "Runtime hello advertised a different session target"),
				);
				envelope = {
					...envelope,
					recovery: {
						...envelope.recovery,
						sessions: envelope.recovery.sessions.filter(
							(cursor) => cursor.sessionId !== this.sessionId || sameTarget(cursor.target, this.target),
						),
					},
				};
			}
		} else {
			if (envelope.sessionId !== this.sessionId) return;
			const snapshotTarget = envelope.streamType === "session-snapshot" ? envelope.snapshot.target : envelope.target;
			if (!sameTarget(envelope.target, this.target) || !sameTarget(snapshotTarget, this.target)) {
				this.onError?.(
					new RemoteSessionError("TARGET_MISMATCH", "Runtime stream target does not match the configured target"),
				);
				return;
			}
		}
		const previousEpoch = this.channelState.runtimeEpoch;
		const reduction = reduceRuntimeStream(this.channelState, envelope);
		this.channelState = reduction.state;
		if (reduction.effect.kind === "ignored-scope") return;
		if (envelope.streamType === "hello" && previousEpoch && previousEpoch !== envelope.runtimeEpoch) {
			this.invalidateRuntimeEpoch(previousEpoch);
		}
		if (envelope.streamType === "hello") {
			this.helloSessionPresence = {
				epoch: envelope.runtimeEpoch,
				present: envelope.recovery.sessions.some(
					(cursor) => cursor.sessionId === this.sessionId && sameTarget(cursor.target, this.target),
				),
				hadPriorSession,
			};
			this.ensureEpochController(envelope.runtimeEpoch);
			this.attachedEpoch = undefined;
		}

		if (
			envelope.streamType === "session-snapshot" &&
			(reduction.effect.kind === "snapshot-applied" || reduction.effect.kind === "resynced")
		) {
			this.authoritativeGeneration++;
			const modelMatchesPending =
				this.pendingModelMutation !== undefined &&
				sameModel(envelope.snapshot.model, this.pendingModelMutation.optimistic);
			const thinkingMatchesPending =
				this.pendingThinkingMutation !== undefined &&
				envelope.snapshot.thinkingLevel === this.pendingThinkingMutation.optimistic;
			this.confirmedModel = envelope.snapshot.model;
			this.confirmedThinkingLevel = envelope.snapshot.thinkingLevel;
			this.stateView.applySnapshot(envelope.snapshot, {
				preserveModel: this.pendingModelMutation !== undefined && !modelMatchesPending,
				preserveThinkingLevel: this.pendingThinkingMutation !== undefined && !thinkingMatchesPending,
			});
			this.dispatchState(envelope.snapshot);
			const snapshotPrompt = envelope.snapshot.activeExecutions.find(
				(execution) => execution.kind === "prompt" && !terminal(execution.status),
			);
			if (snapshotPrompt) {
				const sameActive =
					this.activePrompt?.executionId === snapshotPrompt.executionId &&
					this.activePrompt.requestId === snapshotPrompt.requestId;
				if (
					!this.activePrompt ||
					sameActive ||
					this.activePrompt.status !== "queued" ||
					!this.pendingPromptRequestIds.has(this.activePrompt.requestId)
				) {
					this.activePrompt = snapshotPrompt;
					this.activePromptEpoch = envelope.runtimeEpoch;
				}
			} else if (
				this.activePrompt &&
				(this.activePrompt.status !== "queued" || !this.pendingPromptRequestIds.has(this.activePrompt.requestId))
			) {
				this.activePrompt = undefined;
				this.activePromptEpoch = undefined;
			}
			this.markRecoverySnapshot(envelope.runtimeEpoch);
			this.markResyncSnapshot(envelope.runtimeEpoch);
		}
		if (envelope.streamType === "agent-event" && reduction.effect.kind === "event-applied") {
			this.stateView.applyAgentEvent(envelope.agentEvent);
			this.dispatchEvent(envelope.agentEvent);
		}
		if (envelope.streamType === "execution" && reduction.effect.kind === "event-applied") {
			if (envelope.execution.kind === "prompt") {
				const sameActive =
					this.activePrompt?.executionId === envelope.execution.executionId &&
					this.activePrompt.requestId === envelope.execution.requestId;
				if (terminal(envelope.execution.status)) {
					if (sameActive) {
						this.activePrompt = undefined;
						this.activePromptEpoch = undefined;
					}
				} else if (!this.activePrompt || sameActive) {
					this.activePrompt = envelope.execution;
					this.activePromptEpoch = envelope.runtimeEpoch;
				}
			}
		}

		if (envelope.streamType === "hello" && this.connectionRequested) {
			this.finishResync(this.resync);
			const recoveryEpoch = envelope.runtimeEpoch;
			const recovery = this.recoverAfterHello(previousEpoch);
			if (this.observedRecovery === recovery) return;
			this.observedRecovery = recovery;
			this.track(recovery);
			void recovery
				.then(() => {
					if (this.channelState.runtimeEpoch !== recoveryEpoch) return;
					this.helloConnection?.resolve();
					this.helloConnection = undefined;
				})
				.catch((error: unknown) => {
					if (this.channelState.runtimeEpoch !== recoveryEpoch) return;
					this.helloConnection?.reject(error);
					this.helloConnection = undefined;
					if (!this.disposed) this.onError?.(error);
				})
				.finally(() => {
					if (this.observedRecovery === recovery) this.observedRecovery = undefined;
				});
			return;
		}
		if (this.requiresResync(reduction.effect)) {
			void this.track(this.requestResync(this.resyncReason(reduction.effect))).catch((error: unknown) =>
				this.onError?.(error),
			);
		}
	}

	private dispatchEvent(event: RuntimeAgentEvent): void {
		for (const listener of [...this.listeners]) {
			const previous = this.listenerQueues.get(listener) ?? Promise.resolve();
			const deliveryEvent = structuredClone(event);
			const delivery = previous
				.then(() => listener(deliveryEvent, this.listenerController.signal))
				.catch((error: unknown) => this.onError?.(error));
			this.listenerQueues.set(listener, delivery);
		}
	}

	private dispatchState(snapshot: RuntimeSessionSnapshot): void {
		for (const listener of [...this.stateListeners]) {
			try {
				listener(structuredClone(snapshot));
			} catch (error) {
				this.onError?.(error);
			}
		}
	}

	private requiresResync(effect: RuntimeChannelEffect): boolean {
		return (
			effect.kind === "sequence-gap" ||
			effect.kind === "sequence-conflict" ||
			effect.kind === "revision-regression" ||
			effect.kind === "target-mismatch" ||
			effect.kind === "resync-required" ||
			effect.kind === "resync-pending" ||
			effect.kind === "stale-epoch"
		);
	}

	private resyncReason(effect: RuntimeChannelEffect): Extract<RuntimeRequestOperation, { type: "resync" }>["reason"] {
		if (effect.kind === "revision-regression") return "revision-regression";
		if (effect.kind === "stale-epoch") return "runtime-restart";
		if (effect.kind === "sequence-gap" || effect.kind === "sequence-conflict") return "gap";
		return "explicit";
	}

	private requestResync(reason: Extract<RuntimeRequestOperation, { type: "resync" }>["reason"]): Promise<void> {
		const epoch = this.requireRuntimeEpoch();
		if (this.resync?.epoch === epoch) return this.resync.promise;
		this.finishResync(this.resync);
		const session = this.channelState.sessions[this.sessionId];
		if (!session) return this.recoverAfterHello();
		const request = createRuntimeResyncRequest(this.channelState, {
			sessionId: this.sessionId,
			requestId: this.nextRequestId("resync"),
			reason,
			...(this.trace ? { trace: this.trace } : {}),
		});
		let resolveCycle: () => void = () => {};
		let rejectCycle: (error: unknown) => void = () => {};
		const promise = new Promise<void>((resolve, reject) => {
			resolveCycle = resolve;
			rejectCycle = reject;
		});
		const cycle: ResyncCycle = {
			epoch,
			promise,
			resolve: resolveCycle,
			reject: rejectCycle,
			responseReceived: false,
			snapshotReceived: false,
			timeout: setTimeout(() => {
				if (this.resync !== cycle) return;
				const error = new RemoteSessionError("RESYNC_TIMEOUT", "Runtime resync did not produce a snapshot", true);
				this.rejectResync(cycle, error);
				if (!this.disposed && this.channelState.runtimeEpoch === epoch) {
					void this.track(this.requestResync(reason)).catch((retryError: unknown) => this.onError?.(retryError));
				}
			}, this.resyncTimeoutMs),
		};
		this.resync = cycle;
		void this.sendRequest(request)
			.then(() => {
				if (this.resync !== cycle) return;
				cycle.responseReceived = true;
				this.completeResyncIfReady(cycle);
			})
			.catch((error: unknown) => this.rejectResync(cycle, error));
		return promise;
	}

	private recoverAfterHello(previousRuntimeEpoch?: string): Promise<void> {
		const epoch = this.requireRuntimeEpoch();
		if (this.attachedEpoch === epoch) return Promise.resolve();
		if (this.recovery?.epoch === epoch) return this.recovery.promise;
		if (this.recovery) {
			this.rejectRecovery(
				this.recovery,
				new RemoteSessionError("STALE_REQUEST_EPOCH", "Runtime recovery was superseded by another epoch"),
			);
		}
		const session = this.channelState.sessions[this.sessionId];
		const presence = this.helloSessionPresence?.epoch === epoch ? this.helloSessionPresence : undefined;
		let operation: RuntimeRequestOperation;
		if (!presence || presence.present) {
			operation = {
				type: "attach",
				...(previousRuntimeEpoch ? { knownRuntimeEpoch: previousRuntimeEpoch } : {}),
				...(session ? { lastRevision: session.revision, lastEventSeq: session.lastEventSeq } : {}),
			};
		} else if (presence.hadPriorSession) {
			// The offscreen host restarted without a usable checkpoint. Recover the
			// already-observed durable session instead of accidentally recreating it.
			operation = { type: "load" };
		} else if (this.bootstrap.mode === "create") {
			operation = {
				type: "create",
				systemPrompt: this.bootstrap.systemPrompt,
				...(this.bootstrap.model ? { model: structuredClone(this.bootstrap.model) } : {}),
				...(this.bootstrap.thinkingLevel ? { thinkingLevel: this.bootstrap.thinkingLevel } : {}),
				...(this.bootstrap.initialMessages
					? { initialMessages: structuredClone(this.bootstrap.initialMessages) }
					: {}),
			};
		} else {
			operation = this.bootstrap.mode === "load" ? { type: "load" } : { type: "attach" };
		}
		let resolveCycle: () => void = () => {};
		let rejectCycle: (error: unknown) => void = () => {};
		const promise = new Promise<void>((resolve, reject) => {
			resolveCycle = resolve;
			rejectCycle = reject;
		});
		const cycle: RecoveryCycle = {
			epoch,
			promise,
			resolve: resolveCycle,
			reject: rejectCycle,
			responseReceived: false,
			snapshotReceived: false,
			timeout: setTimeout(() => {
				if (this.recovery !== cycle) return;
				this.rejectRecovery(
					cycle,
					new RemoteSessionError("RECOVERY_TIMEOUT", "Runtime attach did not produce a session snapshot", true),
				);
			}, this.resyncTimeoutMs),
		};
		this.recovery = cycle;
		void this.sendOperation(operation, undefined, epoch)
			.then(() => {
				if (this.recovery !== cycle) return;
				cycle.responseReceived = true;
				this.completeRecoveryIfReady(cycle);
			})
			.catch((error: unknown) => this.rejectRecovery(cycle, error));
		return promise;
	}

	private async ensureConnected(): Promise<void> {
		this.assertUsable();
		if (!this.connectionRequested || !this.channelState.runtimeEpoch) {
			await this.connect();
			return;
		}
		const epoch = this.requireRuntimeEpoch();
		if (this.attachedEpoch !== epoch) await this.recoverAfterHello();
	}

	private sendOperation(
		operation: RuntimeRequestOperation,
		requestId = this.nextRequestId(operation.type),
		runtimeEpoch = this.requireRuntimeEpoch(),
		options: { allowDisposed?: boolean; allowEpochChange?: boolean } = {},
	): Promise<RuntimeValue> {
		const request: RuntimeRequestEnvelope = {
			kind: "request",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch,
			clientId: this.clientId,
			windowId: this.windowId,
			sessionId: this.sessionId,
			target: this.target,
			requestId,
			...(this.trace ? { trace: this.trace } : {}),
			operation,
		};
		return this.sendRequest(request, options);
	}

	private async sendRequest(
		request: RuntimeRequestEnvelope,
		options: { allowDisposed?: boolean; allowEpochChange?: boolean } = {},
	): Promise<RuntimeValue> {
		if (!options.allowDisposed) this.assertUsable();
		if (!isRuntimeRequestEnvelope(request)) {
			throw new RemoteSessionError("NON_SERIALIZABLE_REQUEST", "Runtime request is not valid plain wire data");
		}
		if (!options.allowEpochChange && this.channelState.runtimeEpoch !== request.runtimeEpoch) {
			throw new RemoteSessionError("STALE_REQUEST_EPOCH", "Runtime request targets an obsolete runtime epoch");
		}
		const epochSignal = options.allowEpochChange
			? undefined
			: this.ensureEpochController(request.runtimeEpoch).controller.signal;
		const transportResponse = this.transport.send(structuredClone(request));
		const receivedResponse = options.allowDisposed
			? await transportResponse
			: await this.awaitTransportResponse(transportResponse, epochSignal);
		if (this.disposed && !options.allowDisposed) {
			throw new RemoteSessionError("DISPOSED", "Remote session client was disposed");
		}
		if (!options.allowEpochChange && this.channelState.runtimeEpoch !== request.runtimeEpoch) {
			throw new RemoteSessionError("STALE_REQUEST_EPOCH", "Runtime response belongs to an obsolete runtime epoch");
		}
		if (!isRuntimeResponseEnvelope(receivedResponse)) {
			throw new RemoteSessionError("MALFORMED_RESPONSE", "Transport delivered a malformed runtime response");
		}
		const response = structuredClone(receivedResponse);
		const correlation = correlateRuntimeResponse(request, response);
		if (!correlation.ok) {
			throw new RemoteSessionError(
				"UNCORRELATED_RESPONSE",
				`Runtime response did not match its request: ${correlation.mismatches.join(", ")}`,
			);
		}
		if (!response.ok) {
			throw new RemoteSessionError(
				response.error.code,
				response.error.message,
				response.error.retryable,
				response.error.details,
				true,
			);
		}
		return response.result;
	}

	private awaitTransportResponse(
		response: Promise<RuntimeResponseEnvelope>,
		epochSignal?: AbortSignal,
	): Promise<RuntimeResponseEnvelope> {
		const disposeSignal = this.listenerController.signal;
		if (disposeSignal.aborted)
			return Promise.reject(new RemoteSessionError("DISPOSED", "Remote session client was disposed"));
		if (epochSignal?.aborted) {
			return Promise.reject(
				new RemoteSessionError("STALE_REQUEST_EPOCH", "Runtime request was invalidated by a newer epoch"),
			);
		}
		return new Promise<RuntimeResponseEnvelope>((resolve, reject) => {
			let settled = false;
			const cleanup = (): void => {
				disposeSignal.removeEventListener("abort", onDisposed);
				epochSignal?.removeEventListener("abort", onEpochChanged);
			};
			const settle = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				cleanup();
				callback();
			};
			const onDisposed = (): void =>
				settle(() => reject(new RemoteSessionError("DISPOSED", "Remote session client was disposed")));
			const onEpochChanged = (): void =>
				settle(() =>
					reject(
						new RemoteSessionError("STALE_REQUEST_EPOCH", "Runtime request was invalidated by a newer epoch"),
					),
				);
			disposeSignal.addEventListener("abort", onDisposed, { once: true });
			epochSignal?.addEventListener("abort", onEpochChanged, { once: true });
			void response.then(
				(value) => settle(() => resolve(value)),
				(error: unknown) => settle(() => reject(error)),
			);
		});
	}

	private markRecoverySnapshot(epoch: string): void {
		const cycle = this.recovery;
		if (!cycle || cycle.epoch !== epoch) return;
		cycle.snapshotReceived = true;
		this.completeRecoveryIfReady(cycle);
	}

	private completeRecoveryIfReady(cycle: RecoveryCycle): void {
		if (!cycle.responseReceived || !cycle.snapshotReceived || this.recovery !== cycle) return;
		clearTimeout(cycle.timeout);
		this.recovery = undefined;
		this.attachedEpoch = cycle.epoch;
		cycle.resolve();
	}

	private rejectRecovery(cycle: RecoveryCycle | undefined, error: unknown): void {
		if (!cycle || this.recovery !== cycle) return;
		clearTimeout(cycle.timeout);
		this.recovery = undefined;
		cycle.reject(error);
	}

	private markResyncSnapshot(epoch: string): void {
		const cycle = this.resync;
		if (!cycle || cycle.epoch !== epoch) return;
		cycle.snapshotReceived = true;
		this.completeResyncIfReady(cycle);
	}

	private completeResyncIfReady(cycle: ResyncCycle): void {
		if (!cycle.responseReceived || !cycle.snapshotReceived || this.resync !== cycle) return;
		this.finishResync(cycle);
	}

	private finishResync(cycle: ResyncCycle | undefined): void {
		if (!cycle) return;
		clearTimeout(cycle.timeout);
		if (this.resync === cycle) this.resync = undefined;
		cycle.resolve();
	}

	private rejectResync(cycle: ResyncCycle, error: unknown): void {
		if (this.resync !== cycle) return;
		clearTimeout(cycle.timeout);
		this.resync = undefined;
		cycle.reject(error);
	}

	private ensureEpochController(epoch: string): { epoch: string; controller: AbortController } {
		if (this.epochController?.epoch === epoch) return this.epochController;
		this.epochController?.controller.abort("runtime-epoch-superseded");
		this.epochController = { epoch, controller: new AbortController() };
		return this.epochController;
	}

	private clearActivePrompt(active: RuntimeExecutionDescriptor, epoch: string): void {
		if (
			this.activePromptEpoch === epoch &&
			this.activePrompt?.executionId === active.executionId &&
			this.activePrompt.requestId === active.requestId
		) {
			this.activePrompt = undefined;
			this.activePromptEpoch = undefined;
		}
	}

	private invalidateRuntimeEpoch(previousEpoch: string): void {
		if (this.epochController?.epoch === previousEpoch) {
			this.epochController.controller.abort("runtime-epoch-superseded");
			this.epochController = undefined;
		}
		this.attachedEpoch = undefined;
		this.rejectRecovery(
			this.recovery,
			new RemoteSessionError("STALE_REQUEST_EPOCH", "Runtime recovery was invalidated by a newer epoch"),
		);
		if (this.pendingModelMutation?.epoch === previousEpoch) this.pendingModelMutation = undefined;
		if (this.pendingThinkingMutation?.epoch === previousEpoch) this.pendingThinkingMutation = undefined;
		this.modelMutationTail = Promise.resolve();
		this.thinkingMutationTail = Promise.resolve();
		if (this.confirmedModel) this.stateView.applyOptimisticModel(this.confirmedModel);
		else this.stateView.model = null;
		this.stateView.applyOptimisticThinkingLevel(this.confirmedThinkingLevel);
		this.pendingPromptRequestIds.clear();
		this.activePrompt = undefined;
		this.activePromptEpoch = undefined;
		if (this.resync) {
			this.rejectResync(
				this.resync,
				new RemoteSessionError("STALE_REQUEST_EPOCH", "Runtime resync was invalidated by a newer epoch"),
			);
		}
	}

	private assertMutationEpoch(epoch: string): void {
		this.assertUsable();
		if (this.channelState.runtimeEpoch !== epoch) {
			throw new RemoteSessionError("STALE_REQUEST_EPOCH", "Runtime mutation targets an obsolete runtime epoch");
		}
	}

	private requireRuntimeEpoch(): string {
		const epoch = this.channelState.runtimeEpoch;
		if (!epoch) throw new RemoteSessionError("HELLO_REQUIRED", "Runtime hello has not been received");
		return epoch;
	}

	private nextRequestId(operation: RuntimeRequestOperation["type"]): string {
		return this.requestIdFactory(operation, ++this.requestSequence);
	}

	private track<T>(promise: Promise<T>): Promise<T> {
		this.pendingOperations.add(promise);
		void promise.finally(() => this.pendingOperations.delete(promise)).catch(() => {});
		return promise;
	}

	private assertUsable(): void {
		if (this.disposed) throw new RemoteSessionError("DISPOSED", "Remote session client was disposed");
	}
}
