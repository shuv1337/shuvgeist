import type { RuntimeRecord } from "../agent/runtime-protocol.js";

/** Concrete page selected by `shuvgeist repl --tab-id` / `--frame-id`. */
export interface ReplPageTarget {
	tabId?: number;
	frameId?: number;
}

/**
 * Page operations that should follow a CLI REPL's explicit tab instead of the
 * active tab. Debugger and snapshot operations keep their own target rules.
 */
const PINNED_REPL_PAGE_OPERATIONS = new Set([
	"browser-js",
	"native-input",
	"navigate",
	"repl-overlay-show",
	"repl-overlay-remove",
]);

export function replPageTargetFromParams(params: { tabId?: number; frameId?: number }): ReplPageTarget | undefined {
	const target: ReplPageTarget = {};
	if (typeof params.tabId === "number") target.tabId = params.tabId;
	if (typeof params.frameId === "number") target.frameId = params.frameId;
	if (target.tabId === undefined && target.frameId === undefined) return undefined;
	return target;
}

/**
 * Fill a missing tab or frame from the REPL pin. An id already present on the
 * operation wins, so a script can still address a different tab explicitly.
 */
export function applyPinnedReplPageTarget(
	operation: string,
	params: RuntimeRecord,
	pageTarget: ReplPageTarget | undefined,
): RuntimeRecord {
	if (!pageTarget || !PINNED_REPL_PAGE_OPERATIONS.has(operation)) return params;
	const next: RuntimeRecord = { ...params };
	if (typeof pageTarget.tabId === "number" && next.tabId === undefined) next.tabId = pageTarget.tabId;
	if (typeof pageTarget.frameId === "number" && next.frameId === undefined) next.frameId = pageTarget.frameId;
	return next;
}
