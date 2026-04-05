/**
 * Bridge-mode command executor.
 *
 * Instantiates the same browser tools used by the sidepanel agent and
 * exposes bridge-friendly methods that accept an AbortSignal. This keeps
 * the bridge and agent tooling backed by the same underlying code.
 */

import { DebuggerTool } from "../tools/debugger.js";
import { normalizeDeviceEmulationRequest } from "../tools/device-presets.js";
import { ExtractImageTool } from "../tools/extract-image.js";
import { resolveTabTarget } from "../tools/helpers/browser-target.js";
import { getSharedDebuggerManager } from "../tools/helpers/debugger-manager.js";
import { buildFrameTree, listFrames } from "../tools/helpers/frame-resolver.js";
import { RefMap, type RefResolutionCandidate } from "../tools/helpers/ref-map.js";
import { AskUserWhichElementTool } from "../tools/index.js";
import { NativeInputEventsRuntimeProvider } from "../tools/NativeInputEventsRuntimeProvider.js";
import { NavigateTool } from "../tools/navigate.js";
import { NetworkCaptureEngine } from "../tools/network-capture.js";
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
import { createReplTool } from "../tools/repl/repl.js";
import { BrowserJsRuntimeProvider, NavigateRuntimeProvider } from "../tools/repl/runtime-providers.js";
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
	PageSnapshotBridgeParams,
	PerfMetricsParams,
	PerfTraceStartParams,
	PerfTraceStopParams,
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

/**
 * Router interface for REPL execution.
 * When provided, the executor delegates REPL calls through this router
 * instead of executing directly (needed when running in service worker context).
 */
export interface ReplRouter {
	execute(params: ReplParams, signal?: AbortSignal): Promise<BridgeReplResult>;
}

/**
 * Router interface for screenshot capture.
 * When provided, the executor delegates screenshot calls through this router
 * instead of using ExtractImageTool directly (needed when running in service
 * worker context where canvas/image APIs may hang).
 */
export interface ScreenshotRouter {
	capture(params: ScreenshotParams, signal?: AbortSignal): Promise<BridgeScreenshotResult>;
}

export interface BrowserCommandExecutorOptions {
	windowId: number;
	sessionId?: string;
	sensitiveAccessEnabled: boolean;
	sessionBridge?: SessionBridgeAdapter;
	replRouter?: ReplRouter;
	screenshotRouter?: ScreenshotRouter;
}

export class BrowserCommandExecutor {
	private navigateTool?: NavigateTool;
	private selectElementTool?: AskUserWhichElementTool;
	private replTool?: ReturnType<typeof createReplTool>;
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
	private readonly debuggerManager = getSharedDebuggerManager();
	private readonly refMap = new RefMap();

	constructor(options: BrowserCommandExecutorOptions) {
		this.windowId = options.windowId;
		this.sessionId = options.sessionId;
		this.sensitiveAccessEnabled = options.sensitiveAccessEnabled;
		this.sessionBridge = options.sessionBridge;
		this.replRouter = options.replRouter;
		this.screenshotRouter = options.screenshotRouter;
	}

	/** Dispatch a bridge command by method name. */
	async dispatch(
		method: BridgeMethod,
		params: Record<string, unknown> | undefined,
		signal?: AbortSignal,
	): Promise<unknown> {
		switch (method) {
			case "status":
				return this.status();
			case "navigate":
				return this.navigate((params ?? {}) as NavigateParams, signal);
			case "repl":
				return this.repl(params as unknown as ReplParams, signal);
			case "screenshot":
				return this.screenshot((params ?? {}) as ScreenshotParams, signal);
			case "eval":
				return this.evalCode(params as unknown as EvalParams, signal);
			case "cookies":
				return this.cookies((params ?? {}) as CookiesParams, signal);
			case "select_element":
				return this.selectElement((params ?? {}) as SelectElementParams, signal);
			case "workflow_run":
				return this.workflowRun((params ?? {}) as unknown as WorkflowRunParams, signal);
			case "workflow_validate":
				return this.workflowValidate((params ?? {}) as unknown as WorkflowValidateParams);
			case "page_snapshot":
				return this.pageSnapshot((params ?? {}) as PageSnapshotBridgeParams, signal);
			case "locate_by_role":
				return this.locateByRole((params ?? {}) as unknown as LocateByRoleParams, signal);
			case "locate_by_text":
				return this.locateByText((params ?? {}) as unknown as LocateByTextParams, signal);
			case "locate_by_label":
				return this.locateByLabel((params ?? {}) as unknown as LocateByLabelParams, signal);
			case "ref_click":
				return this.refClick(params as unknown as RefClickParams, signal);
			case "ref_fill":
				return this.refFill(params as unknown as RefFillParams, signal);
			case "frame_list":
				return this.frameList((params ?? {}) as FrameListParams);
			case "frame_tree":
				return this.frameTree((params ?? {}) as FrameListParams);
			case "network_start":
				return this.networkStart((params ?? {}) as unknown as NetworkStartParams);
			case "network_stop":
				return this.networkStop((params ?? {}) as NetworkStartParams);
			case "network_list":
				return this.networkList((params ?? {}) as NetworkListParams);
			case "network_clear":
				return this.networkClear((params ?? {}) as NetworkStartParams);
			case "network_stats":
				return this.networkStats((params ?? {}) as NetworkStartParams);
			case "network_get":
				return this.networkGet((params ?? {}) as unknown as NetworkItemParams);
			case "network_body":
				return this.networkBody((params ?? {}) as unknown as NetworkItemParams);
			case "network_curl":
				return this.networkCurl((params ?? {}) as unknown as NetworkCurlParams);
			case "device_emulate":
				return this.deviceEmulate((params ?? {}) as DeviceEmulateParams);
			case "device_reset":
				return this.deviceReset((params ?? {}) as DeviceResetParams);
			case "perf_metrics":
				return this.perfMetrics((params ?? {}) as PerfMetricsParams);
			case "perf_trace_start":
				return this.perfTraceStart((params ?? {}) as PerfTraceStartParams);
			case "perf_trace_stop":
				return this.perfTraceStop((params ?? {}) as PerfTraceStopParams);
			case "session_history":
				return this.sessionHistory((params ?? {}) as SessionHistoryParams);
			case "session_inject":
				return this.sessionInject(params as unknown as SessionInjectParams, signal);
			case "session_new":
				return this.sessionNew((params ?? {}) as SessionNewParams);
			case "session_set_model":
				return this.sessionSetModel(params as unknown as SessionSetModelParams);
			case "session_artifacts":
				return this.sessionArtifacts();
			default:
				throw new Error("Unknown method: " + method);
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

	async repl(params: ReplParams, signal?: AbortSignal): Promise<BridgeReplResult> {
		// If a REPL router is configured (running in service worker), delegate to it
		if (this.replRouter) {
			return this.replRouter.execute(params, signal);
		}

		// Direct execution (running in sidepanel or extension page with DOM access)
		const result = await this.getReplTool().execute("bridge", { title: params.title, code: params.code }, signal);
		const textItem = result.content.find((item) => item.type === "text");
		const output = (textItem && "text" in textItem ? textItem.text : "") || "";
		return {
			output,
			files: result.details?.files || [],
		};
	}

	async screenshot(params: ScreenshotParams, signal?: AbortSignal): Promise<BridgeScreenshotResult> {
		// If a screenshot router is configured (running in service worker), delegate to it
		if (this.screenshotRouter) {
			return this.screenshotRouter.capture(params, signal);
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
		return {
			mimeType: image.mimeType as BridgeScreenshotResult["mimeType"],
			dataUrl: `data:${image.mimeType};base64,${image.data}`,
		};
	}

	async evalCode(params: EvalParams, signal?: AbortSignal): Promise<unknown> {
		if (!this.sensitiveAccessEnabled) {
			const error = new Error("Eval bridge command is disabled unless sensitive browser data access is enabled");
			(error as Error & { code?: number }).code = ErrorCodes.CAPABILITY_DISABLED;
			throw error;
		}
		const result = await this.getDebuggerTool().execute("bridge", { action: "eval", code: params.code }, signal);
		return result.details;
	}

	async cookies(_params: CookiesParams, signal?: AbortSignal): Promise<unknown> {
		if (!this.sensitiveAccessEnabled) {
			const error = new Error("Cookies bridge command is disabled unless sensitive browser data access is enabled");
			(error as Error & { code?: number }).code = ErrorCodes.CAPABILITY_DISABLED;
			throw error;
		}
		const result = await this.getDebuggerTool().execute("bridge", { action: "cookies" }, signal);
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

	async refClick(params: RefClickParams, signal?: AbortSignal): Promise<unknown> {
		const resolution = await this.resolveReference(params.refId, params.tabId, params.frameId, signal);
		await this.executeRefDomAction(
			resolution.tabId,
			resolution.frameId,
			resolution.selector,
			(selector) => `(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (!(el instanceof HTMLElement)) {
				throw new Error("Resolved ref target is not clickable");
			}
			el.click();
			return { ok: true };
		})()`,
		);
		return { ok: true, refId: params.refId, ...resolution };
	}

	async refFill(params: RefFillParams, signal?: AbortSignal): Promise<unknown> {
		const resolution = await this.resolveReference(params.refId, params.tabId, params.frameId, signal);
		await this.executeRefDomAction(
			resolution.tabId,
			resolution.frameId,
			resolution.selector,
			(selector) => `(() => {
			const el = document.querySelector(${JSON.stringify(selector)});
			if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
				throw new Error("Resolved ref target is not fillable");
			}
			el.focus();
			el.value = ${JSON.stringify(params.value)};
			el.dispatchEvent(new Event("input", { bubbles: true }));
			el.dispatchEvent(new Event("change", { bubbles: true }));
			return { ok: true };
		})()`,
		);
		return { ok: true, refId: params.refId, ...resolution };
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

	async networkStart(params: NetworkStartParams): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return this.getNetworkCapture().start(tabId, {
			maxEntries: params.maxEntries,
			maxBodyBytes: params.maxBodyBytes,
		});
	}

	async networkStop(params: NetworkStartParams): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return this.getNetworkCapture().stop(tabId);
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

	async networkGet(params: NetworkItemParams): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return this.getNetworkCapture().get(tabId, params.requestId);
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

	async deviceEmulate(params: DeviceEmulateParams): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		const normalized = normalizeDeviceEmulationRequest(params);
		const owner = `device-emulation:${tabId}:${Date.now()}`;
		await this.debuggerManager.acquire(tabId, owner);
		try {
			await this.debuggerManager.ensureDomain(tabId, "Page");
			await this.debuggerManager.sendCommand(tabId, "Emulation.setDeviceMetricsOverride", {
				width: normalized.viewport.width,
				height: normalized.viewport.height,
				deviceScaleFactor: normalized.viewport.deviceScaleFactor,
				mobile: normalized.viewport.mobile,
			});
			await this.debuggerManager.sendCommand(tabId, "Emulation.setTouchEmulationEnabled", {
				enabled: normalized.touch,
				configuration: normalized.touch ? "mobile" : "desktop",
			});
			if (normalized.userAgent) {
				await this.debuggerManager.sendCommand(tabId, "Emulation.setUserAgentOverride", {
					userAgent: normalized.userAgent,
				});
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
			await this.debuggerManager.release(tabId, owner);
		}
	}

	async deviceReset(params: DeviceResetParams): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		const owner = `device-reset:${tabId}:${Date.now()}`;
		await this.debuggerManager.acquire(tabId, owner);
		try {
			await this.debuggerManager.sendCommand(tabId, "Emulation.clearDeviceMetricsOverride");
			await this.debuggerManager.sendCommand(tabId, "Emulation.setTouchEmulationEnabled", {
				enabled: false,
				configuration: "desktop",
			});
			await this.debuggerManager.sendCommand(tabId, "Emulation.setUserAgentOverride", {
				userAgent: "",
			});
			return { ok: true, tabId };
		} finally {
			await this.debuggerManager.release(tabId, owner);
		}
	}

	async perfMetrics(params: PerfMetricsParams): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return {
			tabId,
			metrics: await this.getPerformanceTools().getMetrics(tabId),
		};
	}

	async perfTraceStart(params: PerfTraceStartParams): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return this.getPerformanceTools().startTrace(tabId, { timeoutMs: params.autoStopMs });
	}

	async perfTraceStop(params: PerfTraceStopParams): Promise<unknown> {
		const tabId = await this.resolveBridgeTabId(params.tabId);
		return this.getPerformanceTools().stopTrace(tabId);
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

	private getReplTool(): ReturnType<typeof createReplTool> {
		if (!this.replTool) {
			this.replTool = createReplTool();
			this.replTool.overlayWindowId = this.windowId;
			this.replTool.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");
			this.replTool.runtimeProvidersFactory = () => {
				const pageProviders = [
					new NativeInputEventsRuntimeProvider({
						windowId: this.windowId,
						debuggerManager: this.debuggerManager,
					}),
				];
				return [
					...pageProviders,
					new BrowserJsRuntimeProvider(pageProviders, this.windowId),
					new NavigateRuntimeProvider(this.getNavigateTool()),
				];
			};
		}
		return this.replTool;
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
			this.networkCapture = new NetworkCaptureEngine(this.debuggerManager);
		}
		return this.networkCapture;
	}

	private getPerformanceTools(): PerformanceTools {
		if (!this.performanceTools) {
			this.performanceTools = new PerformanceTools({ debuggerManager: this.debuggerManager });
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
		};
	}

	private async executeRefDomAction(
		tabId: number,
		frameId: number,
		selector: string,
		buildCode: (selector: string) => string,
	): Promise<void> {
		const target: { tabId: number; allFrames?: boolean; frameIds?: number[] } = { tabId, allFrames: false };
		if (frameId !== 0) {
			target.frameIds = [frameId];
		}
		const results = await chrome.userScripts.execute({
			js: [{ code: buildCode(selector) }],
			target,
			world: "USER_SCRIPT",
			worldId: "shuvgeist-ref-action",
			injectImmediately: true,
		} as Parameters<typeof chrome.userScripts.execute>[0]);
		const first = results[0] as { result?: { ok?: boolean } } | undefined;
		if (!first?.result?.ok) {
			throw new Error("Ref action did not confirm success");
		}
	}
}
