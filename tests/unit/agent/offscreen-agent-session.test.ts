import type { AgentMessage, AgentTool, StreamFn } from "@shuv1337/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	Type,
} from "@shuv1337/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	OffscreenAgentSessionFactory,
	createShuvgeistOffscreenSessionPersistence,
	type OffscreenAgentPersistenceState,
	type OffscreenAgentSessionPersistence,
	type OffscreenAgentToolRuntimeContext,
} from "@shuvgeist/extension/agent/offscreen-agent-session";
import type {
	OffscreenRuntimeOperationContext,
	OffscreenRuntimeSessionAdapter,
} from "@shuvgeist/extension/agent/offscreen-runtime-host";
import type { OffscreenAgentProviderRuntime } from "@shuvgeist/extension/agent/provider-runtime";
import type { SkillMemoryWriteInput } from "@shuvgeist/extension/agent/skill-memory";
import type {
	RuntimeAgentEvent,
	RuntimeAgentMessage,
	RuntimeSessionSnapshot,
	RuntimeTargetIdentity,
} from "@shuvgeist/extension/agent/runtime-protocol";

const target: RuntimeTargetIdentity = { kind: "chrome-tab", tabId: 41, frameId: 0 };

const model: Model<Api> = {
	id: "model-a",
	name: "Model A",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "https://example.test/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

const replacementModel: Model<Api> = {
	...model,
	id: "model-b",
	name: "Model B",
};

function assistantMessage(text: string, cost = 0, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 10,
			output: 4,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 14,
			cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason,
		timestamp: 2,
	};
}

function userMessage(text: string, timestamp = 1): RuntimeAgentMessage {
	return { role: "user", content: text, timestamp };
}

function completedStream(text = "done", cost = 0): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message = assistantMessage(text, cost);
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

function toolUseStream(toolName: string, toolCallId = "call-1"): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			...assistantMessage("", 0, "toolUse"),
			content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
		};
		stream.push({ type: "done", reason: "toolUse", message });
	});
	return stream;
}

function toolThenDoneProvider(toolName = "navigate"): TestProviderRuntime {
	let streamIndex = 0;
	return new TestProviderRuntime(() => {
		const stream = streamIndex === 0 ? toolUseStream(toolName) : completedStream();
		streamIndex++;
		return stream;
	});
}

class TestProviderRuntime implements OffscreenAgentProviderRuntime {
	readonly resolveModelCalls: string[] = [];
	readonly selectedModelIds: string[] = [];
	readonly streamFn: StreamFn;
	plannerValidatorEnabled = true;

	constructor(streamFn: StreamFn = () => completedStream()) {
		this.streamFn = streamFn;
	}

	async getApiKey(provider: string): Promise<string | undefined> {
		return provider === model.provider ? "secret" : undefined;
	}

	async resolveModel(descriptor: { provider: string; id: string }, signal: AbortSignal): Promise<Model<Api>> {
		if (signal.aborted) throw new DOMException("aborted", "AbortError");
		this.resolveModelCalls.push(`${descriptor.provider}/${descriptor.id}`);
		return descriptor.id === replacementModel.id ? replacementModel : model;
	}

	async resolveDefaultModel(signal: AbortSignal): Promise<Model<Api>> {
		if (signal.aborted) throw new DOMException("aborted", "AbortError");
		return model;
	}

	normalizeModel(value: Model<Api>): Model<Api> {
		return value;
	}

	async saveSelectedModel(value: Model<Api>, signal: AbortSignal): Promise<void> {
		if (signal.aborted) throw new DOMException("aborted", "AbortError");
		this.selectedModelIds.push(value.id);
	}

	async isPlannerValidatorEnabled(signal: AbortSignal): Promise<boolean> {
		if (signal.aborted) throw new DOMException("aborted", "AbortError");
		return this.plannerValidatorEnabled;
	}
}

class TestPersistence implements OffscreenAgentSessionPersistence {
	loaded: { systemPrompt?: string; model: Model<Api>; thinkingLevel: "low"; messages: AgentMessage[] } | null = null;
	readonly saves: Array<{ sessionId: string; state: OffscreenAgentPersistenceState }> = [];
	readonly costs: Array<{ provider: string; modelId: string; cost: number; eventId: string }> = [];
	readonly memories: SkillMemoryWriteInput[] = [];

	async load(): Promise<typeof this.loaded> {
		return this.loaded;
	}

	async save(sessionId: string, state: OffscreenAgentPersistenceState): Promise<void> {
		this.saves.push({ sessionId, state: { ...state, messages: state.messages.slice() } });
	}

	async recordCost(provider: string, modelId: string, cost: number, eventId: string): Promise<void> {
		this.costs.push({ provider, modelId, cost, eventId });
	}

	async recordSkillMemory(input: SkillMemoryWriteInput): Promise<void> {
		this.memories.push({ ...input });
	}
}

function factoryOptions(
	providers: TestProviderRuntime,
	persistence: TestPersistence,
	overrides: Partial<ConstructorParameters<typeof OffscreenAgentSessionFactory>[0]> = {},
): ConstructorParameters<typeof OffscreenAgentSessionFactory>[0] {
	return {
		providers,
		persistence,
		defaultSystemPrompt: "Default system prompt",
		...overrides,
	};
}

function createInput(signal = new AbortController().signal) {
	return {
		clientId: "sidepanel",
		windowId: 9,
		sessionId: "session-1",
		target,
		systemPrompt: "Be exact.",
		model: { provider: model.provider, id: model.id },
		thinkingLevel: "high" as const,
		initialMessages: [userMessage("earlier", 0)],
		signal,
	};
}

let promptContextSequence = 0;

function promptContext(
	session: OffscreenRuntimeSessionAdapter,
	overrides: Partial<OffscreenRuntimeOperationContext> = {},
	signal = new AbortController().signal,
): OffscreenRuntimeOperationContext {
	promptContextSequence++;
	return {
		runtimeEpoch: "epoch-1",
		clientId: "sidepanel",
		windowId: 9,
		sessionId: "session-1",
		target,
		requestId: `prompt-request-${promptContextSequence}`,
		executionId: `prompt-execution-${promptContextSequence}`,
		signal,
		session,
		...overrides,
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Condition was not reached");
}

describe("OffscreenAgentSessionFactory", () => {
	it("owns a concrete sequential Pi agent with offscreen tools and artifact state", async () => {
		const providers = new TestProviderRuntime();
		const persistence = new TestPersistence();
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema, null> = {
			name: "navigate",
			label: "Navigate",
			description: "Navigate the current target",
			parameters: toolSchema,
			async execute() {
				return { content: [{ type: "text", text: "ok" }], details: null };
			},
		};
		let runtimeContext: OffscreenAgentToolRuntimeContext | undefined;
		const dispose = vi.fn();
		const factory = new OffscreenAgentSessionFactory(
			factoryOptions(providers, persistence, {
				toolRuntime: {
					async create(context) {
						runtimeContext = context;
						return {
							tools: [tool],
							async withParentExecution(_context, operation) {
								return operation();
							},
							listArtifacts: () => [
								{ filename: "report.html", mimeType: "text/html", size: 42 },
							],
							dispose,
						};
					},
				},
			}),
		);

		const adapter = await factory.create(createInput());

		expect(runtimeContext).toMatchObject({
			clientId: "sidepanel",
			windowId: 9,
			sessionId: "session-1",
			target,
		});
		expect(runtimeContext?.agent.toolExecution).toBe("sequential");
		expect(runtimeContext?.agent.convertToLlm).toBeTypeOf("function");
		expect(runtimeContext?.agent.transformContext).toBeTypeOf("function");
		expect(adapter.getState()).toMatchObject({
			systemPrompt: "Be exact.",
			model: { provider: model.provider, id: model.id },
			thinkingLevel: "high",
			messages: [userMessage("earlier", 0)],
			tools: [{ name: "navigate", label: "Navigate", description: "Navigate the current target" }],
			artifacts: [{ filename: "report.html", mimeType: "text/html", size: 42 }],
		});

		await adapter.dispose?.();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("streams Pi events, preserves the full transcript, persists once at run end, and records cost", async () => {
		const providers = new TestProviderRuntime(() => completedStream("answer", 0.25));
		const persistence = new TestPersistence();
		const adapter = await new OffscreenAgentSessionFactory(factoryOptions(providers, persistence)).create(
			createInput(),
		);
		const events: RuntimeAgentEvent[] = [];
		adapter.subscribe((event) => events.push(event));

		await adapter.prompt(userMessage("current", 3), promptContext(adapter));

		expect(adapter.getState().messages.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
		const agentEnd = events.find((event) => event.type === "agent_end");
		expect(agentEnd).toMatchObject({ type: "agent_end", messages: [{ role: "user" }, { role: "assistant" }] });
		expect(persistence.saves).toHaveLength(1);
		expect(persistence.saves[0]?.state.messages.map((message) => message.role)).toEqual([
			"user",
			"user",
			"assistant",
		]);
		expect(persistence.costs).toEqual([
			{
				provider: model.provider,
				modelId: model.id,
				cost: 0.25,
				eventId: JSON.stringify(["session-1", 2, "", model.provider, model.id, 2]),
			},
		]);
	});

	it("retries a failed cost write with the same durable event identity at agent end", async () => {
		const providers = new TestProviderRuntime(() => completedStream("answer", 0.25));
		const persistence = new TestPersistence();
		const attemptedEventIds: string[] = [];
		const baseRecordCost = persistence.recordCost.bind(persistence);
		let shouldFail = true;
		persistence.recordCost = async (provider, modelId, cost, eventId) => {
			attemptedEventIds.push(eventId);
			if (shouldFail) {
				shouldFail = false;
				throw new Error("transient cost write failure");
			}
			await baseRecordCost(provider, modelId, cost, eventId);
		};
		const onError = vi.fn();
		const adapter = await new OffscreenAgentSessionFactory(
			factoryOptions(providers, persistence, { lifecycle: { onError } }),
		).create(createInput());

		await adapter.prompt(userMessage("current", 3), promptContext(adapter));

		expect(attemptedEventIds).toHaveLength(2);
		expect(new Set(attemptedEventIds).size).toBe(1);
		expect(persistence.costs).toHaveLength(1);
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "transient cost write failure" }),
			expect.objectContaining({ sessionId: "session-1" }));
	});

	it("keeps tool-result and structured-navigation skills isolated to their session adapter", async () => {
		const toolSchema = Type.Object({});
		const persistence = new TestPersistence();
		const firstTool: AgentTool<typeof toolSchema, { navigation: { skills: Array<{ name: string }> } }> = {
			name: "navigate",
			label: "Navigate",
			description: "Navigate",
			parameters: toolSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "Opened Gmail successfully." }],
					details: { navigation: { skills: [{ name: "gmail" }] } },
				};
			},
		};
		const secondTool: AgentTool<typeof toolSchema, { skills: never[] }> = {
			...firstTool,
			async execute() {
				return {
					content: [{ type: "text", text: "Opened an unrelated page." }],
					details: { skills: [] },
				};
			},
		};
		const firstAdapter = await new OffscreenAgentSessionFactory(
			factoryOptions(toolThenDoneProvider(), persistence, {
				toolRuntime: {
					async create() {
						return { tools: [firstTool], withParentExecution: async (_context, operation) => operation() };
					},
				},
			}),
		).create(createInput());
		const secondAdapter = await new OffscreenAgentSessionFactory(
			factoryOptions(toolThenDoneProvider(), persistence, {
				toolRuntime: {
					async create() {
						return { tools: [secondTool], withParentExecution: async (_context, operation) => operation() };
					},
				},
			}),
		).create({ ...createInput(), windowId: 10, sessionId: "session-2" });

		await firstAdapter.prompt(userMessage("open mail"), promptContext(firstAdapter));
		await secondAdapter.replaceOrAppendMessage(
			{
				role: "navigation",
				url: "https://calendar.example.test",
				title: "Calendar",
				skillsOutput: "Calendar skill",
				skills: [{ name: "calendar" }],
			},
			undefined,
			new AbortController().signal,
		);
		await secondAdapter.prompt(
			userMessage("open page"),
			promptContext(secondAdapter, { windowId: 10, sessionId: "session-2" }),
		);

		expect(persistence.memories).toEqual([
			expect.objectContaining({
				skillName: "gmail",
				sessionId: "session-1",
				noteId: "validator-note:0",
				note: "Opened Gmail successfully.",
			}),
			expect.objectContaining({
				skillName: "calendar",
				sessionId: "session-2",
				noteId: "validator-note:0",
				note: "Opened an unrelated page.",
			}),
		]);
	});

	it("keeps failed skill-memory writes retryable with the same durable identity", async () => {
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema, { skills: Array<{ name: string }> }> = {
			name: "navigate",
			label: "Navigate",
			description: "Navigate",
			parameters: toolSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "Opened Gmail successfully." }],
					details: { skills: [{ name: "gmail" }] },
				};
			},
		};
		const persistence = new TestPersistence();
		const attempts: SkillMemoryWriteInput[] = [];
		const baseRecordSkillMemory = persistence.recordSkillMemory.bind(persistence);
		let shouldFail = true;
		persistence.recordSkillMemory = async (input) => {
			attempts.push({ ...input });
			if (shouldFail) {
				shouldFail = false;
				throw new Error("transient skill memory failure");
			}
			await baseRecordSkillMemory(input);
		};
		const onError = vi.fn();
		const adapter = await new OffscreenAgentSessionFactory(
			factoryOptions(toolThenDoneProvider(), persistence, {
				toolRuntime: {
					async create() {
						return { tools: [tool], withParentExecution: async (_context, operation) => operation() };
					},
				},
				lifecycle: { onError },
			}),
		).create(createInput());

		await adapter.prompt(userMessage("open mail"), promptContext(adapter));
		expect(persistence.memories).toHaveLength(0);
		await adapter.prompt(userMessage("continue"), promptContext(adapter));

		expect(attempts).toHaveLength(2);
		expect(attempts[1]).toEqual(attempts[0]);
		expect(persistence.memories).toEqual([attempts[0]]);
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({ message: "transient skill memory failure" }),
			expect.objectContaining({ sessionId: "session-1" }),
		);
	});

	it("does not persist skill memories after planner drift", async () => {
		const toolSchema = Type.Object({});
		const tool: AgentTool<typeof toolSchema, { skills: Array<{ name: string }> }> = {
			name: "navigate",
			label: "Navigate",
			description: "Navigate",
			parameters: toolSchema,
			async execute() {
				return {
					content: [{ type: "text", text: "Unexpected navigation caused trajectory drift." }],
					details: { skills: [{ name: "gmail" }] },
				};
			},
		};
		const persistence = new TestPersistence();
		const adapter = await new OffscreenAgentSessionFactory(
			factoryOptions(toolThenDoneProvider(), persistence, {
				toolRuntime: {
					async create() {
						return { tools: [tool], withParentExecution: async (_context, operation) => operation() };
					},
				},
			}),
		).create(createInput());

		await adapter.prompt(userMessage("open mail"), promptContext(adapter));

		expect(persistence.memories).toEqual([]);
	});

	it("queues steering through Agent.steer only while a run is active", async () => {
		const streams: ReturnType<typeof createAssistantMessageEventStream>[] = [];
		const contexts: Context[] = [];
		const providers = new TestProviderRuntime((_model, context) => {
			contexts.push({ ...context, messages: context.messages.slice() });
			const stream = createAssistantMessageEventStream();
			streams.push(stream);
			return stream;
		});
		const persistence = new TestPersistence();
		const adapter = await new OffscreenAgentSessionFactory(factoryOptions(providers, persistence)).create(
			createInput(),
		);
		const signal = new AbortController().signal;
		const run = adapter.prompt(userMessage("start"), promptContext(adapter, {}, signal));
		await waitFor(() => streams.length === 1);

		adapter.steer(userMessage("change course", 4), signal);
		const first = assistantMessage("first");
		streams[0]?.push({ type: "done", reason: "stop", message: first });
		await waitFor(() => streams.length === 2);
		expect(contexts[1]?.messages.map((message) => message.role)).toEqual([
			"user",
			"user",
			"user",
			"assistant",
			"user",
		]);
		const second = assistantMessage("second");
		streams[1]?.push({ type: "done", reason: "stop", message: second });
		await run;

		expect(adapter.getState().messages.map((message) => message.role)).toEqual([
			"user",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(() => adapter.steer(userMessage("too late"), signal)).toThrow("Cannot steer an idle agent session");
	});

	it("links host cancellation to the concrete Agent abort signal", async () => {
		let providerSignal: AbortSignal | undefined;
		const providers = new TestProviderRuntime((_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			providerSignal = options?.signal;
			providerSignal?.addEventListener(
				"abort",
				() => {
					const message = assistantMessage("", 0, "aborted");
					stream.push({ type: "error", reason: "aborted", error: message });
				},
				{ once: true },
			);
			return stream;
		});
		const persistence = new TestPersistence();
		const adapter = await new OffscreenAgentSessionFactory(factoryOptions(providers, persistence)).create(
			createInput(),
		);
		const controller = new AbortController();
		const run = adapter.prompt(userMessage("cancel me"), promptContext(adapter, {}, controller.signal));
		await waitFor(() => providerSignal !== undefined);

		controller.abort("test cancellation");

		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(providerSignal?.aborted).toBe(true);
		expect(adapter.getState()).toMatchObject({ isStreaming: false });
		expect(persistence.saves).toHaveLength(1);
		expect(persistence.saves[0]?.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "aborted",
		});
	});

	it("loads durable sessions and restores checkpoint errors without reviving active execution state", async () => {
		const providers = new TestProviderRuntime();
		const persistence = new TestPersistence();
		persistence.loaded = {
			model,
			thinkingLevel: "low",
			messages: [{ role: "user", content: "loaded", timestamp: 1 }],
		};
		const factory = new OffscreenAgentSessionFactory(factoryOptions(providers, persistence));
		const signal = new AbortController().signal;
		const loaded = await factory.load({
			clientId: "sidepanel",
			windowId: 9,
			sessionId: "loaded-session",
			target,
			signal,
		});
		expect(loaded.getState()).toMatchObject({
			systemPrompt: "Default system prompt",
			thinkingLevel: "low",
			messages: [{ role: "user", content: "loaded" }],
		});

		const snapshot: RuntimeSessionSnapshot = {
			sessionId: "restored-session",
			target,
			revision: 7,
			systemPrompt: "Restored prompt",
			model: { provider: model.provider, id: model.id },
			thinkingLevel: "medium",
			messages: [userMessage("restored")],
			tools: [],
			pendingToolCallIds: [],
			isStreaming: false,
			activeExecutions: [],
			artifacts: [],
			errorMessage: "Runtime resumed after active execution state was lost",
		};
		const restored = await factory.restore({
			clientId: "sidepanel",
			windowId: 9,
			sessionId: "restored-session",
			target,
			snapshot,
			signal,
		});
		expect(restored.getState()).toMatchObject({
			systemPrompt: "Restored prompt",
			isStreaming: false,
			pendingToolCallIds: [],
			errorMessage: "Runtime resumed after active execution state was lost",
		});
	});

	it("resolves model mutations and persists transcript mutations at the offscreen owner", async () => {
		const providers = new TestProviderRuntime();
		const persistence = new TestPersistence();
		const adapter = await new OffscreenAgentSessionFactory(factoryOptions(providers, persistence)).create(
			createInput(),
		);
		const signal = new AbortController().signal;

		await adapter.setModel({ provider: model.provider, id: replacementModel.id }, signal);
		await adapter.setThinkingLevel("minimal", signal);
		await adapter.replaceOrAppendMessage(userMessage("replacement"), 0, signal);
		await adapter.replaceOrAppendMessage(userMessage("appended"), undefined, signal);

		expect(providers.resolveModelCalls).toEqual([
			`${model.provider}/${model.id}`,
			`${model.provider}/${replacementModel.id}`,
		]);
		expect(providers.selectedModelIds).toEqual([replacementModel.id]);
		expect(adapter.getState()).toMatchObject({
			model: { id: replacementModel.id },
			thinkingLevel: "minimal",
			messages: [userMessage("replacement"), userMessage("appended")],
		});
		expect(persistence.saves).toHaveLength(4);
	});
});

describe("createShuvgeistOffscreenSessionPersistence", () => {
	it("writes full session data and metadata through the Shuvgeist stores", async () => {
		const saved: Array<{ data: SessionData; metadata: SessionMetadata }> = [];
		const recordCost = vi.fn(async () => {});
		const addMemory = vi.fn(async () => ({}));
		const persistence = createShuvgeistOffscreenSessionPersistence({
			sessions: {
				async loadSession() {
					return null;
				},
				async getMetadata() {
					return {
						id: "session-1",
						title: "Existing title",
						createdAt: "2026-01-01T00:00:00.000Z",
						lastModified: "2026-01-01T00:00:00.000Z",
						messageCount: 1,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						thinkingLevel: "medium",
						preview: "",
					};
				},
				async save(data, metadata) {
					saved.push({ data, metadata });
				},
			},
			costs: { recordCost },
			memories: { add: addMemory },
		});
		const state: OffscreenAgentPersistenceState = {
			systemPrompt: "Prompt",
			model,
			thinkingLevel: "medium",
			messages: [
				{ role: "user", content: "Question", timestamp: 1 },
				assistantMessage("Answer", 0.5),
			],
		};
		const signal = new AbortController().signal;

		await persistence.save("session-1", state, signal);
		await persistence.recordCost?.(model.provider, model.id, 0.5, "session-1:cost-1", signal);
		const memory: SkillMemoryWriteInput = {
			skillName: "gmail",
			sessionId: "session-1",
			createdAt: "2026-06-01T10:00:00.000Z",
			noteId: "validator-note:0",
			note: "Opened Gmail successfully.",
			toolName: "navigate",
			turn: 1,
		};
		await persistence.recordSkillMemory?.(memory, signal);

		expect(saved).toHaveLength(1);
		expect(saved[0]?.data).toMatchObject({
			id: "session-1",
			title: "Existing title",
			model,
			thinkingLevel: "medium",
		});
		expect(saved[0]?.metadata).toMatchObject({
			id: "session-1",
			title: "Existing title",
			createdAt: "2026-01-01T00:00:00.000Z",
			messageCount: 2,
			usage: { cost: { total: 0.5 } },
		});
		expect(recordCost).toHaveBeenCalledWith(model.provider, model.id, 0.5, "session-1:cost-1");
		expect(addMemory).toHaveBeenCalledWith(memory);
	});

	it("does not create empty sessions before a user and assistant exchange exists", async () => {
		const save = vi.fn(async () => {});
		const persistence = createShuvgeistOffscreenSessionPersistence({
			sessions: {
				async loadSession() {
					return null;
				},
				async getMetadata() {
					return null;
				},
				save,
			},
		});

		await persistence.save(
			"session-1",
			{
				systemPrompt: "Prompt",
				model,
				thinkingLevel: "medium",
				messages: [{ role: "user", content: "Only a question", timestamp: 1 }],
			},
			new AbortController().signal,
		);

		expect(save).not.toHaveBeenCalled();
	});
});
