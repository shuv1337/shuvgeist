import type { BridgeTelemetry, BridgeTelemetrySpan, TraceContext } from "../bridge/telemetry.js";
import { type DebuggerManager, getSharedDebuggerManager } from "./helpers/debugger-manager.js";

const REDACTED_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization"]);

export interface NetworkCaptureOptions {
	maxEntries?: number;
	maxBodyBytes?: number;
}

export interface CapturedNetworkRequest {
	id?: string;
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
	requestBody?: string;
	responseBody?: string;
	requestBodyTruncated?: boolean;
	responseBodyTruncated?: boolean;
	requestBodySize?: number;
	responseBodySize?: number;
	hasRequestBody: boolean;
	hasResponseBody: boolean;
}

export interface NetworkCaptureStats {
	tabId: number;
	active: boolean;
	requestCount: number;
	storedBodyBytes: number;
	evictedRequests: number;
}

interface NetworkCaptureState {
	tabId: number;
	active: boolean;
	owner: string;
	sessionId: string;
	maxEntries: number;
	maxBodyBytes: number;
	requests: Map<string, CapturedNetworkRequest>;
	order: string[];
	storedBodyBytes: number;
	evictedRequests: number;
	removeListener?: () => void;
	traceSpan?: BridgeTelemetrySpan;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringMapFrom(value: unknown): Record<string, string> | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(record)) {
		out[key] = String(entry);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function sizeOfText(value: string | undefined): number {
	return value ? new TextEncoder().encode(value).length : 0;
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		out[key] = REDACTED_HEADERS.has(key.toLowerCase()) ? "<redacted>" : value;
	}
	return out;
}

export class NetworkCaptureEngine {
	private readonly states = new Map<number, NetworkCaptureState>();
	private readonly debuggerManager: DebuggerManager;
	private readonly maxEntries: number;
	private readonly maxBodyBytesPerEntry: number;
	private readonly telemetry?: BridgeTelemetry;

	constructor(
		options:
			| DebuggerManager
			| {
					debuggerManager?: DebuggerManager;
					maxRequestsPerTab?: number;
					maxBodyBytesPerEntry?: number;
					telemetry?: BridgeTelemetry;
			  } = {},
	) {
		if (isDebuggerManager(options)) {
			this.debuggerManager = options;
			this.maxEntries = 250;
			this.maxBodyBytesPerEntry = 256_000;
			this.telemetry = undefined;
			return;
		}
		const config = options;
		this.debuggerManager = config.debuggerManager ?? getSharedDebuggerManager();
		this.maxEntries = config.maxRequestsPerTab ?? 250;
		this.maxBodyBytesPerEntry = config.maxBodyBytesPerEntry ?? 256_000;
		this.telemetry = config.telemetry;
	}

	private async acquireDebugger(tabId: number, owner: string, traceContext?: TraceContext): Promise<void> {
		if (typeof this.debuggerManager.acquireWithTrace === "function") {
			await this.debuggerManager.acquireWithTrace(tabId, owner, { parent: traceContext });
			return;
		}
		await this.debuggerManager.acquire(tabId, owner);
	}

	private async ensureDebuggerDomain(tabId: number, domain: "Network", traceContext?: TraceContext): Promise<void> {
		if (typeof this.debuggerManager.ensureDomainWithTrace === "function") {
			await this.debuggerManager.ensureDomainWithTrace(tabId, domain, { parent: traceContext });
			return;
		}
		await this.debuggerManager.ensureDomain(tabId, domain);
	}

	private async releaseDebugger(tabId: number, owner: string, traceContext?: TraceContext): Promise<void> {
		if (typeof this.debuggerManager.releaseWithTrace === "function") {
			await this.debuggerManager.releaseWithTrace(tabId, owner, { parent: traceContext });
			return;
		}
		await this.debuggerManager.release(tabId, owner);
	}

	private async sendDebuggerCommand<T>(
		tabId: number,
		method: string,
		params: Record<string, unknown> | undefined,
		traceContext?: TraceContext,
	): Promise<T> {
		if (typeof this.debuggerManager.sendCommandWithTrace === "function") {
			return this.debuggerManager.sendCommandWithTrace(tabId, method, params, {
				parent: traceContext,
			}) as Promise<T>;
		}
		return this.debuggerManager.sendCommand(tabId, method, params) as Promise<T>;
	}

	async start(
		tabId: number,
		options: NetworkCaptureOptions = {},
		traceContext?: TraceContext,
	): Promise<NetworkCaptureStats> {
		const existing = this.states.get(tabId);
		if (existing?.active) {
			return this.stats(tabId);
		}

		const owner = `network-capture:${tabId}`;
		await this.acquireDebugger(tabId, owner, traceContext);
		await this.ensureDebuggerDomain(tabId, "Network", traceContext);

		const state: NetworkCaptureState = existing ?? {
			tabId,
			active: true,
			owner,
			sessionId: `capture_${tabId}_${Date.now()}`,
			maxEntries: options.maxEntries ?? this.maxEntries,
			maxBodyBytes: options.maxBodyBytes ?? this.maxBodyBytesPerEntry,
			requests: new Map<string, CapturedNetworkRequest>(),
			order: [],
			storedBodyBytes: 0,
			evictedRequests: 0,
			traceSpan: this.telemetry?.startSpan("network.capture.session", {
				parent: traceContext,
				attributes: {
					"network.tab_id": tabId,
					"network.max_entries": options.maxEntries ?? this.maxEntries,
					"network.max_body_bytes": options.maxBodyBytes ?? this.maxBodyBytesPerEntry,
				},
			}),
		};
		state.active = true;
		state.maxEntries = options.maxEntries ?? state.maxEntries;
		state.maxBodyBytes = options.maxBodyBytes ?? state.maxBodyBytes;
		state.traceSpan =
			state.traceSpan ??
			this.telemetry?.startSpan("network.capture.session", {
				parent: traceContext,
				attributes: {
					"network.tab_id": tabId,
					"network.max_entries": state.maxEntries,
					"network.max_body_bytes": state.maxBodyBytes,
				},
			});
		state.removeListener?.();
		state.removeListener = this.debuggerManager.addEventListener(tabId, (method, params) => {
			void this.handleEvent(state, method, params);
		});
		this.states.set(tabId, state);
		return this.stats(tabId);
	}

	async stop(tabId: number, traceContext?: TraceContext): Promise<NetworkCaptureStats> {
		const state = this.states.get(tabId);
		if (!state?.active) {
			return this.stats(tabId);
		}
		state.active = false;
		state.removeListener?.();
		state.removeListener = undefined;
		await this.releaseDebugger(tabId, state.owner, traceContext ?? state.traceSpan?.context);
		state.traceSpan?.setAttributes({
			"network.request_count": state.requests.size,
			"network.stored_body_bytes": state.storedBodyBytes,
			"network.evicted_requests": state.evictedRequests,
		});
		state.traceSpan?.end("ok");
		state.traceSpan = undefined;
		return this.stats(tabId);
	}

	clear(tabId: number): NetworkCaptureStats {
		const state = this.ensureState(tabId);
		state.requests.clear();
		state.order = [];
		state.storedBodyBytes = 0;
		state.evictedRequests = 0;
		return this.stats(tabId);
	}

	list(tabId: number, options: { limit?: number; search?: string } = {}): CapturedNetworkRequest[] {
		const state = this.ensureState(tabId);
		const search = options.search?.toLowerCase();
		const items = state.order
			.map((requestId) => state.requests.get(requestId))
			.filter((request): request is CapturedNetworkRequest => Boolean(request))
			.filter((request) => {
				if (!search) return true;
				return request.url.toLowerCase().includes(search) || request.method.toLowerCase().includes(search);
			});
		const limit = typeof options.limit === "number" ? Math.max(0, options.limit) : items.length;
		return items
			.slice(-limit)
			.reverse()
			.map((item) => ({ ...item, id: item.requestId }));
	}

	get(tabId: number, requestId: string, traceContext?: TraceContext): CapturedNetworkRequest {
		const span = this.telemetry?.startSpan("network.capture.get", {
			parent: traceContext,
			attributes: {
				"network.tab_id": tabId,
				"network.request_id": requestId,
			},
		});
		const state = this.ensureState(tabId);
		const item = state.requests.get(requestId);
		if (!item) {
			const error = new Error(`Captured request ${requestId} was not found`);
			span?.recordError(error);
			span?.end("error");
			throw error;
		}
		span?.end("ok");
		return { ...item, id: item.requestId };
	}

	body(tabId: number, requestId: string): { requestBody?: string; responseBody?: string } {
		const item = this.get(tabId, requestId);
		return {
			requestBody: item.requestBody,
			responseBody: item.responseBody,
		};
	}

	getBody(
		tabId: number,
		requestId: string,
		kind: "request" | "response",
	): { text?: string; truncated: boolean } | undefined {
		const item = this.get(tabId, requestId);
		if (kind === "request" && item.requestBody) {
			return { text: item.requestBody, truncated: item.requestBodyTruncated === true };
		}
		if (kind === "response" && item.responseBody) {
			return { text: item.responseBody, truncated: item.responseBodyTruncated === true };
		}
		return undefined;
	}

	curl(tabId: number, requestId: string, includeSensitive = false): string {
		const item = this.get(tabId, requestId);
		const headers = includeSensitive ? item.requestHeaders : redactHeaders(item.requestHeaders);
		const parts = ["curl", "-X", shellEscape(item.method), shellEscape(item.url)];
		for (const [key, value] of Object.entries(headers ?? {})) {
			parts.push("-H", shellEscape(`${key}: ${value}`));
		}
		if (item.requestBody) {
			parts.push("--data-raw", shellEscape(item.requestBody));
		}
		return parts.join(" ");
	}

	toCurl(
		tabId: number,
		requestId: string,
		options: { redactSensitiveHeaders?: boolean } = {},
	): { command: string; redactedHeaders: string[] } {
		const item = this.get(tabId, requestId);
		const redactedHeaders = Object.keys(item.requestHeaders ?? {}).filter((key) =>
			REDACTED_HEADERS.has(key.toLowerCase()),
		);
		return {
			command: this.curl(tabId, requestId, options.redactSensitiveHeaders === false),
			redactedHeaders,
		};
	}

	isCapturing(tabId: number): boolean {
		return this.states.get(tabId)?.active === true;
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
		if (this.isCapturing(tabId)) {
			await this.stop(tabId);
		}
		this.states.delete(tabId);
	}

	stats(tabId: number): NetworkCaptureStats {
		const state = this.states.get(tabId);
		return {
			tabId,
			active: state?.active ?? false,
			requestCount: state?.requests.size ?? 0,
			storedBodyBytes: state?.storedBodyBytes ?? 0,
			evictedRequests: state?.evictedRequests ?? 0,
		};
	}

	private ensureState(tabId: number): NetworkCaptureState {
		let state = this.states.get(tabId);
		if (!state) {
			state = {
				tabId,
				active: false,
				owner: `network-capture:${tabId}`,
				sessionId: `capture_${tabId}_${Date.now()}`,
				maxEntries: this.maxEntries,
				maxBodyBytes: this.maxBodyBytesPerEntry,
				requests: new Map<string, CapturedNetworkRequest>(),
				order: [],
				storedBodyBytes: 0,
				evictedRequests: 0,
			};
			this.states.set(tabId, state);
		}
		return state;
	}

	private async handleEvent(
		state: NetworkCaptureState,
		method: string,
		params: Record<string, unknown> | undefined,
	): Promise<void> {
		const payload = params ?? {};
		switch (method) {
			case "Network.requestWillBeSent":
				this.upsertRequest(state, payload);
				break;
			case "Network.responseReceived":
				this.updateResponse(state, payload);
				break;
			case "Network.loadingFinished":
				await this.finishRequest(state, payload);
				break;
			case "Network.loadingFailed":
				this.failRequest(state, payload);
				break;
			default:
				break;
		}
	}

	private upsertRequest(state: NetworkCaptureState, payload: Record<string, unknown>): void {
		const requestId = String(payload.requestId ?? "");
		if (!requestId) return;
		const request = asRecord(payload.request);
		const existing = state.requests.get(requestId);
		const item: CapturedNetworkRequest = existing ?? {
			requestId,
			method: String(request?.method ?? "GET"),
			url: String(request?.url ?? ""),
			resourceType: typeof payload.type === "string" ? payload.type : undefined,
			startedAt: Date.now(),
			hasRequestBody: false,
			hasResponseBody: false,
		};
		item.method = String(request?.method ?? item.method);
		item.url = String(request?.url ?? item.url);
		item.resourceType = typeof payload.type === "string" ? payload.type : item.resourceType;
		item.requestHeaders = stringMapFrom(request?.headers);
		const postData = typeof request?.postData === "string" ? request.postData : undefined;
		const boundedRequestBody = this.boundBody(state, postData);
		item.requestBody = boundedRequestBody.text;
		item.requestBodyTruncated = boundedRequestBody.truncated;
		item.requestBodySize = sizeOfText(postData);
		item.hasRequestBody = Boolean(postData);
		if (!existing) {
			state.order.push(requestId);
		}
		state.requests.set(requestId, item);
		this.evictOverflow(state);
	}

	private updateResponse(state: NetworkCaptureState, payload: Record<string, unknown>): void {
		const requestId = String(payload.requestId ?? "");
		if (!requestId) return;
		const item = state.requests.get(requestId);
		if (!item) return;
		const response = asRecord(payload.response);
		item.status = typeof response?.status === "number" ? response.status : item.status;
		item.responseHeaders = stringMapFrom(response?.headers);
		item.contentType = typeof response?.mimeType === "string" ? response.mimeType : item.contentType;
	}

	private async finishRequest(state: NetworkCaptureState, payload: Record<string, unknown>): Promise<void> {
		const requestId = String(payload.requestId ?? "");
		if (!requestId) return;
		const item = state.requests.get(requestId);
		if (!item) return;
		item.endedAt = Date.now();
		item.durationMs = item.endedAt - item.startedAt;
		try {
			const bodyResult = await this.sendDebuggerCommand<{ body?: string; base64Encoded?: boolean }>(
				state.tabId,
				"Network.getResponseBody",
				{
					requestId,
				},
				state.traceSpan?.context,
			);
			const body =
				typeof bodyResult.body === "string" && bodyResult.base64Encoded !== true ? bodyResult.body : undefined;
			const boundedResponseBody = this.boundBody(state, body);
			item.responseBody = boundedResponseBody.text;
			item.responseBodyTruncated = boundedResponseBody.truncated;
			item.responseBodySize = sizeOfText(body);
			item.hasResponseBody = Boolean(body);
		} catch {
			// Some resource types do not expose bodies.
		}
	}

	private failRequest(state: NetworkCaptureState, payload: Record<string, unknown>): void {
		const requestId = String(payload.requestId ?? "");
		const item = state.requests.get(requestId);
		if (!item) return;
		item.endedAt = Date.now();
		item.durationMs = item.endedAt - item.startedAt;
	}

	private boundBody(state: NetworkCaptureState, body: string | undefined): { text?: string; truncated: boolean } {
		if (!body) return { text: undefined, truncated: false };
		const size = sizeOfText(body);
		if (size > state.maxBodyBytes) {
			return {
				text: body.slice(0, Math.max(0, Math.floor((state.maxBodyBytes / Math.max(1, size)) * body.length))),
				truncated: true,
			};
		}
		state.storedBodyBytes += size;
		return { text: body, truncated: false };
	}

	private evictOverflow(state: NetworkCaptureState): void {
		while (state.order.length > state.maxEntries) {
			const oldestId = state.order.shift();
			if (!oldestId) break;
			const removed = state.requests.get(oldestId);
			if (removed) {
				state.storedBodyBytes -= sizeOfText(removed.requestBody) + sizeOfText(removed.responseBody);
				state.requests.delete(oldestId);
				state.evictedRequests += 1;
			}
		}
	}
}

function shellEscape(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function isDebuggerManager(value: unknown): value is DebuggerManager {
	return typeof value === "object" && value !== null && "acquire" in value && !("debuggerManager" in value);
}
