/**
 * Internal message types for communication between background service worker,
 * sidepanel, and offscreen document.
 */

import type { OffscreenRuntimeHostState } from "../agent/offscreen-runtime-host.js";
import type {
	RuntimeAgentMessage,
	RuntimeModelDescriptor,
	RuntimeRecord,
	RuntimeRequestEnvelope,
	RuntimeResponseEnvelope,
	RuntimeStreamEnvelope,
	RuntimeTargetIdentity,
	RuntimeThinkingLevel,
	RuntimeTraceContext,
	RuntimeValue,
} from "../agent/runtime-protocol.js";
import type { BridgeConnectionState } from "./extension-client.js";

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

/** chrome.storage.local key for canonical bridge settings owned by the extension runtime. */
export const BRIDGE_SETTINGS_KEY = "bridge_settings";

/** chrome.storage.session key for bridge connection state (shared with UI). */
export const BRIDGE_STATE_KEY = "bridge_state";

/** chrome.storage.session key for bridge OTEL export state (shared with UI). */
export const BRIDGE_OTEL_STATE_KEY = "bridge_otel_state";

/** chrome.storage.session key for bridge-observed Electron target state. */
export const BRIDGE_ELECTRON_STATE_KEY = "bridge_electron_state";

/** chrome.storage.session checkpoint for the offscreen-owned agent runtime. */
export const AGENT_RUNTIME_STATE_KEY = "agent_runtime_state";

/** chrome.storage.session registry of offscreen sessions bound to browser windows. */
export const AGENT_RUNTIME_CONNECTIONS_KEY = "agent_runtime_connections";

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

export interface BridgeElectronStateData {
	sessions: Array<{
		id: string;
		appId?: string;
		appRef?: string;
		pid?: number;
		port: number;
		browser?: string;
		launched: boolean;
		startedAt: string;
		windows: Array<{
			ref: string;
			label?: string;
			type: string;
			title?: string;
			url?: string;
			isPrimary: boolean;
			closed?: boolean;
		}>;
	}>;
	updatedAt: string;
}

export type AgentRuntimeConnectionRegistry = Record<string, AgentRuntimeConnectionDescriptor>;

// ---------------------------------------------------------------------------
// Background <-> Offscreen messages
// ---------------------------------------------------------------------------

export type BridgeToOffscreenMessage =
	| { type: "bridge-keepalive-ping" }
	| { type: "agent-runtime-init"; state?: OffscreenRuntimeHostState }
	| { type: "agent-runtime-connect"; descriptor: AgentRuntimeConnectionDescriptor }
	| { type: "agent-runtime-request"; request: RuntimeRequestEnvelope }
	| { type: "agent-runtime-abort-intent"; intent: AgentRuntimeAbortIntent };

export interface AgentRuntimeConnectionDescriptor {
	clientId: string;
	windowId: number;
	sessionId: string;
	target: RuntimeTargetIdentity;
	mode: "create" | "load";
	systemPrompt: string;
	model?: RuntimeModelDescriptor;
	thinkingLevel?: RuntimeThinkingLevel;
	initialMessages?: RuntimeAgentMessage[];
}

export type AgentRuntimePortRequest =
	| { type: "agent-runtime-port-connect"; descriptor: AgentRuntimeConnectionDescriptor }
	| { type: "agent-runtime-port-request"; request: RuntimeRequestEnvelope };

export type AgentRuntimePortResponse =
	| { type: "agent-runtime-port-connected"; ok: true }
	| { type: "agent-runtime-port-connected"; ok: false; error: string }
	| { type: "agent-runtime-port-response"; response: RuntimeResponseEnvelope }
	| { type: "agent-runtime-port-error"; requestId: string; error: string }
	| { type: "agent-runtime-port-stream"; envelope: RuntimeStreamEnvelope };

export interface AgentRuntimeHostStreamMessage {
	type: "agent-runtime-host-stream";
	envelope: RuntimeStreamEnvelope;
}

export interface AgentRuntimeCheckpointMessage {
	type: "agent-runtime-checkpoint";
	state: OffscreenRuntimeHostState;
}

/** Offscreen documents expose chrome.runtime but not chrome.storage. */
export interface AgentRuntimeDeveloperSettingsRequest {
	type: "agent-runtime-get-developer-settings";
}

export type AgentRuntimeDeveloperSettingsResponse = { ok: true; debuggerMode: boolean } | { ok: false; error: string };

export interface AgentRuntimePageOperationMessage {
	type: "agent-runtime-page-operation";
	operationId: string;
	runtimeEpoch: string;
	clientId: string;
	windowId: number;
	sessionId: string;
	target: RuntimeTargetIdentity;
	operation:
		| "browser-js"
		| "navigate"
		| "native-input"
		| "navigation-context"
		| "page-snapshot"
		| "select-element"
		| "screenshot"
		| "extract-image-source"
		| "debugger"
		| "repl-overlay-show"
		| "repl-overlay-remove";
	payload: RuntimeRecord;
	trace?: RuntimeTraceContext;
	executionId: string;
	executionRequestId: string;
}

export type AgentRuntimePageOperationResponse = { ok: true; result: RuntimeValue } | { ok: false; error: string };

export interface AgentRuntimePageCancelMessage {
	type: "agent-runtime-page-cancel";
	operationId: string;
	runtimeEpoch: string;
	clientId: string;
	windowId: number;
	sessionId: string;
	target: RuntimeTargetIdentity;
	executionId: string;
	executionRequestId: string;
}

export interface AgentRuntimeAbortIntent {
	clientId: string;
	windowId: number;
	sessionId: string;
	target: RuntimeTargetIdentity;
	executionId: string;
	targetRequestId: string;
	reason: string;
}

export type BackgroundPageRuntimeType = "browser-js" | "navigate" | "native-input";

export interface BackgroundPageRuntimeResponse {
	success: boolean;
	result?: unknown;
	error?: string;
	stack?: string;
	console?: Array<{ type: string; text: string }>;
	artifactMutations?: Array<
		{ action: "put"; filename: string; content: string; mimeType?: string } | { action: "delete"; filename: string }
	>;
	cancelled?: boolean;
}
