import {
	isRuntimeWireValue,
	type RuntimeRecord,
	type RuntimeTargetIdentity,
	type RuntimeTraceContext,
	type RuntimeValue,
} from "../agent/runtime-protocol.js";
import type { AgentRuntimePageCancelMessage, AgentRuntimePageOperationMessage } from "./internal-messages.js";

export type AgentRuntimePageControlMessage = AgentRuntimePageOperationMessage | AgentRuntimePageCancelMessage;

export type AgentRuntimePageOperationResponse = { ok: true; result: RuntimeValue } | { ok: false; error: string };

export interface AgentRuntimeLogicalChromeTarget {
	kind: "chrome-tab";
	tabRef: "active" | `window:${number}`;
	frameId?: number;
}

export interface AgentRuntimePageDelegateScope {
	runtimeEpoch: string;
	clientId: string;
	windowId: number;
	sessionId: string;
	target: AgentRuntimeLogicalChromeTarget;
}

export interface AgentRuntimePageDelegateInput extends AgentRuntimePageDelegateScope {
	operationId: string;
	operation: AgentRuntimePageOperationMessage["operation"];
	payload: RuntimeRecord;
	signal: AbortSignal;
	trace?: RuntimeTraceContext;
	executionId: string;
	executionRequestId: string;
}

/**
 * Narrow execution seam for background-owned privileged operations. A wiring
 * adapter may dispatch BrowserCommandExecutor operations and legacy browser-js
 * or native-input operations without exposing either implementation here.
 */
export interface AgentRuntimePageOperationDelegate {
	execute(input: AgentRuntimePageDelegateInput): Promise<unknown> | unknown;
}

export type AgentRuntimePageOperationDelegateFactory = (
	scope: AgentRuntimePageDelegateScope,
) => Promise<AgentRuntimePageOperationDelegate> | AgentRuntimePageOperationDelegate;

export interface AgentRuntimePageControllerOptions {
	createDelegate: AgentRuntimePageOperationDelegateFactory;
	/** Authorizes concrete payload targets before a privileged delegate is created. */
	authorize?(input: AgentRuntimePageDelegateInput): Promise<void> | void;
	/** Bounds idempotency history while retaining recent terminal responses. */
	maxCompletedOperations?: number;
	reportError?(error: unknown, context: string): void;
}

interface ActivePageOperation {
	readonly abortController: AbortController;
	readonly rejectCancellation: () => void;
	readonly correlationFingerprint: string;
	cancelled: boolean;
}

interface CompletedPageOperation {
	readonly fingerprint: string;
	readonly response: AgentRuntimePageOperationResponse;
}

const PAGE_OPERATIONS: readonly AgentRuntimePageOperationMessage["operation"][] = [
	"browser-js",
	"navigate",
	"native-input",
	"navigation-context",
	"page-snapshot",
	"select-element",
	"screenshot",
	"extract-image-source",
	"debugger",
	"repl-overlay-show",
	"repl-overlay-remove",
];

class PageOperationCancelledError extends Error {
	constructor(operationId: string) {
		super(`Page operation '${operationId}' was cancelled`);
		this.name = "PageOperationCancelledError";
	}
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message;
	const message = String(error);
	return message.trim() ? message : "Unknown page operation error";
}

function cloneWireValue<T extends RuntimeValue>(value: T): T {
	return structuredClone(value);
}

function cloneResponse(response: AgentRuntimePageOperationResponse): AgentRuntimePageOperationResponse {
	return structuredClone(response);
}

function canonicalWireValue(value: RuntimeValue): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalWireValue).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalWireValue(value[key])}`)
		.join(",")}}`;
}

function normalizeLogicalTarget(
	target: RuntimeTargetIdentity,
	windowId: number,
): AgentRuntimeLogicalChromeTarget | string {
	if (!isRuntimeWireValue(target)) return "Page operation target must contain only plain wire data";
	if (target.kind !== "chrome-tab") return "Privileged page operations require a Chrome tab target";
	if (target.tabId !== undefined) {
		return "Page operation target must be logical and cannot contain a concrete tabId";
	}
	if (target.frameId !== undefined && (!Number.isSafeInteger(target.frameId) || target.frameId < 0)) {
		return "Page operation target frameId must be a non-negative safe integer";
	}
	const expectedWindowRef = `window:${windowId}` as `window:${number}`;
	if (target.tabRef !== "active" && target.tabRef !== expectedWindowRef) {
		return `Page operation target must be 'active' or '${expectedWindowRef}'`;
	}
	return {
		kind: "chrome-tab",
		tabRef: target.tabRef,
		...(target.frameId !== undefined ? { frameId: target.frameId } : {}),
	};
}

function validateOperationMessage(
	message: AgentRuntimePageOperationMessage,
): { scope: AgentRuntimePageDelegateScope; payload: RuntimeRecord } | string {
	if (!isRuntimeWireValue(message)) return "Page operation message must contain only plain wire data";
	if (!nonEmptyString(message.operationId)) return "Page operationId must be a non-empty string";
	if (!nonEmptyString(message.runtimeEpoch)) return "Page runtimeEpoch must be a non-empty string";
	if (!nonEmptyString(message.clientId)) return "Page clientId must be a non-empty string";
	if (!Number.isSafeInteger(message.windowId) || message.windowId < 0) {
		return "Page windowId must be a non-negative safe integer";
	}
	if (!nonEmptyString(message.sessionId)) return "Page sessionId must be a non-empty string";
	if (!PAGE_OPERATIONS.includes(message.operation)) return `Unsupported page operation '${message.operation}'`;
	if (!isRuntimeWireValue(message.payload) || Array.isArray(message.payload) || message.payload === null) {
		return "Page operation payload must be a plain wire-data object";
	}
	if (!nonEmptyString(message.executionId)) return "Page executionId must be a non-empty string";
	if (!nonEmptyString(message.executionRequestId)) return "Page executionRequestId must be a non-empty string";
	const target = normalizeLogicalTarget(message.target, message.windowId);
	if (typeof target === "string") return target;
	return {
		scope: {
			runtimeEpoch: message.runtimeEpoch,
			clientId: message.clientId,
			windowId: message.windowId,
			sessionId: message.sessionId,
			target,
		},
		payload: cloneWireValue(message.payload as RuntimeRecord),
	};
}

function validateCancelMessage(message: AgentRuntimePageCancelMessage): string | undefined {
	if (!isRuntimeWireValue(message)) return "Page cancellation must contain only plain wire data";
	if (!nonEmptyString(message.operationId)) return "Page cancellation operationId must be a non-empty string";
	if (!nonEmptyString(message.runtimeEpoch)) return "Page cancellation runtimeEpoch must be a non-empty string";
	if (!nonEmptyString(message.clientId)) return "Page cancellation clientId must be a non-empty string";
	if (!Number.isSafeInteger(message.windowId) || message.windowId < 0) {
		return "Page cancellation windowId must be a non-negative safe integer";
	}
	if (!nonEmptyString(message.sessionId)) return "Page cancellation sessionId must be a non-empty string";
	if (!nonEmptyString(message.executionId)) return "Page cancellation executionId must be a non-empty string";
	if (!nonEmptyString(message.executionRequestId)) {
		return "Page cancellation executionRequestId must be a non-empty string";
	}
	const target = normalizeLogicalTarget(message.target, message.windowId);
	return typeof target === "string" ? target : undefined;
}

function pageControlCorrelationFingerprint(
	message: AgentRuntimePageOperationMessage | AgentRuntimePageCancelMessage,
): string {
	return canonicalWireValue({
		operationId: message.operationId,
		runtimeEpoch: message.runtimeEpoch,
		clientId: message.clientId,
		windowId: message.windowId,
		sessionId: message.sessionId,
		target: message.target,
		executionId: message.executionId,
		executionRequestId: message.executionRequestId,
	});
}

function cancelledResponse(operationId: string): AgentRuntimePageOperationResponse {
	return { ok: false, error: `Page operation '${operationId}' was cancelled` };
}

function operationFingerprint(
	message: AgentRuntimePageOperationMessage,
	validated: { scope: AgentRuntimePageDelegateScope; payload: RuntimeRecord },
): string {
	return canonicalWireValue({
		operationId: message.operationId,
		runtimeEpoch: message.runtimeEpoch,
		clientId: message.clientId,
		windowId: message.windowId,
		sessionId: message.sessionId,
		target: validated.scope.target as unknown as RuntimeValue,
		operation: message.operation,
		payload: validated.payload,
		executionId: message.executionId,
		executionRequestId: message.executionRequestId,
	});
}

/**
 * Owns the lifecycle of privileged page operations in the background service
 * worker. It deliberately tracks logical window targets rather than concrete
 * tabs, allowing the delegate to resolve the active tab at execution time.
 */
export class AgentRuntimePageController {
	private readonly activeOperations = new Map<string, ActivePageOperation>();
	private readonly completedOperations = new Map<string, CompletedPageOperation>();
	private readonly maxCompletedOperations: number;
	private disposed = false;

	constructor(private readonly options: AgentRuntimePageControllerOptions) {
		const requestedLimit = options.maxCompletedOperations;
		this.maxCompletedOperations =
			requestedLimit !== undefined && Number.isSafeInteger(requestedLimit) && requestedLimit > 0
				? requestedLimit
				: 512;
	}

	get activeOperationCount(): number {
		return this.activeOperations.size;
	}

	get completedOperationCount(): number {
		return this.completedOperations.size;
	}

	hasActiveOperation(operationId: string): boolean {
		return this.activeOperations.has(operationId);
	}

	handle(message: AgentRuntimePageControlMessage): Promise<AgentRuntimePageOperationResponse> {
		return message.type === "agent-runtime-page-cancel"
			? Promise.resolve(this.cancel(message))
			: this.execute(message);
	}

	async execute(message: AgentRuntimePageOperationMessage): Promise<AgentRuntimePageOperationResponse> {
		if (this.disposed) return { ok: false, error: "Page operation controller is disposed" };
		const validated = validateOperationMessage(message);
		if (typeof validated === "string") return { ok: false, error: validated };
		const fingerprint = operationFingerprint(message, validated);
		const completed = this.completedOperations.get(message.operationId);
		if (completed) {
			return completed.fingerprint === fingerprint
				? cloneResponse(completed.response)
				: {
						ok: false,
						error: `Page operation '${message.operationId}' already completed with different correlation data`,
					};
		}
		if (this.activeOperations.has(message.operationId)) {
			return { ok: false, error: `Page operation '${message.operationId}' is already active` };
		}

		const abortController = new AbortController();
		let rejectCancellation = () => {};
		const cancellation = new Promise<never>((_resolve, reject) => {
			rejectCancellation = () => reject(new PageOperationCancelledError(message.operationId));
		});
		const active: ActivePageOperation = {
			abortController,
			rejectCancellation,
			correlationFingerprint: pageControlCorrelationFingerprint(message),
			cancelled: false,
		};
		this.activeOperations.set(message.operationId, active);

		const execution = this.executeDelegate(message, validated, abortController.signal);
		let response: AgentRuntimePageOperationResponse;
		try {
			const result = await Promise.race([execution, cancellation]);
			if (active.cancelled || abortController.signal.aborted) {
				response = cancelledResponse(message.operationId);
			} else {
				const wireResult = result === undefined ? null : result;
				response = isRuntimeWireValue(wireResult)
					? { ok: true, result: cloneWireValue(wireResult) }
					: { ok: false, error: `Page operation '${message.operationId}' returned non-wire data` };
			}
		} catch (error) {
			if (active.cancelled || error instanceof PageOperationCancelledError || abortController.signal.aborted) {
				response = cancelledResponse(message.operationId);
			} else {
				response = { ok: false, error: errorMessage(error) };
			}
		} finally {
			if (this.activeOperations.get(message.operationId) === active) {
				this.activeOperations.delete(message.operationId);
			}
		}
		this.rememberCompleted(message.operationId, fingerprint, response);
		return cloneResponse(response);
	}

	cancel(message: AgentRuntimePageCancelMessage): AgentRuntimePageOperationResponse {
		const validationError = validateCancelMessage(message);
		if (validationError) return { ok: false, error: validationError };
		const active = this.activeOperations.get(message.operationId);
		if (!active) {
			return {
				ok: false,
				error: this.completedOperations.has(message.operationId)
					? `Page operation '${message.operationId}' already completed`
					: `Page operation '${message.operationId}' is not active`,
			};
		}
		if (active.correlationFingerprint !== pageControlCorrelationFingerprint(message)) {
			return {
				ok: false,
				error: `Page operation '${message.operationId}' cancellation correlation does not match`,
			};
		}
		if (active.cancelled)
			return { ok: false, error: `Page operation '${message.operationId}' is already cancelling` };
		active.cancelled = true;
		active.abortController.abort();
		active.rejectCancellation();
		return { ok: true, result: { operationId: message.operationId, cancelled: true } };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const active of this.activeOperations.values()) {
			active.cancelled = true;
			active.abortController.abort();
			active.rejectCancellation();
		}
	}

	private rememberCompleted(
		operationId: string,
		fingerprint: string,
		response: AgentRuntimePageOperationResponse,
	): void {
		this.completedOperations.set(operationId, { fingerprint, response: cloneResponse(response) });
		while (this.completedOperations.size > this.maxCompletedOperations) {
			const oldestOperationId = this.completedOperations.keys().next().value;
			if (typeof oldestOperationId !== "string") return;
			this.completedOperations.delete(oldestOperationId);
		}
	}

	private async executeDelegate(
		message: AgentRuntimePageOperationMessage,
		validated: { scope: AgentRuntimePageDelegateScope; payload: RuntimeRecord },
		signal: AbortSignal,
	): Promise<unknown> {
		const input: AgentRuntimePageDelegateInput = {
			...structuredClone(validated.scope),
			operationId: message.operationId,
			operation: message.operation,
			payload: cloneWireValue(validated.payload),
			signal,
			...(message.trace !== undefined ? { trace: structuredClone(message.trace) } : {}),
			executionId: message.executionId,
			executionRequestId: message.executionRequestId,
		};
		try {
			if (this.options.authorize) await this.options.authorize(input);
			if (signal.aborted) throw new PageOperationCancelledError(message.operationId);
			const delegate = await this.options.createDelegate(structuredClone(validated.scope));
			if (signal.aborted) throw new PageOperationCancelledError(message.operationId);
			return await delegate.execute(input);
		} catch (error) {
			if (!signal.aborted) this.options.reportError?.(error, `page operation ${message.operationId}`);
			throw error;
		}
	}
}
