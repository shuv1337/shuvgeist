import type {
	AfterToolCallContext,
	AgentMessage,
	BeforeToolCallContext,
	ShouldStopAfterTurnContext,
} from "@shuv1337/pi-agent-core";
import { createPlannerValidatorHooks, createPlannerValidatorState } from "@shuvgeist/driver/planner-validator";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistantMessage(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 1 };
}

function beforeToolContext(toolName = "ref_click"): BeforeToolCallContext {
	return {
		assistantMessage: assistantMessage("click"),
		toolCall: { type: "toolCall", id: "call-1", name: toolName, args: {} },
		args: {},
		context: { messages: [], tools: [] },
	};
}

function afterToolContext(text: string, toolName = "page_assert"): AfterToolCallContext {
	return {
		assistantMessage: assistantMessage("validate"),
		toolCall: { type: "toolCall", id: "call-1", name: toolName, args: {} },
		args: {},
		result: { content: [{ type: "text", text }], details: undefined },
		isError: false,
		context: { messages: [], tools: [] },
	};
}

function stopContext(message: AgentMessage): ShouldStopAfterTurnContext {
	return {
		message,
		toolResults: [],
		context: { messages: [message], tools: [] },
		newMessages: [message],
	};
}

describe("planner-validator hooks", () => {
	it("injects planner guidance once at the front of context", async () => {
		const hooks = createPlannerValidatorHooks({ plannerPrompt: "Plan, act, validate." });
		const transformed = await hooks.transformContext?.([userMessage("Do the task")]);
		expect(transformed?.[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: expect.stringContaining("[shuvgeist-planner-validator]") }],
		});

		const second = await hooks.transformContext?.(transformed ?? []);
		expect(second).toHaveLength(2);
	});

	it("captures tool-result validator notes and marks drift", async () => {
		const state = createPlannerValidatorState();
		const hooks = createPlannerValidatorHooks({ state, driftMarkers: ["off task"] });
		await hooks.afterToolCall?.(afterToolContext("The browser is off task after navigation."));

		expect(state.validatorNotes).toEqual([
			expect.objectContaining({
				kind: "tool-result",
				toolName: "page_assert",
				message: "The browser is off task after navigation.",
			}),
		]);
		expect(state.driftDetected).toBe(true);
	});

	it("halts on assistant drift markers and blocks subsequent tools", async () => {
		const state = createPlannerValidatorState();
		const hooks = createPlannerValidatorHooks({ state, driftMarkers: ["wrong page"] });
		await expect(hooks.shouldStopAfterTurn?.(stopContext(assistantMessage("We are on the wrong page.")))).resolves.toBe(
			true,
		);

		await expect(hooks.beforeToolCall?.(beforeToolContext("navigate"))).resolves.toEqual({
			block: true,
			reason: "Planner-validator blocked navigate because drift was detected in the previous turn.",
		});
	});
});
