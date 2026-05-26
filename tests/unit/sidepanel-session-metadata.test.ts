import type { AgentMessage, AgentState } from "@mariozechner/pi-agent-core";
import {
	aggregateSessionUsage,
	buildSessionMetadata,
	buildSessionPreview,
	generateSessionTitle,
	shouldSaveSession,
} from "../../src/sidepanel/session-metadata.js";

const user = (content: AgentMessage["content"]): AgentMessage => ({ role: "user", content }) as AgentMessage;
const assistant = (
	content: AgentMessage["content"],
	usage: Partial<Extract<AgentMessage, { role: "assistant" }>["usage"]> = {},
): AgentMessage =>
	({
		role: "assistant",
		content,
		usage: {
			input: usage.input ?? 1,
			output: usage.output ?? 2,
			cacheRead: usage.cacheRead ?? 3,
			cacheWrite: usage.cacheWrite ?? 4,
			cost: usage.cost ?? { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		},
	}) as AgentMessage;

describe("sidepanel session metadata", () => {
	it("saves only sessions with both user and assistant messages", () => {
		expect(shouldSaveSession([])).toBe(false);
		expect(shouldSaveSession([user("hello")])).toBe(false);
		expect(shouldSaveSession([assistant([{ type: "text", text: "hi" }])])).toBe(false);
		expect(shouldSaveSession([user("hello"), assistant([{ type: "text", text: "hi" }])])).toBe(true);
	});

	it("generates concise titles from the first user message", () => {
		expect(generateSessionTitle([user("Short request. More text")])).toBe("Short request.");
		expect(generateSessionTitle([user("a".repeat(80))])).toBe("a".repeat(47) + "...");
		expect(generateSessionTitle([user([{ type: "text", text: "Attached question" }])])).toBe("Attached question");
		expect(generateSessionTitle([assistant([{ type: "text", text: "ignored" }])])).toBe("");
	});

	it("aggregates assistant usage and costs", () => {
		expect(
			aggregateSessionUsage([
				user("ignored"),
				assistant([{ type: "text", text: "one" }]),
				assistant([{ type: "text", text: "two" }], {
					input: 10,
					output: 20,
					cacheRead: 30,
					cacheWrite: 40,
					cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				}),
			]),
		).toEqual({
			input: 11,
			output: 22,
			cacheRead: 33,
			cacheWrite: 44,
			totalTokens: 110,
			cost: { input: 1.1, output: 2.2, cacheRead: 3.3, cacheWrite: 4.4, total: 11 },
		});
	});

	it("builds previews from user text and assistant text/thinking content", () => {
		const preview = buildSessionPreview(
			[
				user([{ type: "text", text: "question" }]),
				assistant([
					{ type: "thinking", thinking: "reasoning" },
					{ type: "text", text: "answer" },
				]),
			],
			20,
		);
		expect(preview).toBe("question\nreasoning\na");
	});

	it("assembles stable metadata without changing stored shape", () => {
		const state = {
			messages: [user("hello"), assistant([{ type: "text", text: "world" }])],
			model: { provider: "anthropic", id: "claude-sonnet-4-6" },
			thinkingLevel: "medium",
		} as unknown as AgentState;
		expect(
			buildSessionMetadata({
				sessionId: "session-1",
				title: "Title",
				createdAt: "2026-01-01T00:00:00.000Z",
				lastModified: "2026-01-02T00:00:00.000Z",
				state,
			}),
		).toMatchObject({
			id: "session-1",
			title: "Title",
			createdAt: "2026-01-01T00:00:00.000Z",
			lastModified: "2026-01-02T00:00:00.000Z",
			messageCount: 2,
			modelId: "claude-sonnet-4-6",
			thinkingLevel: "medium",
			preview: "hello\nworld\n",
		});
	});
});
