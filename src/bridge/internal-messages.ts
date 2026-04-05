/**
 * Internal message types for communication between background service worker,
 * sidepanel, and offscreen document.
 */

import type { BridgeConnectionState } from "./extension-client.js";
import type { BridgeReplResult, ReplParams } from "./protocol.js";

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

/** chrome.storage.local key for bridge settings mirrored from app storage. */
export const BRIDGE_SETTINGS_KEY = "bridge_settings";

/** chrome.storage.session key for bridge connection state (shared with UI). */
export const BRIDGE_STATE_KEY = "bridge_state";

// ---------------------------------------------------------------------------
// Bridge settings (mirrored to chrome.storage.local)
// ---------------------------------------------------------------------------

export interface BridgeSettings {
	enabled: boolean;
	url: string;
	token: string;
	sensitiveAccessEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Bridge state (stored in chrome.storage.session)
// ---------------------------------------------------------------------------

export interface BridgeStateData {
	state: BridgeConnectionState;
	detail?: string;
}

// ---------------------------------------------------------------------------
// Background <-> Sidepanel messages
// ---------------------------------------------------------------------------

export type BridgeToSidepanelMessage =
	| { type: "bridge-session-command"; method: string; params: Record<string, unknown> }
	| { type: "bridge-repl-execute"; params: ReplParams };

export type SidepanelToBackgroundMessage =
	| { type: "bridge-get-state" }
	| { type: "bridge-settings-changed"; settings: BridgeSettings };

// ---------------------------------------------------------------------------
// Background <-> Offscreen messages
// ---------------------------------------------------------------------------

export type BridgeToOffscreenMessage =
	| { type: "bridge-repl-execute"; params: ReplParams }
	| { type: "bridge-keepalive-ping" };

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
