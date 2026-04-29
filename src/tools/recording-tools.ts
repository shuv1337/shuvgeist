import type {
	BridgeRecordStartResponse,
	BridgeRecordStopResponse,
	BridgeToOffscreenMessage,
	OffscreenToBackgroundMessage,
} from "../bridge/internal-messages.js";
import {
	BridgeDefaults,
	type RecordChunkEventData,
	type RecordOutcome,
	type RecordStartParams,
	type RecordStartResult,
	type RecordStatusParams,
	type RecordStatusResult,
	type RecordStopParams,
	type RecordStopResult,
} from "../bridge/protocol.js";
import type { BridgeTelemetry, BridgeTelemetrySpan, TraceContext } from "../bridge/telemetry.js";
import { resolveTabTarget } from "./helpers/browser-target.js";

interface RecordingState {
	recordingId: string;
	tabId: number;
	startedAtMs: number;
	startedAt: string;
	mimeType: string;
	videoBitsPerSecond?: number;
	maxDurationMs: number;
	sizeBytes: number;
	chunkCount: number;
	lastError?: string;
	outcome?: RecordOutcome;
	stopping: boolean;
	maxDurationTimer?: ReturnType<typeof setTimeout>;
	forceStopTimer?: ReturnType<typeof setTimeout>;
	resolveCompletion: (result: RecordStopResult) => void;
	rejectCompletion: (error: Error) => void;
	completion: Promise<RecordStopResult>;
	span?: BridgeTelemetrySpan;
}

export interface RecordingToolsOptions {
	windowId: number;
	ensureOffscreenDocument: () => Promise<void>;
	getOffscreenTabId: () => Promise<number>;
	sendToOffscreen: <T>(message: BridgeToOffscreenMessage) => Promise<T | null>;
	emitRecordChunk: (data: RecordChunkEventData) => void;
	telemetry?: BridgeTelemetry;
}

const DISALLOWED_SCHEMES = ["chrome:", "chrome-extension:", "devtools:", "view-source:", "about:"];

function createRecordingId(tabId: number): string {
	return `rec-${tabId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function base64ByteLength(value: string): number {
	if (!value) return 0;
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function codecFromMimeType(mimeType: string): string | undefined {
	const match = /codecs=([^;]+)/iu.exec(mimeType);
	return match?.[1]?.replace(/["']/g, "").trim();
}

function assertDurationAllowed(maxDurationMs: number): void {
	if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
		throw new Error("Recording max duration must be greater than 0ms");
	}
	if (maxDurationMs > BridgeDefaults.RECORD_HARD_MAX_DURATION_MS) {
		throw new Error(`Recording max duration exceeds hard limit of ${BridgeDefaults.RECORD_HARD_MAX_DURATION_MS}ms`);
	}
}

export function assertRecordableTabUrl(url?: string): void {
	let protocol = "";
	try {
		protocol = url ? new URL(url).protocol : "";
	} catch {
		protocol = "";
	}
	if (DISALLOWED_SCHEMES.includes(protocol)) {
		throw new Error(`Cannot record ${url}. tabCapture does not support internal or extension pages.`);
	}
}

export class RecordingTools {
	private readonly recordingsByTabId = new Map<number, RecordingState>();
	private readonly recordingsById = new Map<string, RecordingState>();
	private readonly windowId: number;
	private readonly ensureOffscreenDocument: () => Promise<void>;
	private readonly getOffscreenTabId: () => Promise<number>;
	private readonly sendToOffscreen: <T>(message: BridgeToOffscreenMessage) => Promise<T | null>;
	private readonly emitRecordChunk: (data: RecordChunkEventData) => void;
	private readonly telemetry?: BridgeTelemetry;

	constructor(options: RecordingToolsOptions) {
		this.windowId = options.windowId;
		this.ensureOffscreenDocument = options.ensureOffscreenDocument;
		this.getOffscreenTabId = options.getOffscreenTabId;
		this.sendToOffscreen = options.sendToOffscreen;
		this.emitRecordChunk = options.emitRecordChunk;
		this.telemetry = options.telemetry;
	}

	async start(
		params: RecordStartParams,
		signal?: AbortSignal,
		traceContext?: TraceContext,
	): Promise<RecordStartResult> {
		const maxDurationMs = params.maxDurationMs ?? BridgeDefaults.RECORD_DEFAULT_MAX_DURATION_MS;
		assertDurationAllowed(maxDurationMs);

		const resolved = await resolveTabTarget({ windowId: this.windowId, tabId: params.tabId });
		const tab = resolved.tab;
		const tabId = resolved.tabId;
		if (this.recordingsByTabId.has(tabId)) {
			throw new Error(`Recording is already active for tab ${tabId}`);
		}
		await this.assertTabIsFocused(tab);
		assertRecordableTabUrl(tab.url);
		if (signal?.aborted) {
			throw new Error("Recording start aborted");
		}

		await this.ensureOffscreenDocument();
		const consumerTabId = await this.getOffscreenTabId();
		const recordingId = createRecordingId(tabId);
		const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId, consumerTabId });
		const startedAtMs = Date.now();
		let resolveCompletion!: (result: RecordStopResult) => void;
		let rejectCompletion!: (error: Error) => void;
		const completion = new Promise<RecordStopResult>((resolve, reject) => {
			resolveCompletion = resolve;
			rejectCompletion = reject;
		});
		const state: RecordingState = {
			recordingId,
			tabId,
			startedAtMs,
			startedAt: new Date(startedAtMs).toISOString(),
			mimeType: params.mimeType ?? "video/webm",
			videoBitsPerSecond: params.videoBitsPerSecond,
			maxDurationMs,
			sizeBytes: 0,
			chunkCount: 0,
			stopping: false,
			resolveCompletion,
			rejectCompletion,
			completion,
			span: this.telemetry?.startSpan("record.session", {
				parent: traceContext,
				attributes: {
					"bridge.method": "record_start",
					"bridge.window_id": this.windowId,
					"record.recording_id": recordingId,
					"record.tab_id": tabId,
					"record.mime_type": params.mimeType,
					"record.codec": params.mimeType ? codecFromMimeType(params.mimeType) : undefined,
					"record.video_bits_per_second": params.videoBitsPerSecond,
				},
			}),
		};
		this.recordingsByTabId.set(tabId, state);
		this.recordingsById.set(recordingId, state);

		try {
			const response = await this.sendToOffscreen<BridgeRecordStartResponse>({
				type: "bridge-record-start",
				recordingId,
				streamId,
				mimeType: params.mimeType,
				videoBitsPerSecond: params.videoBitsPerSecond,
				timesliceMs: BridgeDefaults.RECORD_TIMESLICE_MS,
			});
			if (!response?.ok) {
				throw new Error(response?.error || "Offscreen recorder did not start");
			}
			state.mimeType = response.mimeType;
			state.videoBitsPerSecond = response.videoBitsPerSecond ?? state.videoBitsPerSecond;
			state.span?.setAttributes({
				"record.mime_type": state.mimeType,
				"record.codec": codecFromMimeType(state.mimeType),
				"record.video_bits_per_second": state.videoBitsPerSecond,
			});
			state.maxDurationTimer = setTimeout(() => {
				void this.stopRecording(state, "stopped_max_duration").catch((error) => this.forceStop(state, error));
			}, maxDurationMs);
		} catch (error) {
			this.recordingsByTabId.delete(tabId);
			this.recordingsById.delete(recordingId);
			state.span?.recordError(error);
			state.span?.end("error");
			throw error;
		}

		// Chrome tabCapture streams continue across same-tab navigations. We keep
		// recording until an explicit stop, the configured duration/byte ceiling, or
		// tab closure rather than treating navigation as an implicit stop.
		return {
			ok: true,
			recordingId,
			tabId,
			startedAt: state.startedAt,
			mimeType: state.mimeType,
			videoBitsPerSecond: state.videoBitsPerSecond,
			maxDurationMs,
		};
	}

	async stop(params: RecordStopParams, signal?: AbortSignal, traceContext?: TraceContext): Promise<RecordStopResult> {
		if (signal?.aborted) {
			throw new Error("Recording stop aborted");
		}
		const tabId = await this.resolveRecordingTabId(params.tabId);
		if (typeof tabId !== "number") {
			throw new Error("No active recording");
		}
		const state = this.recordingsByTabId.get(tabId);
		if (!state) {
			throw new Error(`No active recording for tab ${tabId}`);
		}
		const span = this.telemetry?.startSpan("record.stop", {
			parent: traceContext,
			attributes: {
				"bridge.method": "record_stop",
				"bridge.window_id": this.windowId,
				"record.recording_id": state.recordingId,
				"record.tab_id": state.tabId,
			},
		});
		try {
			const result = await this.stopRecording(state, "stopped_user");
			span?.setAttributes({
				"record.duration_ms": result.durationMs,
				"record.mime_type": result.mimeType,
				"record.codec": codecFromMimeType(result.mimeType),
				"record.size_bytes": result.sizeBytes,
				"record.chunk_count": result.chunkCount,
				"record.outcome": result.outcome,
			});
			span?.end("ok");
			return result;
		} catch (error) {
			span?.recordError(error);
			span?.end("error");
			throw error;
		}
	}

	async status(params: RecordStatusParams, traceContext?: TraceContext): Promise<RecordStatusResult> {
		const span = this.telemetry?.startSpan("record.status", {
			parent: traceContext,
			attributes: {
				"bridge.method": "record_status",
				"bridge.window_id": this.windowId,
			},
		});
		try {
			const tabId = await this.resolveRecordingTabId(params.tabId, true);
			const state = typeof tabId === "number" ? this.recordingsByTabId.get(tabId) : undefined;
			if (!state) {
				span?.end("ok");
				return { active: false };
			}
			const result: RecordStatusResult = {
				active: true,
				recordingId: state.recordingId,
				tabId: state.tabId,
				startedAt: state.startedAt,
				mimeType: state.mimeType,
				durationMs: Date.now() - state.startedAtMs,
				sizeBytes: state.sizeBytes,
				lastError: state.lastError,
			};
			span?.setAttributes({
				"record.recording_id": state.recordingId,
				"record.tab_id": state.tabId,
				"record.duration_ms": result.durationMs,
				"record.mime_type": state.mimeType,
				"record.size_bytes": state.sizeBytes,
				"record.chunk_count": state.chunkCount,
			});
			span?.end("ok");
			return result;
		} catch (error) {
			span?.recordError(error);
			span?.end("error");
			throw error;
		}
	}

	hasRecording(recordingId: string): boolean {
		return this.recordingsById.has(recordingId);
	}

	hasRecordingForTab(tabId: number): boolean {
		return this.recordingsByTabId.has(tabId);
	}

	getActiveTabIds(): number[] {
		return Array.from(this.recordingsByTabId.keys());
	}

	handleOffscreenMessage(message: OffscreenToBackgroundMessage): void {
		const state = this.recordingsById.get(message.recordingId);
		if (!state) return;
		if (message.type === "record-chunk") {
			this.handleChunk(state, message);
			return;
		}
		if (message.type === "record-error") {
			state.lastError = message.message;
			state.span?.recordError(new Error(message.message));
			void this.stopRecording(state, "stopped_error").catch((error) => this.forceStop(state, error));
			return;
		}
		this.finishRecording(state, state.outcome ?? message.outcome, message.endedAt);
	}

	handleTabClosed(tabId: number): void {
		const state = this.recordingsByTabId.get(tabId);
		if (!state) return;
		void this.stopRecording(state, "stopped_tab_closed").catch((error) => this.forceStop(state, error));
	}

	private async resolveRecordingTabId(tabId?: number, allowMissing = false): Promise<number | undefined> {
		if (typeof tabId === "number") return tabId;
		if (this.recordingsByTabId.size === 1) {
			return this.recordingsByTabId.keys().next().value as number;
		}
		try {
			return (await resolveTabTarget({ windowId: this.windowId })).tabId;
		} catch (error) {
			if (allowMissing) return undefined;
			throw error;
		}
	}

	private async assertTabIsFocused(tab: chrome.tabs.Tab): Promise<void> {
		if (!tab.id || typeof tab.windowId !== "number") {
			throw new Error("Target tab is not in a tabbed browser window");
		}
		const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
		if (activeTab?.id !== tab.id || tab.active !== true) {
			throw new Error("tabCapture requires the target tab to be active in its window");
		}
	}

	private handleChunk(
		state: RecordingState,
		message: Extract<OffscreenToBackgroundMessage, { type: "record-chunk" }>,
	): void {
		const bytes = base64ByteLength(message.chunkBase64);
		const seq = state.chunkCount;
		state.sizeBytes += bytes;
		state.chunkCount += 1;
		this.telemetry
			?.startSpan("record.chunk", {
				parent: state.span?.context,
				attributes: {
					"record.recording_id": state.recordingId,
					"record.tab_id": state.tabId,
					"record.seq": seq,
					"record.chunk_bytes": bytes,
					"record.chunk_final": message.final === true,
				},
			})
			.end("ok");
		this.emitRecordChunk({
			recordingId: state.recordingId,
			tabId: state.tabId,
			seq,
			mimeType: message.mimeType || state.mimeType,
			chunkBase64: message.chunkBase64,
			final: message.final,
		});
		if (state.sizeBytes >= BridgeDefaults.RECORD_HARD_MAX_BYTES && !state.stopping) {
			void this.stopRecording(state, "stopped_max_bytes").catch((error) => this.forceStop(state, error));
		}
	}

	private async stopRecording(state: RecordingState, outcome: RecordOutcome): Promise<RecordStopResult> {
		if (!state.stopping) {
			state.stopping = true;
			state.outcome = outcome;
			clearTimeout(state.maxDurationTimer);
			const response = await this.sendToOffscreen<BridgeRecordStopResponse>({
				type: "bridge-record-stop",
				recordingId: state.recordingId,
				outcome,
			});
			if (response && !response.ok) {
				state.lastError = response.error;
			}
			state.forceStopTimer = setTimeout(() => this.forceStop(state), 5000);
		}
		return state.completion;
	}

	private forceStop(state: RecordingState, error?: unknown): void {
		if (error) {
			state.lastError = error instanceof Error ? error.message : String(error);
			state.span?.recordError(error);
		}
		this.finishRecording(state, state.outcome ?? "stopped_error", Date.now());
	}

	private finishRecording(state: RecordingState, outcome: RecordOutcome, endedAtMs: number): void {
		if (!this.recordingsById.has(state.recordingId)) return;
		clearTimeout(state.maxDurationTimer);
		clearTimeout(state.forceStopTimer);
		this.recordingsByTabId.delete(state.tabId);
		this.recordingsById.delete(state.recordingId);
		const result: RecordStopResult = {
			ok: true,
			recordingId: state.recordingId,
			tabId: state.tabId,
			startedAt: state.startedAt,
			endedAt: new Date(endedAtMs).toISOString(),
			durationMs: endedAtMs - state.startedAtMs,
			mimeType: state.mimeType,
			sizeBytes: state.sizeBytes,
			chunkCount: state.chunkCount,
			outcome,
		};
		state.span?.setAttributes({
			"record.duration_ms": result.durationMs,
			"record.mime_type": state.mimeType,
			"record.codec": codecFromMimeType(state.mimeType),
			"record.video_bits_per_second": state.videoBitsPerSecond,
			"record.size_bytes": state.sizeBytes,
			"record.chunk_count": state.chunkCount,
			"record.outcome": outcome,
		});
		state.span?.end(outcome === "stopped_error" ? "error" : "ok");
		this.emitRecordChunk({
			recordingId: state.recordingId,
			tabId: state.tabId,
			seq: state.chunkCount,
			mimeType: state.mimeType,
			chunkBase64: "",
			final: true,
			summary: result,
		});
		state.resolveCompletion(result);
		void this.telemetry?.flush();
	}
}
