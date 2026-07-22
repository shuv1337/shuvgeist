import {
	type BridgeCommandHandler,
	type BridgeCommandHandlerRegistry,
	type BridgeCommandParams,
	type BridgeCommandResult,
	type ElectronTargetBridgeMethod,
	ElectronTargetBridgeMethods,
} from "@shuvgeist/protocol/command-schemas";
import type { RecordFrameEventData } from "@shuvgeist/protocol/protocol";
import type { BridgeTarget } from "@shuvgeist/protocol/target";
import type { ElectronSessionManager } from "./session-manager.js";

export interface ElectronTargetHandlerContext {
	sessions: ElectronSessionManager;
	target: BridgeTarget;
	emitRecordFrame(data: RecordFrameEventData): void;
}

/**
 * The concrete Electron-window command adapter. Its keys are the advertised
 * Electron target capabilities, so adding capability support necessarily adds
 * an executable, method-correlated handler at the same declaration site.
 */
export const ElectronTargetCommandHandlers = {
	screenshot: ({ sessions, target }, params) => sessions.screenshot(target, params.maxWidth, params.frameId),
	eval: ({ sessions, target }, params) => sessions.evaluate(target, params.code, params.frameId),
	page_snapshot: ({ sessions, target }, params) => sessions.snapshot(target, params),
	page_assert: ({ sessions, target }, params) => sessions.assert(target, params),
	locate_by_role: ({ sessions, target }, params) => sessions.locateByRole(target, params),
	locate_by_text: ({ sessions, target }, params) => sessions.locateByText(target, params),
	locate_by_label: ({ sessions, target }, params) => sessions.locateByLabel(target, params),
	ref_click: ({ sessions, target }, params) => sessions.refClick(target, params),
	ref_fill: ({ sessions, target }, params) => sessions.refFill(target, params),
	network_start: ({ sessions, target }, params) => sessions.networkStart(target, params),
	network_stop: ({ sessions, target }) => sessions.networkStop(target),
	network_list: ({ sessions, target }, params) => sessions.networkList(target, params),
	network_clear: ({ sessions, target }) => sessions.networkClear(target),
	network_stats: ({ sessions, target }) => sessions.networkStats(target),
	network_get: ({ sessions, target }, params) => sessions.networkGet(target, params),
	network_body: ({ sessions, target }, params) => sessions.networkBody(target, params),
	network_curl: ({ sessions, target }, params) => sessions.networkCurl(target, params),
	perf_metrics: ({ sessions, target }, params) => sessions.perfMetrics(target, params),
	record_start: ({ sessions, target, emitRecordFrame }, params) =>
		sessions.recordStart(target, params, emitRecordFrame),
	record_stop: ({ sessions, target }, params) => sessions.recordStop(target, params.frameId),
	record_status: ({ sessions, target }, params) => sessions.recordStatus(target, params.frameId),
} satisfies BridgeCommandHandlerRegistry<ElectronTargetBridgeMethod, ElectronTargetHandlerContext>;

export { ElectronTargetBridgeMethods };

const ElectronTargetBridgeMethodSet: ReadonlySet<string> = new Set(ElectronTargetBridgeMethods);

export function isElectronTargetBridgeMethod(method: string): method is ElectronTargetBridgeMethod {
	return ElectronTargetBridgeMethodSet.has(method);
}

export function executeElectronTargetCommand<M extends ElectronTargetBridgeMethod>(
	context: ElectronTargetHandlerContext,
	method: M,
	params: BridgeCommandParams<M>,
): Promise<BridgeCommandResult<M>> {
	assertNoChromeSelectors(params);
	const handler = ElectronTargetCommandHandlers[method] as BridgeCommandHandler<M, ElectronTargetHandlerContext>;
	return Promise.resolve(handler(context, params));
}

function assertNoChromeSelectors(params: unknown): void {
	if (typeof params !== "object" || params === null) return;
	const record = params as Record<string, unknown>;
	const conflicting = ["tabId", "tabRef", "windowId"].filter((key) => Object.hasOwn(record, key));
	if (conflicting.length === 0) return;
	throw new Error(`Electron target parameters cannot include Chrome selectors: ${conflicting.join(", ")}`);
}
