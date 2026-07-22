/**
 * Bridge-mode command executor.
 *
 * Instantiates the same browser tools used by the sidepanel agent and
 * exposes bridge-friendly methods that accept an AbortSignal. This keeps
 * the bridge and agent tooling backed by the same underlying code.
 */

import type { SnapshotInjectionEntry } from "@shuvgeist/driver/injected-contracts";
import type { PageSnapshotResult as DriverPageSnapshotResult } from "@shuvgeist/driver/page-driver";
import {
	pageDriverLocatorMatchesToWire,
	pageDriverNetworkBodyToWire,
	pageDriverNetworkCurlToWire,
	pageDriverNetworkGetToWire,
	pageDriverNetworkListToWire,
	pageDriverNetworkStatsToWire,
	pageDriverRefActionToWire,
	pageDriverScopeToWire,
	pageDriverSnapshotToWire,
} from "@shuvgeist/driver/page-driver-wire";
import {
	type BridgeCommandHandler,
	type BridgeCommandHandlerRegistry,
	type BridgeCommandMethodForRoute,
	type BridgeCommandResult,
	formatBridgeCommandValidationErrors,
	getBridgeCommandDefinition,
	validateBridgeCommandParams,
	validateBridgeCommandResult,
} from "@shuvgeist/protocol/command-schemas";
import type {
	BridgeMethod,
	BridgeReplResult,
	BridgeScreenshotResult,
	BridgeStatusResult,
	CookieImportApplyParams,
	CookieImportResult,
	CookiesParams,
	DeviceEmulateParams,
	DeviceResetParams,
	EvalParams,
	FrameListParams,
	LocateByLabelParams,
	LocateByRoleParams,
	LocateByTextParams,
	NavigateParams,
	NetworkCurlParams,
	NetworkItemParams,
	NetworkListParams,
	NetworkStartParams,
	PageAssertParams,
	PageAssertResult,
	PageSnapshotBridgeParams,
	PerfMetricsParams,
	PerfTraceStartParams,
	PerfTraceStopParams,
	RecordStartParams,
	RecordStartResult,
	RecordStatusParams,
	RecordStatusResult,
	RecordStopParams,
	RecordStopResult,
	RefClickParams,
	RefFillParams,
	ReplParams,
	ScreenshotParams,
	SelectElementParams,
	SessionArtifactsResult,
	SessionHistoryParams,
	SessionHistoryResult,
	SessionInjectParams,
	SessionInjectResult,
	SessionNewParams,
	SessionNewResult,
	SessionSetModelParams,
	SessionSetModelResult,
	WorkflowRunParams,
	WorkflowRunResultWire,
	WorkflowValidateParams,
} from "@shuvgeist/protocol/protocol";
import { ErrorCodes, getBridgeCapabilities } from "@shuvgeist/protocol/protocol";
import { type BridgeTarget, isChromeTarget, targetTeachingLabel } from "@shuvgeist/protocol/target";
import type { BridgeTelemetry, TraceContext } from "@shuvgeist/protocol/telemetry";
import { AskUserWhichElementTool } from "../tools/ask-user-which-element.js";
import { DebuggerTool } from "../tools/debugger.js";
import { normalizeDeviceEmulationRequest } from "../tools/device-presets.js";
import { ExtractImageTool } from "../tools/extract-image.js";
import { resolveTabTarget } from "../tools/helpers/browser-target.js";
import { getSharedDebuggerManager } from "../tools/helpers/debugger-manager.js";
import { buildFrameTree, listFrames } from "../tools/helpers/frame-resolver.js";
import { NavigateTool } from "../tools/navigate.js";
import {
	buildMainWorldExpressionAssertCode,
	buildPageAssertResult,
	type ChromePageAssertScope,
	runPageAssert,
} from "../tools/page-assert.js";
import {
	locateByLabel,
	locateByRole,
	locateByText,
	type PageSnapshotEntry,
	type PageSnapshotResult,
} from "../tools/page-snapshot.js";
import { PerformanceTools } from "../tools/performance-tools.js";
import { WorkflowEngine } from "../tools/workflow-engine.js";
import { ShownSkillsState } from "../utils/shown-skills.js";
import {
	ChromePageDriverRegistry,
	type ChromePageDriverRegistryLike,
	type ResolvedChromePageDriver,
} from "./chrome-page-driver-registry.js";
import { buildSessionHistoryResult, type SessionBridgeAdapter } from "./session-bridge.js";

/**
 * Router interface for REPL execution.
 * When provided, the executor delegates REPL calls through this router
 * instead of executing directly (needed when running in service worker context).
 */
export interface ReplRouter {
	execute(params: ReplParams, signal?: AbortSignal, traceContext?: TraceContext): Promise<BridgeReplResult>;
}

type ResolvedChromeRefPageDriver = ResolvedChromePageDriver & { frameId: number };

/**
 * Router interface for screenshot capture.
 * When provided, the executor delegates screenshot calls through this router
 * instead of using ExtractImageTool directly (needed when running in service
 * worker context where canvas/image APIs may hang).
 */
export interface ScreenshotRouter {
	capture(
		params: ScreenshotParams,
		signal?: AbortSignal,
		traceContext?: TraceContext,
	): Promise<BridgeScreenshotResult>;
}

export interface RecordingRouter {
	start(params: RecordStartParams, signal?: AbortSignal, traceContext?: TraceContext): Promise<RecordStartResult>;
	stop(params: RecordStopParams, signal?: AbortSignal, traceContext?: TraceContext): Promise<RecordStopResult>;
	status(params: RecordStatusParams, traceContext?: TraceContext): Promise<RecordStatusResult>;
}

export interface BrowserCommandExecutorOptions {
	windowId: number;
	sessionId?: string;
	sensitiveAccessEnabled: boolean;
	pageDriverRegistry?: ChromePageDriverRegistryLike;
	shownSkillsState?: ShownSkillsState;
	sessionBridge?: SessionBridgeAdapter;
	replRouter?: ReplRouter;
	screenshotRouter?: ScreenshotRouter;
	recordingRouter?: RecordingRouter;
	telemetry?: BridgeTelemetry;
}

type ExtensionBridgeMethod = BridgeCommandMethodForRoute<"extension">;

interface BrowserCommandHandlerContext {
	signal?: AbortSignal;
	traceContext?: TraceContext;
}

export class BrowserCommandExecutor {
	private navigateTool?: NavigateTool;
	private selectElementTool?: AskUserWhichElementTool;
	private extractImageTool?: ExtractImageTool;
	private debuggerTool?: DebuggerTool;
	private workflowEngine?: WorkflowEngine;
	private performanceTools?: PerformanceTools;
	private readonly windowId: number;
	private readonly sessionId?: string;
	private readonly sensitiveAccessEnabled: boolean;
	private readonly sessionBridge?: SessionBridgeAdapter;
	private readonly replRouter?: ReplRouter;
	private readonly screenshotRouter?: ScreenshotRouter;
	private readonly recordingRouter?: RecordingRouter;
	private readonly telemetry?: BridgeTelemetry;
	private readonly debuggerManager = getSharedDebuggerManager();
	private readonly pageDrivers: ChromePageDriverRegistryLike;
	private readonly ownsPageDriverRegistry: boolean;
	private readonly shownSkillsState: ShownSkillsState;
	private readonly refOwners = new Map<string, { tabId: number; frameId: number }>();
	private readonly commandHandlers = {
		status: () => this.status(),
		navigate: ({ signal }, params) => this.navigate(params, signal),
		repl: ({ signal, traceContext }, params) => this.repl(params, signal, traceContext),
		screenshot: ({ signal, traceContext }, params) => this.screenshot(params, signal, traceContext),
		eval: ({ signal, traceContext }, params) => this.evalCode(params, signal, traceContext),
		cookies: ({ signal, traceContext }, params) => this.cookies(params, signal, traceContext),
		cookie_import_apply: (_context, params) => this.applyCookieImport(params),
		select_element: ({ signal }, params) => this.selectElement(params, signal),
		workflow_run: ({ signal }, params) => this.workflowRun(params, signal),
		workflow_validate: (_context, params) => this.workflowValidate(params),
		page_snapshot: ({ signal }, params) => this.pageSnapshot(params, signal),
		page_assert: ({ signal, traceContext }, params) => this.pageAssert(params, signal, traceContext),
		locate_by_role: ({ signal }, params) => this.locateByRole(params, signal),
		locate_by_text: ({ signal }, params) => this.locateByText(params, signal),
		locate_by_label: ({ signal }, params) => this.locateByLabel(params, signal),
		ref_click: ({ signal }, params) => this.refClick(params, signal),
		ref_fill: ({ signal }, params) => this.refFill(params, signal),
		frame_list: (_context, params) => this.frameList(params),
		frame_tree: (_context, params) => this.frameTree(params),
		network_start: ({ signal, traceContext }, params) => this.networkStart(params, signal, traceContext),
		network_stop: ({ traceContext }, params) => this.networkStop(params, traceContext),
		network_list: (_context, params) => this.networkList(params),
		network_clear: (_context, params) => this.networkClear(params),
		network_stats: (_context, params) => this.networkStats(params),
		network_get: ({ traceContext }, params) => this.networkGet(params, traceContext),
		network_body: (_context, params) => this.networkBody(params),
		network_curl: (_context, params) => this.networkCurl(params),
		device_emulate: ({ traceContext }, params) => this.deviceEmulate(params, traceContext),
		device_reset: ({ traceContext }, params) => this.deviceReset(params, traceContext),
		perf_metrics: ({ traceContext }, params) => this.perfMetrics(params, traceContext),
		perf_trace_start: ({ traceContext }, params) => this.perfTraceStart(params, traceContext),
		perf_trace_stop: ({ traceContext }, params) => this.perfTraceStop(params, traceContext),
		record_start: ({ signal, traceContext }, params) => this.recordStart(params, signal, traceContext),
		record_stop: ({ signal, traceContext }, params) => this.recordStop(params, signal, traceContext),
		record_status: ({ traceContext }, params) => this.recordStatus(params, traceContext),
		session_history: (_context, params) => this.sessionHistory(params),
		session_inject: ({ signal }, params) => this.sessionInject(params, signal),
		session_new: (_context, params) => this.sessionNew(params),
		session_set_model: (_context, params) => this.sessionSetModel(params),
		session_artifacts: () => this.sessionArtifacts(),
	} satisfies BridgeCommandHandlerRegistry<ExtensionBridgeMethod, BrowserCommandHandlerContext>;

	constructor(options: BrowserCommandExecutorOptions) {
		this.windowId = options.windowId;
		this.sessionId = options.sessionId;
		this.sensitiveAccessEnabled = options.sensitiveAccessEnabled;
		this.sessionBridge = options.sessionBridge;
		this.replRouter = options.replRouter;
		this.screenshotRouter = options.screenshotRouter;
		this.recordingRouter = options.recordingRouter;
		this.telemetry = options.telemetry;
		this.pageDrivers =
			options.pageDriverRegistry ??
			new ChromePageDriverRegistry({
				ownerWindowId: options.windowId,
				sessionId: options.sessionId,
				debuggerManager: this.debuggerManager,
			});
		this.ownsPageDriverRegistry = options.pageDriverRegistry === undefined;
		this.shownSkillsState = options.shownSkillsState ?? new ShownSkillsState();
	}

	/** Dispatch a bridge command by method name. */
	async dispatch(
		method: BridgeMethod,
		params: Record<string, unknown> | undefined,
		signal?: AbortSignal,
		traceContext?: TraceContext,
		target?: BridgeTarget,
	): Promise<unknown> {
		if (target && !isChromeTarget(target)) {
			throw new Error(
				`Chrome executor cannot handle target '${targetTeachingLabel(
					target,
				)}'. Use an Electron bridge-local dispatcher for Electron targets.`,
			);
		}
		const span = this.telemetry?.startSpan(`bridge.executor.${method}`, {
			parent: traceContext,
			attributes: {
				"bridge.method": method,
				"bridge.window_id": this.windowId,
			},
		});
		try {
			const definition = getBridgeCommandDefinition(method);
			if (definition?.route !== "extension") {
				throw Object.assign(new Error("Unknown method: " + method), {
					code: ErrorCodes.INVALID_METHOD,
				});
			}
			const paramsValidation = validateBridgeCommandParams(method, params);
			if (!paramsValidation.ok) {
				throw Object.assign(
					new Error(
						`Invalid parameters for '${method}': ${formatBridgeCommandValidationErrors(paramsValidation.errors)}`,
					),
					{ code: ErrorCodes.INVALID_PARAMS },
				);
			}
			const handler = this.commandHandlers[method as ExtensionBridgeMethod] as BridgeCommandHandler<
				ExtensionBridgeMethod,
				BrowserCommandHandlerContext
			>;
			const result = await handler({ signal, traceContext }, paramsValidation.value);
			const resultValidation = validateBridgeCommandResult(method, result);
			if (!resultValidation.ok) {
				throw Object.assign(
					new Error(
						`Invalid result for '${method}': ${formatBridgeCommandValidationErrors(resultValidation.errors)}`,
					),
					{ code: ErrorCodes.INVALID_RESULT },
				);
			}
			span?.end("ok");
			return resultValidation.value;
		} catch (error) {
			span?.recordError(error);
			span?.end("error");
			throw error;
		}
	}

	async status(): Promise<BridgeStatusResult> {
		let tab: chrome.tabs.Tab | undefined;
		try {
			tab = (await resolveTabTarget({ windowId: this.windowId })).tab;
		} catch {
			tab = undefined;
		}
		return {
			ok: true,
			ready: true,
			windowId: this.windowId,
			sessionId: this.sessionId,
			capabilities: getBridgeCapabilities(this.sensitiveAccessEnabled),
			activeTab: {
				url: tab?.url,
				title: tab?.title,
				tabId: tab?.id,
			},
		};
	}

	async navigate(params: NavigateParams, signal?: AbortSignal): Promise<BridgeCommandResult<"navigate">> {
		const result = await this.getNavigateTool().execute("bridge", params, signal);
		// Dry-run close only previews ids — do not wipe live refs for tabs still open.
		if (result.details.dryRun !== true) {
			const closedTabIds = result.details.closedTabIds;
			if (Array.isArray(closedTabIds)) {
				for (const closedId of closedTabIds) {
					if (typeof closedId === "number") {
						this.forgetRefOwnersForTab(closedId);
						await this.pageDrivers.release(closedId);
					}
				}
			}
		}
		return result.details;
	}

	async dispose(): Promise<void> {
		this.refOwners.clear();
		if (this.ownsPageDriverRegistry) await this.pageDrivers.dispose();
	}

	async repl(params: ReplParams, signal?: AbortSignal, traceContext?: TraceContext): Promise<BridgeReplResult> {
		if (!this.replRouter) {
			const error = new Error("REPL router is not available");
			(error as Error & { code?: number }).code = ErrorCodes.CAPABILITY_DISABLED;
			throw error;
		}
		return this.replRouter.execute(params, signal, traceContext);
	}

	async screenshot(
		params: ScreenshotParams,
		signal?: AbortSignal,
		traceContext?: TraceContext,
	): Promise<BridgeScreenshotResult> {
		// If a screenshot router is configured (running in service worker), delegate to it
		if (this.screenshotRouter) {
			return this.screenshotRouter.capture(params, signal, traceContext);
		}

		// Direct execution (running in sidepanel or extension page with DOM access)
		const result = await this.getExtractImageTool().execute(
			"bridge",
			{ mode: "screenshot", maxWidth: params.maxWidth ?? 1024 },
			signal,
		);
		const image = result.content.find((item) => item.type === "image") as
			| { type: "image"; data: string; mimeType: string }
			| undefined;
		if (!image?.data || !image.mimeType) {
			throw new Error("Screenshot tool returned no image data");
		}
		const details = result.details as { screenshot?: Omit<BridgeScreenshotResult, "mimeType" | "dataUrl"> };
		if (!details.screenshot) {
			throw new Error("Screenshot tool returned no viewport metadata");
		}
		return {
			mimeType: image.mimeType as BridgeScreenshotResult["mimeType"],
			dataUrl: `data:${image.mimeType};base64,${image.data}`,
			...details.screenshot,
		};
	}

	async evalCode(
		params: EvalParams,
		signal?: AbortSignal,
		_traceContext?: TraceContext,
	): Promise<BridgeCommandResult<"eval">> {
		if (!this.sensitiveAccessEnabled) {
			const error = new Error("Eval bridge command is disabled unless sensitive browser data access is enabled");
			(error as Error & { code?: number }).code = ErrorCodes.CAPABILITY_DISABLED;
			throw error;
		}
		const frameId = params.frameId ?? 0;
		if (frameId !== 0) {
			throw new Error("Frame-targeted eval requires frame context support");
		}
		const resolved = await this.resolvePageDriver(params.tabId, frameId);
		const result = await resolved.driver.evaluate({
			expression: params.code,
			awaitPromise: true,
			returnByValue: true,
			signal,
		});
		return { value: result.value };
	}

	async cookies(
		_params: CookiesParams,
		signal?: AbortSignal,
		traceContext?: TraceContext,
	): Promise<BridgeCommandResult<"cookies">> {
		if (!this.sensitiveAccessEnabled) {
			const error = new Error("Cookies bridge command is disabled unless sensitive browser data access is enabled");
			(error as Error & { code?: number }).code = ErrorCodes.CAPABILITY_DISABLED;
			throw error;
		}
		const debuggerTool = this.getDebuggerTool() as DebuggerTool & {
			executeBridge?: (
				toolCallId: string,
				args: { action: string; code?: string },
				signal?: AbortSignal,
				traceContext?: TraceContext,
			) => Promise<{ details: unknown }>;
		};
		const result =
			typeof debuggerTool.executeBridge === "function"
				? await debuggerTool.executeBridge("bridge", { action: "cookies" }, signal, traceContext)
				: await debuggerTool.execute("bridge", { action: "cookies" }, signal);
		const details = result.details as { value?: unknown };
		if (!Array.isArray(details.value)) {
			throw new Error("Cookies command returned an invalid cookie list");
		}
		return details as BridgeCommandResult<"cookies">;
	}

	async applyCookieImport(params: CookieImportApplyParams): Promise<CookieImportResult> {
		if (!this.sensitiveAccessEnabled) {
			const error = new Error("Cookie import is disabled unless sensitive browser data access is enabled");
			(error as Error & { code?: number }).code = ErrorCodes.CAPABILITY_DISABLED;
			throw error;
		}
		if (!chrome.cookies) {
			throw new Error("Cookie import requires the chrome.cookies permission.");
		}
		const errors: string[] = [];
		let imported = 0;
		for (const cookie of params.cookies) {
			try {
				await chrome.cookies.set({
					url: cookie.url,
					name: cookie.name,
					value: cookie.value,
					domain: cookie.domain,
					path: cookie.path,
					secure: cookie.secure,
					httpOnly: cookie.httpOnly,
					...(typeof cookie.expirationDate === "number" ? { expirationDate: cookie.expirationDate } : {}),
				});
				imported++;
			} catch (error) {
				errors.push(cookie.name + ": " + (error instanceof Error ? error.message : String(error)));
			}
		}
		return {
			ok: true,
			siteUrl: params.cookies[0]?.url ?? "",
			imported,
			skipped: params.cookies.length - imported,
			errors,
		};
	}

	async selectElement(
		params: SelectElementParams,
		signal?: AbortSignal,
	): Promise<BridgeCommandResult<"select_element">> {
		const result = await this.getSelectElementTool().execute("bridge", { message: params.message ?? "" }, signal);
		return result.details;
	}

	async workflowRun(params: WorkflowRunParams, signal?: AbortSignal): Promise<WorkflowRunResultWire> {
		return this.getWorkflowEngine().run(params.workflow, {
			args: params.args,
			dryRun: params.dryRun,
			signal,
		});
	}

	async workflowValidate(params: WorkflowValidateParams): Promise<{ ok: boolean; errors: string[] }> {
		return this.getWorkflowEngine().validate(params.workflow, params.args);
	}

	async pageSnapshot(
		params: PageSnapshotBridgeParams,
		signal?: AbortSignal,
	): Promise<BridgeCommandResult<"page_snapshot">> {
		const resolved = await this.resolvePageDriver(params.tabId, params.frameId);
		const result = await resolved.driver.snapshot({
			frameId: params.frameId,
			maxEntries: params.maxEntries,
			includeHidden: params.includeHidden,
			query: params.query,
			signal,
		});
		this.storeDriverSnapshotRefs(result, resolved.tabId);
		return pageDriverSnapshotToWire(result, chromeResultTarget(resolved.tabId, params.frameId), {
			query: params.query,
		});
	}

	async pageAssert(
		params: PageAssertParams,
		signal?: AbortSignal,
		traceContext?: TraceContext,
	): Promise<PageAssertResult> {
		const resolved = await this.resolvePageDriver(params.tabId);
		const scope = this.chromeAssertScope(resolved, params.frameId);
		if (params.world === "main") {
			if (params.kind !== "expression" || !params.expression) {
				return buildPageAssertResult(params, scope, false, 1, Date.now(), params.timeoutMs ?? 0, {
					ok: false,
					message: "Main-world assertions require kind 'expression' and expression",
				});
			}
			return this.pageAssertMainWorld(params, scope, signal, traceContext);
		}
		return runPageAssert(params, scope, signal);
	}

	async locateByRole(
		params: LocateByRoleParams,
		signal?: AbortSignal,
	): Promise<BridgeCommandResult<"locate_by_role">> {
		const captured = await this.captureSnapshotForTarget(params, signal);
		const matches = locateByRole(captured.legacy, params.role, {
			name: params.name,
			minScore: params.minScore,
			limit: params.limit,
		});
		this.storeLocatorMatches(captured.resolved.tabId, matches);
		return pageDriverLocatorMatchesToWire(chromeResultTarget(captured.resolved.tabId, params.frameId), matches);
	}

	async locateByText(
		params: LocateByTextParams,
		signal?: AbortSignal,
	): Promise<BridgeCommandResult<"locate_by_text">> {
		const captured = await this.captureSnapshotForTarget(params, signal);
		const matches = locateByText(captured.legacy, params.text, {
			minScore: params.minScore,
			limit: params.limit,
		});
		this.storeLocatorMatches(captured.resolved.tabId, matches);
		return pageDriverLocatorMatchesToWire(chromeResultTarget(captured.resolved.tabId, params.frameId), matches);
	}

	async locateByLabel(
		params: LocateByLabelParams,
		signal?: AbortSignal,
	): Promise<BridgeCommandResult<"locate_by_label">> {
		const captured = await this.captureSnapshotForTarget(params, signal);
		const matches = locateByLabel(captured.legacy, params.label, {
			minScore: params.minScore,
			limit: params.limit,
		});
		this.storeLocatorMatches(captured.resolved.tabId, matches);
		return pageDriverLocatorMatchesToWire(chromeResultTarget(captured.resolved.tabId, params.frameId), matches);
	}

	private async pageAssertMainWorld(
		params: PageAssertParams,
		scope: ChromePageAssertScope,
		signal?: AbortSignal,
		traceContext?: TraceContext,
	): Promise<PageAssertResult> {
		const startedAt = Date.now();
		const timeoutMs = params.timeoutMs ?? 5_000;
		const intervalMs = params.intervalMs ?? 100;
		const deadline = startedAt + timeoutMs;
		let attempts = 0;
		let lastResult: { ok: boolean; message: string; actual?: unknown; expected?: unknown } = {
			ok: false,
			message: "Main-world expression assertion did not execute",
		};

		do {
			if (signal?.aborted) {
				throw new Error("Page assertion aborted");
			}
			attempts += 1;
			const evalResult = await this.evalCode(
				{
					code: buildMainWorldExpressionAssertCode(params.expression ?? ""),
					tabId: scope.tabId,
					frameId: scope.frameId,
				},
				signal,
				traceContext,
			);
			const evalValue = unwrapDebuggerEvalValue(evalResult);
			lastResult = isPageAssertCheckResult(evalValue)
				? evalValue
				: { ok: false, message: "Main-world expression assertion returned an invalid result", actual: evalValue };
			if (lastResult.ok || Date.now() >= deadline) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
		} while (Date.now() < deadline);

		return buildPageAssertResult(params, scope, lastResult.ok, attempts, startedAt, timeoutMs, lastResult);
	}

	async refClick(params: RefClickParams, signal?: AbortSignal): Promise<BridgeCommandResult<"ref_click">> {
		const resolved = await this.resolvePageDriverForRef(params.refId, params.tabId, params.frameId);
		const result = await resolved.driver.actOnRef({
			refId: params.refId,
			action: { kind: "click", mode: params.native || params.trusted ? "cdp-trusted" : "dom" },
			signal,
		});
		let wait: Extract<BridgeCommandResult<"ref_click">, { ok: true }>["wait"];
		if (result.ok && typeof params.waitMs === "number" && params.waitMs > 0) {
			wait = await this.waitForRefClickStability(resolved.tabId, params.waitMs, signal);
		}
		return pageDriverRefActionToWire(result, chromeResultTarget(resolved.tabId, resolved.frameId), {
			wait,
			native: params.native === true,
		});
	}

	async refFill(params: RefFillParams, signal?: AbortSignal): Promise<BridgeCommandResult<"ref_fill">> {
		const resolved = await this.resolvePageDriverForRef(params.refId, params.tabId, params.frameId);
		const result = await resolved.driver.actOnRef({
			refId: params.refId,
			action: {
				kind: "fill",
				mode: params.native || params.trusted ? "cdp-trusted" : "dom",
				value: params.value,
			},
			signal,
		});
		return pageDriverRefActionToWire(result, chromeResultTarget(resolved.tabId, resolved.frameId), {
			native: params.native === true,
		});
	}

	async frameList(params: FrameListParams): Promise<BridgeCommandResult<"frame_list">> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return listFrames(tabId);
	}

	async frameTree(params: FrameListParams): Promise<BridgeCommandResult<"frame_tree">> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		const frames = await listFrames(tabId);
		const tree = buildFrameTree(frames);
		return {
			roots: tree.roots,
			orphans: tree.orphans,
		};
	}

	async networkStart(
		params: NetworkStartParams,
		signal?: AbortSignal,
		_traceContext?: TraceContext,
	): Promise<BridgeCommandResult<"network_start">> {
		const resolved = await this.resolvePageDriver(params.tabId);
		return pageDriverNetworkStatsToWire(
			await resolved.driver.network.start({
				maxEntries: params.maxEntries,
				maxBodyBytes: params.maxBodyBytes,
				signal,
			}),
			chromeResultTarget(resolved.tabId),
		);
	}

	async networkStop(
		params: NetworkStartParams,
		_traceContext?: TraceContext,
	): Promise<BridgeCommandResult<"network_stop">> {
		const resolved = await this.resolvePageDriver(params.tabId);
		return pageDriverNetworkStatsToWire(await resolved.driver.network.stop(), chromeResultTarget(resolved.tabId));
	}

	async networkList(params: NetworkListParams): Promise<BridgeCommandResult<"network_list">> {
		const resolved = await this.resolvePageDriver(params.tabId);
		return pageDriverNetworkListToWire(
			resolved.driver.network.list({ limit: params.limit, search: params.search }),
			chromeResultTarget(resolved.tabId),
		);
	}

	async networkClear(params: NetworkStartParams): Promise<BridgeCommandResult<"network_clear">> {
		const resolved = await this.resolvePageDriver(params.tabId);
		return pageDriverNetworkStatsToWire(resolved.driver.network.clear(), chromeResultTarget(resolved.tabId));
	}

	async networkStats(params: NetworkStartParams): Promise<BridgeCommandResult<"network_stats">> {
		const resolved = await this.resolvePageDriver(params.tabId);
		return pageDriverNetworkStatsToWire(resolved.driver.network.stats(), chromeResultTarget(resolved.tabId));
	}

	async networkGet(
		params: NetworkItemParams,
		_traceContext?: TraceContext,
	): Promise<BridgeCommandResult<"network_get">> {
		const resolved = await this.resolvePageDriver(params.tabId);
		return pageDriverNetworkGetToWire(
			resolved.driver.network.get(params.requestId),
			chromeResultTarget(resolved.tabId),
		);
	}

	async networkBody(params: NetworkItemParams): Promise<BridgeCommandResult<"network_body">> {
		const resolved = await this.resolvePageDriver(params.tabId);
		return pageDriverNetworkBodyToWire(
			resolved.driver.network.body(params.requestId),
			chromeResultTarget(resolved.tabId),
		);
	}

	async networkCurl(params: NetworkCurlParams): Promise<BridgeCommandResult<"network_curl">> {
		const resolved = await this.resolvePageDriver(params.tabId);
		return pageDriverNetworkCurlToWire(
			resolved.driver.network.toCurl(params.requestId, {
				redactSensitiveHeaders: params.includeSensitive !== true,
			}),
			chromeResultTarget(resolved.tabId),
		);
	}

	async deviceEmulate(
		params: DeviceEmulateParams,
		traceContext?: TraceContext,
	): Promise<BridgeCommandResult<"device_emulate">> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		const normalized = normalizeDeviceEmulationRequest(params);
		const owner = `device-emulation:${tabId}:${Date.now()}`;
		await this.debuggerManager.acquireWithTrace(tabId, owner, { parent: traceContext });
		try {
			await this.debuggerManager.ensureDomainWithTrace(tabId, "Page", { parent: traceContext });
			await this.debuggerManager.sendCommandWithTrace(
				tabId,
				"Emulation.setDeviceMetricsOverride",
				{
					width: normalized.viewport.width,
					height: normalized.viewport.height,
					deviceScaleFactor: normalized.viewport.deviceScaleFactor,
					mobile: normalized.viewport.mobile,
				},
				{ parent: traceContext },
			);
			await this.debuggerManager.sendCommandWithTrace(
				tabId,
				"Emulation.setTouchEmulationEnabled",
				{
					enabled: normalized.touch,
					configuration: normalized.touch ? "mobile" : "desktop",
				},
				{ parent: traceContext },
			);
			if (normalized.userAgent) {
				await this.debuggerManager.sendCommandWithTrace(
					tabId,
					"Emulation.setUserAgentOverride",
					{
						userAgent: normalized.userAgent,
					},
					{ parent: traceContext },
				);
			}
			return {
				ok: true,
				tabId,
				preset: normalized.preset,
				viewport: normalized.viewport,
				touch: normalized.touch,
				userAgent: normalized.userAgent,
			};
		} finally {
			await this.debuggerManager.releaseWithTrace(tabId, owner, { parent: traceContext });
		}
	}

	async deviceReset(
		params: DeviceResetParams,
		traceContext?: TraceContext,
	): Promise<BridgeCommandResult<"device_reset">> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		const owner = `device-reset:${tabId}:${Date.now()}`;
		await this.debuggerManager.acquireWithTrace(tabId, owner, { parent: traceContext });
		try {
			await this.debuggerManager.sendCommandWithTrace(tabId, "Emulation.clearDeviceMetricsOverride", undefined, {
				parent: traceContext,
			});
			await this.debuggerManager.sendCommandWithTrace(
				tabId,
				"Emulation.setTouchEmulationEnabled",
				{
					enabled: false,
					configuration: "desktop",
				},
				{ parent: traceContext },
			);
			await this.debuggerManager.sendCommandWithTrace(
				tabId,
				"Emulation.setUserAgentOverride",
				{
					userAgent: "",
				},
				{ parent: traceContext },
			);
			return { ok: true, tabId };
		} finally {
			await this.debuggerManager.releaseWithTrace(tabId, owner, { parent: traceContext });
		}
	}

	async perfMetrics(
		params: PerfMetricsParams,
		traceContext?: TraceContext,
	): Promise<BridgeCommandResult<"perf_metrics">> {
		const resolved = await this.resolvePageDriver(params.tabId);
		return {
			...pageDriverScopeToWire(resolved.driver.scope, chromeResultTarget(resolved.tabId)),
			metrics: await this.getPerformanceTools().getMetrics(resolved.tabId, traceContext),
		};
	}

	async perfTraceStart(
		params: PerfTraceStartParams,
		traceContext?: TraceContext,
	): Promise<BridgeCommandResult<"perf_trace_start">> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return this.getPerformanceTools().startTrace(tabId, { timeoutMs: params.autoStopMs }, traceContext);
	}

	async perfTraceStop(
		params: PerfTraceStopParams,
		traceContext?: TraceContext,
	): Promise<BridgeCommandResult<"perf_trace_stop">> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return this.getPerformanceTools().stopTrace(tabId, traceContext);
	}

	async recordStart(
		params: RecordStartParams,
		signal?: AbortSignal,
		traceContext?: TraceContext,
	): Promise<RecordStartResult> {
		if (!this.sensitiveAccessEnabled) {
			throw Object.assign(
				new Error("Record bridge command is disabled unless sensitive browser data access is enabled"),
				{
					code: ErrorCodes.CAPABILITY_DISABLED,
				},
			);
		}
		if (!this.recordingRouter) {
			throw Object.assign(new Error("Recording router is not available"), { code: ErrorCodes.CAPABILITY_DISABLED });
		}
		return this.recordingRouter.start(params, signal, traceContext);
	}

	async recordStop(
		params: RecordStopParams,
		signal?: AbortSignal,
		traceContext?: TraceContext,
	): Promise<RecordStopResult> {
		if (!this.sensitiveAccessEnabled) {
			throw Object.assign(
				new Error("Record bridge command is disabled unless sensitive browser data access is enabled"),
				{
					code: ErrorCodes.CAPABILITY_DISABLED,
				},
			);
		}
		if (!this.recordingRouter) {
			throw Object.assign(new Error("Recording router is not available"), { code: ErrorCodes.CAPABILITY_DISABLED });
		}
		return this.recordingRouter.stop(params, signal, traceContext);
	}

	async recordStatus(params: RecordStatusParams, traceContext?: TraceContext): Promise<RecordStatusResult> {
		if (!this.sensitiveAccessEnabled) {
			throw Object.assign(
				new Error("Record bridge command is disabled unless sensitive browser data access is enabled"),
				{
					code: ErrorCodes.CAPABILITY_DISABLED,
				},
			);
		}
		if (!this.recordingRouter) {
			throw Object.assign(new Error("Recording router is not available"), { code: ErrorCodes.CAPABILITY_DISABLED });
		}
		return this.recordingRouter.status(params, traceContext);
	}

	async sessionHistory(params: SessionHistoryParams): Promise<SessionHistoryResult> {
		if (!this.sessionBridge) {
			throw new Error("Session bridge is not available");
		}
		return buildSessionHistoryResult(await this.sessionBridge.getSnapshot(), params);
	}

	async sessionInject(params: SessionInjectParams, signal?: AbortSignal): Promise<SessionInjectResult> {
		if (!this.sessionBridge) {
			throw new Error("Session bridge is not available");
		}
		if (signal?.aborted) {
			const error = new Error("Session injection aborted");
			(error as Error & { code?: number }).code = ErrorCodes.ABORTED;
			throw error;
		}
		return this.sessionBridge.appendInjectedMessage(params);
	}

	async sessionNew(params: SessionNewParams): Promise<SessionNewResult> {
		if (!this.sessionBridge) {
			throw new Error("Session bridge is not available");
		}
		return this.sessionBridge.newSession(params);
	}

	async sessionSetModel(params: SessionSetModelParams): Promise<SessionSetModelResult> {
		if (!this.sessionBridge) {
			throw new Error("Session bridge is not available");
		}
		return this.sessionBridge.setModel(params);
	}

	async sessionArtifacts(): Promise<SessionArtifactsResult> {
		if (!this.sessionBridge) {
			throw new Error("Session bridge is not available");
		}
		return await this.sessionBridge.getArtifacts();
	}

	private getNavigateTool(): NavigateTool {
		if (!this.navigateTool) {
			this.navigateTool = new NavigateTool({
				windowId: this.windowId,
				shownSkillsState: this.shownSkillsState,
			});
		}
		return this.navigateTool;
	}

	private getSelectElementTool(): AskUserWhichElementTool {
		if (!this.selectElementTool) {
			this.selectElementTool = new AskUserWhichElementTool({ windowId: this.windowId });
		}
		return this.selectElementTool;
	}

	private getExtractImageTool(): ExtractImageTool {
		if (!this.extractImageTool) {
			this.extractImageTool = new ExtractImageTool();
			this.extractImageTool.windowId = this.windowId;
		}
		return this.extractImageTool;
	}

	private getDebuggerTool(): DebuggerTool {
		if (!this.debuggerTool) {
			this.debuggerTool = new DebuggerTool({
				windowId: this.windowId,
				debuggerManager: this.debuggerManager,
			});
		}
		return this.debuggerTool;
	}

	private getWorkflowEngine(): WorkflowEngine {
		if (!this.workflowEngine) {
			this.workflowEngine = new WorkflowEngine({
				dispatch: (method, params, signal) => this.dispatch(method as BridgeMethod, params, signal),
			});
		}
		return this.workflowEngine;
	}

	private getPerformanceTools(): PerformanceTools {
		if (!this.performanceTools) {
			this.performanceTools = new PerformanceTools({
				debuggerManager: this.debuggerManager,
				telemetry: this.telemetry,
			});
		}
		return this.performanceTools;
	}

	private async resolveBridgeTabId(tabId?: number): Promise<number> {
		const resolved = await resolveTabTarget({ windowId: this.windowId, tabId });
		return resolved.tabId;
	}

	private async resolvePageDriver(tabId?: number, frameId?: number): Promise<ResolvedChromePageDriver> {
		assertValidFrameId(frameId);
		return this.pageDrivers.resolve(tabId);
	}

	private async resolvePageDriverForRef(
		refId: string,
		tabId?: number,
		frameId?: number,
	): Promise<ResolvedChromeRefPageDriver> {
		assertValidFrameId(frameId);
		const owner = this.refOwners.get(refId);
		if (owner) {
			if (tabId !== undefined && owner.tabId !== tabId) {
				throw new Error(`Reference ${refId} belongs to Chrome tab ${owner.tabId}, not requested tab ${tabId}`);
			}
			if (frameId !== undefined && owner.frameId !== frameId) {
				throw new Error(`Reference ${refId} belongs to frame ${owner.frameId}, not requested frame ${frameId}`);
			}
			return { ...(await this.pageDrivers.resolve(owner.tabId)), frameId: owner.frameId };
		}
		return { ...(await this.pageDrivers.resolve(tabId)), frameId: frameId ?? 0 };
	}

	private chromeAssertScope(resolved: ResolvedChromePageDriver, frameId?: number): ChromePageAssertScope {
		const target = chromeResultTarget(resolved.tabId, frameId);
		return {
			...pageDriverScopeToWire(resolved.driver.scope, target),
			target,
			tabId: resolved.tabId,
			frameId: frameId ?? 0,
		};
	}

	private forgetRefOwnersForTab(tabId: number): void {
		for (const [refId, owner] of this.refOwners) {
			if (owner.tabId === tabId) this.refOwners.delete(refId);
		}
	}

	private async captureSnapshotForTarget(
		params: { tabId?: number; frameId?: number; maxEntries?: number; includeHidden?: boolean; query?: string },
		signal?: AbortSignal,
	): Promise<{
		resolved: ResolvedChromePageDriver;
		driver: DriverPageSnapshotResult;
		legacy: PageSnapshotResult;
	}> {
		const resolved = await this.resolvePageDriver(params.tabId, params.frameId);
		const driver = await resolved.driver.snapshot({
			frameId: params.frameId,
			maxEntries: params.maxEntries,
			includeHidden: params.includeHidden,
			query: params.query,
			signal,
		});
		this.storeDriverSnapshotRefs(driver, resolved.tabId);
		return {
			resolved,
			driver,
			legacy: toLegacyChromeSnapshot(driver, resolved.tabId, params.frameId ?? 0, params.query),
		};
	}

	private storeDriverSnapshotRefs(snapshot: DriverPageSnapshotResult, tabId: number): void {
		for (const entry of snapshot.snapshot.entries) {
			this.refOwners.set(entry.snapshotId, { tabId, frameId: entry.frameId });
		}
	}

	private storeLocatorMatches(
		tabId: number,
		matches: Array<{ entry: PageSnapshotEntry; score: number; reasons: string[] }>,
	): void {
		for (const match of matches) {
			this.refOwners.set(match.entry.snapshotId, { tabId, frameId: match.entry.frameId });
		}
	}

	private async waitForRefClickStability(
		tabId: number,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<{ tabId: number; finalUrl?: string; status?: string; waitedMs: number; timedOut: boolean }> {
		const startedAt = Date.now();
		const deadline = startedAt + timeoutMs;
		let lastUrl: string | undefined;
		let stableSince = 0;
		let lastStatus: string | undefined;
		while (Date.now() < deadline) {
			if (signal?.aborted) throw new Error("Ref click wait aborted");
			let tab: chrome.tabs.Tab | undefined;
			try {
				tab = await chrome.tabs.get(tabId);
			} catch {
				break;
			}
			const url = tab.url;
			lastStatus = tab.status;
			if (url !== lastUrl) {
				lastUrl = url;
				stableSince = Date.now();
			}
			if (tab.status === "complete" && Date.now() - stableSince >= 150) {
				return { tabId, finalUrl: url, status: tab.status, waitedMs: Date.now() - startedAt, timedOut: false };
			}
			await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
		}
		return { tabId, finalUrl: lastUrl, status: lastStatus, waitedMs: Date.now() - startedAt, timedOut: true };
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapDebuggerEvalValue(value: unknown): unknown {
	const detailsValue = isRecord(value) && Object.hasOwn(value, "value") ? value.value : value;
	if (!isRecord(detailsValue) || !isRecord(detailsValue.result) || !Object.hasOwn(detailsValue.result, "value")) {
		return detailsValue;
	}
	return detailsValue.result.value;
}

function isPageAssertCheckResult(
	value: unknown,
): value is { ok: boolean; message: string; actual?: unknown; expected?: unknown } {
	return isRecord(value) && typeof value.ok === "boolean" && typeof value.message === "string";
}

function chromeResultTarget(tabId: number, frameId?: number) {
	return { kind: "chrome-tab" as const, tabId, frameId: frameId ?? 0 };
}

function assertValidFrameId(frameId?: number): void {
	if (frameId !== undefined && (!Number.isSafeInteger(frameId) || frameId < 0)) {
		throw new Error(`Chrome frameId must be a non-negative safe integer; received ${frameId}`);
	}
}

function toLegacyChromeSnapshot(
	result: DriverPageSnapshotResult,
	tabId: number,
	frameId: number,
	query?: string,
): PageSnapshotResult {
	return {
		tabId,
		frameId,
		...(query ? { query } : {}),
		...result.snapshot,
		entries: result.snapshot.entries.map((entry) => toLegacyChromeSnapshotEntry(entry, tabId)),
	};
}

function toLegacyChromeSnapshotEntry(entry: SnapshotInjectionEntry, tabId: number): PageSnapshotEntry {
	return {
		...entry,
		tabId,
		attributes: { ...entry.attributes },
		selectorCandidates: [...entry.selectorCandidates],
		ordinalPath: [...entry.ordinalPath],
		boundingBox: { ...entry.boundingBox },
	};
}
