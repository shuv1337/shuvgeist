/**
 * Bridge protocol types shared between server, CLI, and extension client.
 *
 * JSON-RPC-inspired messages over WebSocket. The bridge server is the
 * rendezvous point — extension and CLI never connect directly.
 */

// ---------------------------------------------------------------------------
// Protocol versioning
// ---------------------------------------------------------------------------

import {
	CatalogBridgeMethods,
	CatalogExtensionBridgeCapabilities,
	isCatalogServerLocalMethod,
	isCatalogTargetDispatchedMethod,
	isCatalogWriteMethod,
	isSensitiveBridgeCapability,
} from "./command-catalog.js";
import type {
	BridgeCommandParams,
	BridgeCommandParamsMap,
	BridgeCommandResult,
	BridgeCommandResultMap,
	NavigateCloseTabFilter as SchemaNavigateCloseTabFilter,
	ResolvedPageTarget as SchemaResolvedPageTarget,
	TargetedBridgeParams as SchemaTargetedBridgeParams,
} from "./command-schemas.js";

export {
	formatBridgeCommandValidationErrors,
	isBridgeSchemaMethod,
	validateBridgeCommandParams,
	validateBridgeCommandResult,
} from "./command-schemas.js";

import type { BridgeTarget } from "./target.js";

export const BRIDGE_PROTOCOL_VERSION = 4;
export const BRIDGE_PROTOCOL_MIN_VERSION = 4;

export function isBridgeProtocolCompatible(protocolVersion?: number, minProtocolVersion?: number): boolean {
	return (
		typeof protocolVersion === "number" &&
		typeof minProtocolVersion === "number" &&
		protocolVersion >= BRIDGE_PROTOCOL_MIN_VERSION &&
		minProtocolVersion <= BRIDGE_PROTOCOL_VERSION
	);
}

export function formatBridgeProtocolMismatch(
	peer: string,
	protocolVersion?: number,
	minProtocolVersion?: number,
): string {
	const version = typeof protocolVersion === "number" ? String(protocolVersion) : "missing";
	const range =
		typeof minProtocolVersion === "number" ? `${minProtocolVersion}-${protocolVersion ?? "unknown"}` : "missing";
	return `Bridge protocol mismatch: ${peer} supports ${range}, server supports ${BRIDGE_PROTOCOL_MIN_VERSION}-${BRIDGE_PROTOCOL_VERSION}. Rebuild or restart shuvgeist.`;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Capabilities a Chrome extension target can actually execute. */
export const BridgeCapabilities = CatalogExtensionBridgeCapabilities;
export type BridgeCapability = (typeof BridgeCapabilities)[number];

export function getBridgeCapabilities(sensitiveAccessEnabled: boolean): BridgeCapability[] {
	return BridgeCapabilities.filter((capability) => sensitiveAccessEnabled || !isSensitiveBridgeCapability(capability));
}

export function isWriteMethod(method: BridgeMethod): boolean {
	return isCatalogWriteMethod(method);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface ExtensionRegistration {
	type: "register";
	role: "extension";
	token: string;
	protocolVersion: number;
	minProtocolVersion: number;
	appVersion: string;
	windowId: number;
	sessionId?: string;
	capabilities: BridgeCapability[];
}

export interface CliRegistration {
	type: "register";
	role: "cli";
	token: string;
	protocolVersion: number;
	minProtocolVersion: number;
	appVersion: string;
	name?: string;
}

export type RegistrationMessage = ExtensionRegistration | CliRegistration;

export interface RegisterResult {
	type: "register_result";
	ok: boolean;
	error?: string;
}

// ---------------------------------------------------------------------------
// Requests / Responses
// ---------------------------------------------------------------------------

export const BridgeMethods = CatalogBridgeMethods;
export type BridgeMethod = (typeof BridgeMethods)[number];
export type BridgeParamsByMethod = BridgeCommandParamsMap;
export type BridgeResultsByMethod = BridgeCommandResultMap;

export interface BridgeRequest {
	id: number;
	method: BridgeMethod;
	params?: Record<string, unknown>;
	target?: BridgeTarget;
	traceparent?: string;
	tracestate?: string;
}

/** A method-correlated request for typed producers and adapter registries. */
export type TypedBridgeRequest<M extends BridgeMethod> = Omit<BridgeRequest, "method" | "params"> & {
	method: M;
} & (Record<string, never> extends BridgeCommandParams<M>
		? { params?: BridgeCommandParams<M> }
		: { params: BridgeCommandParams<M> });

export function isServerLocalMethod(method: BridgeMethod): boolean {
	return isCatalogServerLocalMethod(method);
}

export function isTargetDispatchedMethod(
	method: BridgeMethod,
	targetKind: BridgeTarget["kind"] = "chrome-tab",
): boolean {
	return isCatalogTargetDispatchedMethod(method, targetKind);
}

export function isExtensionRelayedMethod(method: BridgeMethod): boolean {
	return !isServerLocalMethod(method);
}

export interface BridgeError {
	code: number;
	message: string;
}

export interface BridgeResponse {
	id: number;
	result?: unknown;
	error?: BridgeError;
}

/** A method-correlated response for typed producers and adapter registries. */
export type TypedBridgeResponse<M extends BridgeMethod> = Omit<BridgeResponse, "result"> & {
	result?: BridgeCommandResult<M>;
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type BridgeEventType =
	| "extension_connected"
	| "extension_disconnected"
	| "capabilities_update"
	| "active_tab_changed"
	| "session_changed"
	| "session_message"
	| "session_tool"
	| "session_run_state"
	| "record_frame"
	| "record_chunk";

export interface BridgeEvent {
	type: "event";
	event: BridgeEventType;
	data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Abort (server → extension when CLI disconnects mid-request)
// ---------------------------------------------------------------------------

export interface AbortMessage {
	type: "abort";
	id: number;
}

// ---------------------------------------------------------------------------
// Union of all wire messages
// ---------------------------------------------------------------------------

export type BridgeMessage =
	| RegistrationMessage
	| RegisterResult
	| BridgeRequest
	| BridgeResponse
	| BridgeEvent
	| AbortMessage;

// ---------------------------------------------------------------------------
// Schema-derived command parameter and result types
// ---------------------------------------------------------------------------

export type NavigateCloseTabFilter = SchemaNavigateCloseTabFilter;
export type TargetedBridgeParams = SchemaTargetedBridgeParams;
export type ResolvedPageTarget = SchemaResolvedPageTarget;

export type NavigateParams = BridgeCommandParams<"navigate">;
export type ReplParams = BridgeCommandParams<"repl">;
export type ScreenshotParams = BridgeCommandParams<"screenshot">;
export type EvalParams = BridgeCommandParams<"eval">;
export type CookiesParams = BridgeCommandParams<"cookies">;
export type CookieImportParams = BridgeCommandParams<"cookie_import">;
export type CookieImportApplyParams = BridgeCommandParams<"cookie_import_apply">;
export type SelectElementParams = BridgeCommandParams<"select_element">;
export type WorkflowRunParams = BridgeCommandParams<"workflow_run">;
export type WorkflowValidateParams = BridgeCommandParams<"workflow_validate">;
export type PageSnapshotBridgeParams = BridgeCommandParams<"page_snapshot">;
export type SnapshotStoreParams = BridgeCommandParams<"snapshot_store">;
export type SnapshotReadParams = BridgeCommandParams<"snapshot_read">;
export type PageAssertParams = BridgeCommandParams<"page_assert">;
export type PageAssertKind = PageAssertParams["kind"];
export type PageAssertWorld = NonNullable<PageAssertParams["world"]>;
export type LocateByRoleParams = BridgeCommandParams<"locate_by_role">;
export type LocateByTextParams = BridgeCommandParams<"locate_by_text">;
export type LocateByLabelParams = BridgeCommandParams<"locate_by_label">;
export type RefClickParams = BridgeCommandParams<"ref_click">;
export type RefFillParams = BridgeCommandParams<"ref_fill">;
export type FrameListParams = BridgeCommandParams<"frame_list">;
export type NetworkStartParams = BridgeCommandParams<"network_start">;
export type NetworkListParams = BridgeCommandParams<"network_list">;
export type NetworkItemParams = BridgeCommandParams<"network_get">;
export type NetworkCurlParams = BridgeCommandParams<"network_curl">;
export type DeviceEmulateParams = BridgeCommandParams<"device_emulate">;
export type DeviceResetParams = BridgeCommandParams<"device_reset">;
export type PerfMetricsParams = BridgeCommandParams<"perf_metrics">;
export type PerfTraceStartParams = BridgeCommandParams<"perf_trace_start">;
export type PerfTraceStopParams = BridgeCommandParams<"perf_trace_stop">;
export type RecordStartParams = BridgeCommandParams<"record_start">;
export type RecordStopParams = BridgeCommandParams<"record_stop">;
export type RecordStatusParams = BridgeCommandParams<"record_status">;
export type SessionHistoryParams = BridgeCommandParams<"session_history">;
export type SessionInjectParams = BridgeCommandParams<"session_inject">;
export type SessionNewParams = BridgeCommandParams<"session_new">;
export type SessionSetModelParams = BridgeCommandParams<"session_set_model">;

export type BridgeStatusResult = BridgeCommandResult<"status">;
export type BridgeScreenshotResult = BridgeCommandResult<"screenshot">;
export type BridgeReplResult = BridgeCommandResult<"repl">;
export type BridgeReplFile = BridgeReplResult["files"][number];
export type CookieImportResult = BridgeCommandResult<"cookie_import">;
export type WorkflowRunResultWire = BridgeCommandResult<"workflow_run">;
export type WorkflowValidateResult = BridgeCommandResult<"workflow_validate">;
export type PageAssertResult = BridgeCommandResult<"page_assert">;
export type PageSnapshotBridgeResult = BridgeCommandResult<"page_snapshot">;
export type BridgeSnapshotEntry = PageSnapshotBridgeResult["entries"][number];
export type SnapshotStoreResult = BridgeCommandResult<"snapshot_store">;
export type PageSnapshotRecordSummary = SnapshotStoreResult["record"];
export type SnapshotReadResult = BridgeCommandResult<"snapshot_read">;
export type SnapshotLocatorMatchResult = BridgeCommandResult<"locate_by_role">[number];
export type FrameDescriptorResult = BridgeCommandResult<"frame_list">[number];
export type FrameTreeResult = BridgeCommandResult<"frame_tree">;
export type FrameTreeNodeResult = FrameTreeResult["roots"][number];
export type RefActionResult = BridgeCommandResult<"ref_click">;
export type NetworkCaptureListResult = BridgeCommandResult<"network_list">;
export type NetworkCaptureGetResult = BridgeCommandResult<"network_get">;
export type NetworkCaptureRequestSummary = NetworkCaptureGetResult["request"];
export type NetworkCaptureBodyResult = BridgeCommandResult<"network_body">;
export type NetworkCaptureCurlResult = BridgeCommandResult<"network_curl">;
export type NetworkCaptureStats = BridgeCommandResult<"network_stats">;
export type DeviceEmulationResult = BridgeCommandResult<"device_emulate">;
export type PerfMetricsResult = BridgeCommandResult<"perf_metrics">;
export type PerfTraceResult = BridgeCommandResult<"perf_trace_stop">;
export type RecordOutcome = BridgeCommandResult<"record_stop">["outcome"];
export type RecordStartResult = BridgeCommandResult<"record_start">;
export type RecordStopResult = BridgeCommandResult<"record_stop">;
export type RecordStatusResult = BridgeCommandResult<"record_status">;
export type SessionHistoryResult = BridgeCommandResult<"session_history">;
export type SessionInjectResult = BridgeCommandResult<"session_inject">;
export type SessionNewResult = BridgeCommandResult<"session_new">;
export type SessionSetModelResult = BridgeCommandResult<"session_set_model">;
export type SessionArtifact = BridgeCommandResult<"session_artifacts">["artifacts"][number];
export type SessionArtifactsResult = BridgeCommandResult<"session_artifacts">;
export type SessionWireAttachment = SessionHistoryResult["messages"][number]["attachments"] extends
	| Array<infer Attachment>
	| undefined
	? Attachment
	: never;
export type SessionWireMessage = SessionHistoryResult["messages"][number];

export interface RecordFrameEventData {
	recordingId: string;
	target: ResolvedPageTarget;
	navigationGeneration: number;
	/** Chrome-only compatibility fields. New consumers should read target. */
	tabId?: number;
	frameId?: number;
	seq: number;
	format: "jpeg" | "png";
	dataBase64: string;
	capturedAtMs: number;
	metadata?: {
		timestamp?: number;
		deviceWidth?: number;
		deviceHeight?: number;
		pageScaleFactor?: number;
		offsetTop?: number;
		scrollOffsetX?: number;
		scrollOffsetY?: number;
	};
	final?: boolean;
	summary?: RecordStopResult;
}

/** Legacy MediaRecorder chunk event kept during the 1.1.x to 1.2.x transition. */
export interface RecordChunkEventData {
	recordingId: string;
	target: ResolvedPageTarget;
	navigationGeneration: number;
	/** Chrome-only compatibility fields. New consumers should read target. */
	tabId?: number;
	frameId?: number;
	seq: number;
	mimeType: string;
	chunkBase64: string;
	final?: boolean;
	summary?: RecordStopResult;
}

// ---------------------------------------------------------------------------
// Non-command status and event contracts
// ---------------------------------------------------------------------------

export interface BridgeServerStatus {
	ok: true;
	protocolVersion: number;
	minProtocolVersion: number;
	serverVersion: string;
	extension:
		| {
				connected: true;
				windowId?: number;
				sessionId?: string;
				capabilities?: string[];
				remoteAddress?: string;
				protocolVersion?: number;
				minProtocolVersion?: number;
				appVersion?: string;
		  }
		| { connected: false };
	clients: {
		total: number;
		cli: number;
		extension: number;
	};
	electron: {
		sessions: Array<{
			id: string;
			appId?: string;
			appRef?: string;
			pid?: number;
			port: number;
			browser?: string;
			mainInspector?: {
				port: number;
				webSocketDebuggerUrl?: string;
				available: boolean;
				browser?: string;
			};
			launched: boolean;
			startedAt: string;
			/** Server-verified CDP and page-target liveness. Missing on older bridge servers. */
			live?: boolean;
			livePageTargetCount?: number;
			livenessCheckedAt?: string;
			livenessReason?: "ok" | "cdp_unreachable" | "endpoint_changed" | "no_page_targets";
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
	};
	skillsSnapshot?: {
		state: "missing" | "fresh" | "stale" | "invalid";
		generatedAt?: string;
		ageMs?: number;
		skillCount?: number;
		message?: string;
	};
	pendingRequests: number;
}

export interface SessionChangedEventData {
	sessionId?: string;
	persisted: boolean;
	title: string;
	model?: { provider: string; id: string };
	messageCount: number;
	lastMessageIndex: number;
}

export interface SessionMessageEventData {
	sessionId?: string;
	persisted: boolean;
	message: SessionWireMessage;
}

export interface SessionToolEventData {
	sessionId?: string;
	phase: "start" | "update" | "end";
	toolCallId: string;
	toolName: string;
	isError?: boolean;
	summary?: string;
}

export interface SessionRunStateEventData {
	sessionId?: string;
	state: "started" | "idle";
}

// ---------------------------------------------------------------------------
// Network / config types
// ---------------------------------------------------------------------------

/** Server-side config (bind address). */
export interface BridgeServerConfig {
	host: string;
	port: number;
	token: string;
	serverVersion?: string;
	otel?: {
		enabled?: boolean;
		ingestUrl?: string;
		ingestKey?: string;
	};
}

/** Client-side config (connect address). */
export interface BridgeClientConfig {
	url: string;
	token: string;
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const ErrorCodes = {
	/** No extension target is currently connected to the bridge. */
	NO_EXTENSION_TARGET: -32000,
	/** Token mismatch or missing token during registration. */
	AUTH_FAILED: -32001,
	/** Method name is not in the V1 command set. */
	INVALID_METHOD: -32002,
	/** Tool execution failed in the extension. */
	EXECUTION_ERROR: -32003,
	/** Request timed out waiting for extension response. */
	TIMEOUT: -32004,
	/** Request was aborted (CLI disconnected). */
	ABORTED: -32005,
	/** Client sent a request before completing registration. */
	REGISTRATION_REQUIRED: -32006,
	/** Capability exists in protocol but is disabled by local settings. */
	CAPABILITY_DISABLED: -32008,
	/** Requested operation cannot modify the currently active session while streaming. */
	SESSION_BUSY: -32009,
	/** CLI attempted to write to a session that is no longer active. */
	SESSION_MISMATCH: -32010,
	/** There is no active persisted sidepanel session for write operations. */
	NO_ACTIVE_SESSION: -32011,
	/** Another CLI currently holds the write lease for session injection. */
	WRITE_LOCKED: -32012,
	/** Request targeted a bridge-local Electron session that is not attached. */
	NO_ELECTRON_SESSION: -32013,
	/** Request cannot be handled by this target kind. */
	INVALID_TARGET: -32014,
	/** Client/server protocol version cannot support the requested target. */
	PROTOCOL_MISMATCH: -32015,
	/** Request parameters do not satisfy the method's schema. */
	INVALID_PARAMS: -32602,
	/** A command handler returned a value outside its declared result schema. */
	INVALID_RESULT: -32016,
} as const;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const BridgeDefaults = {
	HOST: "0.0.0.0",
	PORT: 19285,
	STATUS_TIMEOUT_MS: 10_000,
	REQUEST_TIMEOUT_MS: 60_000,
	SLOW_REQUEST_TIMEOUT_MS: 120_000,
	WORKFLOW_TIMEOUT_MS: 600_000,
	CAPTURE_TIMEOUT_MS: 0,
	TRACE_TIMEOUT_MS: 120_000,
	RECORD_DEFAULT_MAX_DURATION_MS: 30_000,
	RECORD_DEFAULT_FPS: 12,
	RECORD_DEFAULT_JPEG_QUALITY: 70,
	RECORD_DEFAULT_MAX_WIDTH: 1280,
	RECORD_MAX_FPS: 30,
	RECORD_MIN_FPS: 1,
	RECORD_HARD_MAX_DURATION_MS: 120_000,
	RECORD_HARD_MAX_BYTES: 64 * 1024 * 1024,
	RECORD_TIMESLICE_MS: 1000,
	/** Grace period (ms) for a newly connected socket to send a register message. */
	REGISTER_TIMEOUT_MS: 10_000,
} as const;
