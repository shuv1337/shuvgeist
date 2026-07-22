import type { CdpSession } from "./cdp-session.js";
import type { PageDriverScope } from "./page-driver-identity.js";

const DEFAULT_MAX_DURATION_MS = 30_000;
const DEFAULT_FPS = 12;
const DEFAULT_QUALITY = 70;
const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const HARD_MAX_DURATION_MS = 120_000;
const MAX_FPS = 30;
const MAX_DIMENSION = 16_384;

export interface PageScreencastStartOptions {
	maxDurationMs?: number;
	videoBitsPerSecond?: number;
	mimeType?: string;
	fps?: number;
	quality?: number;
	maxWidth?: number;
	maxHeight?: number;
	everyNthFrame?: number;
	signal?: AbortSignal;
}

export interface PageScreencastStartResult {
	scope: PageDriverScope;
	ok: true;
	recordingId: string;
	startedAt: string;
	mimeType: string;
	videoBitsPerSecond?: number;
	maxDurationMs: number;
}

export type PageScreencastStopReason = "user" | "max-duration" | "max-bytes" | "target-closed" | "abort" | "error";

export interface PageScreencastSummary {
	scope: PageDriverScope;
	ok: true;
	recordingId: string;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	mimeType: string;
	/** Sum of decoded JPEG/PNG frame bytes received from CDP. */
	sourceBytes: number;
	frameCount: number;
	reason: PageScreencastStopReason;
	lastError?: string;
}

export type PageScreencastStatus =
	| { scope: PageDriverScope; active: false }
	| {
			scope: PageDriverScope;
			active: true;
			recordingId: string;
			startedAt: string;
			mimeType: string;
			durationMs: number;
			sourceBytes: number;
			frameCount: number;
			fps: number;
			lastError?: string;
	  };

export interface PageScreencastFrameMetadata {
	timestamp?: number;
	deviceWidth?: number;
	deviceHeight?: number;
	pageScaleFactor?: number;
	offsetTop?: number;
	scrollOffsetX?: number;
	scrollOffsetY?: number;
}

export interface PageScreencastFrame {
	scope: PageDriverScope;
	recordingId: string;
	seq: number;
	format: "jpeg" | "png";
	dataBase64: string;
	capturedAtMs: number;
	metadata?: PageScreencastFrameMetadata;
}

export interface PageScreencastHandlers {
	onFrame: (frame: PageScreencastFrame) => void;
	onComplete: (summary: PageScreencastSummary) => void;
}

export interface PageScreencastEngine {
	start(options: PageScreencastStartOptions, handlers: PageScreencastHandlers): Promise<PageScreencastStartResult>;
	stop(recordingId?: string, reason?: PageScreencastStopReason): Promise<PageScreencastSummary>;
	status(recordingId?: string): PageScreencastStatus;
	dispose(): Promise<void>;
}

export interface CreatePageScreencastEngineOptions {
	cdp: CdpSession;
	getScope: () => PageDriverScope;
	maxSourceBytes?: number;
	captureSeedFrame?: boolean;
}

type RecordingPhase = "starting" | "active" | "stopping" | "complete";

interface ScreencastFramePayload {
	data?: unknown;
	sessionId?: unknown;
	metadata?: unknown;
}

interface RecordingState {
	recordingId: string;
	owner: string;
	phase: RecordingPhase;
	startedAtMs: number;
	startedAt: string;
	mimeType: string;
	videoBitsPerSecond?: number;
	maxDurationMs: number;
	fps: number;
	quality: number;
	maxWidth: number;
	maxHeight?: number;
	everyNthFrame: number;
	sourceBytes: number;
	frameCount: number;
	lastError?: string;
	acquired: boolean;
	screencastStarted: boolean;
	transportClosed: boolean;
	requestedReason?: PageScreencastStopReason;
	handlers: PageScreencastHandlers;
	removeFrameListener?: () => void;
	removeCloseListener?: () => void;
	removeAbortListener?: () => void;
	maxDurationTimer?: ReturnType<typeof setTimeout>;
	seedFrameTimer?: ReturnType<typeof setTimeout>;
	completion: Promise<PageScreencastSummary>;
	resolveCompletion: (summary: PageScreencastSummary) => void;
	stopPromise?: Promise<PageScreencastSummary>;
}

let nextEngineId = 1;
let nextRecordingId = 1;

export function createPageScreencastEngine(options: CreatePageScreencastEngineOptions): PageScreencastEngine {
	return new CdpPageScreencastEngine(options);
}

class CdpPageScreencastEngine implements PageScreencastEngine {
	private readonly cdp: CdpSession;
	private readonly getScope: () => PageDriverScope;
	private readonly ownerPrefix: string;
	private readonly maxSourceBytes: number;
	private readonly captureSeedFrame: boolean;
	private current?: RecordingState;
	private disposed = false;
	private transportClosed = false;

	constructor(options: CreatePageScreencastEngineOptions) {
		this.cdp = options.cdp;
		this.getScope = options.getScope;
		this.ownerPrefix = `page-screencast:${nextEngineId++}`;
		this.maxSourceBytes = normalizePositiveInteger(
			options.maxSourceBytes,
			DEFAULT_MAX_SOURCE_BYTES,
			"maxSourceBytes",
		);
		this.captureSeedFrame = options.captureSeedFrame !== false;
	}

	async start(
		options: PageScreencastStartOptions,
		handlers: PageScreencastHandlers,
	): Promise<PageScreencastStartResult> {
		if (this.disposed) throw new Error("Page screencast engine is disposed");
		if (this.transportClosed) throw new Error("Page CDP session is closed");
		if (this.current && this.current.phase !== "complete") {
			throw new Error("A screencast is already active for this page");
		}

		const state = createRecordingState(this.ownerPrefix, options, handlers);
		this.current = state;
		try {
			this.installListeners(state, options.signal);
			this.assertStartupCanContinue(state, options.signal);
			await this.cdp.acquire(state.owner);
			state.acquired = true;
			this.assertStartupCanContinue(state, options.signal);
			await this.cdp.ensureDomain("Page");
			this.assertStartupCanContinue(state, options.signal);
			await this.cdp.send("Page.startScreencast", startScreencastParams(state));
			state.screencastStarted = true;
			this.assertStartupCanContinue(state, options.signal);
			state.phase = "active";
			state.maxDurationTimer = setTimeout(() => {
				void this.requestStop(state, "max-duration");
			}, state.maxDurationMs);
			if (this.captureSeedFrame) {
				state.seedFrameTimer = setTimeout(() => {
					void this.captureSeedFrameIfNeeded(state);
				}, 0);
			}
			return {
				scope: this.getScope(),
				ok: true,
				recordingId: state.recordingId,
				startedAt: state.startedAt,
				mimeType: state.mimeType,
				videoBitsPerSecond: state.videoBitsPerSecond,
				maxDurationMs: state.maxDurationMs,
			};
		} catch (error) {
			const reason = state.transportClosed
				? "target-closed"
				: options.signal?.aborted
					? "abort"
					: (state.requestedReason ?? "error");
			await this.requestStop(state, reason, error, true);
			throw error;
		}
	}

	async stop(recordingId?: string, reason: PageScreencastStopReason = "user"): Promise<PageScreencastSummary> {
		const state = this.requireRecording(recordingId);
		return this.requestStop(state, reason);
	}

	status(recordingId?: string): PageScreencastStatus {
		const state = this.current;
		if (!state || state.phase === "complete") return { scope: this.getScope(), active: false };
		if (recordingId && recordingId !== state.recordingId) return { scope: this.getScope(), active: false };
		return {
			scope: this.getScope(),
			active: true,
			recordingId: state.recordingId,
			startedAt: state.startedAt,
			mimeType: state.mimeType,
			durationMs: Math.max(0, Date.now() - state.startedAtMs),
			sourceBytes: state.sourceBytes,
			frameCount: state.frameCount,
			fps: state.fps,
			lastError: state.lastError,
		};
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const state = this.current;
		if (state && state.phase !== "complete") await this.requestStop(state, "abort");
	}

	private installListeners(state: RecordingState, signal?: AbortSignal): void {
		state.removeFrameListener = this.cdp.onEvent("Page.screencastFrame", (payload) => {
			void this.handleFrame(state, payload);
		});
		state.removeCloseListener = this.cdp.onClose((reason) => {
			state.transportClosed = true;
			this.transportClosed = true;
			if (reason !== undefined) state.lastError = `CDP session closed: ${String(reason)}`;
			if (state.phase === "starting") {
				state.requestedReason = "target-closed";
				return;
			}
			void this.requestStop(state, "target-closed", reason);
		});
		if (signal) {
			const onAbort = (): void => {
				state.requestedReason = "abort";
				if (state.phase !== "starting") void this.requestStop(state, "abort", signal.reason);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			state.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		}
	}

	private assertStartupCanContinue(state: RecordingState, signal?: AbortSignal): void {
		if (state.transportClosed || this.transportClosed)
			throw new Error("Page CDP session closed during screencast start");
		if (signal?.aborted || state.requestedReason === "abort") throw new Error("Page screencast start aborted");
		if (this.disposed) throw new Error("Page screencast engine was disposed during start");
		if (state.requestedReason) throw new Error(`Page screencast start stopped: ${state.requestedReason}`);
		if (this.current !== state || state.phase !== "starting") throw new Error("Page screencast start was superseded");
	}

	private async handleFrame(state: RecordingState, payload: Record<string, unknown>): Promise<void> {
		if (!this.acceptsFrames(state)) return;
		const frame = payload as ScreencastFramePayload;
		if (typeof frame.sessionId === "number") {
			try {
				await this.cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
			} catch (error) {
				await this.requestStop(state, "error", error);
				return;
			}
		}
		if (!this.acceptsFrames(state) || typeof frame.data !== "string" || !frame.data) return;
		try {
			this.emitFrame(state, frame.data, Date.now(), normalizeMetadata(frame.metadata));
		} catch (error) {
			await this.requestStop(state, "error", error);
			return;
		}
		if (state.sourceBytes >= this.maxSourceBytes) await this.requestStop(state, "max-bytes");
	}

	private emitFrame(
		state: RecordingState,
		dataBase64: string,
		capturedAtMs: number,
		metadata?: PageScreencastFrameMetadata,
	): void {
		if (!this.acceptsFrames(state)) return;
		const seq = state.frameCount;
		state.frameCount += 1;
		state.sourceBytes += base64DecodedByteLength(dataBase64);
		state.handlers.onFrame({
			scope: this.getScope(),
			recordingId: state.recordingId,
			seq,
			format: "jpeg",
			dataBase64,
			capturedAtMs,
			metadata,
		});
	}

	private async captureSeedFrameIfNeeded(state: RecordingState): Promise<void> {
		if (!this.acceptsFrames(state) || state.phase !== "active" || state.frameCount > 0) return;
		try {
			const result = await this.cdp.send<{ data?: string }>("Page.captureScreenshot", {
				format: "jpeg",
				quality: state.quality,
				captureBeyondViewport: false,
			});
			if (!this.acceptsFrames(state) || state.frameCount > 0 || !result.data) return;
			this.emitFrame(state, result.data, Date.now());
			if (state.sourceBytes >= this.maxSourceBytes) await this.requestStop(state, "max-bytes");
		} catch (error) {
			if (this.acceptsFrames(state)) {
				state.lastError = errorMessage(error);
			}
		}
	}

	private requestStop(
		state: RecordingState,
		reason: PageScreencastStopReason,
		error?: unknown,
		finishStarting = false,
	): Promise<PageScreencastSummary> {
		if (error !== undefined) state.lastError = errorMessage(error);
		if (state.phase === "complete") return state.completion;
		if (state.stopPromise) return state.completion;
		state.requestedReason ??= reason;
		if (state.phase === "starting" && !finishStarting) return state.completion;
		state.phase = "stopping";
		this.clearStateResources(state);
		state.stopPromise = this.finishState(state, state.requestedReason);
		return state.completion;
	}

	private async finishState(state: RecordingState, reason: PageScreencastStopReason): Promise<PageScreencastSummary> {
		if (state.screencastStarted && !state.transportClosed) {
			try {
				await this.cdp.send("Page.stopScreencast");
			} catch (error) {
				state.lastError ??= errorMessage(error);
			}
			state.screencastStarted = false;
		}
		if (state.acquired && !state.transportClosed) {
			state.acquired = false;
			try {
				await this.cdp.release(state.owner);
			} catch (error) {
				state.lastError ??= errorMessage(error);
			}
		}
		const endedAtMs = Date.now();
		const summary: PageScreencastSummary = {
			scope: this.getScope(),
			ok: true,
			recordingId: state.recordingId,
			startedAt: state.startedAt,
			endedAt: new Date(endedAtMs).toISOString(),
			durationMs: Math.max(0, endedAtMs - state.startedAtMs),
			mimeType: state.mimeType,
			sourceBytes: state.sourceBytes,
			frameCount: state.frameCount,
			reason,
			lastError: state.lastError,
		};
		state.phase = "complete";
		if (this.current === state) this.current = undefined;
		try {
			state.handlers.onComplete(summary);
		} catch {
			// Completion must settle even when its consumer has disconnected.
		}
		state.resolveCompletion(summary);
		return summary;
	}

	private clearStateResources(state: RecordingState): void {
		if (state.maxDurationTimer) clearTimeout(state.maxDurationTimer);
		if (state.seedFrameTimer) clearTimeout(state.seedFrameTimer);
		state.maxDurationTimer = undefined;
		state.seedFrameTimer = undefined;
		for (const remove of [state.removeFrameListener, state.removeCloseListener, state.removeAbortListener]) {
			try {
				remove?.();
			} catch {
				// Cleanup must continue through every subscription.
			}
		}
		state.removeFrameListener = undefined;
		state.removeCloseListener = undefined;
		state.removeAbortListener = undefined;
	}

	private acceptsFrames(state: RecordingState): boolean {
		return this.current === state && (state.phase === "starting" || state.phase === "active");
	}

	private requireRecording(recordingId?: string): RecordingState {
		const state = this.current;
		if (!state || state.phase === "complete") throw new Error("No page screencast is active");
		if (recordingId && recordingId !== state.recordingId) {
			throw new Error(`Page screencast ${recordingId} is not active for this page`);
		}
		return state;
	}
}

function createRecordingState(
	ownerPrefix: string,
	options: PageScreencastStartOptions,
	handlers: PageScreencastHandlers,
): RecordingState {
	const recordingId = `recording-${Date.now()}-${nextRecordingId++}`;
	const startedAtMs = Date.now();
	let resolveCompletion!: (summary: PageScreencastSummary) => void;
	const completion = new Promise<PageScreencastSummary>((resolve) => {
		resolveCompletion = resolve;
	});
	return {
		recordingId,
		owner: `${ownerPrefix}:${recordingId}`,
		phase: "starting",
		startedAtMs,
		startedAt: new Date(startedAtMs).toISOString(),
		mimeType: options.mimeType ?? "video/webm",
		videoBitsPerSecond: normalizeOptionalPositiveInteger(options.videoBitsPerSecond, "videoBitsPerSecond"),
		maxDurationMs: normalizeBoundedInteger(
			options.maxDurationMs,
			DEFAULT_MAX_DURATION_MS,
			1,
			HARD_MAX_DURATION_MS,
			"maxDurationMs",
		),
		fps: normalizeBoundedInteger(options.fps, DEFAULT_FPS, 1, MAX_FPS, "fps"),
		quality: normalizeBoundedInteger(options.quality, DEFAULT_QUALITY, 0, 100, "quality"),
		maxWidth: normalizeBoundedInteger(options.maxWidth, DEFAULT_MAX_WIDTH, 1, MAX_DIMENSION, "maxWidth"),
		maxHeight: normalizeOptionalBoundedInteger(options.maxHeight, 1, MAX_DIMENSION, "maxHeight"),
		everyNthFrame: normalizePositiveInteger(options.everyNthFrame, 1, "everyNthFrame"),
		sourceBytes: 0,
		frameCount: 0,
		acquired: false,
		screencastStarted: false,
		transportClosed: false,
		handlers,
		completion,
		resolveCompletion,
	};
}

function startScreencastParams(state: RecordingState): Record<string, unknown> {
	return {
		format: "jpeg",
		quality: state.quality,
		maxWidth: state.maxWidth,
		...(state.maxHeight ? { maxHeight: state.maxHeight } : {}),
		everyNthFrame: state.everyNthFrame,
	};
}

function normalizeMetadata(value: unknown): PageScreencastFrameMetadata | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const metadata: PageScreencastFrameMetadata = {};
	for (const key of [
		"timestamp",
		"deviceWidth",
		"deviceHeight",
		"pageScaleFactor",
		"offsetTop",
		"scrollOffsetX",
		"scrollOffsetY",
	] as const) {
		if (typeof record[key] === "number") metadata[key] = record[key];
	}
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function base64DecodedByteLength(value: string): number {
	if (!value) return 0;
	const normalized = value.replace(/\s/gu, "");
	const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function normalizePositiveInteger(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
	return value;
}

function normalizeOptionalPositiveInteger(value: number | undefined, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
	return value;
}

function normalizeOptionalBoundedInteger(
	value: number | undefined,
	minimum: number,
	maximum: number,
	name: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be a safe integer between ${minimum} and ${maximum}`);
	}
	return value;
}

function normalizeBoundedInteger(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	name: string,
): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be a safe integer between ${minimum} and ${maximum}`);
	}
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
