import { canonicalRuntimeValue as canonicalValue, sameRuntimeTarget as sameTarget } from "./runtime-identity.js";
import {
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeAgentEvent,
	type RuntimeExecutionDescriptor,
	type RuntimeExecutionStatus,
	type RuntimeHelloEnvelope,
	type RuntimeRequestEnvelope,
	type RuntimeResponseEnvelope,
	type RuntimeSessionSnapshot,
	type RuntimeSessionStreamEnvelope,
	type RuntimeStreamEnvelope,
	type RuntimeTargetIdentity,
	type RuntimeTraceContext,
	type RuntimeValue,
} from "./runtime-protocol.js";

type RuntimeExecutionKind = RuntimeExecutionDescriptor["kind"];
type RuntimeTerminalStatus = Extract<RuntimeExecutionStatus, "succeeded" | "failed" | "cancelled">;

function canonicalEnvelope(value: RuntimeRequestEnvelope | RuntimeResponseEnvelope): string {
	return canonicalValue(value as unknown as RuntimeValue);
}

function sameTrace(left: RuntimeTraceContext | undefined, right: RuntimeTraceContext | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return canonicalValue(left as unknown as RuntimeValue) === canonicalValue(right as unknown as RuntimeValue);
}

function requestKey(
	request: Pick<RuntimeRequestEnvelope, "clientId" | "windowId" | "sessionId" | "requestId">,
): string {
	return JSON.stringify([request.clientId, request.windowId, request.sessionId, request.requestId]);
}

function executionKey(
	value: Pick<RuntimeRequestEnvelope, "clientId" | "windowId" | "sessionId"> & { executionId: string },
): string {
	return JSON.stringify([value.clientId, value.windowId, value.sessionId, value.executionId]);
}

function createRecord<T>(): Record<string, T> {
	return Object.create(null) as Record<string, T>;
}

function copyRecord<T>(source: Readonly<Record<string, T>>): Record<string, T> {
	return Object.assign(createRecord<T>(), source);
}

function operationExecution(
	operation: RuntimeRequestEnvelope["operation"],
): { executionId: string; kind: RuntimeExecutionKind } | undefined {
	if (operation.type === "prompt") return { executionId: operation.executionId, kind: "prompt" };
	if (operation.type === "repl-execute") return { executionId: operation.executionId, kind: "repl" };
	if (operation.type === "page-operation") {
		return { executionId: operation.executionId, kind: "page-operation" };
	}
	return undefined;
}

export interface RuntimeRequestLedgerEntry {
	readonly request: RuntimeRequestEnvelope;
	readonly fingerprint: string;
	readonly executionId?: string;
	readonly executionKind?: RuntimeExecutionKind;
	status: RuntimeExecutionStatus;
}

export type RuntimeLedgerBeginResult =
	| { kind: "accepted"; entry: RuntimeRequestLedgerEntry }
	| { kind: "duplicate"; entry: RuntimeRequestLedgerEntry }
	| { kind: "request-conflict"; entry: RuntimeRequestLedgerEntry }
	| { kind: "execution-conflict"; entry: RuntimeRequestLedgerEntry }
	| { kind: "stale-epoch"; expectedRuntimeEpoch: string; receivedRuntimeEpoch: string };

export interface RuntimeExecutionReference {
	runtimeEpoch: string;
	clientId: string;
	windowId: number;
	sessionId: string;
	requestId: string;
	executionId: string;
}

export type RuntimeLedgerStartResult =
	| { kind: "started"; entry: RuntimeRequestLedgerEntry }
	| { kind: "already-running"; entry: RuntimeRequestLedgerEntry }
	| { kind: "cancelled-before-start"; entry: RuntimeRequestLedgerEntry }
	| { kind: "already-terminal"; entry: RuntimeRequestLedgerEntry }
	| { kind: "not-found" }
	| { kind: "identity-mismatch"; entry: RuntimeRequestLedgerEntry }
	| { kind: "stale-epoch"; expectedRuntimeEpoch: string; receivedRuntimeEpoch: string };

export type RuntimeLedgerFinishResult =
	| { kind: "finished"; entry: RuntimeRequestLedgerEntry }
	| { kind: "already-terminal"; entry: RuntimeRequestLedgerEntry }
	| { kind: "not-found" }
	| { kind: "identity-mismatch"; entry: RuntimeRequestLedgerEntry }
	| { kind: "stale-epoch"; expectedRuntimeEpoch: string; receivedRuntimeEpoch: string };

export type RuntimeLedgerCancelResult =
	| {
			kind: "cancelled-before-start" | "cancel-requested" | "already-cancel-requested" | "already-terminal";
			abortEntry: RuntimeRequestLedgerEntry;
			targetEntry: RuntimeRequestLedgerEntry;
	  }
	| { kind: "duplicate-abort"; abortEntry: RuntimeRequestLedgerEntry }
	| { kind: "not-found"; abortEntry: RuntimeRequestLedgerEntry }
	| { kind: "identity-mismatch"; abortEntry: RuntimeRequestLedgerEntry; targetEntry: RuntimeRequestLedgerEntry }
	| { kind: "request-conflict" | "execution-conflict"; entry: RuntimeRequestLedgerEntry }
	| { kind: "stale-epoch"; expectedRuntimeEpoch: string; receivedRuntimeEpoch: string };

function isTerminal(status: RuntimeExecutionStatus): status is RuntimeTerminalStatus {
	return status === "succeeded" || status === "failed" || status === "cancelled";
}

function entryMatchesReference(entry: RuntimeRequestLedgerEntry, reference: RuntimeExecutionReference): boolean {
	return (
		entry.request.runtimeEpoch === reference.runtimeEpoch &&
		entry.request.clientId === reference.clientId &&
		entry.request.windowId === reference.windowId &&
		entry.request.sessionId === reference.sessionId &&
		entry.request.requestId === reference.requestId &&
		entry.executionId === reference.executionId
	);
}

export function executionReferenceFor(entry: RuntimeRequestLedgerEntry): RuntimeExecutionReference | undefined {
	if (!entry.executionId) return undefined;
	return {
		runtimeEpoch: entry.request.runtimeEpoch,
		clientId: entry.request.clientId,
		windowId: entry.request.windowId,
		sessionId: entry.request.sessionId,
		requestId: entry.request.requestId,
		executionId: entry.executionId,
	};
}

/**
 * Host-side request ledger. Its keys include client and window identity, while
 * cancellation additionally matches session, request, execution, and target.
 */
export class RuntimeRequestLedger {
	private readonly requests = new Map<string, RuntimeRequestLedgerEntry>();
	private readonly executions = new Map<string, RuntimeRequestLedgerEntry>();

	constructor(private currentRuntimeEpoch: string) {
		if (!currentRuntimeEpoch.trim()) throw new Error("runtimeEpoch must be non-empty");
	}

	get runtimeEpoch(): string {
		return this.currentRuntimeEpoch;
	}

	restart(runtimeEpoch: string): void {
		if (!runtimeEpoch.trim()) throw new Error("runtimeEpoch must be non-empty");
		if (runtimeEpoch === this.currentRuntimeEpoch) return;
		this.currentRuntimeEpoch = runtimeEpoch;
		this.requests.clear();
		this.executions.clear();
	}

	begin(request: RuntimeRequestEnvelope): RuntimeLedgerBeginResult {
		if (request.runtimeEpoch !== this.currentRuntimeEpoch) {
			return {
				kind: "stale-epoch",
				expectedRuntimeEpoch: this.currentRuntimeEpoch,
				receivedRuntimeEpoch: request.runtimeEpoch,
			};
		}
		const key = requestKey(request);
		const fingerprint = canonicalEnvelope(request);
		const previous = this.requests.get(key);
		if (previous) {
			return previous.fingerprint === fingerprint
				? { kind: "duplicate", entry: previous }
				: { kind: "request-conflict", entry: previous };
		}

		const execution = operationExecution(request.operation);
		if (execution) {
			const priorExecution = this.executions.get(executionKey({ ...request, executionId: execution.executionId }));
			if (priorExecution) return { kind: "execution-conflict", entry: priorExecution };
		}

		const entry: RuntimeRequestLedgerEntry = {
			request,
			fingerprint,
			executionId: execution?.executionId,
			executionKind: execution?.kind,
			status: "queued",
		};
		this.requests.set(key, entry);
		if (execution) {
			this.executions.set(executionKey({ ...request, executionId: execution.executionId }), entry);
		}
		return { kind: "accepted", entry };
	}

	get(
		request: Pick<RuntimeRequestEnvelope, "clientId" | "windowId" | "sessionId" | "requestId">,
	): RuntimeRequestLedgerEntry | undefined {
		return this.requests.get(requestKey(request));
	}

	/**
	 * Forgets one completed request after the host's replay window expires. The
	 * execution index must be removed with the request so an evicted execution
	 * identity can be reused just like an evicted request identity.
	 */
	forget(request: Pick<RuntimeRequestEnvelope, "clientId" | "windowId" | "sessionId" | "requestId">): boolean {
		const key = requestKey(request);
		const entry = this.requests.get(key);
		if (!entry) return false;
		this.requests.delete(key);
		if (entry.executionId) {
			const key = executionKey({ ...entry.request, executionId: entry.executionId });
			if (this.executions.get(key) === entry) this.executions.delete(key);
		}
		return true;
	}

	markStarted(reference: RuntimeExecutionReference): RuntimeLedgerStartResult {
		if (reference.runtimeEpoch !== this.currentRuntimeEpoch) {
			return {
				kind: "stale-epoch",
				expectedRuntimeEpoch: this.currentRuntimeEpoch,
				receivedRuntimeEpoch: reference.runtimeEpoch,
			};
		}
		const entry = this.requests.get(requestKey(reference));
		if (!entry) return { kind: "not-found" };
		if (!entryMatchesReference(entry, reference)) return { kind: "identity-mismatch", entry };
		if (entry.status === "queued") {
			entry.status = "running";
			return { kind: "started", entry };
		}
		if (entry.status === "running" || entry.status === "cancel-requested") {
			return { kind: "already-running", entry };
		}
		if (entry.status === "cancelled") return { kind: "cancelled-before-start", entry };
		return { kind: "already-terminal", entry };
	}

	markTerminal(reference: RuntimeExecutionReference, status: RuntimeTerminalStatus): RuntimeLedgerFinishResult {
		if (reference.runtimeEpoch !== this.currentRuntimeEpoch) {
			return {
				kind: "stale-epoch",
				expectedRuntimeEpoch: this.currentRuntimeEpoch,
				receivedRuntimeEpoch: reference.runtimeEpoch,
			};
		}
		const entry = this.requests.get(requestKey(reference));
		if (!entry) return { kind: "not-found" };
		if (!entryMatchesReference(entry, reference)) return { kind: "identity-mismatch", entry };
		if (isTerminal(entry.status)) return { kind: "already-terminal", entry };
		entry.status = status;
		return { kind: "finished", entry };
	}

	cancel(
		abortRequest: RuntimeRequestEnvelope & {
			operation: Extract<RuntimeRequestEnvelope["operation"], { type: "abort" }>;
		},
	): RuntimeLedgerCancelResult {
		const begun = this.begin(abortRequest);
		if (begun.kind === "stale-epoch") return begun;
		if (begun.kind === "request-conflict" || begun.kind === "execution-conflict") return begun;
		if (begun.kind === "duplicate") return { kind: "duplicate-abort", abortEntry: begun.entry };

		const abortEntry = begun.entry;
		const targetEntry = this.requests.get(
			requestKey({ ...abortRequest, requestId: abortRequest.operation.targetRequestId }),
		);
		if (!targetEntry) {
			abortEntry.status = "failed";
			return { kind: "not-found", abortEntry };
		}
		const exactIdentity =
			targetEntry.request.runtimeEpoch === abortRequest.runtimeEpoch &&
			targetEntry.request.clientId === abortRequest.clientId &&
			targetEntry.request.windowId === abortRequest.windowId &&
			targetEntry.request.sessionId === abortRequest.sessionId &&
			targetEntry.executionId === abortRequest.operation.executionId &&
			sameTarget(targetEntry.request.target, abortRequest.target);
		if (!exactIdentity) {
			abortEntry.status = "failed";
			return { kind: "identity-mismatch", abortEntry, targetEntry };
		}

		abortEntry.status = "succeeded";
		if (targetEntry.status === "queued") {
			targetEntry.status = "cancelled";
			return { kind: "cancelled-before-start", abortEntry, targetEntry };
		}
		if (targetEntry.status === "running") {
			targetEntry.status = "cancel-requested";
			return { kind: "cancel-requested", abortEntry, targetEntry };
		}
		if (targetEntry.status === "cancel-requested") {
			return { kind: "already-cancel-requested", abortEntry, targetEntry };
		}
		return { kind: "already-terminal", abortEntry, targetEntry };
	}
}

export type RuntimeResponseCorrelation =
	| { ok: true }
	| {
			ok: false;
			mismatches: Array<
				| "protocolVersion"
				| "runtimeEpoch"
				| "clientId"
				| "windowId"
				| "sessionId"
				| "target"
				| "requestId"
				| "operation"
				| "trace"
			>;
	  };

export function correlateRuntimeResponse(
	request: RuntimeRequestEnvelope,
	response: RuntimeResponseEnvelope,
): RuntimeResponseCorrelation {
	const mismatches: Exclude<RuntimeResponseCorrelation, { ok: true }>["mismatches"] = [];
	if (response.protocolVersion !== request.protocolVersion) mismatches.push("protocolVersion");
	if (response.runtimeEpoch !== request.runtimeEpoch) mismatches.push("runtimeEpoch");
	if (response.clientId !== request.clientId) mismatches.push("clientId");
	if (response.windowId !== request.windowId) mismatches.push("windowId");
	if (response.sessionId !== request.sessionId) mismatches.push("sessionId");
	if (!sameTarget(response.target, request.target)) mismatches.push("target");
	if (response.requestId !== request.requestId) mismatches.push("requestId");
	if (response.operation !== request.operation.type) mismatches.push("operation");
	if (!sameTrace(response.trace, request.trace)) mismatches.push("trace");
	return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
}

export interface RuntimeSessionChannelState {
	sessionId: string;
	target: RuntimeTargetIdentity;
	revision: number;
	lastEventSeq: number;
	needsResync: boolean;
	snapshot?: RuntimeSessionSnapshot;
	lastAgentEvent?: RuntimeAgentEvent;
	executions: Record<string, RuntimeExecutionDescriptor>;
	lastTrace?: RuntimeTraceContext;
	lastEventFingerprint?: string;
}

export interface RuntimeChannelState {
	clientId: string;
	windowId: number;
	runtimeEpoch?: string;
	sessions: Record<string, RuntimeSessionChannelState>;
}

export type RuntimeChannelEffect =
	| { kind: "hello"; mode: RuntimeHelloEnvelope["recovery"]["mode"]; runtimeEpoch: string }
	| { kind: "runtime-restarted"; previousRuntimeEpoch: string; runtimeEpoch: string; sessionIds: string[] }
	| { kind: "ignored-scope" }
	| { kind: "hello-required" }
	| { kind: "stale-epoch"; expectedRuntimeEpoch: string; receivedRuntimeEpoch: string }
	| { kind: "target-mismatch"; sessionId: string }
	| { kind: "duplicate"; sessionId: string; eventSeq: number }
	| { kind: "sequence-conflict"; sessionId: string; eventSeq: number }
	| { kind: "stale-sequence"; sessionId: string; eventSeq: number }
	| {
			kind: "sequence-gap";
			sessionId: string;
			expectedEventSeq: number;
			receivedEventSeq: number;
			knownRevision: number;
	  }
	| {
			kind: "revision-regression";
			sessionId: string;
			knownRevision: number;
			receivedRevision: number;
	  }
	| { kind: "resync-pending"; sessionId: string }
	| { kind: "resync-required"; sessionId: string; reason: string }
	| { kind: "snapshot-applied" | "resynced" | "event-applied"; sessionId: string };

export interface RuntimeChannelReduction {
	state: RuntimeChannelState;
	effect: RuntimeChannelEffect;
}

export function createRuntimeChannelState(clientId: string, windowId: number): RuntimeChannelState {
	if (!clientId.trim()) throw new Error("clientId must be non-empty");
	if (!Number.isInteger(windowId) || windowId < 0) throw new Error("windowId must be a non-negative integer");
	return { clientId, windowId, sessions: createRecord<RuntimeSessionChannelState>() };
}

function emptySessionState(
	sessionId: string,
	target: RuntimeTargetIdentity,
	revision = 0,
	needsResync = false,
): RuntimeSessionChannelState {
	return {
		sessionId,
		target,
		revision,
		lastEventSeq: 0,
		needsResync,
		executions: createRecord<RuntimeExecutionDescriptor>(),
	};
}

function scopeMatches(state: RuntimeChannelState, envelope: RuntimeStreamEnvelope): boolean {
	return envelope.clientId === state.clientId && envelope.windowId === state.windowId;
}

function reduceHello(state: RuntimeChannelState, envelope: RuntimeHelloEnvelope): RuntimeChannelReduction {
	if (!scopeMatches(state, envelope)) return { state, effect: { kind: "ignored-scope" } };
	const previousRuntimeEpoch = state.runtimeEpoch;
	if (previousRuntimeEpoch === envelope.runtimeEpoch) {
		const sessions = copyRecord(state.sessions);
		for (const cursor of envelope.recovery.sessions) {
			const previous = sessions[cursor.sessionId];
			if (!previous) {
				sessions[cursor.sessionId] = emptySessionState(cursor.sessionId, cursor.target, 0, true);
				continue;
			}
			if (
				!sameTarget(previous.target, cursor.target) ||
				previous.revision !== cursor.revision ||
				previous.lastEventSeq !== cursor.eventSeq
			) {
				sessions[cursor.sessionId] = { ...previous, needsResync: true };
			}
		}
		return {
			state: { ...state, sessions },
			effect: { kind: "hello", mode: envelope.recovery.mode, runtimeEpoch: envelope.runtimeEpoch },
		};
	}

	const sessions = createRecord<RuntimeSessionChannelState>();
	for (const previous of Object.values(state.sessions)) {
		sessions[previous.sessionId] = {
			...previous,
			lastEventSeq: 0,
			needsResync: true,
			lastEventFingerprint: undefined,
		};
	}
	for (const cursor of envelope.recovery.sessions) {
		const previous = sessions[cursor.sessionId];
		sessions[cursor.sessionId] = previous
			? { ...previous, target: cursor.target, needsResync: true }
			: emptySessionState(cursor.sessionId, cursor.target, cursor.revision, true);
	}
	const nextState: RuntimeChannelState = {
		...state,
		runtimeEpoch: envelope.runtimeEpoch,
		sessions,
	};
	if (previousRuntimeEpoch !== undefined) {
		return {
			state: nextState,
			effect: {
				kind: "runtime-restarted",
				previousRuntimeEpoch,
				runtimeEpoch: envelope.runtimeEpoch,
				sessionIds: Object.keys(sessions).sort(),
			},
		};
	}
	return {
		state: nextState,
		effect: { kind: "hello", mode: envelope.recovery.mode, runtimeEpoch: envelope.runtimeEpoch },
	};
}

function withSession(state: RuntimeChannelState, session: RuntimeSessionChannelState): RuntimeChannelState {
	const sessions = copyRecord(state.sessions);
	sessions[session.sessionId] = session;
	return { ...state, sessions };
}

function executionsFromSnapshot(snapshot: RuntimeSessionSnapshot): Record<string, RuntimeExecutionDescriptor> {
	const executions = createRecord<RuntimeExecutionDescriptor>();
	for (const execution of snapshot.activeExecutions) executions[execution.executionId] = execution;
	return executions;
}

function applySnapshot(
	state: RuntimeChannelState,
	envelope: Extract<RuntimeSessionStreamEnvelope, { streamType: "session-snapshot" }>,
): RuntimeChannelReduction {
	const previous = state.sessions[envelope.sessionId];
	const fingerprint = canonicalValue(envelope as unknown as RuntimeValue);
	if (previous && !sameTarget(previous.target, envelope.target)) {
		return {
			state: markNeedsResync(state, previous, envelope.trace),
			effect: { kind: "target-mismatch", sessionId: envelope.sessionId },
		};
	}
	if (previous && !previous.needsResync && envelope.eventSeq === previous.lastEventSeq) {
		if (previous.lastEventFingerprint === fingerprint) {
			return { state, effect: { kind: "duplicate", sessionId: envelope.sessionId, eventSeq: envelope.eventSeq } };
		}
		return {
			state: markNeedsResync(state, previous, envelope.trace),
			effect: { kind: "sequence-conflict", sessionId: envelope.sessionId, eventSeq: envelope.eventSeq },
		};
	}
	if (previous && envelope.eventSeq < previous.lastEventSeq) {
		return {
			state,
			effect: { kind: "stale-sequence", sessionId: envelope.sessionId, eventSeq: envelope.eventSeq },
		};
	}
	if (previous && envelope.revision < previous.revision) {
		return {
			state: markNeedsResync(state, previous, envelope.trace),
			effect: {
				kind: "revision-regression",
				sessionId: envelope.sessionId,
				knownRevision: previous.revision,
				receivedRevision: envelope.revision,
			},
		};
	}
	const session: RuntimeSessionChannelState = {
		sessionId: envelope.sessionId,
		target: envelope.target,
		revision: envelope.revision,
		lastEventSeq: envelope.eventSeq,
		needsResync: false,
		snapshot: envelope.snapshot,
		executions: executionsFromSnapshot(envelope.snapshot),
		lastTrace: envelope.trace ?? previous?.lastTrace,
		lastEventFingerprint: fingerprint,
	};
	return {
		state: withSession(state, session),
		effect: { kind: previous?.needsResync ? "resynced" : "snapshot-applied", sessionId: envelope.sessionId },
	};
}

function markNeedsResync(
	state: RuntimeChannelState,
	session: RuntimeSessionChannelState,
	trace?: RuntimeTraceContext,
): RuntimeChannelState {
	return withSession(state, { ...session, needsResync: true, lastTrace: trace ?? session.lastTrace });
}

function reduceSessionStream(
	state: RuntimeChannelState,
	envelope: RuntimeSessionStreamEnvelope,
): RuntimeChannelReduction {
	if (!scopeMatches(state, envelope)) return { state, effect: { kind: "ignored-scope" } };
	if (!state.runtimeEpoch) return { state, effect: { kind: "hello-required" } };
	if (envelope.runtimeEpoch !== state.runtimeEpoch) {
		return {
			state,
			effect: {
				kind: "stale-epoch",
				expectedRuntimeEpoch: state.runtimeEpoch,
				receivedRuntimeEpoch: envelope.runtimeEpoch,
			},
		};
	}
	if (envelope.streamType === "session-snapshot") return applySnapshot(state, envelope);

	let session = state.sessions[envelope.sessionId];
	if (!session) session = emptySessionState(envelope.sessionId, envelope.target);
	if (!sameTarget(session.target, envelope.target)) {
		return {
			state: markNeedsResync(state, session, envelope.trace),
			effect: { kind: "target-mismatch", sessionId: envelope.sessionId },
		};
	}
	if (session.needsResync) {
		return { state, effect: { kind: "resync-pending", sessionId: envelope.sessionId } };
	}
	if (envelope.eventSeq === session.lastEventSeq) {
		const fingerprint = canonicalValue(envelope as unknown as RuntimeValue);
		if (session.lastEventFingerprint === fingerprint) {
			return { state, effect: { kind: "duplicate", sessionId: envelope.sessionId, eventSeq: envelope.eventSeq } };
		}
		return {
			state: markNeedsResync(state, session, envelope.trace),
			effect: { kind: "sequence-conflict", sessionId: envelope.sessionId, eventSeq: envelope.eventSeq },
		};
	}
	if (envelope.eventSeq < session.lastEventSeq) {
		return {
			state,
			effect: { kind: "stale-sequence", sessionId: envelope.sessionId, eventSeq: envelope.eventSeq },
		};
	}
	const expectedEventSeq = session.lastEventSeq + 1;
	if (envelope.eventSeq !== expectedEventSeq) {
		return {
			state: markNeedsResync(state, session, envelope.trace),
			effect: {
				kind: "sequence-gap",
				sessionId: envelope.sessionId,
				expectedEventSeq,
				receivedEventSeq: envelope.eventSeq,
				knownRevision: session.revision,
			},
		};
	}
	if (envelope.revision < session.revision) {
		return {
			state: markNeedsResync(state, session, envelope.trace),
			effect: {
				kind: "revision-regression",
				sessionId: envelope.sessionId,
				knownRevision: session.revision,
				receivedRevision: envelope.revision,
			},
		};
	}
	if (envelope.streamType === "resync-required") {
		return {
			state: markNeedsResync(state, session, envelope.trace),
			effect: { kind: "resync-required", sessionId: envelope.sessionId, reason: envelope.reason },
		};
	}

	const nextSession: RuntimeSessionChannelState = {
		...session,
		revision: envelope.revision,
		lastEventSeq: envelope.eventSeq,
		lastTrace: envelope.trace ?? session.lastTrace,
		lastEventFingerprint: canonicalValue(envelope as unknown as RuntimeValue),
	};
	if (envelope.streamType === "agent-event") nextSession.lastAgentEvent = envelope.agentEvent;
	if (envelope.streamType === "execution") {
		nextSession.executions = copyRecord(session.executions);
		nextSession.executions[envelope.execution.executionId] = envelope.execution;
	}
	return {
		state: withSession(state, nextSession),
		effect: { kind: "event-applied", sessionId: envelope.sessionId },
	};
}

export function reduceRuntimeStream(
	state: RuntimeChannelState,
	envelope: RuntimeStreamEnvelope,
): RuntimeChannelReduction {
	return envelope.streamType === "hello" ? reduceHello(state, envelope) : reduceSessionStream(state, envelope);
}

export interface CreateRuntimeResyncRequestOptions {
	sessionId: string;
	requestId: string;
	reason?: Extract<RuntimeRequestEnvelope["operation"], { type: "resync" }>["reason"];
	trace?: RuntimeTraceContext;
}

export function createRuntimeResyncRequest(
	state: RuntimeChannelState,
	options: CreateRuntimeResyncRequestOptions,
): RuntimeRequestEnvelope & { operation: Extract<RuntimeRequestEnvelope["operation"], { type: "resync" }> } {
	if (!state.runtimeEpoch) throw new Error("Cannot resync before a runtime hello");
	const session = state.sessions[options.sessionId];
	if (!session) throw new Error(`Cannot resync unknown session '${options.sessionId}'`);
	if (!options.requestId.trim()) throw new Error("requestId must be non-empty");
	const trace = options.trace ?? session.lastTrace;
	return {
		kind: "request",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: state.runtimeEpoch,
		clientId: state.clientId,
		windowId: state.windowId,
		sessionId: session.sessionId,
		target: session.target,
		requestId: options.requestId,
		...(trace ? { trace } : {}),
		operation: {
			type: "resync",
			knownRevision: session.revision,
			lastEventSeq: session.lastEventSeq,
			reason: options.reason ?? "explicit",
		},
	};
}
