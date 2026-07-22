import { describe, expect, it } from "vitest";
import {
	correlateRuntimeResponse,
	createRuntimeChannelState,
	createRuntimeResyncRequest,
	executionReferenceFor,
	reduceRuntimeStream,
	RuntimeRequestLedger,
} from "@shuvgeist/extension/agent/runtime-channel";
import {
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeAgentEventEnvelope,
	type RuntimeExecutionEventEnvelope,
	type RuntimeHelloEnvelope,
	type RuntimeRequestEnvelope,
	type RuntimeResponseEnvelope,
	type RuntimeSessionSnapshot,
	type RuntimeSnapshotEnvelope,
	type RuntimeTargetIdentity,
	type RuntimeTraceContext,
} from "@shuvgeist/extension/agent/runtime-protocol";

const target: RuntimeTargetIdentity = { kind: "electron-window", appRef: "code", windowRef: "w1", targetId: "t7" };
const otherTarget: RuntimeTargetIdentity = { kind: "chrome-tab", tabId: 22, frameId: 0 };
const trace: RuntimeTraceContext = {
	traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	spanId: "bbbbbbbbbbbbbbbb",
	traceFlags: "01",
	tracestate: "vendor=state",
};

function promptRequest(
	overrides: Partial<RuntimeRequestEnvelope> = {},
): RuntimeRequestEnvelope & { operation: Extract<RuntimeRequestEnvelope["operation"], { type: "prompt" }> } {
	return {
		kind: "request",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "client-1",
		windowId: 4,
		sessionId: "session-1",
		target,
		requestId: "request-prompt",
		trace,
		operation: {
			type: "prompt",
			executionId: "execution-prompt",
			message: { role: "user", content: "hello", timestamp: 1 },
		},
		...overrides,
	} as RuntimeRequestEnvelope & {
		operation: Extract<RuntimeRequestEnvelope["operation"], { type: "prompt" }>;
	};
}

function abortRequest(
	requestId: string,
	overrides: Partial<RuntimeRequestEnvelope> = {},
): RuntimeRequestEnvelope & { operation: Extract<RuntimeRequestEnvelope["operation"], { type: "abort" }> } {
	return {
		kind: "request",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "client-1",
		windowId: 4,
		sessionId: "session-1",
		target,
		requestId,
		trace,
		operation: {
			type: "abort",
			executionId: "execution-prompt",
			targetRequestId: "request-prompt",
			reason: "user",
		},
		...overrides,
	} as RuntimeRequestEnvelope & {
		operation: Extract<RuntimeRequestEnvelope["operation"], { type: "abort" }>;
	};
}

function hello(
	runtimeEpoch = "epoch-1",
	overrides: Partial<RuntimeHelloEnvelope> = {},
): RuntimeHelloEnvelope {
	return {
		kind: "stream",
		streamType: "hello",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch,
		clientId: "client-1",
		windowId: 4,
		trace,
		recovery: { mode: "fresh", sessions: [] },
		...overrides,
	};
}

function snapshot(revision: number, overrides: Partial<RuntimeSessionSnapshot> = {}): RuntimeSessionSnapshot {
	return {
		sessionId: "session-1",
		target,
		revision,
		systemPrompt: "Be precise.",
		model: { provider: "openai", id: "gpt-test" },
		thinkingLevel: "medium",
		messages: [],
		tools: [],
		pendingToolCallIds: [],
		isStreaming: false,
		activeExecutions: [],
		artifacts: [],
		...overrides,
	};
}

function snapshotEnvelope(
	eventSeq: number,
	revision: number,
	overrides: Partial<RuntimeSnapshotEnvelope> = {},
): RuntimeSnapshotEnvelope {
	return {
		kind: "stream",
		streamType: "session-snapshot",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "client-1",
		windowId: 4,
		sessionId: "session-1",
		target,
		trace,
		revision,
		eventSeq,
		snapshot: snapshot(revision),
		...overrides,
	};
}

function agentEvent(
	eventSeq: number,
	revision: number,
	overrides: Partial<RuntimeAgentEventEnvelope> = {},
): RuntimeAgentEventEnvelope {
	return {
		kind: "stream",
		streamType: "agent-event",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "client-1",
		windowId: 4,
		sessionId: "session-1",
		target,
		trace,
		revision,
		eventSeq,
		agentEvent: { type: "agent_start" },
		...overrides,
	};
}

function executionEvent(
	eventSeq: number,
	revision: number,
	status: RuntimeExecutionEventEnvelope["execution"]["status"],
): RuntimeExecutionEventEnvelope {
	return {
		kind: "stream",
		streamType: "execution",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "client-1",
		windowId: 4,
		sessionId: "session-1",
		target,
		trace,
		revision,
		eventSeq,
		execution: {
			executionId: "execution-prompt",
			requestId: "request-prompt",
			kind: "prompt",
			status,
		},
	};
}

describe("RuntimeRequestLedger", () => {
	it("deduplicates an identical request ID and rejects conflicting reuse", () => {
		const ledger = new RuntimeRequestLedger("epoch-1");
		const first = ledger.begin(promptRequest());
		const duplicate = ledger.begin(promptRequest());
		const conflict = ledger.begin(
			promptRequest({ operation: { type: "prompt", executionId: "other-execution", message: { role: "user", content: "different" } } }),
		);

		expect(first.kind).toBe("accepted");
		expect(duplicate.kind).toBe("duplicate");
		expect(conflict.kind).toBe("request-conflict");
		if (first.kind === "accepted" && duplicate.kind === "duplicate") expect(duplicate.entry).toBe(first.entry);
	});

	it("isolates duplicate request IDs by client, window, and session", () => {
		const ledger = new RuntimeRequestLedger("epoch-1");
		const windowFour = ledger.begin(promptRequest());
		const windowFive = ledger.begin(promptRequest({ windowId: 5 }));
		const clientTwo = ledger.begin(promptRequest({ clientId: "client-2" }));
		const sessionTwo = ledger.begin(promptRequest({ sessionId: "session-2" }));

		expect(windowFour.kind).toBe("accepted");
		expect(windowFive.kind).toBe("accepted");
		expect(clientTwo.kind).toBe("accepted");
		expect(sessionTwo.kind).toBe("accepted");
	});

	it("keeps NUL-containing scope fields collision-free", () => {
		const ledger = new RuntimeRequestLedger("epoch-1");
		const first = ledger.begin(
			promptRequest({ clientId: "a", windowId: 1, sessionId: "b\u00002\u0000c", requestId: "same" }),
		);
		const second = ledger.begin(
			promptRequest({ clientId: "a\u00001\u0000b", windowId: 2, sessionId: "c", requestId: "same" }),
		);
		expect(first.kind).toBe("accepted");
		expect(second.kind).toBe("accepted");
	});

	it("rejects stale epochs before and after a runtime restart", () => {
		const ledger = new RuntimeRequestLedger("epoch-2");
		expect(ledger.begin(promptRequest()).kind).toBe("stale-epoch");

		ledger.restart("epoch-3");
		expect(ledger.begin(promptRequest({ runtimeEpoch: "epoch-2" })).kind).toBe("stale-epoch");
		expect(ledger.begin(promptRequest({ runtimeEpoch: "epoch-3" })).kind).toBe("accepted");
	});

	it("cancels an exact execution before it starts and prevents late start", () => {
		const ledger = new RuntimeRequestLedger("epoch-1");
		const begun = ledger.begin(promptRequest());
		expect(begun.kind).toBe("accepted");
		if (begun.kind !== "accepted") return;
		const reference = executionReferenceFor(begun.entry);
		expect(reference).toBeDefined();
		if (!reference) return;

		const cancelled = ledger.cancel(abortRequest("request-abort-1"));
		expect(cancelled.kind).toBe("cancelled-before-start");
		expect(ledger.markStarted(reference).kind).toBe("cancelled-before-start");
	});

	it("requests cancellation after start, deduplicates the abort, and settles terminally", () => {
		const ledger = new RuntimeRequestLedger("epoch-1");
		const begun = ledger.begin(promptRequest());
		if (begun.kind !== "accepted") throw new Error("expected accepted prompt");
		const reference = executionReferenceFor(begun.entry);
		if (!reference) throw new Error("expected execution reference");

		expect(ledger.markStarted(reference).kind).toBe("started");
		expect(ledger.cancel(abortRequest("request-abort-1")).kind).toBe("cancel-requested");
		expect(ledger.cancel(abortRequest("request-abort-1")).kind).toBe("duplicate-abort");
		expect(ledger.markTerminal(reference, "cancelled").kind).toBe("finished");
		expect(ledger.cancel(abortRequest("request-abort-2")).kind).toBe("already-terminal");
	});

	it("retains a fast terminal transition for duplicate replay", () => {
		const ledger = new RuntimeRequestLedger("epoch-1");
		const begun = ledger.begin(promptRequest());
		if (begun.kind !== "accepted") throw new Error("expected accepted prompt");
		const reference = executionReferenceFor(begun.entry);
		if (!reference) throw new Error("expected execution reference");

		expect(ledger.markTerminal(reference, "succeeded").kind).toBe("finished");
		const replay = ledger.begin(promptRequest());
		expect(replay.kind).toBe("duplicate");
		if (replay.kind === "duplicate") expect(replay.entry.status).toBe("succeeded");
		expect(ledger.markStarted(reference).kind).toBe("already-terminal");
	});

	it("forgets both request and execution indexes after replay eviction", () => {
		const ledger = new RuntimeRequestLedger("epoch-1");
		const original = promptRequest();
		expect(ledger.begin(original).kind).toBe("accepted");
		expect(ledger.forget(original)).toBe(true);
		expect(ledger.get(original)).toBeUndefined();
		expect(ledger.forget(original)).toBe(false);

		expect(ledger.begin(original).kind).toBe("accepted");
		expect(
			ledger.begin(promptRequest({ requestId: "replacement-request" })),
		).toMatchObject({ kind: "execution-conflict" });
	});

	it("refuses cancellation when session, target, request, or execution identity differs", () => {
		const variants: Array<[ReturnType<typeof abortRequest>, "not-found" | "identity-mismatch"]> = [
			[abortRequest("abort-session", { sessionId: "other-session" }), "not-found"],
			[abortRequest("abort-target", { target: otherTarget }), "identity-mismatch"],
			[abortRequest("abort-execution", {
				operation: { type: "abort", executionId: "other-execution", targetRequestId: "request-prompt" },
			}), "identity-mismatch"],
		];

		for (const [abort, expected] of variants) {
			const ledger = new RuntimeRequestLedger("epoch-1");
			const begun = ledger.begin(promptRequest());
			if (begun.kind !== "accepted") throw new Error("expected accepted prompt");
			expect(ledger.cancel(abort).kind).toBe(expected);
			expect(begun.entry.status).toBe("queued");
		}
	});

	it("preserves target and trace and correlates both success and error responses", () => {
		const ledger = new RuntimeRequestLedger("epoch-1");
		const request = promptRequest();
		const begun = ledger.begin(request);
		if (begun.kind !== "accepted") throw new Error("expected accepted prompt");
		expect(begun.entry.request.target).toEqual(target);
		expect(begun.entry.request.trace).toEqual(trace);

		const success: RuntimeResponseEnvelope = {
			kind: "response",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: request.runtimeEpoch,
			clientId: request.clientId,
			windowId: request.windowId,
			sessionId: request.sessionId,
			target: request.target,
			requestId: request.requestId,
			operation: request.operation.type,
			trace: request.trace,
			ok: true,
			result: { accepted: true },
		};
		const failure: RuntimeResponseEnvelope = {
			kind: "response",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: request.runtimeEpoch,
			clientId: request.clientId,
			windowId: request.windowId,
			sessionId: request.sessionId,
			target: request.target,
			requestId: request.requestId,
			operation: request.operation.type,
			trace: request.trace,
			ok: false,
			error: { code: "FAILED", message: "failed", retryable: false },
		};

		expect(correlateRuntimeResponse(request, success)).toEqual({ ok: true });
		expect(correlateRuntimeResponse(request, failure)).toEqual({ ok: true });
		expect(correlateRuntimeResponse(request, { ...failure, target: otherTarget, trace: { ...trace, spanId: "cccccccccccccccc" } })).toEqual({
			ok: false,
			mismatches: ["target", "trace"],
		});
	});
});

describe("runtime stream reducer", () => {
	it("requires hello and rejects stale runtime epochs", () => {
		const initial = createRuntimeChannelState("client-1", 4);
		const beforeHello = reduceRuntimeStream(initial, agentEvent(1, 1));
		expect(beforeHello.effect.kind).toBe("hello-required");

		const connected = reduceRuntimeStream(initial, hello()).state;
		const stale = reduceRuntimeStream(connected, agentEvent(1, 1, { runtimeEpoch: "epoch-0" }));
		expect(stale.effect.kind).toBe("stale-epoch");
		expect(stale.state).toBe(connected);
	});

	it("isolates streams by client and window", () => {
		const state = reduceRuntimeStream(createRuntimeChannelState("client-1", 4), hello()).state;
		const otherWindow = reduceRuntimeStream(state, agentEvent(1, 1, { windowId: 5 }));
		const otherClient = reduceRuntimeStream(state, agentEvent(1, 1, { clientId: "client-2" }));

		expect(otherWindow.effect.kind).toBe("ignored-scope");
		expect(otherClient.effect.kind).toBe("ignored-scope");
		expect(otherWindow.state).toBe(state);
	});

	it("stores hostile session and execution identifiers without prototype collisions", () => {
		let state = reduceRuntimeStream(createRuntimeChannelState("client-1", 4), hello()).state;
		const hostileSession = "__proto__";
		state = reduceRuntimeStream(
			state,
			snapshotEnvelope(1, 1, {
				sessionId: hostileSession,
				snapshot: snapshot(1, { sessionId: hostileSession }),
			}),
		).state;
		const constructorSession = "constructor";
		state = reduceRuntimeStream(
			state,
			snapshotEnvelope(1, 1, {
				sessionId: constructorSession,
				snapshot: snapshot(1, { sessionId: constructorSession }),
			}),
		).state;
		expect(state.sessions[hostileSession]?.sessionId).toBe(hostileSession);
		expect(state.sessions[constructorSession]?.sessionId).toBe(constructorSession);
		expect(Object.getPrototypeOf(state.sessions)).toBeNull();

		state = reduceRuntimeStream(
			state,
			{
				...executionEvent(2, 2, "running"),
				sessionId: hostileSession,
				execution: {
					executionId: "__proto__",
					requestId: "hostile-request",
					kind: "prompt",
					status: "running",
				},
			},
		).state;
		expect(state.sessions[hostileSession]?.executions.__proto__?.executionId).toBe("__proto__");
		expect(Object.getPrototypeOf(state.sessions[hostileSession]?.executions)).toBeNull();
	});

	it("applies a snapshot anchor and a fast terminal execution without requiring a start event", () => {
		let state = reduceRuntimeStream(createRuntimeChannelState("client-1", 4), hello()).state;
		const anchored = reduceRuntimeStream(state, snapshotEnvelope(5, 2));
		expect(anchored.effect.kind).toBe("snapshot-applied");
		state = anchored.state;

		const terminal = reduceRuntimeStream(state, executionEvent(6, 3, "succeeded"));
		expect(terminal.effect.kind).toBe("event-applied");
		expect(terminal.state.sessions["session-1"].executions["execution-prompt"].status).toBe("succeeded");
		expect(terminal.state.sessions["session-1"].lastEventSeq).toBe(6);
	});

	it("detects sequence gaps, emits an exact resync request, and resumes from a snapshot", () => {
		let state = reduceRuntimeStream(createRuntimeChannelState("client-1", 4), hello()).state;
		state = reduceRuntimeStream(state, snapshotEnvelope(5, 2)).state;
		const gapTrace = { ...trace, spanId: "dddddddddddddddd" };
		const gap = reduceRuntimeStream(state, agentEvent(7, 3, { trace: gapTrace }));

		expect(gap.effect).toEqual({
			kind: "sequence-gap",
			sessionId: "session-1",
			expectedEventSeq: 6,
			receivedEventSeq: 7,
			knownRevision: 2,
		});
		expect(gap.state.sessions["session-1"].needsResync).toBe(true);
		const resync = createRuntimeResyncRequest(gap.state, {
			sessionId: "session-1",
			requestId: "request-resync",
			reason: "gap",
		});
		expect(resync).toMatchObject({
			runtimeEpoch: "epoch-1",
			clientId: "client-1",
			windowId: 4,
			sessionId: "session-1",
			target,
			trace: gapTrace,
			operation: { type: "resync", knownRevision: 2, lastEventSeq: 5, reason: "gap" },
		});
		expect(reduceRuntimeStream(gap.state, agentEvent(6, 3)).effect.kind).toBe("resync-pending");

		const recovered = reduceRuntimeStream(gap.state, snapshotEnvelope(7, 3));
		expect(recovered.effect.kind).toBe("resynced");
		expect(recovered.state.sessions["session-1"].needsResync).toBe(false);
		expect(reduceRuntimeStream(recovered.state, agentEvent(8, 3)).effect.kind).toBe("event-applied");
	});

	it("detects revision regression without applying the event", () => {
		let state = reduceRuntimeStream(createRuntimeChannelState("client-1", 4), hello()).state;
		state = reduceRuntimeStream(state, snapshotEnvelope(2, 5)).state;
		const regressed = reduceRuntimeStream(state, agentEvent(3, 4));

		expect(regressed.effect).toEqual({
			kind: "revision-regression",
			sessionId: "session-1",
			knownRevision: 5,
			receivedRevision: 4,
		});
		expect(regressed.state.sessions["session-1"].revision).toBe(5);
		expect(regressed.state.sessions["session-1"].needsResync).toBe(true);
	});

	it("deduplicates exact events, detects same-sequence conflicts, and rejects target changes", () => {
		let state = reduceRuntimeStream(createRuntimeChannelState("client-1", 4), hello()).state;
		const anchor = snapshotEnvelope(2, 2);
		state = reduceRuntimeStream(state, anchor).state;
		expect(reduceRuntimeStream(state, anchor).effect.kind).toBe("duplicate");
		expect(reduceRuntimeStream(state, agentEvent(2, 2)).effect.kind).toBe("sequence-conflict");
		expect(reduceRuntimeStream(state, agentEvent(1, 2)).effect.kind).toBe("stale-sequence");
		expect(reduceRuntimeStream(state, agentEvent(3, 3, { target: otherTarget })).effect.kind).toBe("target-mismatch");
	});

	it("isolates monotonic cursors for multiple sessions in one client window", () => {
		let state = reduceRuntimeStream(createRuntimeChannelState("client-1", 4), hello()).state;
		state = reduceRuntimeStream(state, snapshotEnvelope(4, 2)).state;
		const sessionTwoTarget: RuntimeTargetIdentity = { kind: "chrome-tab", tabId: 44 };
		state = reduceRuntimeStream(
			state,
			snapshotEnvelope(1, 1, {
				sessionId: "session-2",
				target: sessionTwoTarget,
				snapshot: snapshot(1, { sessionId: "session-2", target: sessionTwoTarget }),
			}),
		).state;

		expect(state.sessions["session-1"]).toMatchObject({ revision: 2, lastEventSeq: 4 });
		expect(state.sessions["session-2"]).toMatchObject({ revision: 1, lastEventSeq: 1 });
		expect(
			reduceRuntimeStream(
				state,
				agentEvent(2, 2, { sessionId: "session-2", target: sessionTwoTarget }),
			).effect.kind,
		).toBe("event-applied");
	});

	it("rejects a regressed snapshot revision even when its event sequence advances", () => {
		let state = reduceRuntimeStream(createRuntimeChannelState("client-1", 4), hello()).state;
		state = reduceRuntimeStream(state, snapshotEnvelope(2, 5)).state;
		const regressed = reduceRuntimeStream(state, snapshotEnvelope(3, 4));

		expect(regressed.effect.kind).toBe("revision-regression");
		expect(regressed.state.sessions["session-1"]).toMatchObject({ revision: 5, needsResync: true });
	});

	it("marks every known session for recovery when a hello announces a restart", () => {
		let state = reduceRuntimeStream(createRuntimeChannelState("client-1", 4), hello()).state;
		state = reduceRuntimeStream(state, snapshotEnvelope(2, 3)).state;
		const restarted = reduceRuntimeStream(
			state,
			hello("epoch-2", {
				recovery: {
					mode: "restarted",
					previousRuntimeEpoch: "epoch-1",
					sessions: [
						{ sessionId: "session-1", target, revision: 3, eventSeq: 2 },
						{ sessionId: "session-2", target: otherTarget, revision: 1, eventSeq: 1 },
					],
				},
			}),
		);

		expect(restarted.effect).toEqual({
			kind: "runtime-restarted",
			previousRuntimeEpoch: "epoch-1",
			runtimeEpoch: "epoch-2",
			sessionIds: ["session-1", "session-2"],
		});
		expect(restarted.state.sessions["session-1"]).toMatchObject({ lastEventSeq: 0, needsResync: true });
		expect(restarted.state.sessions["session-2"]).toMatchObject({ lastEventSeq: 0, needsResync: true });
	});

	it("uses a resumed same-epoch hello to detect missed and newly recoverable sessions", () => {
		let state = reduceRuntimeStream(createRuntimeChannelState("client-1", 4), hello()).state;
		state = reduceRuntimeStream(state, snapshotEnvelope(2, 3)).state;
		const resumed = reduceRuntimeStream(
			state,
			hello("epoch-1", {
				recovery: {
					mode: "resumed",
					sessions: [
						{ sessionId: "session-1", target, revision: 4, eventSeq: 5 },
						{ sessionId: "session-2", target: otherTarget, revision: 1, eventSeq: 1 },
					],
				},
			}),
		);

		expect(resumed.effect).toEqual({ kind: "hello", mode: "resumed", runtimeEpoch: "epoch-1" });
		expect(resumed.state.sessions["session-1"]).toMatchObject({
			revision: 3,
			lastEventSeq: 2,
			needsResync: true,
		});
		expect(resumed.state.sessions["session-2"]).toMatchObject({
			revision: 0,
			lastEventSeq: 0,
			needsResync: true,
		});
	});
});
