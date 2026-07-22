import type {
	AfterToolCallContext,
	AfterToolCallResult,
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
} from "@shuv1337/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@shuv1337/pi-ai";
import type { SessionMetadata } from "@shuv1337/pi-web-ui";
import type { SessionData } from "@shuv1337/pi-web-ui/storage/types.js";
import {
	type AgentSessionContext,
	type CreateAgentRuntimeOptions,
	createAgentRuntime,
	DEFAULT_AGENT_THINKING_LEVEL,
} from "@shuvgeist/driver/runtime";
import { browserMessageTransformer } from "../messages/message-transformer.js";
import {
	aggregateSessionUsage,
	buildSessionPreview,
	generateSessionTitle,
	type ShuvgeistSessionMetadata,
	shouldSaveSession,
} from "../sidepanel/session-metadata.js";
import type {
	OffscreenRuntimeCreateSessionInput,
	OffscreenRuntimeLoadSessionInput,
	OffscreenRuntimeOperationContext,
	OffscreenRuntimeRestoreSessionInput,
	OffscreenRuntimeSessionAdapter,
	OffscreenRuntimeSessionFactory,
	OffscreenRuntimeSessionScope,
	OffscreenRuntimeSessionState,
} from "./offscreen-runtime-host.js";
import { modelToRuntimeDescriptor, type OffscreenAgentProviderRuntime } from "./provider-runtime.js";
import type {
	RuntimeAgentEvent,
	RuntimeAgentMessage,
	RuntimeArtifactDescriptor,
	RuntimeModelDescriptor,
	RuntimeRecord,
	RuntimeThinkingLevel,
	RuntimeValue,
} from "./runtime-protocol.js";
import { buildSkillMemoryWrites, type SkillMemoryWriteInput } from "./skill-memory.js";

export interface OffscreenPersistedAgentSession {
	systemPrompt?: string;
	model: Model<Api>;
	thinkingLevel: RuntimeThinkingLevel;
	messages: AgentMessage[];
}

export interface OffscreenAgentPersistenceState {
	systemPrompt: string;
	model: Model<Api>;
	thinkingLevel: RuntimeThinkingLevel;
	messages: AgentMessage[];
}

export interface OffscreenAgentSessionPersistence {
	load(sessionId: string, signal: AbortSignal): Promise<OffscreenPersistedAgentSession | null>;
	save(sessionId: string, state: OffscreenAgentPersistenceState, signal: AbortSignal): Promise<void>;
	recordCost?(provider: string, modelId: string, cost: number, eventId: string, signal: AbortSignal): Promise<void>;
	recordSkillMemory?(input: SkillMemoryWriteInput, signal: AbortSignal): Promise<void>;
}

export interface OffscreenAgentSessionStore {
	loadSession(id: string): Promise<SessionData | null>;
	getMetadata(id: string): Promise<SessionMetadata | null>;
	save(data: SessionData, metadata: SessionMetadata): Promise<void>;
}

export interface OffscreenAgentCostStore {
	recordCost(provider: string, modelId: string, cost: number, eventId: string): Promise<void>;
}

export interface OffscreenAgentMemoryStore {
	add(input: SkillMemoryWriteInput): Promise<unknown>;
}

export interface ShuvgeistOffscreenPersistenceStorage {
	sessions: OffscreenAgentSessionStore;
	costs?: OffscreenAgentCostStore;
	memories?: OffscreenAgentMemoryStore;
}

export interface OffscreenAgentToolEnvironment {
	tools: AgentTool[];
	withParentExecution<T>(context: OffscreenRuntimeOperationContext, operation: () => Promise<T>): Promise<T>;
	listArtifacts?(): readonly RuntimeArtifactDescriptor[];
	dispose?(): Promise<void> | void;
}

export interface OffscreenAgentToolRuntimeContext extends OffscreenRuntimeSessionScope {
	agent: Agent;
	signal: AbortSignal;
}

/**
 * Creates the DOM-capable tool environment owned by the offscreen document.
 * The implementation may construct an ArtifactsPanel, sandbox REPL providers,
 * attachment providers, and tools that proxy privileged page operations back
 * through the service worker. No sidepanel object is exposed here.
 */
export interface OffscreenAgentToolRuntime {
	create(context: OffscreenAgentToolRuntimeContext): Promise<OffscreenAgentToolEnvironment>;
}

export interface OffscreenAgentLifecycleContext extends OffscreenRuntimeSessionScope {
	agent: Agent;
	plannerValidator: AgentSessionContext["plannerValidator"];
}

export interface OffscreenAgentLifecycleHooks {
	onEvent?(event: AgentEvent, context: OffscreenAgentLifecycleContext, signal: AbortSignal): Promise<void> | void;
	onError?(error: unknown, context: OffscreenRuntimeSessionScope): void;
}

export type OffscreenAgentRuntimeHooks = Pick<
	CreateAgentRuntimeOptions,
	"transformContext" | "beforeToolCall" | "afterToolCall" | "shouldStopAfterTurn" | "prepareNextTurn"
>;

export interface OffscreenAgentSessionFactoryOptions {
	providers: OffscreenAgentProviderRuntime;
	persistence: OffscreenAgentSessionPersistence;
	defaultSystemPrompt: string;
	toolRuntime?: OffscreenAgentToolRuntime;
	lifecycle?: OffscreenAgentLifecycleHooks;
	runtimeHooks?: OffscreenAgentRuntimeHooks;
	createRuntime?: (options: CreateAgentRuntimeOptions) => AgentSessionContext;
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortError("Offscreen agent operation was aborted");
}

function assertActive(disposed: boolean, signal: AbortSignal): void {
	if (disposed) throw new Error("Offscreen agent session is disposed");
	throwIfAborted(signal);
}

function normalizeRuntimeValue(value: unknown, path: string, ancestors = new Set<object>()): RuntimeValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite numbers`);
		return value;
	}
	if (typeof value !== "object") throw new Error(`${path} contains a value that cannot cross the runtime boundary`);
	if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);

	const nextAncestors = new Set(ancestors);
	nextAncestors.add(value);
	if (Array.isArray(value)) {
		return value.map((entry, index) => normalizeRuntimeValue(entry, `${path}[${index}]`, nextAncestors));
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${path} contains a non-plain object`);
	}
	const record: RuntimeRecord = {};
	for (const [key, entry] of Object.entries(value as { [key: string]: unknown })) {
		if (entry !== undefined) record[key] = normalizeRuntimeValue(entry, `${path}.${key}`, nextAncestors);
	}
	return record;
}

function serializeAgentMessage(message: AgentMessage, path = "agent message"): RuntimeAgentMessage {
	const serialized = normalizeRuntimeValue(message, path);
	if (Array.isArray(serialized) || serialized === null || typeof serialized !== "object") {
		throw new Error(`${path} must be an object`);
	}
	if (typeof serialized.role !== "string" || !serialized.role.trim()) {
		throw new Error(`${path}.role must be a non-empty string`);
	}
	return serialized as RuntimeAgentMessage;
}

function deserializeAgentMessage(message: RuntimeAgentMessage): AgentMessage {
	const cloned = structuredClone(message);
	// RuntimeAgentMessage is the wire-safe structural form of the extensible
	// AgentMessage union. The runtime protocol validates it before this boundary.
	return cloned as unknown as AgentMessage;
}

function serializeRecord(value: unknown, path: string): RuntimeRecord {
	const serialized = normalizeRuntimeValue(value, path);
	if (Array.isArray(serialized) || serialized === null || typeof serialized !== "object") {
		throw new Error(`${path} must be an object`);
	}
	return serialized;
}

function serializeAgentEvent(event: AgentEvent): RuntimeAgentEvent {
	switch (event.type) {
		case "agent_start":
			return { type: "agent_start" };
		case "agent_end":
			return { type: "agent_end", messages: event.messages.map((message) => serializeAgentMessage(message)) };
		case "turn_start":
			return { type: "turn_start" };
		case "turn_end":
			return {
				type: "turn_end",
				message: serializeAgentMessage(event.message),
				toolResults: event.toolResults.map((message) => serializeAgentMessage(message)),
			};
		case "message_start":
			return { type: "message_start", message: serializeAgentMessage(event.message) };
		case "message_update":
			return {
				type: "message_update",
				message: serializeAgentMessage(event.message),
				assistantMessageEvent: serializeRecord(event.assistantMessageEvent, "assistant message event"),
			};
		case "message_end":
			return { type: "message_end", message: serializeAgentMessage(event.message) };
		case "tool_execution_start":
			return {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: normalizeRuntimeValue(event.args, "tool arguments"),
			};
		case "tool_execution_update":
			return {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: normalizeRuntimeValue(event.args, "tool arguments"),
				partialResult: normalizeRuntimeValue(event.partialResult, "partial tool result"),
			};
		case "tool_execution_end":
			return {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: normalizeRuntimeValue(event.result, "tool result"),
				isError: event.isError,
			};
	}
}

function cloneArtifacts(environment: OffscreenAgentToolEnvironment | undefined): RuntimeArtifactDescriptor[] {
	return (environment?.listArtifacts?.() ?? []).map((artifact) => ({ ...artifact }));
}

function clonePersistenceState(state: AgentState): OffscreenAgentPersistenceState {
	return {
		systemPrompt: state.systemPrompt,
		model: state.model,
		thinkingLevel: state.thinkingLevel,
		messages: state.messages.slice(),
	};
}

function assistantCost(message: AgentMessage): number | undefined {
	if (message.role !== "assistant") return undefined;
	const total = message.usage.cost?.total;
	return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : undefined;
}

function normalizeMessageIndex(messageIndex: number | undefined, length: number): number | undefined {
	if (messageIndex === undefined || messageIndex >= length) return undefined;
	if (!Number.isInteger(messageIndex) || messageIndex < 0) {
		throw new RangeError("messageIndex must be a non-negative integer");
	}
	return messageIndex;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectSkillNames(value: unknown): string[] {
	const names = new Set<string>();
	const visited = new Set<object>();

	const collectSkillList = (skills: unknown): void => {
		if (!Array.isArray(skills)) return;
		for (const skill of skills) {
			const name =
				typeof skill === "string"
					? skill
					: isUnknownRecord(skill)
						? typeof skill.name === "string"
							? skill.name
							: typeof skill.skillName === "string"
								? skill.skillName
								: undefined
						: undefined;
			if (name?.trim()) names.add(name.trim());
		}
	};

	const visit = (entry: unknown, depth: number): void => {
		if (depth > 4 || entry === null || typeof entry !== "object") return;
		if (visited.has(entry)) return;
		visited.add(entry);
		if (Array.isArray(entry)) {
			for (const item of entry) visit(item, depth + 1);
			return;
		}
		for (const [key, nested] of Object.entries(entry)) {
			if (key === "skills") collectSkillList(nested);
			else if (nested !== null && typeof nested === "object") visit(nested, depth + 1);
		}
	};

	visit(value, 0);
	return [...names];
}

function collectStructuredNavigationSkillNames(value: unknown): string[] {
	return isUnknownRecord(value) && value.role === "navigation" ? collectSkillNames(value) : [];
}

export function createShuvgeistOffscreenSessionPersistence(
	storage: ShuvgeistOffscreenPersistenceStorage,
): OffscreenAgentSessionPersistence {
	return {
		async load(sessionId: string, signal: AbortSignal): Promise<OffscreenPersistedAgentSession | null> {
			throwIfAborted(signal);
			const session = await storage.sessions.loadSession(sessionId);
			throwIfAborted(signal);
			if (!session) return null;
			return {
				model: session.model,
				thinkingLevel: session.thinkingLevel,
				messages: session.messages.slice(),
			};
		},

		async save(sessionId: string, state: OffscreenAgentPersistenceState, signal: AbortSignal): Promise<void> {
			throwIfAborted(signal);
			if (!shouldSaveSession(state.messages)) return;
			const existing = await storage.sessions.getMetadata(sessionId);
			throwIfAborted(signal);
			const now = new Date().toISOString();
			const title = existing?.title || generateSessionTitle(state.messages);
			const createdAt = existing?.createdAt || now;
			const metadata: ShuvgeistSessionMetadata = {
				id: sessionId,
				title,
				createdAt,
				lastModified: now,
				messageCount: state.messages.length,
				usage: aggregateSessionUsage(state.messages),
				thinkingLevel: state.thinkingLevel,
				preview: buildSessionPreview(state.messages),
				modelId: state.model.id,
			};
			const data: SessionData = {
				id: sessionId,
				title,
				model: state.model,
				thinkingLevel: state.thinkingLevel,
				messages: state.messages.slice(),
				createdAt,
				lastModified: now,
			};
			await storage.sessions.save(data, metadata);
			throwIfAborted(signal);
		},

		async recordCost(
			provider: string,
			modelId: string,
			cost: number,
			eventId: string,
			signal: AbortSignal,
		): Promise<void> {
			if (!storage.costs) return;
			throwIfAborted(signal);
			await storage.costs.recordCost(provider, modelId, cost, eventId);
			throwIfAborted(signal);
		},

		async recordSkillMemory(input: SkillMemoryWriteInput, signal: AbortSignal): Promise<void> {
			if (!storage.memories) return;
			throwIfAborted(signal);
			await storage.memories.add(input);
			throwIfAborted(signal);
		},
	};
}

interface PendingSkillMemoryBatch {
	writes: SkillMemoryWriteInput[];
	nextNoteIndex: number;
}

interface OffscreenAgentSessionAdapterOptions extends OffscreenRuntimeSessionScope {
	agentSession: AgentSessionContext;
	providers: OffscreenAgentProviderRuntime;
	persistence: OffscreenAgentSessionPersistence;
	toolEnvironment?: OffscreenAgentToolEnvironment;
	lifecycle?: OffscreenAgentLifecycleHooks;
	restoredErrorMessage?: string;
}

export class OffscreenAgentSessionAdapter implements OffscreenRuntimeSessionAdapter {
	private readonly scope: OffscreenRuntimeSessionScope;
	private readonly agentSession: AgentSessionContext;
	private readonly agent: Agent;
	private readonly providers: OffscreenAgentProviderRuntime;
	private readonly persistence: OffscreenAgentSessionPersistence;
	private readonly toolEnvironment?: OffscreenAgentToolEnvironment;
	private readonly lifecycle?: OffscreenAgentLifecycleHooks;
	private readonly listeners = new Set<(event: RuntimeAgentEvent) => void>();
	private readonly recordedCostMessages = new WeakSet<AssistantMessage>();
	private readonly pendingCostMessages = new Set<AssistantMessage>();
	private readonly shownSkillNames = new Set<string>();
	private readonly unsubscribeAgent: () => void;
	private pendingSkillMemoryBatch?: PendingSkillMemoryBatch;
	private validatorNoteCursor = 0;
	private restoredErrorMessage?: string;
	private disposed = false;

	constructor(options: OffscreenAgentSessionAdapterOptions) {
		this.scope = {
			clientId: options.clientId,
			windowId: options.windowId,
			sessionId: options.sessionId,
			target: options.target,
		};
		this.agentSession = options.agentSession;
		this.agent = options.agentSession.agent;
		this.providers = options.providers;
		this.persistence = options.persistence;
		this.toolEnvironment = options.toolEnvironment;
		this.lifecycle = options.lifecycle;
		this.restoredErrorMessage = options.restoredErrorMessage;
		for (const message of this.agent.state.messages) {
			if (message.role === "assistant") this.recordedCostMessages.add(message);
			for (const skillName of collectStructuredNavigationSkillNames(message)) {
				this.shownSkillNames.add(skillName);
			}
		}
		this.unsubscribeAgent = this.agent.subscribe((event, signal) => this.handleAgentEvent(event, signal));
	}

	getState(): OffscreenRuntimeSessionState {
		const state = this.agent.state;
		return {
			systemPrompt: state.systemPrompt,
			model: modelToRuntimeDescriptor(state.model),
			thinkingLevel: state.thinkingLevel,
			messages: state.messages.map((message) => serializeAgentMessage(message)),
			tools: state.tools.map((tool) => ({
				name: tool.name,
				label: tool.label,
				...(tool.description ? { description: tool.description } : {}),
			})),
			pendingToolCallIds: [...state.pendingToolCalls],
			isStreaming: state.isStreaming,
			...(state.streamingMessage
				? { streamingMessage: serializeAgentMessage(state.streamingMessage, "streaming message") }
				: {}),
			artifacts: cloneArtifacts(this.toolEnvironment),
			...(state.errorMessage || this.restoredErrorMessage
				? { errorMessage: state.errorMessage ?? this.restoredErrorMessage }
				: {}),
		};
	}

	subscribe(listener: (event: RuntimeAgentEvent) => void): () => void {
		if (this.disposed) throw new Error("Offscreen agent session is disposed");
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(message: RuntimeAgentMessage, context: OffscreenRuntimeOperationContext): Promise<void> {
		assertActive(this.disposed, context.signal);
		this.restoredErrorMessage = undefined;
		const abort = (): void => this.agent.abort();
		context.signal.addEventListener("abort", abort, { once: true });
		try {
			const execute = () => this.agent.prompt(deserializeAgentMessage(message));
			if (this.toolEnvironment) await this.toolEnvironment.withParentExecution(context, execute);
			else await execute();
			throwIfAborted(context.signal);
		} finally {
			context.signal.removeEventListener("abort", abort);
		}
	}

	abort(_executionId: string): void {
		if (!this.disposed) this.agent.abort();
	}

	async setModel(model: RuntimeModelDescriptor, signal: AbortSignal): Promise<void> {
		assertActive(this.disposed, signal);
		const resolved = await this.providers.resolveModel(model, signal);
		throwIfAborted(signal);
		await this.providers.saveSelectedModel(resolved, signal);
		throwIfAborted(signal);
		this.agent.state.model = resolved;
		await this.persist(signal);
	}

	async setThinkingLevel(thinkingLevel: RuntimeThinkingLevel, signal: AbortSignal): Promise<void> {
		assertActive(this.disposed, signal);
		this.agent.state.thinkingLevel = thinkingLevel;
		await this.persist(signal);
	}

	steer(message: RuntimeAgentMessage, signal: AbortSignal): void {
		assertActive(this.disposed, signal);
		if (!this.agent.state.isStreaming) throw new Error("Cannot steer an idle agent session");
		this.agent.steer(deserializeAgentMessage(message));
		throwIfAborted(signal);
	}

	async replaceOrAppendMessage(
		message: RuntimeAgentMessage,
		messageIndex: number | undefined,
		signal: AbortSignal,
	): Promise<void> {
		assertActive(this.disposed, signal);
		const messages = this.agent.state.messages.slice();
		const index = normalizeMessageIndex(messageIndex, messages.length);
		const agentMessage = deserializeAgentMessage(message);
		for (const skillName of collectStructuredNavigationSkillNames(agentMessage)) {
			this.shownSkillNames.add(skillName);
		}
		if (index === undefined) messages.push(agentMessage);
		else messages[index] = agentMessage;
		this.agent.state.messages = messages;
		await this.persist(signal);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.listeners.clear();
		this.unsubscribeAgent();
		this.agent.abort();
		await this.toolEnvironment?.dispose?.();
	}

	private async handleAgentEvent(event: AgentEvent, signal: AbortSignal): Promise<void> {
		if (this.disposed) return;
		if (event.type === "agent_start") this.restoredErrorMessage = undefined;
		if (event.type === "tool_execution_end" && !event.isError) {
			for (const skillName of collectSkillNames(event.result)) this.shownSkillNames.add(skillName);
		}
		if (event.type === "message_start" || event.type === "message_end") {
			for (const skillName of collectStructuredNavigationSkillNames(event.message)) {
				this.shownSkillNames.add(skillName);
			}
		}
		try {
			const runtimeEvent = serializeAgentEvent(event);
			for (const listener of this.listeners) listener(runtimeEvent);
		} catch (error) {
			this.reportError(error);
		}

		try {
			await this.lifecycle?.onEvent?.(
				event,
				{
					...this.scope,
					agent: this.agent,
					plannerValidator: this.agentSession.plannerValidator,
				},
				signal,
			);
		} catch (error) {
			this.reportError(error);
		}
		if (event.type === "message_end") {
			try {
				await this.recordCost(event.message, signal);
			} catch (error) {
				this.reportError(error);
			}
		}
		if (event.type === "agent_end") {
			const durabilitySignal = signal.aborted ? new AbortController().signal : signal;
			try {
				await this.retryPendingCosts(durabilitySignal);
			} catch (error) {
				this.reportError(error);
			}
			try {
				await this.persistSkillMemories(durabilitySignal);
			} catch (error) {
				this.reportError(error);
			}
			try {
				await this.persist(durabilitySignal);
			} catch (error) {
				this.reportError(error);
			}
		}
	}

	private async recordCost(message: AgentMessage, signal: AbortSignal): Promise<void> {
		if (message.role !== "assistant" || this.recordedCostMessages.has(message)) return;
		const cost = assistantCost(message);
		if (cost === undefined) return;
		this.pendingCostMessages.add(message);
		const eventId = this.costEventId(message);
		await this.persistence.recordCost?.(message.provider, message.model, cost, eventId, signal);
		this.pendingCostMessages.delete(message);
		this.recordedCostMessages.add(message);
	}

	private async retryPendingCosts(signal: AbortSignal): Promise<void> {
		for (const message of [...this.pendingCostMessages]) {
			await this.recordCost(message, signal);
		}
	}

	private async persistSkillMemories(signal: AbortSignal): Promise<void> {
		if (!this.persistence.recordSkillMemory) return;
		await this.flushPendingSkillMemoryBatch(signal);

		const plannerValidator = this.agentSession.plannerValidator;
		if (!plannerValidator) return;
		const nextNoteIndex = plannerValidator.validatorNotes.length;
		const writes = buildSkillMemoryWrites({
			plannerValidator,
			skillNames: this.shownSkillNames,
			sessionId: this.scope.sessionId,
			fromNoteIndex: this.validatorNoteCursor,
		});
		if (writes.length === 0) {
			this.validatorNoteCursor = nextNoteIndex;
			return;
		}

		this.pendingSkillMemoryBatch = { writes, nextNoteIndex };
		await this.flushPendingSkillMemoryBatch(signal);
	}

	private async flushPendingSkillMemoryBatch(signal: AbortSignal): Promise<void> {
		const batch = this.pendingSkillMemoryBatch;
		if (!batch) return;
		while (batch.writes.length > 0) {
			const write = batch.writes[0];
			if (!write) break;
			await this.persistence.recordSkillMemory?.(write, signal);
			batch.writes.shift();
		}
		this.validatorNoteCursor = batch.nextNoteIndex;
		this.pendingSkillMemoryBatch = undefined;
	}

	private costEventId(message: AssistantMessage): string {
		const transcriptIndex = this.agent.state.messages.lastIndexOf(message);
		if (transcriptIndex < 0) throw new Error("Assistant cost event is missing from the durable transcript");
		return JSON.stringify([
			this.scope.sessionId,
			transcriptIndex,
			message.responseId ?? "",
			message.provider,
			message.model,
			message.timestamp,
		]);
	}

	private async persist(signal: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		await this.persistence.save(this.scope.sessionId, clonePersistenceState(this.agent.state), signal);
		throwIfAborted(signal);
	}

	private reportError(error: unknown): void {
		this.lifecycle?.onError?.(error, this.scope);
	}
}

export class OffscreenAgentSessionFactory implements OffscreenRuntimeSessionFactory {
	private readonly options: OffscreenAgentSessionFactoryOptions;

	constructor(options: OffscreenAgentSessionFactoryOptions) {
		this.options = options;
	}

	async create(input: OffscreenRuntimeCreateSessionInput): Promise<OffscreenRuntimeSessionAdapter> {
		throwIfAborted(input.signal);
		const model = input.model
			? await this.options.providers.resolveModel(input.model, input.signal)
			: await this.options.providers.resolveDefaultModel(input.signal);
		return await this.build(
			input,
			{
				systemPrompt: input.systemPrompt,
				model,
				thinkingLevel: input.thinkingLevel ?? DEFAULT_AGENT_THINKING_LEVEL,
				messages: (input.initialMessages ?? []).map((message) => deserializeAgentMessage(message)),
			},
			undefined,
		);
	}

	async load(input: OffscreenRuntimeLoadSessionInput): Promise<OffscreenRuntimeSessionAdapter> {
		throwIfAborted(input.signal);
		const persisted = await this.options.persistence.load(input.sessionId, input.signal);
		throwIfAborted(input.signal);
		if (!persisted) throw new Error(`Session not found: ${input.sessionId}`);
		return await this.build(
			input,
			{
				systemPrompt: persisted.systemPrompt ?? this.options.defaultSystemPrompt,
				model: this.options.providers.normalizeModel(persisted.model),
				thinkingLevel: persisted.thinkingLevel,
				messages: persisted.messages,
			},
			undefined,
		);
	}

	async restore(input: OffscreenRuntimeRestoreSessionInput): Promise<OffscreenRuntimeSessionAdapter> {
		throwIfAborted(input.signal);
		const model = input.snapshot.model
			? await this.options.providers.resolveModel(input.snapshot.model, input.signal)
			: await this.options.providers.resolveDefaultModel(input.signal);
		return await this.build(
			input,
			{
				systemPrompt: input.snapshot.systemPrompt,
				model,
				thinkingLevel: input.snapshot.thinkingLevel,
				messages: input.snapshot.messages.map((message) => deserializeAgentMessage(message)),
			},
			input.snapshot.errorMessage,
		);
	}

	private async build(
		scope: OffscreenRuntimeSessionScope & { signal: AbortSignal },
		initialState: OffscreenAgentPersistenceState,
		restoredErrorMessage: string | undefined,
	): Promise<OffscreenAgentSessionAdapter> {
		throwIfAborted(scope.signal);
		const plannerValidatorEnabled = await this.options.providers.isPlannerValidatorEnabled(scope.signal);
		throwIfAborted(scope.signal);
		const createRuntime = this.options.createRuntime ?? createAgentRuntime;
		const agentSession = createRuntime({
			initialState: {
				systemPrompt: initialState.systemPrompt,
				model: initialState.model,
				thinkingLevel: initialState.thinkingLevel,
				messages: initialState.messages,
				tools: [],
			},
			systemPrompt: initialState.systemPrompt,
			model: initialState.model,
			thinkingLevel: initialState.thinkingLevel,
			convertToLlm: browserMessageTransformer,
			streamFn: this.options.providers.streamFn,
			getApiKey: (provider) => this.options.providers.getApiKey(provider),
			toolExecution: "sequential",
			sessionId: scope.sessionId,
			plannerValidator: plannerValidatorEnabled ? {} : false,
			...this.options.runtimeHooks,
		});
		let toolEnvironment: OffscreenAgentToolEnvironment | undefined;
		try {
			toolEnvironment = await this.options.toolRuntime?.create({
				clientId: scope.clientId,
				windowId: scope.windowId,
				sessionId: scope.sessionId,
				target: scope.target,
				agent: agentSession.agent,
				signal: scope.signal,
			});
			throwIfAborted(scope.signal);
			agentSession.agent.state.tools = toolEnvironment?.tools ?? [];
			return new OffscreenAgentSessionAdapter({
				clientId: scope.clientId,
				windowId: scope.windowId,
				sessionId: scope.sessionId,
				target: scope.target,
				agentSession,
				providers: this.options.providers,
				persistence: this.options.persistence,
				toolEnvironment,
				lifecycle: this.options.lifecycle,
				restoredErrorMessage,
			});
		} catch (error) {
			agentSession.agent.abort();
			await toolEnvironment?.dispose?.();
			throw error;
		}
	}
}

export type OffscreenAgentBeforeToolCall = (
	context: BeforeToolCallContext,
	signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

export type OffscreenAgentAfterToolCall = (
	context: AfterToolCallContext,
	signal?: AbortSignal,
) => Promise<AfterToolCallResult | undefined>;
