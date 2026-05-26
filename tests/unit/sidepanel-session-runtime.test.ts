import type { Agent, AgentMessage, AgentState } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import { ErrorCodes, type SessionArtifactsResult } from "../../src/bridge/protocol.js";
import { SidepanelSessionRuntime, type SidepanelSessionRuntimeDeps } from "../../src/sidepanel/session-runtime.js";

function testModel(id = "model-1", provider = "provider-1"): Model<any> {
	return { id, provider, api: "openai" } as Model<any>;
}

function userMessage(content: string): AgentMessage {
	return { role: "user", content, timestamp: 1 } as AgentMessage;
}

function assistantMessage(content: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: "openai",
		provider: "provider-1",
		model: "model-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	} as AgentMessage;
}

function createHarness(options: { sessionId?: string; title?: string; messages?: AgentMessage[]; isStreaming?: boolean } = {}) {
	let sessionId = options.sessionId;
	let title = options.title ?? "";
	let agent = {
		state: {
			messages: options.messages ?? [],
			isStreaming: options.isStreaming ?? false,
			model: testModel(),
			thinkingLevel: "medium",
			tools: [],
			systemPrompt: "system",
		} as unknown as AgentState,
		waitForIdle: vi.fn(async () => {
			agent.state.isStreaming = false;
		}),
		prompt: vi.fn(async (message: AgentMessage) => {
			agent.state.messages = [...agent.state.messages, message];
		}),
	};
	const artifacts: SessionArtifactsResult = {
		sessionId,
		artifacts: [{ filename: "artifact.txt", content: "data", createdAt: "2026-01-01", updatedAt: "2026-01-02" }],
	};
	const deps: SidepanelSessionRuntimeDeps = {
		getAgent: () => agent as unknown as Agent,
		getSessionId: () => sessionId,
		setSessionId: vi.fn((nextSessionId) => {
			sessionId = nextSessionId;
		}),
		getTitle: () => title,
		setTitle: vi.fn((nextTitle) => {
			title = nextTitle;
		}),
		systemPrompt: "system prompt",
		saveSession: vi.fn(async () => {}),
		render: vi.fn(),
		emitSessionChanged: vi.fn(),
		emitSessionMessage: vi.fn(),
		updateUrl: vi.fn(),
		createAgent: vi.fn(async (initialState) => {
			agent = {
				...agent,
				state: {
					messages: initialState?.messages ?? [],
					isStreaming: false,
					model: initialState?.model ?? testModel("default-model"),
					thinkingLevel: initialState?.thinkingLevel ?? "medium",
					tools: initialState?.tools ?? [],
					systemPrompt: initialState?.systemPrompt ?? "system",
				} as unknown as AgentState,
			};
		}),
		resolveModelSpec: vi.fn(async (spec: string, providerHint?: string) => testModel(spec, providerHint ?? "resolved")),
		normalizeModelForRuntime: vi.fn((model) => ({ ...model, id: `normalized-${model.id}` }) as Model<any>),
		requestModelUiUpdate: vi.fn(),
		setLastUsedModel: vi.fn(async () => {}),
		updateAuthLabel: vi.fn(async () => {}),
		getArtifactsResult: vi.fn(() => artifacts),
		logSessionIdleWait: vi.fn(),
		createSessionId: vi.fn(() => "new-session"),
	};
	return { runtime: new SidepanelSessionRuntime(deps), deps, get agent() { return agent; } };
}

describe("SidepanelSessionRuntime", () => {
	it("projects the current session snapshot", () => {
		const { runtime } = createHarness({
			sessionId: "session-1",
			title: "Session title",
			messages: [userMessage("hello"), assistantMessage("hi")],
		});

		expect(runtime.getSnapshot()).toMatchObject({
			sessionId: "session-1",
			persisted: true,
			title: "Session title",
			model: { provider: "provider-1", id: "model-1" },
			isStreaming: false,
			messageCount: 2,
			lastMessageIndex: 1,
		});
		expect(runtime.getSnapshot().messages.map((message) => message.text)).toEqual(["hello", "hi"]);
	});

	it("rejects writes without an active persisted session", async () => {
		const { runtime } = createHarness();

		await expect(
			runtime.appendInjectedMessage({ expectedSessionId: "missing", role: "assistant", content: "hi" }),
		).rejects.toMatchObject({ code: ErrorCodes.NO_ACTIVE_SESSION });
	});

	it("rejects writes against a stale expected session id", async () => {
		const { runtime } = createHarness({ sessionId: "current" });

		await expect(
			runtime.appendInjectedMessage({ expectedSessionId: "stale", role: "assistant", content: "hi" }),
		).rejects.toMatchObject({ code: ErrorCodes.SESSION_MISMATCH });
	});

	it("rejects busy sessions when waitForIdle is disabled", async () => {
		const { runtime } = createHarness({ sessionId: "session-1", isStreaming: true });

		await expect(
			runtime.appendInjectedMessage({
				expectedSessionId: "session-1",
				role: "assistant",
				content: "hi",
				waitForIdle: false,
			}),
		).rejects.toMatchObject({ code: ErrorCodes.SESSION_BUSY });
	});

	it("appends assistant messages, saves, renders, and emits bridge updates", async () => {
		const { runtime, deps, agent } = createHarness({
			sessionId: "session-1",
			messages: [userMessage("Summarize the bridge runtime. More details")],
		});

		const result = await runtime.appendInjectedMessage({
			expectedSessionId: "session-1",
			role: "assistant",
			content: "done",
		});

		expect(result).toEqual({ ok: true, sessionId: "session-1", messageIndex: 1 });
		expect(agent.state.messages).toHaveLength(2);
		expect(deps.setTitle).toHaveBeenCalledWith("Summarize the bridge runtime.");
		expect(deps.saveSession).toHaveBeenCalledOnce();
		expect(deps.render).toHaveBeenCalledOnce();
		expect(deps.emitSessionMessage).toHaveBeenCalledWith(agent.state.messages[1], 1);
		expect(deps.emitSessionChanged).toHaveBeenCalledOnce();
	});

	it("creates a fresh session with an optional resolved model", async () => {
		const { runtime, deps } = createHarness({ sessionId: "old-session", isStreaming: true });

		const result = await runtime.newSession({ model: "anthropic/model-a" });

		expect(deps.getAgent().waitForIdle).toHaveBeenCalledOnce();
		expect(deps.resolveModelSpec).toHaveBeenCalledWith("anthropic/model-a");
		expect(deps.createAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				model: expect.objectContaining({ id: "anthropic/model-a", provider: "resolved" }),
				systemPrompt: "system prompt",
				messages: [],
				tools: [],
			}),
		);
		expect(deps.setSessionId).toHaveBeenLastCalledWith("new-session");
		expect(deps.updateUrl).toHaveBeenCalledWith("new-session");
		expect(result).toEqual({ ok: true, sessionId: "new-session", model: { provider: "resolved", id: "anthropic/model-a" } });
	});

	it("sets the active model and persists the choice", async () => {
		const { runtime, deps } = createHarness({ sessionId: "session-1" });

		const result = await runtime.setModel({ model: "model-a", provider: "provider-a" });

		expect(deps.resolveModelSpec).toHaveBeenCalledWith("model-a", "provider-a");
		expect(deps.normalizeModelForRuntime).toHaveBeenCalledWith(expect.objectContaining({ id: "model-a" }));
		expect(deps.getAgent().state.model).toMatchObject({ id: "normalized-model-a", provider: "provider-a" });
		expect(deps.requestModelUiUpdate).toHaveBeenCalledOnce();
		expect(deps.setLastUsedModel).toHaveBeenCalledWith(expect.objectContaining({ id: "normalized-model-a" }));
		expect(deps.updateAuthLabel).toHaveBeenCalledOnce();
		expect(deps.emitSessionChanged).toHaveBeenCalledOnce();
		expect(deps.render).toHaveBeenCalledOnce();
		expect(result).toEqual({ ok: true, model: { provider: "provider-a", id: "normalized-model-a" } });
	});

	it("returns the current artifacts result", () => {
		const { runtime } = createHarness({ sessionId: "session-1" });

		expect(runtime.getArtifacts()).toMatchObject({
			sessionId: "session-1",
			artifacts: [{ filename: "artifact.txt", content: "data" }],
		});
	});
});
