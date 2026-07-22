import type { RuntimeRecord, RuntimeValue } from "../agent/runtime-protocol.js";
import type { AgentRuntimePageOperationMessage } from "./internal-messages.js";

export interface AgentRuntimePageAuthorizationInput {
	windowId: number;
	operation: AgentRuntimePageOperationMessage["operation"];
	payload: RuntimeRecord;
	signal?: AbortSignal;
}

export interface AgentRuntimeTabWindowResolver {
	getWindowId(tabId: number): Promise<number>;
}

function runtimeRecord(value: RuntimeValue | undefined): RuntimeRecord | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function operationParams(input: AgentRuntimePageAuthorizationInput): RuntimeRecord {
	if (input.operation !== "navigate") return input.payload;
	return runtimeRecord(input.payload.args) ?? input.payload;
}

function numericTarget(value: RuntimeValue | undefined, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} must be a non-negative safe integer`);
	}
	return value;
}

function explicitTabIds(input: AgentRuntimePageAuthorizationInput): number[] {
	const params = operationParams(input);
	const ids: number[] = [];
	const push = (value: RuntimeValue | undefined, label: string): void => {
		const id = numericTarget(value, label);
		if (id !== undefined && !ids.includes(id)) ids.push(id);
	};
	push(params.tabId, "tabId");
	if (input.operation === "navigate") {
		push(params.switchToTab, "switchToTab");
		push(params.closeTab, "closeTab");
		if (params.closeTabs !== undefined) {
			if (!Array.isArray(params.closeTabs)) throw new Error("closeTabs must be an array of tab ids");
			for (const value of params.closeTabs) push(value, "closeTabs entry");
		}
	}
	return ids;
}

function explicitWindowIds(input: AgentRuntimePageAuthorizationInput): number[] {
	if (input.operation !== "navigate") return [];
	const params = operationParams(input);
	const ids: number[] = [];
	const push = (value: RuntimeValue | undefined, label: string): void => {
		const id = numericTarget(value, label);
		if (id !== undefined && !ids.includes(id)) ids.push(id);
	};
	push(params.closeWindow, "closeWindow");
	const filter = runtimeRecord(params.closeTabFilter);
	if (filter) push(filter.windowId, "closeTabFilter.windowId");
	return ids;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const error = new Error("Page target authorization was aborted");
	error.name = "AbortError";
	throw error;
}

/** Enforces the descriptor window before any privileged delegate is created. */
export async function authorizeAgentRuntimePageTarget(
	input: AgentRuntimePageAuthorizationInput,
	resolver: AgentRuntimeTabWindowResolver,
): Promise<void> {
	if (!Number.isSafeInteger(input.windowId) || input.windowId <= 0) {
		throw new Error("Privileged Chrome page operations require a positive descriptor windowId");
	}
	for (const windowId of explicitWindowIds(input)) {
		if (windowId !== input.windowId) {
			throw new Error(`Window ${windowId} is outside authorized window ${input.windowId}`);
		}
	}
	for (const tabId of explicitTabIds(input)) {
		throwIfAborted(input.signal);
		const actualWindowId = await resolver.getWindowId(tabId);
		if (actualWindowId !== input.windowId) {
			throw new Error(`Tab ${tabId} belongs to window ${actualWindowId}, not authorized window ${input.windowId}`);
		}
	}
	throwIfAborted(input.signal);
}

/** Constrains filter-based tab mutation, which has no explicit tab id to pre-authorize. */
export function scopeAgentRuntimeNavigatePayload(payload: RuntimeRecord, windowId: number): RuntimeRecord {
	const cloned = structuredClone(payload);
	const nestedArgs = runtimeRecord(cloned.args);
	const params = nestedArgs ?? cloned;
	const filter = runtimeRecord(params.closeTabFilter);
	if (!filter) return cloned;
	params.closeTabFilter = { ...filter, windowId };
	if (nestedArgs) cloned.args = params;
	return cloned;
}
