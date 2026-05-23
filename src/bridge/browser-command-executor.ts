/**
 * Bridge-mode command executor.
 *
 * Instantiates the same browser tools used by the sidepanel agent and
 * exposes bridge-friendly methods that accept an AbortSignal. This keeps
 * the bridge and agent tooling backed by the same underlying code.
 */

import { AskUserWhichElementTool } from "../tools/ask-user-which-element.js";
import { DebuggerTool } from "../tools/debugger.js";
import { normalizeDeviceEmulationRequest } from "../tools/device-presets.js";
import { ExtractImageTool } from "../tools/extract-image.js";
import { resolveTabTarget } from "../tools/helpers/browser-target.js";
import { getSharedDebuggerManager } from "../tools/helpers/debugger-manager.js";
import { buildFrameTree, listFrames } from "../tools/helpers/frame-resolver.js";
import { executePageFunction, type PageExecutionFunction } from "../tools/helpers/page-execution.js";
import { type RefBoundingBox, RefMap, type RefResolutionCandidate } from "../tools/helpers/ref-map.js";
import { NativeInputEventsRuntimeProvider, type NativeInputPoint } from "../tools/NativeInputEventsRuntimeProvider.js";
import { NavigateTool } from "../tools/navigate.js";
import { NetworkCaptureEngine } from "../tools/network-capture.js";
import { buildMainWorldExpressionAssertCode, buildPageAssertResult, runPageAssert } from "../tools/page-assert.js";
import {
	buildRefLocatorBundle,
	capturePageSnapshot,
	locateByLabel,
	locateByRole,
	locateByText,
	type PageSnapshotEntry,
	PageSnapshotTool,
} from "../tools/page-snapshot.js";
import { PerformanceTools } from "../tools/performance-tools.js";
import { WorkflowEngine } from "../tools/workflow-engine.js";
import type {
	BridgeMethod,
	BridgeReplResult,
	BridgeScreenshotResult,
	BridgeStatusResult,
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
} from "./protocol.js";
import { ErrorCodes, getBridgeCapabilities } from "./protocol.js";
import { buildSessionHistoryResult, type SessionBridgeAdapter } from "./session-bridge.js";
import { type BridgeTarget, isChromeTarget, targetTeachingLabel } from "./target.js";
import type { BridgeTelemetry, TraceContext } from "./telemetry.js";

/**
 * Router interface for REPL execution.
 * When provided, the executor delegates REPL calls through this router
 * instead of executing directly (needed when running in service worker context).
 */
export interface ReplRouter {
	execute(params: ReplParams, signal?: AbortSignal, traceContext?: TraceContext): Promise<BridgeReplResult>;
}

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
	sessionBridge?: SessionBridgeAdapter;
	replRouter?: ReplRouter;
	screenshotRouter?: ScreenshotRouter;
	recordingRouter?: RecordingRouter;
	telemetry?: BridgeTelemetry;
}

export class BrowserCommandExecutor {
	private navigateTool?: NavigateTool;
	private selectElementTool?: AskUserWhichElementTool;
	private extractImageTool?: ExtractImageTool;
	private debuggerTool?: DebuggerTool;
	private pageSnapshotTool?: PageSnapshotTool;
	private workflowEngine?: WorkflowEngine;
	private networkCapture?: NetworkCaptureEngine;
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
	private readonly refMap = new RefMap();

	constructor(options: BrowserCommandExecutorOptions) {
		this.windowId = options.windowId;
		this.sessionId = options.sessionId;
		this.sensitiveAccessEnabled = options.sensitiveAccessEnabled;
		this.sessionBridge = options.sessionBridge;
		this.replRouter = options.replRouter;
		this.screenshotRouter = options.screenshotRouter;
		this.recordingRouter = options.recordingRouter;
		this.telemetry = options.telemetry;
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
			let result: unknown;
			switch (method) {
				case "status":
					result = await this.status();
					break;
				case "navigate":
					result = await this.navigate((params ?? {}) as NavigateParams, signal);
					break;
				case "repl":
					result = await this.repl(params as unknown as ReplParams, signal, span?.context);
					break;
				case "screenshot":
					result = await this.screenshot((params ?? {}) as ScreenshotParams, signal, span?.context);
					break;
				case "eval":
					result = await this.evalCode(params as unknown as EvalParams, signal, span?.context);
					break;
				case "cookies":
					result = await this.cookies((params ?? {}) as CookiesParams, signal, span?.context);
					break;
				case "select_element":
					result = await this.selectElement((params ?? {}) as SelectElementParams, signal);
					break;
				case "workflow_run":
					result = await this.workflowRun((params ?? {}) as unknown as WorkflowRunParams, signal);
					break;
				case "workflow_validate":
					result = await this.workflowValidate((params ?? {}) as unknown as WorkflowValidateParams);
					break;
				case "page_snapshot":
					result = await this.pageSnapshot((params ?? {}) as PageSnapshotBridgeParams, signal);
					break;
				case "page_assert":
					result = await this.pageAssert((params ?? {}) as unknown as PageAssertParams, signal, span?.context);
					break;
				case "locate_by_role":
					result = await this.locateByRole((params ?? {}) as unknown as LocateByRoleParams, signal);
					break;
				case "locate_by_text":
					result = await this.locateByText((params ?? {}) as unknown as LocateByTextParams, signal);
					break;
				case "locate_by_label":
					result = await this.locateByLabel((params ?? {}) as unknown as LocateByLabelParams, signal);
					break;
				case "ref_click":
					result = await this.refClick(params as unknown as RefClickParams, signal);
					break;
				case "ref_fill":
					result = await this.refFill(params as unknown as RefFillParams, signal);
					break;
				case "frame_list":
					result = await this.frameList((params ?? {}) as FrameListParams);
					break;
				case "frame_tree":
					result = await this.frameTree((params ?? {}) as FrameListParams);
					break;
				case "network_start":
					result = await this.networkStart((params ?? {}) as unknown as NetworkStartParams, span?.context);
					break;
				case "network_stop":
					result = await this.networkStop((params ?? {}) as NetworkStartParams, span?.context);
					break;
				case "network_list":
					result = await this.networkList((params ?? {}) as NetworkListParams);
					break;
				case "network_clear":
					result = await this.networkClear((params ?? {}) as NetworkStartParams);
					break;
				case "network_stats":
					result = await this.networkStats((params ?? {}) as NetworkStartParams);
					break;
				case "network_get":
					result = await this.networkGet((params ?? {}) as unknown as NetworkItemParams, span?.context);
					break;
				case "network_body":
					result = await this.networkBody((params ?? {}) as unknown as NetworkItemParams);
					break;
				case "network_curl":
					result = await this.networkCurl((params ?? {}) as unknown as NetworkCurlParams);
					break;
				case "device_emulate":
					result = await this.deviceEmulate((params ?? {}) as DeviceEmulateParams, span?.context);
					break;
				case "device_reset":
					result = await this.deviceReset((params ?? {}) as DeviceResetParams, span?.context);
					break;
				case "perf_metrics":
					result = await this.perfMetrics((params ?? {}) as PerfMetricsParams, span?.context);
					break;
				case "perf_trace_start":
					result = await this.perfTraceStart((params ?? {}) as PerfTraceStartParams, span?.context);
					break;
				case "perf_trace_stop":
					result = await this.perfTraceStop((params ?? {}) as PerfTraceStopParams, span?.context);
					break;
				case "record_start":
					result = await this.recordStart((params ?? {}) as RecordStartParams, signal, span?.context);
					break;
				case "record_stop":
					result = await this.recordStop((params ?? {}) as RecordStopParams, signal, span?.context);
					break;
				case "record_status":
					result = await this.recordStatus((params ?? {}) as RecordStatusParams, span?.context);
					break;
				case "session_history":
					result = await this.sessionHistory((params ?? {}) as SessionHistoryParams);
					break;
				case "session_inject":
					result = await this.sessionInject(params as unknown as SessionInjectParams, signal);
					break;
				case "session_new":
					result = await this.sessionNew((params ?? {}) as SessionNewParams);
					break;
				case "session_set_model":
					result = await this.sessionSetModel(params as unknown as SessionSetModelParams);
					break;
				case "session_artifacts":
					result = await this.sessionArtifacts();
					break;
				default:
					throw new Error("Unknown method: " + method);
			}
			span?.end("ok");
			return result;
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

	async navigate(params: NavigateParams, signal?: AbortSignal): Promise<unknown> {
		const result = await this.getNavigateTool().execute("bridge", params, signal);
		return result.details;
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

	async evalCode(params: EvalParams, signal?: AbortSignal, traceContext?: TraceContext): Promise<unknown> {
		if (!this.sensitiveAccessEnabled) {
			const error = new Error("Eval bridge command is disabled unless sensitive browser data access is enabled");
			(error as Error & { code?: number }).code = ErrorCodes.CAPABILITY_DISABLED;
			throw error;
		}
		const debuggerTool = this.getDebuggerTool() as DebuggerTool & {
			executeBridge?: (
				toolCallId: string,
				args: { action: string; code?: string; tabId?: number; frameId?: number },
				signal?: AbortSignal,
				traceContext?: TraceContext,
			) => Promise<{ details: unknown }>;
		};
		const args = { action: "eval", code: params.code, tabId: params.tabId, frameId: params.frameId };
		const result =
			typeof debuggerTool.executeBridge === "function"
				? await debuggerTool.executeBridge("bridge", args, signal, traceContext)
				: await debuggerTool.execute("bridge", args, signal);
		return result.details;
	}

	async cookies(_params: CookiesParams, signal?: AbortSignal, traceContext?: TraceContext): Promise<unknown> {
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
		return result.details;
	}

	async selectElement(params: SelectElementParams, signal?: AbortSignal): Promise<unknown> {
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

	async pageSnapshot(params: PageSnapshotBridgeParams, signal?: AbortSignal): Promise<unknown> {
		const result = await this.getPageSnapshotTool().execute("bridge", params, signal);
		this.storeSnapshotRefs(result.details);
		return result.details;
	}

	async pageAssert(
		params: PageAssertParams,
		signal?: AbortSignal,
		traceContext?: TraceContext,
	): Promise<PageAssertResult> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		const target = { tabId, frameId: params.frameId };
		if (params.world === "main") {
			if (params.kind !== "expression" || !params.expression) {
				return buildPageAssertResult(params, target, false, 1, Date.now(), params.timeoutMs ?? 0, {
					ok: false,
					message: "Main-world assertions require kind 'expression' and expression",
				});
			}
			return this.pageAssertMainWorld(params, target, signal, traceContext);
		}
		return runPageAssert(params, target, signal);
	}

	async locateByRole(params: LocateByRoleParams, signal?: AbortSignal): Promise<unknown> {
		const snapshot = await this.captureSnapshotForTarget(params, signal);
		return this.storeLocatorMatches(
			locateByRole(snapshot, params.role, {
				name: params.name,
				minScore: params.minScore,
				limit: params.limit,
			}),
		);
	}

	async locateByText(params: LocateByTextParams, signal?: AbortSignal): Promise<unknown> {
		const snapshot = await this.captureSnapshotForTarget(params, signal);
		return this.storeLocatorMatches(
			locateByText(snapshot, params.text, {
				minScore: params.minScore,
				limit: params.limit,
			}),
		);
	}

	async locateByLabel(params: LocateByLabelParams, signal?: AbortSignal): Promise<unknown> {
		const snapshot = await this.captureSnapshotForTarget(params, signal);
		return this.storeLocatorMatches(
			locateByLabel(snapshot, params.label, {
				minScore: params.minScore,
				limit: params.limit,
			}),
		);
	}

	private async pageAssertMainWorld(
		params: PageAssertParams,
		target: { tabId: number; frameId?: number },
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
					tabId: target.tabId,
					frameId: target.frameId,
				},
				signal,
				traceContext,
			);
			const evalValue = isRecord(evalResult) && Object.hasOwn(evalResult, "value") ? evalResult.value : evalResult;
			lastResult = isPageAssertCheckResult(evalValue)
				? evalValue
				: { ok: false, message: "Main-world expression assertion returned an invalid result", actual: evalValue };
			if (lastResult.ok || Date.now() >= deadline) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
		} while (Date.now() < deadline);

		return buildPageAssertResult(params, target, lastResult.ok, attempts, startedAt, timeoutMs, lastResult);
	}

	async refClick(params: RefClickParams, signal?: AbortSignal): Promise<unknown> {
		const resolution = await this.resolveReference(params.refId, params.tabId, params.frameId, signal);
		if (params.native) {
			const point = await this.resolveNativeRefPoint(resolution, signal);
			const nativeInput = new NativeInputEventsRuntimeProvider({
				windowId: this.windowId,
				tabId: resolution.tabId,
				frameId: resolution.frameId,
				debuggerManager: this.debuggerManager,
				telemetry: this.telemetry,
			});
			await nativeInput.clickAt(point);
			return {
				ok: true,
				refId: params.refId,
				tabId: resolution.tabId,
				frameId: resolution.frameId,
				selector: resolution.selector,
				native: true,
				point,
			};
		}
		await this.executeRefDomAction(resolution.tabId, resolution.frameId, resolution.selector, refClickInPage);
		return {
			ok: true,
			refId: params.refId,
			tabId: resolution.tabId,
			frameId: resolution.frameId,
			selector: resolution.selector,
		};
	}

	async refFill(params: RefFillParams, signal?: AbortSignal): Promise<unknown> {
		const resolution = await this.resolveReference(params.refId, params.tabId, params.frameId, signal);
		if (params.native) {
			const point = await this.resolveNativeRefPoint(resolution, signal);
			const nativeInput = new NativeInputEventsRuntimeProvider({
				windowId: this.windowId,
				tabId: resolution.tabId,
				frameId: resolution.frameId,
				debuggerManager: this.debuggerManager,
				telemetry: this.telemetry,
			});
			await nativeInput.fillAt(point, params.value);
			return {
				ok: true,
				refId: params.refId,
				tabId: resolution.tabId,
				frameId: resolution.frameId,
				selector: resolution.selector,
				native: true,
				point,
			};
		}
		await this.executeRefDomAction(resolution.tabId, resolution.frameId, resolution.selector, refFillInPage, [
			params.value,
		]);
		return {
			ok: true,
			refId: params.refId,
			tabId: resolution.tabId,
			frameId: resolution.frameId,
			selector: resolution.selector,
		};
	}

	async frameList(params: FrameListParams): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return listFrames(tabId);
	}

	async frameTree(params: FrameListParams): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		const frames = await listFrames(tabId);
		const tree = buildFrameTree(frames);
		return {
			roots: tree.roots,
			orphans: tree.orphans,
		};
	}

	async networkStart(params: NetworkStartParams, traceContext?: TraceContext): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return this.getNetworkCapture().start(
			tabId,
			{
				maxEntries: params.maxEntries,
				maxBodyBytes: params.maxBodyBytes,
			},
			traceContext,
		);
	}

	async networkStop(params: NetworkStartParams, traceContext?: TraceContext): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return this.getNetworkCapture().stop(tabId, traceContext);
	}

	async networkList(params: NetworkListParams): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return this.getNetworkCapture().list(tabId, {
			limit: params.limit,
			search: params.search,
		});
	}

	async networkClear(params: NetworkStartParams): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return this.getNetworkCapture().clear(tabId);
	}

	async networkStats(params: NetworkStartParams): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return this.getNetworkCapture().stats(tabId);
	}

	async networkGet(params: NetworkItemParams, traceContext?: TraceContext): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return this.getNetworkCapture().get(tabId, params.requestId, traceContext);
	}

	async networkBody(params: NetworkItemParams): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return this.getNetworkCapture().body(tabId, params.requestId);
	}

	async networkCurl(params: NetworkCurlParams): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return {
			requestId: params.requestId,
			command: this.getNetworkCapture().curl(tabId, params.requestId, params.includeSensitive),
		};
	}

	async deviceEmulate(params: DeviceEmulateParams, traceContext?: TraceContext): Promise<unknown> {
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

	async deviceReset(params: DeviceResetParams, traceContext?: TraceContext): Promise<unknown> {
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

	async perfMetrics(params: PerfMetricsParams, traceContext?: TraceContext): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return {
			tabId,
			metrics: await this.getPerformanceTools().getMetrics(tabId, traceContext),
		};
	}

	async perfTraceStart(params: PerfTraceStartParams, traceContext?: TraceContext): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return this.getPerformanceTools().startTrace(tabId, { timeoutMs: params.autoStopMs }, traceContext);
	}

	async perfTraceStop(params: PerfTraceStopParams, traceContext?: TraceContext): Promise<unknown> {
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
		return buildSessionHistoryResult(this.sessionBridge.getSnapshot(), params);
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
		return this.sessionBridge.getArtifacts();
	}

	private getNavigateTool(): NavigateTool {
		if (!this.navigateTool) {
			this.navigateTool = new NavigateTool({ windowId: this.windowId });
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

	private getPageSnapshotTool(): PageSnapshotTool {
		if (!this.pageSnapshotTool) {
			this.pageSnapshotTool = new PageSnapshotTool();
			this.pageSnapshotTool.windowId = this.windowId;
		}
		return this.pageSnapshotTool;
	}

	private getWorkflowEngine(): WorkflowEngine {
		if (!this.workflowEngine) {
			this.workflowEngine = new WorkflowEngine({
				dispatch: (method, params, signal) => this.dispatch(method as BridgeMethod, params, signal),
			});
		}
		return this.workflowEngine;
	}

	private getNetworkCapture(): NetworkCaptureEngine {
		if (!this.networkCapture) {
			this.networkCapture = new NetworkCaptureEngine({
				debuggerManager: this.debuggerManager,
				telemetry: this.telemetry,
			});
		}
		return this.networkCapture;
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

	private async captureSnapshotForTarget(
		params: { tabId?: number; frameId?: number; maxEntries?: number; includeHidden?: boolean },
		signal?: AbortSignal,
	) {
		if (signal?.aborted) {
			throw new Error("Snapshot capture aborted");
		}
		const tabId = await this.resolveBridgeTabId(params.tabId);
		const snapshot = await capturePageSnapshot({
			tabId,
			frameId: params.frameId,
			maxEntries: params.maxEntries,
			includeHidden: params.includeHidden,
		});
		this.storeSnapshotRefs(snapshot);
		return snapshot;
	}

	private storeSnapshotRefs(snapshot: { tabId: number; frameId: number; entries: PageSnapshotEntry[] }): void {
		this.refMap.invalidateOnNavigation(snapshot.tabId, snapshot.frameId);
		for (const entry of snapshot.entries) {
			this.refMap.createRef({
				refId: entry.snapshotId,
				tabId: snapshot.tabId,
				frameId: snapshot.frameId,
				locator: buildRefLocatorBundle(entry),
			});
		}
	}

	private storeLocatorMatches(
		matches: Array<{ entry: PageSnapshotEntry; score: number; reasons: string[] }>,
	): Array<{ refId: string; score: number; reasons: string[]; entry: PageSnapshotEntry }> {
		return matches.map((match) => {
			const ref = this.refMap.createRef({
				refId: match.entry.snapshotId,
				tabId: match.entry.tabId,
				frameId: match.entry.frameId,
				locator: buildRefLocatorBundle(match.entry),
			});
			return {
				refId: ref.refId,
				score: match.score,
				reasons: match.reasons,
				entry: match.entry,
			};
		});
	}

	private async resolveReference(refId: string, tabId?: number, frameId?: number, signal?: AbortSignal) {
		if (signal?.aborted) {
			throw new Error("Reference resolution aborted");
		}

		const ref = this.refMap.getRef(refId);
		if (!ref) {
			throw new Error(`Reference ${refId} does not exist`);
		}
		const targetTabId = tabId ?? ref.tabId;
		const targetFrameId = frameId ?? ref.frameId;
		const snapshot = await capturePageSnapshot({
			tabId: targetTabId,
			frameId: targetFrameId,
		});
		const candidates: RefResolutionCandidate[] = snapshot.entries.map((entry) => ({
			candidateId: entry.snapshotId,
			tabId: entry.tabId,
			frameId: entry.frameId,
			selectorCandidates: entry.selectorCandidates,
			role: entry.role,
			name: entry.name,
			text: entry.text,
			label: entry.label,
			tagName: entry.tagName,
			attributes: entry.attributes,
			ordinalPath: entry.ordinalPath,
			boundingBox: entry.boundingBox,
		}));
		const resolution = this.refMap.resolveRef(refId, candidates);
		if (!resolution.ok) {
			throw new Error(resolution.message);
		}
		const selector = resolution.match.selectorCandidates?.[0];
		if (!selector) {
			throw new Error(`Reference ${refId} resolved without a usable selector`);
		}
		return {
			tabId: resolution.ref.tabId,
			frameId: resolution.ref.frameId,
			selector,
			boundingBox: resolution.match.boundingBox,
		};
	}

	private async resolveNativeRefPoint(resolution: ResolvedReference, signal?: AbortSignal): Promise<NativeInputPoint> {
		if (signal?.aborted) {
			throw new Error("Native ref coordinate resolution aborted");
		}
		const execution = await executePageFunction<{ ok: true; x: number; y: number } | { ok: false; error: string }>(
			{ tabId: resolution.tabId, frameId: resolution.frameId },
			nativeRefCoordinateInPage,
			{
				worldId: "shuvgeist-native-ref-coordinate",
				args: [resolution.selector],
				signal,
			},
		);
		if (!execution.success) {
			throw new Error(
				`Native ref coordinate resolution failed for selector ${resolution.selector}: ${
					execution.error || "unknown script error"
				}`,
			);
		}
		if (!isNativeRefCoordinateResult(execution.value)) {
			if (isNativeRefCoordinateFailure(execution.value)) {
				throw new Error(
					`Native ref coordinate resolution failed for selector ${resolution.selector}: ${execution.value.error}`,
				);
			}
			throw new Error(
				`Native ref coordinate resolution failed for selector ${resolution.selector}: ${JSON.stringify(execution.value)}`,
			);
		}
		const frameOffset = await this.resolveFrameViewportOffset(resolution.tabId, resolution.frameId, signal);
		return { x: execution.value.x + frameOffset.x, y: execution.value.y + frameOffset.y };
	}

	private async resolveFrameViewportOffset(
		tabId: number,
		frameId: number,
		signal?: AbortSignal,
	): Promise<NativeInputPoint> {
		if (frameId === 0) {
			return { x: 0, y: 0 };
		}
		if (signal?.aborted) {
			throw new Error("Native ref frame offset resolution aborted");
		}
		const frames = await listFrames(tabId);
		const frame = frames.find((candidate) => candidate.frameId === frameId);
		if (!frame) {
			throw new Error(`Frame ${frameId} was not found for native ref coordinate resolution`);
		}
		const parentFrameId = typeof frame.parentFrameId === "number" ? frame.parentFrameId : 0;
		const parentOffset = await this.resolveFrameViewportOffset(tabId, parentFrameId, signal);
		const execution = await executePageFunction<{ ok: true; x: number; y: number } | { ok: false; error: string }>(
			{ tabId, frameId: parentFrameId },
			frameElementOffsetInPage,
			{
				worldId: "shuvgeist-native-frame-offset",
				args: [frame.url],
				signal,
			},
		);
		if (!execution.success) {
			throw new Error(
				`Native ref frame offset resolution failed for frame ${frameId}: ${execution.error || "unknown script error"}`,
			);
		}
		if (isNativeRefCoordinateFailure(execution.value)) {
			throw new Error(`Native ref frame offset resolution failed for frame ${frameId}: ${execution.value.error}`);
		}
		if (!isNativeRefCoordinateResult(execution.value)) {
			throw new Error(
				`Native ref frame offset resolution failed for frame ${frameId}: ${JSON.stringify(execution.value)}`,
			);
		}
		return {
			x: parentOffset.x + execution.value.x,
			y: parentOffset.y + execution.value.y,
		};
	}

	private async executeRefDomAction(
		tabId: number,
		frameId: number,
		selector: string,
		pageFunction: PageExecutionFunction,
		extraArgs: unknown[] = [],
	): Promise<void> {
		const execution = await executePageFunction<{ ok?: boolean }>({ tabId, frameId }, pageFunction, {
			worldId: "shuvgeist-ref-action",
			args: [selector, ...extraArgs],
		});
		if (!execution.success) {
			throw new Error(`Ref action failed for selector ${selector}: ${execution.error || "unknown script error"}`);
		}
		if (!execution.value?.ok) {
			throw new Error(`Ref action did not confirm success for selector ${selector}`);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPageAssertCheckResult(
	value: unknown,
): value is { ok: boolean; message: string; actual?: unknown; expected?: unknown } {
	return isRecord(value) && typeof value.ok === "boolean" && typeof value.message === "string";
}

interface ResolvedReference {
	tabId: number;
	frameId: number;
	selector: string;
	boundingBox?: RefBoundingBox;
}

function nativeRefCoordinateInPage(
	selector: string,
): { ok: true; x: number; y: number } | { ok: false; error: string } {
	try {
		const el = document.querySelector(selector);
		if (!(el instanceof Element)) {
			return { ok: false, error: "Resolved ref target is not present for native input" };
		}
		const rect = el.getBoundingClientRect();
		if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || rect.width <= 0 || rect.height <= 0) {
			return { ok: false, error: "Resolved ref target has no usable viewport bounds" };
		}
		const x = rect.left + rect.width / 2;
		const y = rect.top + rect.height / 2;
		return { ok: true, x, y };
	} catch (error) {
		return {
			ok: false,
			error: `Unable to translate subframe ref coordinates: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function frameElementOffsetInPage(frameUrl: string): { ok: true; x: number; y: number } | { ok: false; error: string } {
	try {
		const candidates = Array.from(document.querySelectorAll("iframe,frame"));
		for (const candidate of candidates) {
			if (!(candidate instanceof HTMLIFrameElement || candidate instanceof HTMLFrameElement)) continue;
			let matches = false;
			try {
				matches = candidate.contentWindow?.location.href === frameUrl;
			} catch {
				matches = false;
			}
			if (!matches) {
				const rawSrc = candidate.getAttribute("src");
				if (rawSrc) {
					try {
						matches = new URL(rawSrc, document.baseURI).href === frameUrl;
					} catch {
						matches = false;
					}
				}
			}
			if (!matches) continue;
			const rect = candidate.getBoundingClientRect();
			if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || rect.width <= 0 || rect.height <= 0) {
				return { ok: false, error: "Resolved frame element has no usable viewport bounds" };
			}
			return { ok: true, x: rect.left, y: rect.top };
		}
		return { ok: false, error: `No frame element matched ${frameUrl}` };
	} catch (error) {
		return {
			ok: false,
			error: `Unable to resolve frame element offset: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function refClickInPage(selector: string): { ok: true } {
	const el = document.querySelector(selector);
	if (!(el instanceof HTMLElement)) {
		throw new Error("Resolved ref target is not clickable");
	}
	el.click();
	return { ok: true };
}

function refFillInPage(selector: string, value: string): { ok: true } {
	const el = document.querySelector(selector);
	if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
		throw new Error("Resolved ref target is not fillable");
	}
	el.focus();
	el.value = value;
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return { ok: true };
}

function isNativeRefCoordinateResult(value: unknown): value is { ok: true; x: number; y: number } {
	return (
		isRecord(value) &&
		value.ok === true &&
		typeof value.x === "number" &&
		typeof value.y === "number" &&
		Number.isFinite(value.x) &&
		Number.isFinite(value.y)
	);
}

function isNativeRefCoordinateFailure(value: unknown): value is { ok: false; error: string } {
	return isRecord(value) && value.ok === false && typeof value.error === "string";
}
