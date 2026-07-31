import type { RecordOutcome, RecordStopResult } from "@shuvgeist/protocol/protocol";

export type TabCaptureStopReason = "user" | "max-duration" | "target-closed" | "abort" | "error";

export interface TabCaptureStartMessage {
	type: "tab-capture-start";
	windowId: number;
	tabId: number;
	recordingId: string;
	streamId: string;
	startedAt: string;
	navigationGeneration: number;
	audio: boolean;
	maxDurationMs: number;
	mimeType?: string;
	videoBitsPerSecond?: number;
}

export interface TabCaptureStopMessage {
	type: "tab-capture-stop";
	recordingId: string;
	reason: TabCaptureStopReason;
}

export interface TabCaptureStatusMessage {
	type: "tab-capture-status";
	recordingId?: string;
	tabId?: number;
	windowId: number;
}

export type TabCaptureOffscreenMessage = TabCaptureStartMessage | TabCaptureStopMessage | TabCaptureStatusMessage;

export type TabCaptureOffscreenResponse =
	| {
			ok: true;
			active: true;
			windowId: number;
			tabId: number;
			navigationGeneration: number;
			recordingId: string;
			startedAt: string;
			mimeType: string;
			audio: boolean;
			sourceBytes: number;
			chunkCount: number;
	  }
	| { ok: true; active: false }
	| { ok: false; error: string };

export interface TabCaptureChunkMessage {
	type: "tab-capture-chunk";
	windowId: number;
	tabId: number;
	recordingId: string;
	navigationGeneration: number;
	seq: number;
	mimeType: string;
	chunkBase64: string;
}

export interface TabCaptureCompleteMessage {
	type: "tab-capture-complete";
	windowId: number;
	tabId: number;
	recordingId: string;
	navigationGeneration: number;
	seq: number;
	mimeType: string;
	summary: RecordStopResult;
}

export type TabCaptureOffscreenEvent = TabCaptureChunkMessage | TabCaptureCompleteMessage;

export function tabCaptureOutcome(reason: TabCaptureStopReason): RecordOutcome {
	if (reason === "user") return "stopped_user";
	if (reason === "max-duration") return "stopped_max_duration";
	if (reason === "target-closed") return "stopped_target_closed";
	return "stopped_error";
}

export function isTabCaptureOffscreenMessage(value: { type?: string }): value is TabCaptureOffscreenMessage {
	return (
		value.type === "tab-capture-start" || value.type === "tab-capture-stop" || value.type === "tab-capture-status"
	);
}

export function isTabCaptureOffscreenEvent(value: { type?: string }): value is TabCaptureOffscreenEvent {
	return value.type === "tab-capture-chunk" || value.type === "tab-capture-complete";
}
