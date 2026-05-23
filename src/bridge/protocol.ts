/**
 * Bridge protocol types shared between server, CLI, and extension client.
 *
 * JSON-RPC-inspired messages over WebSocket. The bridge server is the
 * rendezvous point — extension and CLI never connect directly.
 */

// ---------------------------------------------------------------------------
// Protocol versioning
// ---------------------------------------------------------------------------

import type { BridgeTarget } from "./target.js";

export const BRIDGE_PROTOCOL_VERSION = 3;
export const BRIDGE_PROTOCOL_MIN_VERSION = 2;

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
	return `Bridge protocol mismatch: ${peer} ${version}, server supports ${BRIDGE_PROTOCOL_MIN_VERSION}-${BRIDGE_PROTOCOL_VERSION}. Rebuild or restart shuvgeist.`;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export const BridgeCapabilities = [
	"navigate",
	"tabs",
	"repl",
	"screenshot",
	"eval",
	"cookies",
	"select_element",
	"workflow_run",
	"workflow_validate",
	"page_snapshot",
	"page_assert",
	"locate_by_role",
	"locate_by_text",
	"locate_by_label",
	"ref_click",
	"ref_fill",
	"frame_list",
	"frame_tree",
	"network_start",
	"network_stop",
	"network_list",
	"network_clear",
	"network_stats",
	"network_get",
	"network_body",
	"network_curl",
	"device_emulate",
	"device_reset",
	"perf_metrics",
	"perf_trace_start",
	"perf_trace_stop",
	"record_start",
	"record_stop",
	"record_status",
	"status",
	"session_history",
	"session_inject",
	"session_new",
	"session_set_model",
	"session_artifacts",
	"electron_list",
	"electron_allow",
	"electron_launch",
	"electron_attach",
	"electron_detach",
	"electron_windows",
	"electron_label",
	"electron_main_info",
	"electron_ipc_tap_start",
	"electron_ipc_tap_stop",
	"electron_main_network_start",
	"electron_main_network_stop",
	"electron_source_layout",
	"electron_source_list",
	"electron_source_read",
	"electron_source_extract",
	"electron_doctor",
	"electron_auto_attach",
	"skills_snapshot_status",
] as const;
export type BridgeCapability = (typeof BridgeCapabilities)[number];

export function getBridgeCapabilities(sensitiveAccessEnabled: boolean): BridgeCapability[] {
	const sensitiveCapabilities = new Set<BridgeCapability>([
		"eval",
		"cookies",
		"network_get",
		"network_body",
		"network_curl",
		"record_start",
		"record_stop",
		"record_status",
	]);
	return BridgeCapabilities.filter((capability) => sensitiveAccessEnabled || !sensitiveCapabilities.has(capability));
}

export function isWriteMethod(method: BridgeMethod): boolean {
	return method === "session_inject" || method === "session_new" || method === "session_set_model";
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface ExtensionRegistration {
	type: "register";
	role: "extension";
	token: string;
	protocolVersion: number;
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

export const BridgeMethods = [
	"status",
	"navigate",
	"repl",
	"screenshot",
	"eval",
	"cookies",
	"select_element",
	"workflow_run",
	"workflow_validate",
	"page_snapshot",
	"page_assert",
	"locate_by_role",
	"locate_by_text",
	"locate_by_label",
	"ref_click",
	"ref_fill",
	"frame_list",
	"frame_tree",
	"network_start",
	"network_stop",
	"network_list",
	"network_clear",
	"network_stats",
	"network_get",
	"network_body",
	"network_curl",
	"device_emulate",
	"device_reset",
	"perf_metrics",
	"perf_trace_start",
	"perf_trace_stop",
	"record_start",
	"record_stop",
	"record_status",
	"session_history",
	"session_inject",
	"session_new",
	"session_set_model",
	"session_artifacts",
	"electron_list",
	"electron_allow",
	"electron_launch",
	"electron_attach",
	"electron_detach",
	"electron_windows",
	"electron_label",
	"electron_main_info",
	"electron_ipc_tap_start",
	"electron_ipc_tap_stop",
	"electron_main_network_start",
	"electron_main_network_stop",
	"electron_source_layout",
	"electron_source_list",
	"electron_source_read",
	"electron_source_extract",
	"electron_doctor",
	"electron_auto_attach",
	"skills_snapshot_status",
] as const;
export type BridgeMethod = (typeof BridgeMethods)[number];

export interface BridgeRequest {
	id: number;
	method: BridgeMethod;
	params?: Record<string, unknown>;
	target?: BridgeTarget;
	traceparent?: string;
	tracestate?: string;
}

const ServerLocalMethods = new Set<BridgeMethod>([
	"electron_list",
	"electron_allow",
	"electron_launch",
	"electron_attach",
	"electron_detach",
	"electron_windows",
	"electron_label",
	"electron_main_info",
	"electron_ipc_tap_start",
	"electron_ipc_tap_stop",
	"electron_main_network_start",
	"electron_main_network_stop",
	"electron_source_layout",
	"electron_source_list",
	"electron_source_read",
	"electron_source_extract",
	"electron_doctor",
	"electron_auto_attach",
	"skills_snapshot_status",
]);

export function isServerLocalMethod(method: BridgeMethod): boolean {
	return ServerLocalMethods.has(method);
}

export function isTargetDispatchedMethod(method: BridgeMethod): boolean {
	return !method.startsWith("session_");
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

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type BridgeEventType =
	| "extension_connected"
	| "extension_disconnected"
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
// Command-specific parameter types
// ---------------------------------------------------------------------------

export interface NavigateParams {
	url?: string;
	newTab?: boolean;
	listTabs?: boolean;
	switchToTab?: number;
}

export interface ReplParams extends TargetedBridgeParams {
	title: string;
	code: string;
}

export interface ScreenshotParams extends TargetedBridgeParams {
	maxWidth?: number;
}

export interface EvalParams extends TargetedBridgeParams {
	code: string;
}

export interface CookiesParams {
	url?: string;
}

export interface SelectElementParams {
	message?: string;
}

export interface TargetedBridgeParams {
	tabId?: number;
	tabRef?: string;
	windowId?: number;
	frameId?: number;
}

export interface WorkflowRunParams {
	workflow: unknown;
	args?: Record<string, unknown>;
	dryRun?: boolean;
}

export interface WorkflowValidateParams {
	workflow: unknown;
	args?: Record<string, unknown>;
}

export interface PageSnapshotBridgeParams extends TargetedBridgeParams {
	maxEntries?: number;
	includeHidden?: boolean;
}

export type PageAssertKind = "expression" | "text" | "selector" | "role" | "label" | "url";
export type PageAssertWorld = "user" | "main";

export interface PageAssertParams extends TargetedBridgeParams {
	kind: PageAssertKind;
	world?: PageAssertWorld;
	expression?: string;
	text?: string;
	selector?: string;
	role?: string;
	name?: string;
	label?: string;
	url?: string;
	urlPattern?: string;
	exact?: boolean;
	visible?: boolean;
	enabled?: boolean;
	count?: number;
	minCount?: number;
	maxCount?: number;
	timeoutMs?: number;
	intervalMs?: number;
}

export interface LocateByRoleParams extends TargetedBridgeParams {
	role: string;
	name?: string;
	minScore?: number;
	limit?: number;
}

export interface LocateByTextParams extends TargetedBridgeParams {
	text: string;
	minScore?: number;
	limit?: number;
}

export interface LocateByLabelParams extends TargetedBridgeParams {
	label: string;
	minScore?: number;
	limit?: number;
}

export interface RefClickParams extends TargetedBridgeParams {
	refId: string;
	native?: boolean;
}

export interface RefFillParams extends TargetedBridgeParams {
	refId: string;
	value: string;
	native?: boolean;
}

export interface FrameListParams {
	tabId?: number;
}

export interface NetworkStartParams {
	tabId?: number;
	maxEntries?: number;
	maxBodyBytes?: number;
}

export interface NetworkListParams {
	tabId?: number;
	limit?: number;
	search?: string;
}

export interface NetworkItemParams {
	tabId?: number;
	requestId: string;
}

export interface NetworkCurlParams extends NetworkItemParams {
	includeSensitive?: boolean;
}

export interface DeviceEmulateParams {
	tabId?: number;
	preset?: string;
	viewport?: {
		width: number;
		height: number;
		deviceScaleFactor?: number;
		mobile?: boolean;
	};
	touch?: boolean;
	userAgent?: string;
}

export interface DeviceResetParams {
	tabId?: number;
}

export interface PerfMetricsParams {
	tabId?: number;
}

export interface PerfTraceStartParams {
	tabId?: number;
	autoStopMs?: number;
}

export interface PerfTraceStopParams {
	tabId?: number;
}

export type RecordOutcome =
	| "stopped_user"
	| "stopped_max_duration"
	| "stopped_max_bytes"
	| "stopped_tab_closed"
	| "stopped_error";

export interface RecordStartParams extends TargetedBridgeParams {
	maxDurationMs?: number;
	videoBitsPerSecond?: number;
	mimeType?: string;
	fps?: number;
	quality?: number;
	maxWidth?: number;
	maxHeight?: number;
	everyNthFrame?: number;
}

export interface RecordStopParams extends TargetedBridgeParams {}

export interface RecordStatusParams extends TargetedBridgeParams {}

export interface RecordStartResult {
	ok: true;
	recordingId: string;
	tabId: number;
	startedAt: string;
	mimeType: string;
	videoBitsPerSecond?: number;
	maxDurationMs: number;
}

export interface RecordStopResult {
	ok: true;
	recordingId: string;
	tabId: number;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	mimeType: string;
	sizeBytes: number;
	sourceBytes?: number;
	encodedSizeBytes?: number;
	chunkCount: number;
	frameCount?: number;
	outcome: RecordOutcome;
}

export type RecordStatusResult =
	| { active: false }
	| {
			active: true;
			recordingId: string;
			tabId: number;
			startedAt: string;
			mimeType: string;
			durationMs: number;
			sizeBytes: number;
			sourceBytes?: number;
			chunkCount?: number;
			frameCount?: number;
			fps?: number;
			lastError?: string;
	  };

export interface RecordFrameEventData {
	recordingId: string;
	tabId: number;
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

/** Legacy MediaRecorder chunk event kept during the 1.1.x → 1.2.x transition. */
export interface RecordChunkEventData {
	recordingId: string;
	tabId: number;
	seq: number;
	mimeType: string;
	chunkBase64: string;
	final?: boolean;
	summary?: RecordStopResult;
}

export interface SessionHistoryParams {
	last?: number;
	afterMessageIndex?: number;
}

export interface SessionInjectParams {
	expectedSessionId: string;
	role: "user" | "assistant";
	content: string;
	waitForIdle?: boolean;
}

// ---------------------------------------------------------------------------
// Bridge result types
// ---------------------------------------------------------------------------

export interface BridgeStatusResult {
	ok: true;
	ready: true;
	windowId?: number;
	sessionId?: string;
	capabilities?: BridgeCapability[];
	activeTab?: {
		url?: string;
		title?: string;
		tabId?: number;
	};
}

export interface BridgeScreenshotResult {
	mimeType: "image/webp" | "image/png";
	dataUrl: string;
	imageWidth: number;
	imageHeight: number;
	cssWidth: number;
	cssHeight: number;
	devicePixelRatio: number;
	scale: number;
}

export interface BridgeReplFile {
	fileName: string;
	mimeType: string;
	size: number;
	contentBase64: string;
}

export interface BridgeReplResult {
	output: string;
	files: BridgeReplFile[];
}

export interface WorkflowRunResultWire {
	ok: boolean;
	aborted: boolean;
	dryRun: boolean;
	name?: string;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	steps: Array<{
		path: string;
		type: "command" | "assert" | "repeat" | "each";
		status: "ok" | "error" | "aborted";
		durationMs: number;
		method?: string;
		as?: string;
		wait?: { type: "navigation" | "dom_stable" | "network_quiet"; timeoutMs?: number; quietMs?: number };
		iterations?: number;
		result?: unknown;
		error?: string;
	}>;
	captured: Record<string, unknown>;
	errors: string[];
	warnings: Array<{
		path: string;
		code: "target_unpinned";
		message: string;
	}>;
	truncation: {
		stepResults: number;
		captures: number;
	};
}

export interface WorkflowValidateResult {
	ok: boolean;
	errors: string[];
}

export interface PageAssertResult {
	ok: boolean;
	kind: PageAssertKind;
	message: string;
	actual?: unknown;
	expected?: unknown;
	attempts: number;
	durationMs: number;
	timeoutMs: number;
	tabId: number;
	frameId: number;
}

export interface BridgeSnapshotEntry {
	snapshotId: string;
	tabId: number;
	frameId: number;
	tagName: string;
	role?: string;
	name?: string;
	text?: string;
	label?: string;
	attributes: Record<string, string>;
	selectorCandidates: string[];
	ordinalPath: number[];
	boundingBox: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	interactive: boolean;
	headingLevel?: number;
	landmark?: string;
}

export interface PageSnapshotBridgeResult {
	tabId: number;
	frameId: number;
	url: string;
	title: string;
	generatedAt: number;
	totalCandidates: number;
	truncated: boolean;
	entries: BridgeSnapshotEntry[];
}

export interface SnapshotLocatorMatchResult {
	refId: string;
	score: number;
	reasons: string[];
	entry: BridgeSnapshotEntry;
}

export interface FrameDescriptorResult {
	frameId: number;
	parentFrameId: number;
	url: string;
	errorOccurred?: boolean;
}

export interface FrameTreeNodeResult extends FrameDescriptorResult {
	depth: number;
	path: string;
	children: FrameTreeNodeResult[];
}

export interface FrameTreeResult {
	roots: FrameTreeNodeResult[];
	orphans: FrameTreeNodeResult[];
}

export interface RefActionResult {
	ok: true;
	refId: string;
	tabId: number;
	frameId: number;
	selector?: string;
}

export interface NetworkCaptureRequestSummary {
	requestId: string;
	method: string;
	url: string;
	status?: number;
	resourceType?: string;
	contentType?: string;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	requestHeaders?: Record<string, string>;
	responseHeaders?: Record<string, string>;
	requestBodySize?: number;
	responseBodySize?: number;
	hasRequestBody?: boolean;
	hasResponseBody?: boolean;
}

export interface NetworkCaptureStats {
	tabId: number;
	active: boolean;
	requestCount: number;
	storedBodyBytes: number;
	evictedRequests: number;
}

export interface DeviceEmulationResult {
	ok: true;
	tabId: number;
	preset?: string;
	viewport?: {
		width: number;
		height: number;
		deviceScaleFactor?: number;
		mobile?: boolean;
	};
	touch?: boolean;
	userAgent?: string;
}

export interface PerfMetricsResult {
	tabId: number;
	metrics: Array<{ name: string; value: number }>;
}

export interface PerfTraceResult {
	ok: true;
	tabId: number;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	eventCount: number;
	traceEvents: unknown[];
}

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

export interface SessionWireAttachment {
	kind: "image" | "file";
	mimeType?: string;
	name?: string;
}

export interface SessionWireMessage {
	messageIndex: number;
	role: "user" | "assistant" | "toolResult" | "navigation";
	text: string;
	timestamp?: number;
	provider?: string;
	model?: string;
	toolCalls?: { name: string; argsSummary: string }[];
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	attachments?: SessionWireAttachment[];
}

export interface SessionHistoryResult {
	sessionId?: string;
	persisted: boolean;
	title: string;
	model?: { provider: string; id: string };
	isStreaming: boolean;
	messageCount: number;
	lastMessageIndex: number;
	messages: SessionWireMessage[];
}

export interface SessionInjectResult {
	ok: true;
	sessionId: string;
	messageIndex: number;
}

export interface SessionNewParams {
	/** Optional model to set on the new session (provider/id format, e.g. "anthropic/claude-sonnet-4-6"). */
	model?: string;
}

export interface SessionNewResult {
	ok: true;
	sessionId: string;
	model?: { provider: string; id: string };
}

export interface SessionSetModelParams {
	/** Model in provider/id format (e.g. "anthropic/claude-sonnet-4-6") or just model id. */
	model: string;
	/** Provider name (required if model doesn't contain a slash). */
	provider?: string;
}

export interface SessionSetModelResult {
	ok: true;
	model: { provider: string; id: string };
}

export interface SessionArtifact {
	filename: string;
	content: string;
	createdAt: string;
	updatedAt: string;
}

export interface SessionArtifactsResult {
	sessionId?: string;
	artifacts: SessionArtifact[];
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

/** Persisted CLI config at ~/.shuvgeist/bridge.json */
export interface CliConfigFile {
	url?: string;
	token?: string;
	electron?: {
		allowlist?: string[];
		portRange?: [number, number];
		defaultFlags?: Record<string, string[]>;
		capabilities?: Record<
			string,
			Partial<Record<"eval" | "cookies" | "main_inspect" | "ipc_tap" | "main_network_tap", boolean>>
		>;
	};
	otel?: {
		enabled?: boolean;
		ingestUrl?: string;
		privateIngestKey?: string;
	};
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
	/** Another extension target is already connected. */
	EXTENSION_ALREADY_CONNECTED: -32007,
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
