import type {
	TabCaptureOffscreenEvent,
	TabCaptureOffscreenMessage,
	TabCaptureOffscreenResponse,
	TabCaptureStartMessage,
	TabCaptureStopReason,
} from "./tab-capture-messages.js";
import { tabCaptureOutcome } from "./tab-capture-messages.js";

interface ActiveTabCapture {
	request: TabCaptureStartMessage;
	stream: MediaStream;
	recorder: MediaRecorder;
	audioContext?: AudioContext;
	mimeType: string;
	sourceBytes: number;
	chunkCount: number;
	nextSequence: number;
	stopReason: TabCaptureStopReason;
	lastError?: string;
	maxDurationTimer?: ReturnType<typeof setTimeout>;
	chunkQueue: Promise<void>;
	completing: boolean;
}

const captures = new Map<string, ActiveTabCapture>();

async function sendEvent(event: TabCaptureOffscreenEvent): Promise<boolean> {
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			const response = (await chrome.runtime.sendMessage(event)) as { ok?: boolean } | undefined;
			if (response?.ok === true) return true;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const batchSize = 32_768;
	for (let offset = 0; offset < bytes.length; offset += batchSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + batchSize));
	}
	return btoa(binary);
}

function chooseMimeType(requested?: string): string {
	const candidates = [
		requested,
		"video/webm;codecs=vp9,opus",
		"video/webm;codecs=vp8,opus",
		"video/webm;codecs=vp9",
		"video/webm;codecs=vp8",
		"video/webm",
	].filter((candidate): candidate is string => Boolean(candidate));
	const supported = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
	if (!supported) throw new Error("This Chrome build does not expose a supported WebM MediaRecorder codec.");
	return supported;
}

function stopTracks(capture: ActiveTabCapture): void {
	for (const track of capture.stream.getTracks()) track.stop();
	if (capture.audioContext) void capture.audioContext.close().catch(() => undefined);
}

function requestStop(capture: ActiveTabCapture, reason: TabCaptureStopReason, lastError?: string): void {
	capture.stopReason = reason;
	capture.lastError = lastError;
	if (capture.recorder.state !== "inactive") {
		capture.recorder.stop();
		return;
	}
	stopTracks(capture);
}

async function completeCapture(capture: ActiveTabCapture): Promise<void> {
	if (capture.completing) return;
	capture.completing = true;
	if (capture.maxDurationTimer) clearTimeout(capture.maxDurationTimer);
	await capture.chunkQueue;
	stopTracks(capture);
	captures.delete(capture.request.recordingId);
	const endedAt = new Date().toISOString();
	const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(capture.request.startedAt));
	await sendEvent({
		type: "tab-capture-complete",
		windowId: capture.request.windowId,
		tabId: capture.request.tabId,
		recordingId: capture.request.recordingId,
		navigationGeneration: capture.request.navigationGeneration,
		seq: capture.nextSequence,
		mimeType: capture.mimeType,
		summary: {
			target: { kind: "chrome-tab", tabId: capture.request.tabId, frameId: 0 },
			navigationGeneration: capture.request.navigationGeneration,
			tabId: capture.request.tabId,
			frameId: 0,
			ok: true,
			mode: "tab-capture",
			audio: capture.request.audio,
			artifactState: capture.stopReason === "error" || capture.stopReason === "abort" ? "partial" : "complete",
			recordingId: capture.request.recordingId,
			startedAt: capture.request.startedAt,
			endedAt,
			durationMs,
			mimeType: capture.mimeType,
			sourceBytes: capture.sourceBytes,
			encodedSizeBytes: capture.sourceBytes,
			chunkCount: capture.chunkCount,
			frameCount: 0,
			outcome: tabCaptureOutcome(capture.stopReason),
			lastError: capture.lastError,
		},
	});
}

async function startCapture(message: TabCaptureStartMessage): Promise<TabCaptureOffscreenResponse> {
	if (captures.has(message.recordingId)) {
		return { ok: false, error: `Recording ${message.recordingId} is already active.` };
	}
	const mimeType = chooseMimeType(message.mimeType);
	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			audio: message.audio
				? {
						mandatory: {
							chromeMediaSource: "tab",
							chromeMediaSourceId: message.streamId,
						},
					}
				: false,
			video: {
				mandatory: {
					chromeMediaSource: "tab",
					chromeMediaSourceId: message.streamId,
				},
			},
		} as MediaStreamConstraints);
	} catch (error) {
		throw new Error(
			`Chrome denied the tab media stream. Keep the target tab open, confirm tabCapture permission, and retry from a user-owned tab. ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	const recorder = new MediaRecorder(stream, {
		mimeType,
		...(message.videoBitsPerSecond ? { videoBitsPerSecond: message.videoBitsPerSecond } : {}),
	});
	let audioContext: AudioContext | undefined;
	if (message.audio && stream.getAudioTracks().length > 0) {
		audioContext = new AudioContext();
		audioContext.createMediaStreamSource(stream).connect(audioContext.destination);
	}
	const capture: ActiveTabCapture = {
		request: message,
		stream,
		recorder,
		audioContext,
		mimeType: recorder.mimeType || mimeType,
		sourceBytes: 0,
		chunkCount: 0,
		nextSequence: 0,
		stopReason: "user",
		chunkQueue: Promise.resolve(),
		completing: false,
	};
	capture.maxDurationTimer = setTimeout(() => requestStop(capture, "max-duration"), message.maxDurationMs);
	recorder.addEventListener("dataavailable", (event) => {
		if (event.data.size === 0) return;
		capture.chunkQueue = capture.chunkQueue.then(async () => {
			const chunkBase64 = arrayBufferToBase64(await event.data.arrayBuffer());
			capture.sourceBytes += event.data.size;
			capture.chunkCount += 1;
			const delivered = await sendEvent({
				type: "tab-capture-chunk",
				windowId: message.windowId,
				tabId: message.tabId,
				recordingId: message.recordingId,
				navigationGeneration: message.navigationGeneration,
				seq: capture.nextSequence++,
				mimeType: capture.mimeType,
				chunkBase64,
			});
			if (!delivered) {
				capture.stopReason = "error";
				capture.lastError = "The bridge disconnected before a WebM chunk could be delivered.";
			}
		});
	});
	recorder.addEventListener("stop", () => void completeCapture(capture));
	recorder.addEventListener("error", (event) => {
		requestStop(capture, "error", event.error?.message || "MediaRecorder failed.");
	});
	for (const track of stream.getTracks()) {
		track.addEventListener("ended", () => {
			if (recorder.state !== "inactive") requestStop(capture, "target-closed", "The captured tab stream ended.");
		});
	}
	captures.set(message.recordingId, capture);
	recorder.start(1_000);
	return {
		ok: true,
		active: true,
		windowId: message.windowId,
		tabId: message.tabId,
		navigationGeneration: message.navigationGeneration,
		recordingId: message.recordingId,
		startedAt: message.startedAt,
		mimeType: capture.mimeType,
		audio: message.audio,
		sourceBytes: 0,
		chunkCount: 0,
	};
}

export async function handleOffscreenTabCaptureMessage(
	message: TabCaptureOffscreenMessage,
): Promise<TabCaptureOffscreenResponse> {
	if (message.type === "tab-capture-start") return startCapture(message);
	const capture =
		(message.recordingId ? captures.get(message.recordingId) : undefined) ??
		(message.type === "tab-capture-status"
			? [...captures.values()].find((candidate) =>
					message.tabId !== undefined
						? candidate.request.tabId === message.tabId
						: candidate.request.windowId === message.windowId,
				)
			: undefined);
	if (message.type === "tab-capture-stop") {
		if (!capture) return { ok: false, error: `No active tab-capture recording ${message.recordingId}.` };
		requestStop(capture, message.reason);
	}
	if (!capture) return { ok: true, active: false };
	return {
		ok: true,
		active: true,
		windowId: capture.request.windowId,
		tabId: capture.request.tabId,
		navigationGeneration: capture.request.navigationGeneration,
		recordingId: capture.request.recordingId,
		startedAt: capture.request.startedAt,
		mimeType: capture.mimeType,
		audio: capture.request.audio,
		sourceBytes: capture.sourceBytes,
		chunkCount: capture.chunkCount,
	};
}

export function releaseOffscreenTabCapturesForTests(): void {
	for (const capture of captures.values()) {
		if (capture.maxDurationTimer) clearTimeout(capture.maxDurationTimer);
		if (capture.recorder.state !== "inactive") capture.recorder.stop();
		stopTracks(capture);
	}
	captures.clear();
}
