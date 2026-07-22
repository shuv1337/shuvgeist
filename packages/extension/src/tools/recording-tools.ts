import type { PageDriver } from "@shuvgeist/driver/page-driver";
import { pageDriverScopeToWire } from "@shuvgeist/driver/page-driver-wire";
import type {
	PageScreencastFrame,
	PageScreencastStartResult,
	PageScreencastStatus,
	PageScreencastStopReason,
	PageScreencastSummary,
} from "@shuvgeist/driver/page-screencast-engine";
import type {
	RecordFrameEventData,
	RecordOutcome,
	RecordStartParams,
	RecordStartResult,
	RecordStatusParams,
	RecordStatusResult,
	RecordStopParams,
	RecordStopResult,
} from "@shuvgeist/protocol/protocol";
import type { BridgeTelemetry, TraceContext } from "@shuvgeist/protocol/telemetry";
import {
	ChromePageDriverRegistry,
	type ChromePageDriverRegistryLike,
	type ResolvedChromePageDriver,
} from "../bridge/chrome-page-driver-registry.js";
import type { DebuggerManager } from "./helpers/debugger-manager.js";

interface RecordingState {
	tabId: number;
	driver: PageDriver;
	recordingId: string;
}

export interface RecordingToolsOptions {
	windowId: number;
	pageDriverRegistry?: ChromePageDriverRegistryLike;
	debuggerManager?: DebuggerManager;
	emitRecordFrame: (data: RecordFrameEventData) => void;
	telemetry?: BridgeTelemetry;
}

const DISALLOWED_SCHEMES = ["chrome:", "chrome-extension:", "devtools:", "view-source:", "about:"];

export function assertRecordableTabUrl(url?: string): void {
	let protocol = "";
	try {
		protocol = url ? new URL(url).protocol : "";
	} catch {
		protocol = "";
	}
	if (DISALLOWED_SCHEMES.includes(protocol)) {
		throw new Error(`Cannot record ${url}. Chrome debugger screencast does not support internal or extension pages.`);
	}
}

/**
 * Bridge-facing Chrome recording adapter. CDP ownership, frame accounting,
 * limits, detach handling, and teardown all live in PageScreencastEngine.
 */
export class RecordingTools {
	private readonly pageDrivers: ChromePageDriverRegistryLike;
	private readonly ownsPageDrivers: boolean;
	private readonly emitRecordFrame: (data: RecordFrameEventData) => void;
	private readonly telemetry?: BridgeTelemetry;
	private readonly recordingsByTabId = new Map<number, RecordingState>();
	private readonly recordingsById = new Map<string, RecordingState>();

	constructor(options: RecordingToolsOptions) {
		if (!options.pageDriverRegistry && !options.debuggerManager) {
			throw new Error("RecordingTools requires a PageDriver registry or debugger manager");
		}
		this.pageDrivers =
			options.pageDriverRegistry ??
			new ChromePageDriverRegistry({
				ownerWindowId: options.windowId,
				debuggerManager: options.debuggerManager as DebuggerManager,
			});
		this.ownsPageDrivers = options.pageDriverRegistry === undefined;
		this.emitRecordFrame = options.emitRecordFrame;
		this.telemetry = options.telemetry;
	}

	async start(
		params: RecordStartParams,
		signal?: AbortSignal,
		traceContext?: TraceContext,
	): Promise<RecordStartResult> {
		assertTopFrame(params.frameId);
		const resolved = await this.pageDrivers.resolve(params.tabId);
		assertRecordableTabUrl(resolved.tab.url);
		if (this.recordingsByTabId.has(resolved.tabId)) {
			throw new Error(`Recording is already active for tab ${resolved.tabId}`);
		}
		const span = this.telemetry?.startSpan("record.start", {
			parent: traceContext,
			attributes: { "bridge.method": "record_start", "record.tab_id": resolved.tabId },
		});
		try {
			const started = await resolved.driver.screencast.start(
				{
					maxDurationMs: params.maxDurationMs,
					videoBitsPerSecond: params.videoBitsPerSecond,
					mimeType: params.mimeType,
					fps: params.fps,
					quality: params.quality,
					maxWidth: params.maxWidth,
					maxHeight: params.maxHeight,
					everyNthFrame: params.everyNthFrame,
					signal,
				},
				{
					onFrame: (frame) => this.emitFrame(resolved.tabId, frame),
					onComplete: (summary) => this.complete(resolved.tabId, summary),
				},
			);
			const state = { tabId: resolved.tabId, driver: resolved.driver, recordingId: started.recordingId };
			this.recordingsByTabId.set(resolved.tabId, state);
			this.recordingsById.set(started.recordingId, state);
			span?.end("ok");
			return startResultToWire(started, resolved.tabId);
		} catch (error) {
			span?.recordError(error);
			span?.end("error");
			throw error;
		}
	}

	async stop(params: RecordStopParams, signal?: AbortSignal, traceContext?: TraceContext): Promise<RecordStopResult> {
		assertTopFrame(params.frameId);
		if (signal?.aborted) throw new Error("Recording stop aborted");
		const state = await this.resolveRecording(params.tabId);
		const span = this.telemetry?.startSpan("record.stop", {
			parent: traceContext,
			attributes: {
				"bridge.method": "record_stop",
				"record.recording_id": state.recordingId,
				"record.tab_id": state.tabId,
			},
		});
		try {
			const result = summaryToWire(await state.driver.screencast.stop(state.recordingId), state.tabId);
			span?.end("ok");
			return result;
		} catch (error) {
			span?.recordError(error);
			span?.end("error");
			throw error;
		}
	}

	async status(params: RecordStatusParams, traceContext?: TraceContext): Promise<RecordStatusResult> {
		assertTopFrame(params.frameId);
		const resolved = await this.resolveStatusTarget(params.tabId);
		const status = resolved.driver.screencast.status();
		const result = statusToWire(status, resolved.tabId);
		this.telemetry
			?.startSpan("record.status", {
				parent: traceContext,
				attributes: {
					"bridge.method": "record_status",
					"record.tab_id": resolved.tabId,
					"record.active": result.active,
				},
			})
			.end("ok");
		return result;
	}

	hasRecording(recordingId: string): boolean {
		return this.recordingsById.has(recordingId);
	}

	hasRecordingForTab(tabId: number): boolean {
		return this.recordingsByTabId.has(tabId);
	}

	getActiveTabIds(): number[] {
		return [...this.recordingsByTabId.keys()];
	}

	handleTabClosed(tabId: number): void {
		const state = this.recordingsByTabId.get(tabId);
		if (!state) {
			void this.pageDrivers.release(tabId);
			return;
		}
		void state.driver.screencast
			.stop(state.recordingId, "target-closed")
			.catch(() => undefined)
			.finally(() => this.pageDrivers.release(tabId));
	}

	async dispose(): Promise<void> {
		await Promise.all(
			[...this.recordingsById.values()].map((state) =>
				state.driver.screencast.stop(state.recordingId, "abort").catch(() => undefined),
			),
		);
		if (this.ownsPageDrivers) await this.pageDrivers.dispose();
	}

	private async resolveRecording(tabId?: number): Promise<RecordingState> {
		if (tabId !== undefined) {
			const state = this.recordingsByTabId.get(tabId);
			if (!state) throw new Error(`No active recording for tab ${tabId}`);
			return state;
		}
		if (this.recordingsById.size === 1) return this.recordingsById.values().next().value as RecordingState;
		if (this.recordingsById.size === 0) throw new Error("No active recording");
		throw new Error("Multiple recordings are active; specify --tab-id");
	}

	private async resolveStatusTarget(tabId?: number): Promise<ResolvedChromePageDriver> {
		if (tabId !== undefined) return this.pageDrivers.resolve(tabId);
		if (this.recordingsById.size === 1) {
			const state = this.recordingsById.values().next().value as RecordingState;
			const resolved = await this.pageDrivers.resolve(state.tabId);
			if (resolved.driver !== state.driver) throw new Error("Recording target changed while reading status");
			return resolved;
		}
		return this.pageDrivers.resolve();
	}

	private emitFrame(tabId: number, frame: PageScreencastFrame): void {
		const scope = pageDriverScopeToWire(frame.scope, chromeTarget(tabId));
		this.emitRecordFrame({
			...scope,
			recordingId: frame.recordingId,
			seq: frame.seq,
			format: frame.format,
			dataBase64: frame.dataBase64,
			capturedAtMs: frame.capturedAtMs,
			metadata: frame.metadata ? { ...frame.metadata } : undefined,
		});
	}

	private complete(tabId: number, summary: PageScreencastSummary): void {
		const state = this.recordingsById.get(summary.recordingId);
		if (state) {
			this.recordingsById.delete(summary.recordingId);
			if (this.recordingsByTabId.get(tabId) === state) this.recordingsByTabId.delete(tabId);
		}
		const wireSummary = summaryToWire(summary, tabId);
		this.emitRecordFrame({
			...pageDriverScopeToWire(summary.scope, chromeTarget(tabId)),
			recordingId: summary.recordingId,
			seq: summary.frameCount,
			format: "jpeg",
			dataBase64: "",
			capturedAtMs: Date.parse(summary.endedAt),
			final: true,
			summary: wireSummary,
		});
		void this.telemetry?.flush();
	}
}

function startResultToWire(result: PageScreencastStartResult, tabId: number): RecordStartResult {
	return {
		...pageDriverScopeToWire(result.scope, chromeTarget(tabId)),
		ok: true,
		recordingId: result.recordingId,
		startedAt: result.startedAt,
		mimeType: result.mimeType,
		videoBitsPerSecond: result.videoBitsPerSecond,
		maxDurationMs: result.maxDurationMs,
	};
}

function statusToWire(status: PageScreencastStatus, tabId: number): RecordStatusResult {
	const scope = pageDriverScopeToWire(status.scope, chromeTarget(tabId));
	if (!status.active) return { ...scope, active: false };
	return {
		...scope,
		active: true,
		recordingId: status.recordingId,
		startedAt: status.startedAt,
		mimeType: status.mimeType,
		durationMs: status.durationMs,
		sourceBytes: status.sourceBytes,
		frameCount: status.frameCount,
		fps: status.fps,
		lastError: status.lastError,
	};
}

function summaryToWire(summary: PageScreencastSummary, tabId: number): RecordStopResult {
	return {
		...pageDriverScopeToWire(summary.scope, chromeTarget(tabId)),
		ok: true,
		recordingId: summary.recordingId,
		startedAt: summary.startedAt,
		endedAt: summary.endedAt,
		durationMs: summary.durationMs,
		mimeType: summary.mimeType,
		sourceBytes: summary.sourceBytes,
		frameCount: summary.frameCount,
		outcome: outcomeFromReason(summary.reason),
		lastError: summary.lastError,
	};
}

function outcomeFromReason(reason: PageScreencastStopReason): RecordOutcome {
	if (reason === "user") return "stopped_user";
	if (reason === "max-duration") return "stopped_max_duration";
	if (reason === "max-bytes") return "stopped_max_bytes";
	if (reason === "target-closed") return "stopped_target_closed";
	return "stopped_error";
}

function chromeTarget(tabId: number) {
	return { kind: "chrome-tab" as const, tabId, frameId: 0 };
}

function assertTopFrame(frameId?: number): void {
	if (frameId !== undefined && frameId !== 0) {
		throw new Error(`Chrome recording supports only the top frame; received frameId ${frameId}`);
	}
}
