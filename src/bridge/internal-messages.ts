/**
 * Internal message types for communication between background service worker,
 * sidepanel, and offscreen document.
 */

import type { BridgeConnectionState } from "./extension-client.js";
import type {
	BridgeReplResult,
	BridgeScreenshotResult,
	RecordOutcome,
	ReplParams,
	ScreenshotParams,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

/** chrome.storage.local key for canonical bridge settings owned by the extension runtime. */
export const BRIDGE_SETTINGS_KEY = "bridge_settings";

/** chrome.storage.session key for bridge connection state (shared with UI). */
export const BRIDGE_STATE_KEY = "bridge_state";

/** chrome.storage.session key for bridge OTEL export state (shared with UI). */
export const BRIDGE_OTEL_STATE_KEY = "bridge_otel_state";

// ---------------------------------------------------------------------------
// Bridge settings (canonical chrome.storage.local shape)
// ---------------------------------------------------------------------------

export interface BridgeSettings {
	enabled: boolean;
	url: string;
	token: string;
	sensitiveAccessEnabled: boolean;
	observability: BridgeObservabilitySettings;
}

export interface BridgeObservabilitySettings {
	enabled: boolean;
	ingestUrl: string;
	publicIngestKey: string;
}

// ---------------------------------------------------------------------------
// Bridge state (stored in chrome.storage.session)
// ---------------------------------------------------------------------------

export interface BridgeStateData {
	state: BridgeConnectionState;
	detail?: string;
}

export interface BridgeOtelStateData {
	state: "disabled" | "idle" | "ok" | "error";
	lastExportedAt?: string;
	lastErrorAt?: string;
	lastError?: string;
}

// ---------------------------------------------------------------------------
// Background <-> Sidepanel messages
// ---------------------------------------------------------------------------

export type BridgeToSidepanelMessage =
	| { type: "bridge-session-command"; method: string; params: Record<string, unknown> }
	| { type: "bridge-repl-execute"; params: ReplParams; traceparent?: string; tracestate?: string }
	| { type: "bridge-screenshot"; params: ScreenshotParams };

export type SidepanelToBackgroundMessage = { type: "bridge-get-state" };

// ---------------------------------------------------------------------------
// Background <-> Offscreen messages
// ---------------------------------------------------------------------------

export type BridgeToOffscreenMessage =
	| { type: "bridge-repl-execute"; params: ReplParams; windowId?: number; traceparent?: string; tracestate?: string }
	| { type: "bridge-keepalive-ping" }
	| {
			type: "bridge-record-start";
			recordingId: string;
			streamId: string;
			mimeType?: string;
			videoBitsPerSecond?: number;
			timesliceMs: number;
	  }
	| { type: "bridge-record-stop"; recordingId: string; outcome?: RecordOutcome };

export type BridgeRecordStartResponse =
	| { ok: true; mimeType: string; videoBitsPerSecond?: number }
	| { ok: false; error: string };

export type BridgeRecordStopResponse = { ok: true } | { ok: false; error: string };

export type OffscreenToBackgroundMessage =
	| {
			type: "record-chunk";
			recordingId: string;
			seq: number;
			mimeType: string;
			chunkBase64: string;
			final?: boolean;
	  }
	| { type: "record-error"; recordingId: string; message: string }
	| {
			type: "record-stopped";
			recordingId: string;
			outcome: RecordOutcome;
			sizeBytes: number;
			chunkCount: number;
			endedAt: number;
	  };

// ---------------------------------------------------------------------------
// Offscreen -> Background runtime proxy messages
//
// When the sidepanel is closed, the offscreen document hosts the REPL sandbox
// but has no access to chrome.tabs / chrome.userScripts / chrome.debugger.
// The proxy runtime providers injected into that sandbox relay browserjs(),
// navigate(), and nativeClick()/nativeType()/etc. calls to the background
// service worker via these messages.
// ---------------------------------------------------------------------------

export type BgRuntimeType = "browser-js" | "navigate" | "native-input";

export interface BgRuntimeExecMessage {
	type: "bg-runtime-exec";
	runtimeType: BgRuntimeType;
	payload: Record<string, unknown>;
	windowId?: number;
	traceparent?: string;
	tracestate?: string;
	/** Sandbox id from the offscreen REPL; used to route user-script messages
	 *  (e.g. nested nativeClick calls from skill code) back through the same
	 *  execution context while background.userScripts.execute() is pending. */
	sandboxId?: string;
}

export interface BgRuntimeExecResponse {
	success: boolean;
	result?: unknown;
	error?: string;
	stack?: string;
	console?: Array<{ type: string; text: string }>;
	cancelled?: boolean;
}

// ---------------------------------------------------------------------------
// Shared response types
// ---------------------------------------------------------------------------

export interface BridgeReplResponse {
	ok: true;
	result: BridgeReplResult;
}

export interface BridgeReplErrorResponse {
	ok: false;
	error: string;
}

export type BridgeReplMessageResponse = BridgeReplResponse | BridgeReplErrorResponse;

export interface BridgeScreenshotResponse {
	ok: true;
	result: BridgeScreenshotResult;
}

export interface BridgeScreenshotErrorResponse {
	ok: false;
	error: string;
}

export type BridgeScreenshotMessageResponse = BridgeScreenshotResponse | BridgeScreenshotErrorResponse;

export interface BridgeSessionCommandResponse {
	ok: true;
	result: unknown;
}

export interface BridgeSessionCommandErrorResponse {
	ok: false;
	error: string;
	code?: number;
}

export type BridgeSessionCommandMessageResponse = BridgeSessionCommandResponse | BridgeSessionCommandErrorResponse;
