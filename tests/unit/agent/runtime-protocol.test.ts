import { describe, expect, it } from "vitest";
import {
	isRuntimeEnvelope,
	isRuntimeRequestEnvelope,
	isRuntimeResponseEnvelope,
	isRuntimeStreamEnvelope,
	isRuntimeWireValue,
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeAgentEvent,
	type RuntimeAgentMessage,
	type RuntimeRequestEnvelope,
	type RuntimeRequestOperation,
	type RuntimeSessionSnapshot,
	type RuntimeStreamEnvelope,
	type RuntimeTargetIdentity,
	type RuntimeTraceContext,
	validateRuntimeEnvelope,
} from "@shuvgeist/extension/agent/runtime-protocol";

const target: RuntimeTargetIdentity = { kind: "chrome-tab", tabRef: "active", tabId: 17, frameId: 0 };
const trace: RuntimeTraceContext = {
	traceId: "0123456789abcdef0123456789abcdef",
	spanId: "0123456789abcdef",
	traceFlags: "01",
	tracestate: "vendor=value",
};
const message: RuntimeAgentMessage = { role: "user", content: "hello", timestamp: 10 };

function request(
	operation: RuntimeRequestOperation,
	overrides: Partial<Omit<RuntimeRequestEnvelope, "operation">> = {},
): RuntimeRequestEnvelope {
	return {
		kind: "request",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "client-1",
		windowId: 4,
		sessionId: "session-1",
		target,
		requestId: `request-${operation.type}`,
		trace,
		operation,
		...overrides,
	};
}

function snapshot(overrides: Partial<RuntimeSessionSnapshot> = {}): RuntimeSessionSnapshot {
	return {
		sessionId: "session-1",
		target,
		revision: 3,
		systemPrompt: "Be precise.",
		model: {
			provider: "openai",
			id: "gpt-test",
			name: "Test model",
			api: "openai-responses",
			reasoning: true,
			contextWindow: 100_000,
			maxTokens: 10_000,
		},
		thinkingLevel: "high",
		messages: [message],
		tools: [{ name: "navigate", label: "Navigate", description: "Navigate the page" }],
		pendingToolCallIds: ["tool-call-1"],
		isStreaming: true,
		streamingMessage: { role: "assistant", content: [{ type: "text", text: "partial" }] },
		activeExecutions: [
			{
				executionId: "execution-1",
				requestId: "request-prompt",
				kind: "prompt",
				status: "running",
				startedAt: "2026-07-21T12:00:00.000Z",
			},
		],
		artifacts: [
			{
				filename: "notes.txt",
				mimeType: "text/plain",
				size: 5,
				createdAt: "2026-07-21T12:00:00.000Z",
				updatedAt: "2026-07-21T12:00:01.000Z",
			},
		],
		...overrides,
	};
}

function streamBase() {
	return {
		kind: "stream" as const,
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "client-1",
		windowId: 4,
		sessionId: "session-1",
		target,
		trace,
		revision: 3,
		eventSeq: 2,
	};
}

describe("runtime protocol", () => {
	it("accepts every explicit request operation as plain structured-clone data", () => {
		const operations: RuntimeRequestOperation[] = [
			{ type: "attach", knownRuntimeEpoch: "epoch-0", lastRevision: 2, lastEventSeq: 7 },
			{
				type: "create",
				systemPrompt: "Be precise.",
				model: {
					provider: "openai",
					id: "gpt-test",
					name: "GPT Test",
					api: "openai-completions",
					baseUrl: "https://example.test/v1",
					reasoning: true,
					thinkingLevelMap: { off: null, high: "high" },
					input: ["text", "image"],
					cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
					contextWindow: 100_000,
					maxTokens: 10_000,
					headers: { "x-session-affinity": "session-1" },
					compat: { supportsStore: false, maxTokensField: "max_tokens" },
				},
				thinkingLevel: "medium",
				initialMessages: [message],
			},
			{ type: "load" },
			{ type: "prompt", executionId: "execution-prompt", message },
			{ type: "abort", executionId: "execution-prompt", targetRequestId: "request-prompt", reason: "user" },
			{ type: "set-model", model: { provider: "anthropic", id: "claude-test" } },
			{ type: "set-thinking", thinkingLevel: "xhigh" },
			{ type: "steer", message },
			{ type: "replace-or-append-message", message, messageIndex: 0, expectedRevision: 3 },
			{ type: "artifacts", payload: { action: "list" } },
			{ type: "artifacts", payload: { action: "get", filename: "notes.txt" } },
			{ type: "artifacts", payload: { action: "put", filename: "notes.json", content: { ok: true } } },
			{ type: "artifacts", payload: { action: "delete", filename: "notes.txt" } },
			{ type: "release", force: true, reason: "window-removed" },
			{ type: "repl-execute", executionId: "execution-repl", code: "return 1", language: "javascript" },
			{
				type: "page-operation",
				executionId: "execution-page",
				operation: "trusted-click",
				params: { ref: "e12", button: "left" },
			},
			{ type: "resync", knownRevision: 3, lastEventSeq: 7, reason: "gap" },
		];

		for (const operation of operations) {
			const envelope = request(operation);
			expect(isRuntimeRequestEnvelope(envelope), operation.type).toBe(true);
			expect(structuredClone(envelope)).toEqual(envelope);
		}
	});

	it("accepts correlated success and error response shapes", () => {
		const success = {
			...request({ type: "load" }),
			kind: "response",
			operation: "load",
			ok: true,
			result: { loaded: true },
		};
		const failure = {
			...request({ type: "load" }),
			kind: "response",
			operation: "load",
			ok: false,
			error: { code: "SESSION_NOT_FOUND", message: "Missing session", retryable: false },
		};

		expect(isRuntimeResponseEnvelope(success)).toBe(true);
		expect(isRuntimeResponseEnvelope(failure)).toBe(true);
		expect(isRuntimeRequestEnvelope(success)).toBe(false);
	});

	it("accepts hello recovery, snapshots, execution updates, and every AgentEvent-like variant", () => {
		const hello: RuntimeStreamEnvelope = {
			kind: "stream",
			streamType: "hello",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: "epoch-1",
			clientId: "client-1",
			windowId: 4,
			trace,
			recovery: {
				mode: "restarted",
				previousRuntimeEpoch: "epoch-0",
				sessions: [{ sessionId: "session-1", target, revision: 3, eventSeq: 12 }],
			},
		};
		const events: RuntimeAgentEvent[] = [
			{ type: "agent_start" },
			{ type: "agent_end", messages: [message] },
			{ type: "turn_start" },
			{ type: "turn_end", message, toolResults: [{ role: "toolResult", content: [] }] },
			{ type: "message_start", message },
			{ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "h" } },
			{ type: "message_end", message },
			{ type: "tool_execution_start", toolCallId: "call-1", toolName: "navigate", args: { url: "/" } },
			{
				type: "tool_execution_update",
				toolCallId: "call-1",
				toolName: "navigate",
				args: { url: "/" },
				partialResult: { progress: 0.5 },
			},
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "navigate",
				result: { url: "https://example.test" },
				isError: false,
			},
		];
		const envelopes: RuntimeStreamEnvelope[] = [
			hello,
			{ ...streamBase(), streamType: "session-snapshot", snapshot: snapshot() },
			{
				...streamBase(),
				streamType: "execution",
				execution: {
					executionId: "execution-1",
					requestId: "request-prompt",
					kind: "prompt",
					status: "succeeded",
				},
			},
			{
				...streamBase(),
				streamType: "resync-required",
				reason: "gap",
				expectedEventSeq: 2,
				receivedEventSeq: 4,
			},
			...events.map((agentEvent) => ({ ...streamBase(), streamType: "agent-event" as const, agentEvent })),
		];

		for (const envelope of envelopes) {
			expect(isRuntimeStreamEnvelope(envelope)).toBe(true);
			expect(isRuntimeEnvelope(envelope)).toBe(true);
			expect(structuredClone(envelope)).toEqual(envelope);
		}
	});

	it("requires snapshot identity, target, and revision to match its envelope", () => {
		const mismatched = {
			...streamBase(),
			streamType: "session-snapshot",
			snapshot: snapshot({
				sessionId: "other-session",
				target: { kind: "electron-window", electronSessionId: "e1", windowRef: "w1" },
				revision: 4,
			}),
		};
		const result = validateRuntimeEnvelope(mismatched);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues.map((entry) => entry.path)).toEqual(
				expect.arrayContaining(["$.snapshot.sessionId", "$.snapshot.target", "$.snapshot.revision"]),
			);
		}
	});

	it("rejects malformed envelopes and executable or host-specific values", () => {
		const cyclic: Record<string, unknown> = { ok: true };
		cyclic.self = cyclic;
		const malformed: unknown[] = [
			{ ...request({ type: "load" }), protocolVersion: 2 },
			{ ...request({ type: "load" }), requestId: "" },
			{ ...request({ type: "load" }), trace: { ...trace, spanId: "not-a-span" } },
			{ ...request({ type: "load" }), kind: "response", operation: "load", ok: true, result: null, error: { code: "BAD", message: "ambiguous", retryable: false } },
			{ ...request({ type: "load" }), kind: "response", operation: "load", ok: false, result: null, error: { code: "BAD", message: "ambiguous", retryable: false } },
			{ ...request({ type: "set-thinking", thinkingLevel: "medium" }), operation: { type: "set-thinking", thinkingLevel: "extreme" } },
			{ ...request({ type: "prompt", executionId: "e1", message }), operation: { type: "prompt", executionId: "e1", message: { content: "missing role" } } },
			{ ...request({ type: "page-operation", executionId: "e1", operation: "click", params: {} }), operation: { type: "page-operation", executionId: "e1", operation: "click", params: { run: () => true } } },
			{ ...request({ type: "load" }), pending: new Set(["call-1"]) },
			{ ...request({ type: "load" }), signal: new AbortController().signal },
			{ ...request({ type: "load" }), cyclic },
			{
				kind: "stream",
				streamType: "hello",
				protocolVersion: RUNTIME_PROTOCOL_VERSION,
				runtimeEpoch: "epoch-2",
				clientId: "client-1",
				windowId: 4,
				recovery: { mode: "restarted", sessions: [] },
			},
			{ ...request({ type: "load" }), target: { kind: "electron-window", windowRef: "w1" } },
			{ ...streamBase(), streamType: "agent-event", agentEvent: { type: "unknown" } },
			{ ...streamBase(), eventSeq: 0, streamType: "agent-event", agentEvent: { type: "agent_start" } },
		];

		for (const envelope of malformed) expect(isRuntimeEnvelope(envelope)).toBe(false);
	});

	it("limits generic values to finite acyclic plain data", () => {
		class ConcreteAgentLike {
			prompt(): void {}
		}

		expect(isRuntimeWireValue({ nested: [null, true, 1, "ok", { value: 2 }] })).toBe(true);
		expect(isRuntimeWireValue(Number.NaN)).toBe(false);
		expect(isRuntimeWireValue(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isRuntimeWireValue(BigInt(1))).toBe(false);
		expect(isRuntimeWireValue(new Date())).toBe(false);
		expect(isRuntimeWireValue(new ConcreteAgentLike())).toBe(false);
		expect(isRuntimeWireValue([, "sparse"])).toBe(false);
	});
});
