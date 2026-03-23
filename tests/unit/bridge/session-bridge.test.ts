import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	buildSessionHistoryResult,
	projectSessionMessage,
	projectSessionMessages,
	summarizeForBridge,
	type SessionSnapshot,
} from "../../../src/bridge/session-bridge.js";

function makeSnapshot(messages: ReturnType<typeof projectSessionMessages>): SessionSnapshot {
	return {
		sessionId: "session-1",
		persisted: true,
		title: "Test Session",
		model: { provider: "anthropic", id: "claude-sonnet-4-6" },
		isStreaming: false,
		messageCount: messages.length,
		lastMessageIndex: messages.length - 1,
		messages,
	};
}

describe("session bridge projection", () => {
	it("summarizes large and sensitive payloads", () => {
		const summary = summarizeForBridge({
			data: "x".repeat(500),
			preview: "y".repeat(50),
			list: Array.from({ length: 25 }, (_, index) => index),
		});

		expect(summary).toContain("[omitted data: 500 chars]");
		expect(summary).toContain("[omitted preview: 50 chars]");
		expect(summary).toContain("[+5 more items]");
	});

	it("projects user messages with attachment summaries", () => {
		const message = {
			role: "user-with-attachments",
			content: [{ type: "text", text: "Look at this" }],
			attachments: [{ type: "image", mimeType: "image/png", fileName: "cat.png" }],
			timestamp: 123,
		} as unknown as AgentMessage;

		const projected = projectSessionMessage(message, 0);
		expect(projected).toEqual({
			messageIndex: 0,
			role: "user",
			text: "Look at this",
			timestamp: 123,
			attachments: [{ kind: "image", mimeType: "image/png", name: "cat.png" }],
		});
	});

	it("projects assistant tool calls and tool results", () => {
		const assistant = {
			role: "assistant",
			content: [
				{ type: "text", text: "Working" },
				{ type: "toolCall", name: "navigate", arguments: { url: "https://example.com", dataUrl: "data:image/png;base64,abc" } },
			],
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			timestamp: 456,
		} as unknown as AgentMessage;
		const toolResult = {
			role: "toolResult",
			content: [{ type: "text", text: "Done" }],
			toolName: "navigate",
			toolCallId: "tool-1",
			isError: false,
			timestamp: 789,
		} as unknown as AgentMessage;

		const projectedAssistant = projectSessionMessage(assistant, 1);
		expect(projectedAssistant?.toolCalls).toEqual([
			{
				name: "navigate",
				argsSummary: expect.stringContaining('"dataUrl": "[omitted dataUrl: 25 chars]"'),
			},
		]);
		expect(projectedAssistant?.provider).toBe("anthropic");
		expect(projectedAssistant?.model).toBe("claude-sonnet-4-6");

		const projectedToolResult = projectSessionMessage(toolResult, 2);
		expect(projectedToolResult).toEqual({
			messageIndex: 2,
			role: "toolResult",
			text: "Done",
			timestamp: 789,
			toolName: "navigate",
			toolCallId: "tool-1",
			isError: false,
		});
	});

	it("projects navigation messages", () => {
		const navigation = {
			role: "navigation",
			title: "Example",
			url: "https://example.com",
			tabId: 42,
		} as unknown as AgentMessage;

		expect(projectSessionMessage(navigation, 3)).toEqual({
			messageIndex: 3,
			role: "navigation",
			text: "Navigation: Example — https://example.com (tab 42)",
		});
	});

	it("builds history windows by index and tail count", () => {
		const messages = projectSessionMessages([
			{ role: "user", content: "one", timestamp: 1 } as unknown as AgentMessage,
			{ role: "assistant", content: [{ type: "text", text: "two" }], timestamp: 2 } as unknown as AgentMessage,
			{ role: "user", content: "three", timestamp: 3 } as unknown as AgentMessage,
			{ role: "assistant", content: [{ type: "text", text: "four" }], timestamp: 4 } as unknown as AgentMessage,
		]);
		const snapshot = makeSnapshot(messages);

		expect(buildSessionHistoryResult(snapshot).messages).toHaveLength(4);
		expect(buildSessionHistoryResult(snapshot, { afterMessageIndex: 1 }).messages.map((msg) => msg.messageIndex)).toEqual([2, 3]);
		expect(buildSessionHistoryResult(snapshot, { last: 2 }).messages.map((msg) => msg.messageIndex)).toEqual([2, 3]);
	});
});
