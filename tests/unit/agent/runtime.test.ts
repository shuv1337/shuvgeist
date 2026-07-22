import { createAgentRuntime } from "@shuvgeist/driver/runtime";

const model = {
	id: "test",
	name: "Test",
	api: "test",
	provider: "test",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

describe("createAgentRuntime", () => {
	it("keeps planner-validator hooks opt-in", () => {
		const runtime = createAgentRuntime({ systemPrompt: "Prompt", model });
		expect(runtime.plannerValidator).toBeUndefined();
		expect(runtime.agent.transformContext).toBeUndefined();
	});

	it("composes planner-validator hooks with caller hooks", async () => {
		const seen: string[] = [];
		const runtime = createAgentRuntime({
			systemPrompt: "Prompt",
			model,
			plannerValidator: { plannerPrompt: "Plan first." },
			transformContext: async (messages) => {
				seen.push(messages.map((message) => message.role).join(","));
				return messages;
			},
		});

		const transformed = await runtime.agent.transformContext?.([
			{ role: "user", content: [{ type: "text", text: "Task" }], timestamp: 1 },
		]);
		expect(runtime.plannerValidator).toMatchObject({ turns: 0, toolCalls: 0, driftDetected: false });
		expect(transformed?.[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: expect.stringContaining("[shuvgeist-planner-validator]") }],
		});
		expect(seen).toEqual(["user,user"]);
	});
});
