import {
	type CdpSessionTraceOptions,
	type ChromeDebuggerManagerLike,
	ChromeDebuggerSession,
} from "@shuvgeist/driver/cdp-session";
import { createPageDriverScope, createPageIdentity } from "@shuvgeist/driver/page-driver-identity";
import {
	createPageNetworkEngine,
	type PageNetworkCaptureOptions,
	type PageNetworkEngine,
	type PageNetworkRequest,
	type PageNetworkStats,
} from "@shuvgeist/driver/page-network-engine";
import type { BridgeTelemetry, BridgeTelemetrySpan, TraceContext } from "@shuvgeist/protocol/telemetry";
import { type DebuggerManager, getSharedDebuggerManager } from "./helpers/debugger-manager.js";

const DEFAULT_MAX_ENTRIES = 250;
const DEFAULT_MAX_BODY_BYTES = 256_000;

export type NetworkCaptureOptions = Omit<PageNetworkCaptureOptions, "signal">;

/** Compatibility projection for the former extension-local capture engine. */
export interface CapturedNetworkRequest extends PageNetworkRequest {
	id?: string;
}

export interface NetworkCaptureStats {
	tabId: number;
	active: boolean;
	requestCount: number;
	storedBodyBytes: number;
	evictedRequests: number;
}

interface NetworkCaptureEntry {
	engine: PageNetworkEngine;
	traceState: { context?: TraceContext };
	traceSpan?: BridgeTelemetrySpan;
	removeCloseListener: () => void;
}

interface LegacyDebuggerManagerLike {
	acquire(tabId: number, owner: string): Promise<void>;
	release(tabId: number, owner: string): Promise<void>;
	ensureDomain(tabId: number, domain: "Network"): Promise<void>;
	sendCommand<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T>;
	acquireWithTrace?(tabId: number, owner: string, trace?: CdpSessionTraceOptions): Promise<void>;
	releaseWithTrace?(tabId: number, owner: string, trace?: CdpSessionTraceOptions): Promise<void>;
	ensureDomainWithTrace?(tabId: number, domain: "Network", trace?: CdpSessionTraceOptions): Promise<void>;
	sendCommandWithTrace?<T = unknown>(
		tabId: number,
		method: string,
		params?: Record<string, unknown>,
		trace?: CdpSessionTraceOptions,
	): Promise<T>;
	addEventListener?(
		tabId: number,
		listener: (method: string, params: Record<string, unknown> | undefined, source: unknown) => void,
	): () => void;
	addDetachListener?(tabId: number, listener: (event: { tabId: number; reason: unknown }) => void): () => void;
}

interface NetworkCaptureEngineOptions {
	debuggerManager?: DebuggerManager;
	maxRequestsPerTab?: number;
	maxBodyBytesPerEntry?: number;
	telemetry?: BridgeTelemetry;
}

/**
 * Backward-compatible extension facade over the canonical PageNetworkEngine.
 *
 * The capture lifecycle, event handling, body accounting, eviction, and curl
 * generation live only in `@shuvgeist/driver/page-network-engine`. This class
 * retains the former tab-keyed API for downstream extension consumers.
 */
export class NetworkCaptureEngine {
	private readonly entries = new Map<number, NetworkCaptureEntry>();
	private readonly debuggerManager: DebuggerManager;
	private readonly maxEntries: number;
	private readonly maxBodyBytes: number;
	private readonly telemetry?: BridgeTelemetry;

	constructor(options: DebuggerManager | NetworkCaptureEngineOptions = {}) {
		if (isDebuggerManager(options)) {
			this.debuggerManager = options;
			this.maxEntries = DEFAULT_MAX_ENTRIES;
			this.maxBodyBytes = DEFAULT_MAX_BODY_BYTES;
			return;
		}
		this.debuggerManager = options.debuggerManager ?? getSharedDebuggerManager();
		this.maxEntries = options.maxRequestsPerTab ?? DEFAULT_MAX_ENTRIES;
		this.maxBodyBytes = options.maxBodyBytesPerEntry ?? DEFAULT_MAX_BODY_BYTES;
		this.telemetry = options.telemetry;
	}

	async start(
		tabId: number,
		options: NetworkCaptureOptions = {},
		traceContext?: TraceContext,
	): Promise<NetworkCaptureStats> {
		const entry = this.entry(tabId);
		if (entry.engine.stats().active) return toLegacyStats(tabId, entry.engine.stats());

		const span = this.telemetry?.startSpan("network.capture.session", {
			parent: traceContext,
			attributes: {
				"network.tab_id": tabId,
				"network.max_entries": options.maxEntries ?? this.maxEntries,
				"network.max_body_bytes": options.maxBodyBytes ?? this.maxBodyBytes,
			},
		});
		entry.traceSpan = span;
		entry.traceState.context = span?.context ?? traceContext;
		try {
			return toLegacyStats(tabId, await entry.engine.start(options));
		} catch (error) {
			span?.recordError(error);
			span?.end("error");
			entry.traceSpan = undefined;
			entry.traceState.context = undefined;
			throw error;
		}
	}

	async stop(tabId: number, traceContext?: TraceContext): Promise<NetworkCaptureStats> {
		const entry = this.entries.get(tabId);
		if (!entry) return emptyStats(tabId);
		entry.traceState.context = traceContext ?? entry.traceSpan?.context;
		try {
			const stats = await entry.engine.stop();
			entry.traceSpan?.setAttributes({
				"network.request_count": stats.requestCount,
				"network.stored_body_bytes": stats.storedBodyBytes,
				"network.evicted_requests": stats.evictedRequests,
			});
			entry.traceSpan?.end("ok");
			entry.traceSpan = undefined;
			entry.traceState.context = undefined;
			return toLegacyStats(tabId, stats);
		} catch (error) {
			entry.traceSpan?.recordError(error);
			entry.traceSpan?.end("error");
			entry.traceSpan = undefined;
			entry.traceState.context = undefined;
			throw error;
		}
	}

	clear(tabId: number): NetworkCaptureStats {
		return toLegacyStats(tabId, this.entry(tabId).engine.clear());
	}

	list(tabId: number, options: { limit?: number; search?: string } = {}): CapturedNetworkRequest[] {
		const engine = this.entry(tabId).engine;
		return engine.list(options).requests.map(({ requestId }) => toLegacyRequest(engine.get(requestId).request));
	}

	get(tabId: number, requestId: string, traceContext?: TraceContext): CapturedNetworkRequest {
		const span = this.telemetry?.startSpan("network.capture.get", {
			parent: traceContext,
			attributes: { "network.tab_id": tabId, "network.request_id": requestId },
		});
		try {
			const request = toLegacyRequest(this.entry(tabId).engine.get(requestId).request);
			span?.end("ok");
			return request;
		} catch (error) {
			span?.recordError(error);
			span?.end("error");
			throw error;
		}
	}

	body(tabId: number, requestId: string): { requestBody?: string; responseBody?: string } {
		const body = this.entry(tabId).engine.body(requestId);
		return { requestBody: body.requestBody, responseBody: body.responseBody };
	}

	getBody(
		tabId: number,
		requestId: string,
		kind: "request" | "response",
	): { text?: string; truncated: boolean } | undefined {
		const body = this.entry(tabId).engine.body(requestId);
		if (kind === "request" && body.requestBody) {
			return { text: body.requestBody, truncated: body.requestBodyTruncated };
		}
		if (kind === "response" && body.responseBody) {
			return { text: body.responseBody, truncated: body.responseBodyTruncated };
		}
		return undefined;
	}

	curl(tabId: number, requestId: string, includeSensitive = false): string {
		return this.entry(tabId).engine.toCurl(requestId, { redactSensitiveHeaders: !includeSensitive }).command;
	}

	toCurl(
		tabId: number,
		requestId: string,
		options: { redactSensitiveHeaders?: boolean } = {},
	): { command: string; redactedHeaders: string[] } {
		const result = this.entry(tabId).engine.toCurl(requestId, options);
		return { command: result.command, redactedHeaders: result.redactedHeaders };
	}

	isCapturing(tabId: number): boolean {
		return this.entries.get(tabId)?.engine.stats().active === true;
	}

	async startCapture(
		tabId: number,
		options: NetworkCaptureOptions = {},
	): Promise<{ tabId: number; alreadyCapturing: boolean }> {
		const alreadyCapturing = this.isCapturing(tabId);
		await this.start(tabId, options);
		return { tabId, alreadyCapturing };
	}

	async stopCapture(tabId: number): Promise<{ tabId: number; stopped: boolean }> {
		const stopped = this.isCapturing(tabId);
		await this.stop(tabId);
		return { tabId, stopped };
	}

	async handleTabClosed(tabId: number): Promise<void> {
		const entry = this.entries.get(tabId);
		if (!entry) return;
		if (entry.engine.stats().active) await this.stop(tabId);
		entry.removeCloseListener();
		await entry.engine.dispose();
		this.entries.delete(tabId);
	}

	stats(tabId: number): NetworkCaptureStats {
		const entry = this.entries.get(tabId);
		return entry ? toLegacyStats(tabId, entry.engine.stats()) : emptyStats(tabId);
	}

	private entry(tabId: number): NetworkCaptureEntry {
		const existing = this.entries.get(tabId);
		if (existing) return existing;

		const traceState: { context?: TraceContext } = {};
		const session = new ChromeDebuggerSession({
			tabId,
			manager: legacyCdpManager(this.debuggerManager, () => traceState.context),
		});
		const identity = createPageIdentity("chrome-debugger", {
			sessionId: `legacy-network-capture:${tabId}`,
			windowId: "unknown",
			pageId: String(tabId),
		});
		const engine = createPageNetworkEngine({
			cdp: session,
			getScope: () => createPageDriverScope(identity, session.navigationGeneration),
			maxEntries: this.maxEntries,
			maxBodyBytes: this.maxBodyBytes,
		});
		let entry!: NetworkCaptureEntry;
		const removeCloseListener = session.onClose((reason) => {
			if (!entry.traceSpan) return;
			entry.traceSpan.recordError(reason ?? new Error("Chrome debugger session closed"));
			entry.traceSpan.end("error");
			entry.traceSpan = undefined;
			entry.traceState.context = undefined;
		});
		entry = { engine, traceState, removeCloseListener };
		this.entries.set(tabId, entry);
		return entry;
	}
}

function legacyCdpManager(
	manager: DebuggerManager,
	traceContext: () => TraceContext | undefined,
): ChromeDebuggerManagerLike {
	const legacy = manager as unknown as LegacyDebuggerManagerLike;
	const trace = (requested?: CdpSessionTraceOptions): CdpSessionTraceOptions | undefined =>
		requested ?? (traceContext() ? { parent: traceContext() } : undefined);
	return {
		acquireWithTrace: (tabId, owner, requested) =>
			legacy.acquireWithTrace?.(tabId, owner, trace(requested)) ?? legacy.acquire(tabId, owner),
		releaseWithTrace: (tabId, owner, requested) =>
			legacy.releaseWithTrace?.(tabId, owner, trace(requested)) ?? legacy.release(tabId, owner),
		ensureDomainWithTrace: (tabId, domain, requested) =>
			legacy.ensureDomainWithTrace?.(tabId, domain as "Network", trace(requested)) ??
			legacy.ensureDomain(tabId, domain as "Network"),
		sendCommandWithTrace: <T>(
			tabId: number,
			method: string,
			params?: Record<string, unknown>,
			requested?: CdpSessionTraceOptions,
		) =>
			legacy.sendCommandWithTrace?.<T>(tabId, method, params, trace(requested)) ??
			legacy.sendCommand<T>(tabId, method, params),
		addEventListener: legacy.addEventListener?.bind(legacy),
		addDetachListener: legacy.addDetachListener?.bind(legacy),
	};
}

function toLegacyStats(tabId: number, stats: PageNetworkStats): NetworkCaptureStats {
	return {
		tabId,
		active: stats.active,
		requestCount: stats.requestCount,
		storedBodyBytes: stats.storedBodyBytes,
		evictedRequests: stats.evictedRequests,
	};
}

function emptyStats(tabId: number): NetworkCaptureStats {
	return { tabId, active: false, requestCount: 0, storedBodyBytes: 0, evictedRequests: 0 };
}

function toLegacyRequest(request: PageNetworkRequest): CapturedNetworkRequest {
	return { ...request, id: request.requestId };
}

function isDebuggerManager(value: unknown): value is DebuggerManager {
	return typeof value === "object" && value !== null && "acquire" in value && !("debuggerManager" in value);
}
