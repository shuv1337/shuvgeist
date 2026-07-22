/**
 * Wire contract between sidepanel clients, the service-worker coordinator, and
 * the offscreen agent host. Every value is plain, acyclic data so it can cross
 * extension runtime boundaries without transferring executable objects.
 */

export const RUNTIME_PROTOCOL_VERSION = 1 as const;

export type RuntimeProtocolVersion = typeof RUNTIME_PROTOCOL_VERSION;
export type RuntimeScalar = null | boolean | number | string;
export type RuntimeValue = RuntimeScalar | RuntimeValue[] | { [key: string]: RuntimeValue };
export type RuntimeRecord = { [key: string]: RuntimeValue };

export interface RuntimeTraceContext {
	traceId: string;
	spanId: string;
	traceFlags: string;
	tracestate?: string;
}

export type RuntimeTargetIdentity =
	| {
			kind: "chrome-tab";
			tabRef?: string;
			tabId?: number;
			frameId?: number;
	  }
	| {
			kind: "electron-window";
			appRef?: string;
			electronSessionId?: string;
			windowRef?: string;
			targetId?: string;
	  };

export interface RuntimeModelDescriptor {
	provider: string;
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<RuntimeThinkingLevel, string | null>>;
	input?: Array<"text" | "image">;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow?: number;
	maxTokens?: number;
	headers?: Record<string, string>;
	compat?: RuntimeRecord;
}

export type RuntimeThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface RuntimeAgentMessage extends RuntimeRecord {
	role: string;
}

export interface RuntimeToolDescriptor {
	name: string;
	label: string;
	description?: string;
}

export interface RuntimeArtifactDescriptor {
	filename: string;
	mimeType?: string;
	size?: number;
	createdAt?: string;
	updatedAt?: string;
}

export type RuntimeExecutionStatus = "queued" | "running" | "cancel-requested" | "succeeded" | "failed" | "cancelled";

export interface RuntimeExecutionDescriptor {
	/** Stable identity of one long-running prompt, REPL, or privileged page execution. */
	executionId: string;
	/** Request that created the execution; cancellation must match both identities. */
	requestId: string;
	kind: "prompt" | "repl" | "page-operation";
	status: RuntimeExecutionStatus;
	startedAt?: string;
	finishedAt?: string;
	error?: RuntimeErrorDescriptor;
}

export interface RuntimeErrorDescriptor {
	code: string;
	message: string;
	retryable: boolean;
	details?: RuntimeValue;
}

export interface RuntimeSessionSnapshot {
	sessionId: string;
	target: RuntimeTargetIdentity;
	/** Monotonic state version for this session. */
	revision: number;
	systemPrompt: string;
	model: RuntimeModelDescriptor | null;
	thinkingLevel: RuntimeThinkingLevel;
	messages: RuntimeAgentMessage[];
	tools: RuntimeToolDescriptor[];
	pendingToolCallIds: string[];
	isStreaming: boolean;
	streamingMessage?: RuntimeAgentMessage;
	activeExecutions: RuntimeExecutionDescriptor[];
	artifacts: RuntimeArtifactDescriptor[];
	errorMessage?: string;
}

export type RuntimeAgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: RuntimeAgentMessage[] }
	| { type: "turn_start" }
	| { type: "turn_end"; message: RuntimeAgentMessage; toolResults: RuntimeAgentMessage[] }
	| { type: "message_start"; message: RuntimeAgentMessage }
	| { type: "message_update"; message: RuntimeAgentMessage; assistantMessageEvent: RuntimeRecord }
	| { type: "message_end"; message: RuntimeAgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: RuntimeValue }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: RuntimeValue;
			partialResult: RuntimeValue;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: RuntimeValue;
			isError: boolean;
	  };

export type RuntimeArtifactsPayload =
	| { action: "list" }
	| { action: "get"; filename: string }
	| { action: "put"; filename: string; content: RuntimeValue; mimeType?: string }
	| { action: "delete"; filename: string };

export type RuntimeRequestOperation =
	| {
			type: "attach";
			knownRuntimeEpoch?: string;
			lastRevision?: number;
			lastEventSeq?: number;
	  }
	| {
			type: "create";
			systemPrompt: string;
			model?: RuntimeModelDescriptor;
			thinkingLevel?: RuntimeThinkingLevel;
			initialMessages?: RuntimeAgentMessage[];
	  }
	| { type: "load" }
	| { type: "prompt"; executionId: string; message: RuntimeAgentMessage }
	| { type: "abort"; executionId: string; targetRequestId: string; reason?: string }
	| { type: "set-model"; model: RuntimeModelDescriptor }
	| { type: "set-thinking"; thinkingLevel: RuntimeThinkingLevel }
	| { type: "steer"; message: RuntimeAgentMessage }
	| {
			type: "replace-or-append-message";
			message: RuntimeAgentMessage;
			messageIndex?: number;
			expectedRevision: number;
	  }
	| { type: "artifacts"; payload: RuntimeArtifactsPayload }
	| { type: "release"; force?: boolean; reason?: string }
	| { type: "repl-execute"; executionId: string; code: string; language?: "javascript" }
	| { type: "page-operation"; executionId: string; operation: string; params: RuntimeRecord }
	| {
			type: "resync";
			knownRevision: number;
			lastEventSeq: number;
			reason: "gap" | "runtime-restart" | "revision-regression" | "explicit";
	  };

export type RuntimeOperationType = RuntimeRequestOperation["type"];

interface RuntimeEnvelopeBase {
	protocolVersion: RuntimeProtocolVersion;
	/** Incarnation token for the current offscreen runtime host. */
	runtimeEpoch: string;
	clientId: string;
	windowId: number;
	trace?: RuntimeTraceContext;
}

interface RuntimeSessionScope {
	sessionId: string;
	target: RuntimeTargetIdentity;
}

export interface RuntimeRequestEnvelope extends RuntimeEnvelopeBase, RuntimeSessionScope {
	kind: "request";
	/** Idempotency key within one client, window, session, and runtime epoch. */
	requestId: string;
	operation: RuntimeRequestOperation;
}

interface RuntimeResponseEnvelopeBase extends RuntimeEnvelopeBase, RuntimeSessionScope {
	kind: "response";
	requestId: string;
	operation: RuntimeOperationType;
}

export interface RuntimeSuccessResponseEnvelope extends RuntimeResponseEnvelopeBase {
	ok: true;
	result: RuntimeValue;
}

export interface RuntimeErrorResponseEnvelope extends RuntimeResponseEnvelopeBase {
	ok: false;
	error: RuntimeErrorDescriptor;
}

export type RuntimeResponseEnvelope = RuntimeSuccessResponseEnvelope | RuntimeErrorResponseEnvelope;

export interface RuntimeRecoveryCursor {
	sessionId: string;
	target: RuntimeTargetIdentity;
	revision: number;
	eventSeq: number;
}

export interface RuntimeHelloEnvelope extends RuntimeEnvelopeBase {
	kind: "stream";
	streamType: "hello";
	recovery: {
		mode: "fresh" | "resumed" | "restarted";
		previousRuntimeEpoch?: string;
		sessions: RuntimeRecoveryCursor[];
	};
}

interface RuntimeSessionStreamEnvelopeBase extends RuntimeEnvelopeBase, RuntimeSessionScope {
	kind: "stream";
	/** Monotonic session state version; it may stay equal across non-mutating events. */
	revision: number;
	/** Strictly increasing stream position within a session and runtime epoch. */
	eventSeq: number;
}

export interface RuntimeSnapshotEnvelope extends RuntimeSessionStreamEnvelopeBase {
	streamType: "session-snapshot";
	snapshot: RuntimeSessionSnapshot;
}

export interface RuntimeAgentEventEnvelope extends RuntimeSessionStreamEnvelopeBase {
	streamType: "agent-event";
	agentEvent: RuntimeAgentEvent;
}

export interface RuntimeExecutionEventEnvelope extends RuntimeSessionStreamEnvelopeBase {
	streamType: "execution";
	execution: RuntimeExecutionDescriptor;
}

export interface RuntimeResyncRequiredEnvelope extends RuntimeSessionStreamEnvelopeBase {
	streamType: "resync-required";
	reason: "gap" | "runtime-restart" | "revision-regression" | "unknown-session";
	expectedEventSeq: number;
	receivedEventSeq: number;
}

export type RuntimeSessionStreamEnvelope =
	| RuntimeSnapshotEnvelope
	| RuntimeAgentEventEnvelope
	| RuntimeExecutionEventEnvelope
	| RuntimeResyncRequiredEnvelope;

export type RuntimeStreamEnvelope = RuntimeHelloEnvelope | RuntimeSessionStreamEnvelope;
export type RuntimeEnvelope = RuntimeRequestEnvelope | RuntimeResponseEnvelope | RuntimeStreamEnvelope;

export interface RuntimeValidationIssue {
	path: string;
	message: string;
}

export type RuntimeValidationResult<T> = { ok: true; value: T } | { ok: false; issues: RuntimeValidationIssue[] };

const OPERATION_TYPES: readonly RuntimeOperationType[] = [
	"attach",
	"create",
	"load",
	"prompt",
	"abort",
	"set-model",
	"set-thinking",
	"steer",
	"replace-or-append-message",
	"artifacts",
	"release",
	"repl-execute",
	"page-operation",
	"resync",
];

const THINKING_LEVELS: readonly RuntimeThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isRuntimeWireValueInternal(value: unknown, ancestors: ReadonlySet<object>): value is RuntimeValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || ancestors.has(value)) return false;

	const nextAncestors = new Set(ancestors);
	nextAncestors.add(value);
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			if (!(index in value) || !isRuntimeWireValueInternal(value[index], nextAncestors)) return false;
		}
		return true;
	}
	if (!isPlainRecord(value)) return false;
	return Object.values(value).every((entry) => isRuntimeWireValueInternal(entry, nextAncestors));
}

/** A deliberately strict structured-clone subset: finite JSON-like plain data. */
export function isRuntimeWireValue(value: unknown): value is RuntimeValue {
	return isRuntimeWireValueInternal(value, new Set());
}

function issue(issues: RuntimeValidationIssue[], path: string, message: string): void {
	issues.push({ path, message });
}

function recordAt(value: unknown, path: string, issues: RuntimeValidationIssue[]): Record<string, unknown> | undefined {
	if (!isPlainRecord(value)) {
		issue(issues, path, "must be a plain object");
		return undefined;
	}
	return value;
}

function arrayAt(value: unknown, path: string, issues: RuntimeValidationIssue[]): unknown[] | undefined {
	if (!Array.isArray(value)) {
		issue(issues, path, "must be an array");
		return undefined;
	}
	return value;
}

function nonEmptyStringAt(value: unknown, path: string, issues: RuntimeValidationIssue[]): value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		issue(issues, path, "must be a non-empty string");
		return false;
	}
	return true;
}

function optionalNonEmptyStringAt(value: unknown, path: string, issues: RuntimeValidationIssue[]): void {
	if (value !== undefined) nonEmptyStringAt(value, path, issues);
}

function integerAt(value: unknown, path: string, issues: RuntimeValidationIssue[], minimum = 0): value is number {
	if (!Number.isInteger(value) || (value as number) < minimum) {
		issue(issues, path, `must be an integer greater than or equal to ${minimum}`);
		return false;
	}
	return true;
}

function finiteNumberAt(value: unknown, path: string, issues: RuntimeValidationIssue[], minimum = 0): value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
		issue(issues, path, `must be a finite number greater than or equal to ${minimum}`);
		return false;
	}
	return true;
}

function optionalIntegerAt(value: unknown, path: string, issues: RuntimeValidationIssue[], minimum = 0): void {
	if (value !== undefined) integerAt(value, path, issues, minimum);
}

function booleanAt(value: unknown, path: string, issues: RuntimeValidationIssue[]): value is boolean {
	if (typeof value !== "boolean") {
		issue(issues, path, "must be a boolean");
		return false;
	}
	return true;
}

function oneOfAt<T extends string>(
	value: unknown,
	allowed: readonly T[],
	path: string,
	issues: RuntimeValidationIssue[],
): value is T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		issue(issues, path, `must be one of: ${allowed.join(", ")}`);
		return false;
	}
	return true;
}

function validateTrace(value: unknown, path: string, issues: RuntimeValidationIssue[]): void {
	if (value === undefined) return;
	const trace = recordAt(value, path, issues);
	if (!trace) return;
	if (typeof trace.traceId !== "string" || !/^[0-9a-f]{32}$/iu.test(trace.traceId)) {
		issue(issues, `${path}.traceId`, "must be a 32-character hexadecimal trace id");
	}
	if (typeof trace.spanId !== "string" || !/^[0-9a-f]{16}$/iu.test(trace.spanId)) {
		issue(issues, `${path}.spanId`, "must be a 16-character hexadecimal span id");
	}
	if (typeof trace.traceFlags !== "string" || !/^[0-9a-f]{2}$/iu.test(trace.traceFlags)) {
		issue(issues, `${path}.traceFlags`, "must be a two-character hexadecimal trace flag");
	}
	optionalNonEmptyStringAt(trace.tracestate, `${path}.tracestate`, issues);
}

function validateTarget(value: unknown, path: string, issues: RuntimeValidationIssue[]): void {
	const target = recordAt(value, path, issues);
	if (!target) return;
	if (target.kind === "chrome-tab") {
		optionalNonEmptyStringAt(target.tabRef, `${path}.tabRef`, issues);
		optionalIntegerAt(target.tabId, `${path}.tabId`, issues);
		optionalIntegerAt(target.frameId, `${path}.frameId`, issues);
		return;
	}
	if (target.kind === "electron-window") {
		optionalNonEmptyStringAt(target.appRef, `${path}.appRef`, issues);
		optionalNonEmptyStringAt(target.electronSessionId, `${path}.electronSessionId`, issues);
		optionalNonEmptyStringAt(target.windowRef, `${path}.windowRef`, issues);
		optionalNonEmptyStringAt(target.targetId, `${path}.targetId`, issues);
		if (target.appRef === undefined && target.electronSessionId === undefined && target.targetId === undefined) {
			issue(issues, path, "must identify an Electron app, session, or target");
		}
		return;
	}
	issue(issues, `${path}.kind`, "must be chrome-tab or electron-window");
}

function validateModel(value: unknown, path: string, issues: RuntimeValidationIssue[]): void {
	const model = recordAt(value, path, issues);
	if (!model) return;
	nonEmptyStringAt(model.provider, `${path}.provider`, issues);
	nonEmptyStringAt(model.id, `${path}.id`, issues);
	optionalNonEmptyStringAt(model.name, `${path}.name`, issues);
	optionalNonEmptyStringAt(model.api, `${path}.api`, issues);
	if (model.baseUrl !== undefined && typeof model.baseUrl !== "string") {
		issue(issues, `${path}.baseUrl`, "must be a string");
	}
	if (model.reasoning !== undefined) booleanAt(model.reasoning, `${path}.reasoning`, issues);
	if (model.thinkingLevelMap !== undefined) {
		const levels = recordAt(model.thinkingLevelMap, `${path}.thinkingLevelMap`, issues);
		if (levels) {
			for (const [level, mapped] of Object.entries(levels)) {
				if (!THINKING_LEVELS.includes(level as RuntimeThinkingLevel)) {
					issue(issues, `${path}.thinkingLevelMap.${level}`, "is not a supported thinking level");
				} else if (mapped !== null && (typeof mapped !== "string" || mapped.length === 0)) {
					issue(issues, `${path}.thinkingLevelMap.${level}`, "must be a non-empty string or null");
				}
			}
		}
	}
	if (model.input !== undefined) {
		const inputs = arrayAt(model.input, `${path}.input`, issues);
		inputs?.forEach((input, index) => {
			oneOfAt(input, ["text", "image"] as const, `${path}.input[${index}]`, issues);
		});
	}
	if (model.cost !== undefined) {
		const cost = recordAt(model.cost, `${path}.cost`, issues);
		if (cost) {
			finiteNumberAt(cost.input, `${path}.cost.input`, issues);
			finiteNumberAt(cost.output, `${path}.cost.output`, issues);
			finiteNumberAt(cost.cacheRead, `${path}.cost.cacheRead`, issues);
			finiteNumberAt(cost.cacheWrite, `${path}.cost.cacheWrite`, issues);
		}
	}
	optionalIntegerAt(model.contextWindow, `${path}.contextWindow`, issues, 1);
	optionalIntegerAt(model.maxTokens, `${path}.maxTokens`, issues, 1);
	if (model.headers !== undefined) {
		const headers = recordAt(model.headers, `${path}.headers`, issues);
		if (headers) {
			for (const [name, headerValue] of Object.entries(headers)) {
				if (!name.trim()) issue(issues, `${path}.headers`, "header names must be non-empty");
				if (typeof headerValue !== "string") issue(issues, `${path}.headers.${name}`, "must be a string");
			}
		}
	}
	if (model.compat !== undefined) recordAt(model.compat, `${path}.compat`, issues);
}

function validateMessage(value: unknown, path: string, issues: RuntimeValidationIssue[]): void {
	const message = recordAt(value, path, issues);
	if (!message) return;
	nonEmptyStringAt(message.role, `${path}.role`, issues);
}

function validateMessageArray(value: unknown, path: string, issues: RuntimeValidationIssue[]): void {
	const messages = arrayAt(value, path, issues);
	if (!messages) return;
	messages.forEach((message, index) => {
		validateMessage(message, `${path}[${index}]`, issues);
	});
}

function validateTool(value: unknown, path: string, issues: RuntimeValidationIssue[]): void {
	const tool = recordAt(value, path, issues);
	if (!tool) return;
	nonEmptyStringAt(tool.name, `${path}.name`, issues);
	nonEmptyStringAt(tool.label, `${path}.label`, issues);
	optionalNonEmptyStringAt(tool.description, `${path}.description`, issues);
}

function validateArtifact(value: unknown, path: string, issues: RuntimeValidationIssue[]): void {
	const artifact = recordAt(value, path, issues);
	if (!artifact) return;
	nonEmptyStringAt(artifact.filename, `${path}.filename`, issues);
	optionalNonEmptyStringAt(artifact.mimeType, `${path}.mimeType`, issues);
	optionalIntegerAt(artifact.size, `${path}.size`, issues);
	optionalNonEmptyStringAt(artifact.createdAt, `${path}.createdAt`, issues);
	optionalNonEmptyStringAt(artifact.updatedAt, `${path}.updatedAt`, issues);
}

function validateError(value: unknown, path: string, issues: RuntimeValidationIssue[]): void {
	const error = recordAt(value, path, issues);
	if (!error) return;
	nonEmptyStringAt(error.code, `${path}.code`, issues);
	nonEmptyStringAt(error.message, `${path}.message`, issues);
	booleanAt(error.retryable, `${path}.retryable`, issues);
}

const EXECUTION_KINDS = ["prompt", "repl", "page-operation"] as const;
const EXECUTION_STATUSES: readonly RuntimeExecutionStatus[] = [
	"queued",
	"running",
	"cancel-requested",
	"succeeded",
	"failed",
	"cancelled",
];

function validateExecution(value: unknown, path: string, issues: RuntimeValidationIssue[]): void {
	const execution = recordAt(value, path, issues);
	if (!execution) return;
	nonEmptyStringAt(execution.executionId, `${path}.executionId`, issues);
	nonEmptyStringAt(execution.requestId, `${path}.requestId`, issues);
	oneOfAt(execution.kind, EXECUTION_KINDS, `${path}.kind`, issues);
	oneOfAt(execution.status, EXECUTION_STATUSES, `${path}.status`, issues);
	optionalNonEmptyStringAt(execution.startedAt, `${path}.startedAt`, issues);
	optionalNonEmptyStringAt(execution.finishedAt, `${path}.finishedAt`, issues);
	if (execution.error !== undefined) validateError(execution.error, `${path}.error`, issues);
}

function validateSnapshot(value: unknown, path: string, issues: RuntimeValidationIssue[]): void {
	const snapshot = recordAt(value, path, issues);
	if (!snapshot) return;
	nonEmptyStringAt(snapshot.sessionId, `${path}.sessionId`, issues);
	validateTarget(snapshot.target, `${path}.target`, issues);
	integerAt(snapshot.revision, `${path}.revision`, issues);
	if (typeof snapshot.systemPrompt !== "string") issue(issues, `${path}.systemPrompt`, "must be a string");
	if (snapshot.model !== null) validateModel(snapshot.model, `${path}.model`, issues);
	oneOfAt(snapshot.thinkingLevel, THINKING_LEVELS, `${path}.thinkingLevel`, issues);
	validateMessageArray(snapshot.messages, `${path}.messages`, issues);
	const tools = arrayAt(snapshot.tools, `${path}.tools`, issues);
	tools?.forEach((tool, index) => {
		validateTool(tool, `${path}.tools[${index}]`, issues);
	});
	const pending = arrayAt(snapshot.pendingToolCallIds, `${path}.pendingToolCallIds`, issues);
	pending?.forEach((id, index) => {
		nonEmptyStringAt(id, `${path}.pendingToolCallIds[${index}]`, issues);
	});
	booleanAt(snapshot.isStreaming, `${path}.isStreaming`, issues);
	if (snapshot.streamingMessage !== undefined) {
		validateMessage(snapshot.streamingMessage, `${path}.streamingMessage`, issues);
	}
	const executions = arrayAt(snapshot.activeExecutions, `${path}.activeExecutions`, issues);
	executions?.forEach((execution, index) => {
		validateExecution(execution, `${path}.activeExecutions[${index}]`, issues);
	});
	const artifacts = arrayAt(snapshot.artifacts, `${path}.artifacts`, issues);
	artifacts?.forEach((artifact, index) => {
		validateArtifact(artifact, `${path}.artifacts[${index}]`, issues);
	});
	optionalNonEmptyStringAt(snapshot.errorMessage, `${path}.errorMessage`, issues);
}

function validateAgentEvent(value: unknown, path: string, issues: RuntimeValidationIssue[]): void {
	const event = recordAt(value, path, issues);
	if (!event) return;
	if (!nonEmptyStringAt(event.type, `${path}.type`, issues)) return;
	switch (event.type) {
		case "agent_start":
		case "turn_start":
			return;
		case "agent_end":
			validateMessageArray(event.messages, `${path}.messages`, issues);
			return;
		case "turn_end":
			validateMessage(event.message, `${path}.message`, issues);
			validateMessageArray(event.toolResults, `${path}.toolResults`, issues);
			return;
		case "message_start":
		case "message_end":
			validateMessage(event.message, `${path}.message`, issues);
			return;
		case "message_update":
			validateMessage(event.message, `${path}.message`, issues);
			recordAt(event.assistantMessageEvent, `${path}.assistantMessageEvent`, issues);
			return;
		case "tool_execution_start":
			nonEmptyStringAt(event.toolCallId, `${path}.toolCallId`, issues);
			nonEmptyStringAt(event.toolName, `${path}.toolName`, issues);
			if (!("args" in event)) issue(issues, `${path}.args`, "is required");
			return;
		case "tool_execution_update":
			nonEmptyStringAt(event.toolCallId, `${path}.toolCallId`, issues);
			nonEmptyStringAt(event.toolName, `${path}.toolName`, issues);
			if (!("args" in event)) issue(issues, `${path}.args`, "is required");
			if (!("partialResult" in event)) issue(issues, `${path}.partialResult`, "is required");
			return;
		case "tool_execution_end":
			nonEmptyStringAt(event.toolCallId, `${path}.toolCallId`, issues);
			nonEmptyStringAt(event.toolName, `${path}.toolName`, issues);
			if (!("result" in event)) issue(issues, `${path}.result`, "is required");
			booleanAt(event.isError, `${path}.isError`, issues);
			return;
		default:
			issue(issues, `${path}.type`, "is not a supported agent event");
	}
}

function validateArtifactsPayload(value: unknown, path: string, issues: RuntimeValidationIssue[]): void {
	const payload = recordAt(value, path, issues);
	if (!payload) return;
	if (!oneOfAt(payload.action, ["list", "get", "put", "delete"] as const, `${path}.action`, issues)) return;
	if (payload.action !== "list") nonEmptyStringAt(payload.filename, `${path}.filename`, issues);
	if (payload.action === "put") {
		if (!("content" in payload)) issue(issues, `${path}.content`, "is required");
		optionalNonEmptyStringAt(payload.mimeType, `${path}.mimeType`, issues);
	}
}

function validateRequestOperation(value: unknown, path: string, issues: RuntimeValidationIssue[]): void {
	const operation = recordAt(value, path, issues);
	if (!operation || !oneOfAt(operation.type, OPERATION_TYPES, `${path}.type`, issues)) return;
	switch (operation.type) {
		case "attach":
			optionalNonEmptyStringAt(operation.knownRuntimeEpoch, `${path}.knownRuntimeEpoch`, issues);
			optionalIntegerAt(operation.lastRevision, `${path}.lastRevision`, issues);
			optionalIntegerAt(operation.lastEventSeq, `${path}.lastEventSeq`, issues);
			return;
		case "create":
			if (typeof operation.systemPrompt !== "string") issue(issues, `${path}.systemPrompt`, "must be a string");
			if (operation.model !== undefined) validateModel(operation.model, `${path}.model`, issues);
			if (operation.thinkingLevel !== undefined) {
				oneOfAt(operation.thinkingLevel, THINKING_LEVELS, `${path}.thinkingLevel`, issues);
			}
			if (operation.initialMessages !== undefined) {
				validateMessageArray(operation.initialMessages, `${path}.initialMessages`, issues);
			}
			return;
		case "load":
			return;
		case "prompt":
			nonEmptyStringAt(operation.executionId, `${path}.executionId`, issues);
			validateMessage(operation.message, `${path}.message`, issues);
			return;
		case "abort":
			nonEmptyStringAt(operation.executionId, `${path}.executionId`, issues);
			nonEmptyStringAt(operation.targetRequestId, `${path}.targetRequestId`, issues);
			optionalNonEmptyStringAt(operation.reason, `${path}.reason`, issues);
			return;
		case "set-model":
			validateModel(operation.model, `${path}.model`, issues);
			return;
		case "set-thinking":
			oneOfAt(operation.thinkingLevel, THINKING_LEVELS, `${path}.thinkingLevel`, issues);
			return;
		case "steer":
			validateMessage(operation.message, `${path}.message`, issues);
			return;
		case "replace-or-append-message":
			validateMessage(operation.message, `${path}.message`, issues);
			optionalIntegerAt(operation.messageIndex, `${path}.messageIndex`, issues);
			integerAt(operation.expectedRevision, `${path}.expectedRevision`, issues);
			return;
		case "artifacts":
			validateArtifactsPayload(operation.payload, `${path}.payload`, issues);
			return;
		case "release":
			if (operation.force !== undefined) booleanAt(operation.force, `${path}.force`, issues);
			optionalNonEmptyStringAt(operation.reason, `${path}.reason`, issues);
			return;
		case "repl-execute":
			nonEmptyStringAt(operation.executionId, `${path}.executionId`, issues);
			if (typeof operation.code !== "string") issue(issues, `${path}.code`, "must be a string");
			if (operation.language !== undefined && operation.language !== "javascript") {
				issue(issues, `${path}.language`, "must be javascript");
			}
			return;
		case "page-operation":
			nonEmptyStringAt(operation.executionId, `${path}.executionId`, issues);
			nonEmptyStringAt(operation.operation, `${path}.operation`, issues);
			recordAt(operation.params, `${path}.params`, issues);
			return;
		case "resync":
			integerAt(operation.knownRevision, `${path}.knownRevision`, issues);
			integerAt(operation.lastEventSeq, `${path}.lastEventSeq`, issues);
			oneOfAt(
				operation.reason,
				["gap", "runtime-restart", "revision-regression", "explicit"] as const,
				`${path}.reason`,
				issues,
			);
	}
}

function validateBase(envelope: Record<string, unknown>, issues: RuntimeValidationIssue[]): void {
	if (envelope.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
		issue(issues, "$.protocolVersion", `must equal ${RUNTIME_PROTOCOL_VERSION}`);
	}
	nonEmptyStringAt(envelope.runtimeEpoch, "$.runtimeEpoch", issues);
	nonEmptyStringAt(envelope.clientId, "$.clientId", issues);
	integerAt(envelope.windowId, "$.windowId", issues);
	validateTrace(envelope.trace, "$.trace", issues);
}

function validateSessionScope(envelope: Record<string, unknown>, issues: RuntimeValidationIssue[]): void {
	nonEmptyStringAt(envelope.sessionId, "$.sessionId", issues);
	validateTarget(envelope.target, "$.target", issues);
}

function validateRequest(envelope: Record<string, unknown>, issues: RuntimeValidationIssue[]): void {
	validateSessionScope(envelope, issues);
	nonEmptyStringAt(envelope.requestId, "$.requestId", issues);
	validateRequestOperation(envelope.operation, "$.operation", issues);
}

function validateResponse(envelope: Record<string, unknown>, issues: RuntimeValidationIssue[]): void {
	validateSessionScope(envelope, issues);
	nonEmptyStringAt(envelope.requestId, "$.requestId", issues);
	oneOfAt(envelope.operation, OPERATION_TYPES, "$.operation", issues);
	if (!booleanAt(envelope.ok, "$.ok", issues)) return;
	if (envelope.ok) {
		if (!("result" in envelope)) issue(issues, "$.result", "is required for a successful response");
		if ("error" in envelope) issue(issues, "$.error", "must be omitted from a successful response");
	} else {
		validateError(envelope.error, "$.error", issues);
		if ("result" in envelope) issue(issues, "$.result", "must be omitted from an error response");
	}
}

function validateRecoveryCursor(value: unknown, path: string, issues: RuntimeValidationIssue[]): void {
	const cursor = recordAt(value, path, issues);
	if (!cursor) return;
	nonEmptyStringAt(cursor.sessionId, `${path}.sessionId`, issues);
	validateTarget(cursor.target, `${path}.target`, issues);
	integerAt(cursor.revision, `${path}.revision`, issues);
	integerAt(cursor.eventSeq, `${path}.eventSeq`, issues);
}

function validateHello(envelope: Record<string, unknown>, issues: RuntimeValidationIssue[]): void {
	const recovery = recordAt(envelope.recovery, "$.recovery", issues);
	if (!recovery) return;
	if (!oneOfAt(recovery.mode, ["fresh", "resumed", "restarted"] as const, "$.recovery.mode", issues)) return;
	optionalNonEmptyStringAt(recovery.previousRuntimeEpoch, "$.recovery.previousRuntimeEpoch", issues);
	if (recovery.mode === "restarted" && recovery.previousRuntimeEpoch === undefined) {
		issue(issues, "$.recovery.previousRuntimeEpoch", "is required for restarted recovery");
	}
	const sessions = arrayAt(recovery.sessions, "$.recovery.sessions", issues);
	sessions?.forEach((cursor, index) => {
		validateRecoveryCursor(cursor, `$.recovery.sessions[${index}]`, issues);
	});
}

function canonicalWireValue(value: RuntimeValue): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalWireValue).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalWireValue(value[key])}`)
		.join(",")}}`;
}

function sameTarget(left: unknown, right: unknown): boolean {
	return (
		isRuntimeWireValue(left) && isRuntimeWireValue(right) && canonicalWireValue(left) === canonicalWireValue(right)
	);
}

function validateSessionStream(envelope: Record<string, unknown>, issues: RuntimeValidationIssue[]): void {
	validateSessionScope(envelope, issues);
	integerAt(envelope.revision, "$.revision", issues);
	integerAt(envelope.eventSeq, "$.eventSeq", issues, 1);
	switch (envelope.streamType) {
		case "session-snapshot": {
			validateSnapshot(envelope.snapshot, "$.snapshot", issues);
			const snapshot = isPlainRecord(envelope.snapshot) ? envelope.snapshot : undefined;
			if (snapshot && snapshot.sessionId !== envelope.sessionId) {
				issue(issues, "$.snapshot.sessionId", "must match the envelope sessionId");
			}
			if (snapshot && snapshot.revision !== envelope.revision) {
				issue(issues, "$.snapshot.revision", "must match the envelope revision");
			}
			if (snapshot && !sameTarget(snapshot.target, envelope.target)) {
				issue(issues, "$.snapshot.target", "must match the envelope target");
			}
			return;
		}
		case "agent-event":
			validateAgentEvent(envelope.agentEvent, "$.agentEvent", issues);
			return;
		case "execution":
			validateExecution(envelope.execution, "$.execution", issues);
			return;
		case "resync-required":
			oneOfAt(
				envelope.reason,
				["gap", "runtime-restart", "revision-regression", "unknown-session"] as const,
				"$.reason",
				issues,
			);
			integerAt(envelope.expectedEventSeq, "$.expectedEventSeq", issues, 1);
			integerAt(envelope.receivedEventSeq, "$.receivedEventSeq", issues, 1);
			return;
		default:
			issue(issues, "$.streamType", "is not a supported stream type");
	}
}

export function validateRuntimeEnvelope(value: unknown): RuntimeValidationResult<RuntimeEnvelope> {
	const issues: RuntimeValidationIssue[] = [];
	if (!isRuntimeWireValue(value)) {
		return {
			ok: false,
			issues: [{ path: "$", message: "must contain only finite, acyclic plain runtime wire values" }],
		};
	}
	const envelope = recordAt(value, "$", issues);
	if (!envelope) return { ok: false, issues };
	validateBase(envelope, issues);
	if (envelope.kind === "request") {
		validateRequest(envelope, issues);
	} else if (envelope.kind === "response") {
		validateResponse(envelope, issues);
	} else if (envelope.kind === "stream") {
		if (envelope.streamType === "hello") validateHello(envelope, issues);
		else validateSessionStream(envelope, issues);
	} else {
		issue(issues, "$.kind", "must be request, response, or stream");
	}
	return issues.length === 0 ? { ok: true, value: value as unknown as RuntimeEnvelope } : { ok: false, issues };
}

export function isRuntimeEnvelope(value: unknown): value is RuntimeEnvelope {
	return validateRuntimeEnvelope(value).ok;
}

export function isRuntimeRequestEnvelope(value: unknown): value is RuntimeRequestEnvelope {
	const result = validateRuntimeEnvelope(value);
	return result.ok && result.value.kind === "request";
}

export function isRuntimeResponseEnvelope(value: unknown): value is RuntimeResponseEnvelope {
	const result = validateRuntimeEnvelope(value);
	return result.ok && result.value.kind === "response";
}

export function isRuntimeStreamEnvelope(value: unknown): value is RuntimeStreamEnvelope {
	const result = validateRuntimeEnvelope(value);
	return result.ok && result.value.kind === "stream";
}
