import type { CdpSession } from "./cdp-session.js";
import { NetworkRedactor, type NetworkSecretStore } from "./network-redaction.js";
import type { PageDriverScope } from "./page-driver-identity.js";

const DEFAULT_MAX_ENTRIES = 250;
const DEFAULT_MAX_BODY_BYTES = 256_000;

export interface PageNetworkCaptureOptions {
	maxEntries?: number;
	maxBodyBytes?: number;
	sensitiveFields?: string[];
	signal?: AbortSignal;
}

export interface PageNetworkRequest {
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
	requestBodyOmitted?: boolean;
	responseBodyOmitted?: boolean;
	redactedHeaders?: string[];
	redactedFields?: string[];
	secretReferences?: string[];
	hasRequestBody: boolean;
	hasResponseBody: boolean;
}

export interface PageNetworkStats {
	scope: PageDriverScope;
	active: boolean;
	requestCount: number;
	storedBodyBytes: number;
	evictedRequests: number;
}

export interface PageNetworkListOptions {
	limit?: number;
	search?: string;
}

export interface PageNetworkListResult {
	scope: PageDriverScope;
	requests: PageNetworkRequest[];
}

export interface PageNetworkGetResult {
	scope: PageDriverScope;
	request: PageNetworkRequest;
}

export interface PageNetworkBodyResult {
	scope: PageDriverScope;
	requestId: string;
	requestBody?: string;
	responseBody?: string;
	requestBodyTruncated: boolean;
	responseBodyTruncated: boolean;
	requestBodyOmitted: boolean;
	responseBodyOmitted: boolean;
	redactedFields: string[];
	secretReferences: string[];
}

export interface PageNetworkCurlResult {
	scope: PageDriverScope;
	requestId: string;
	command: string;
	redactedHeaders: string[];
}

export interface PageNetworkEngine {
	start(options?: PageNetworkCaptureOptions): Promise<PageNetworkStats>;
	stop(): Promise<PageNetworkStats>;
	clear(): PageNetworkStats;
	stats(): PageNetworkStats;
	list(options?: PageNetworkListOptions): PageNetworkListResult;
	get(requestId: string): PageNetworkGetResult;
	body(requestId: string): PageNetworkBodyResult;
	toCurl(
		requestId: string,
		options?: { redactSensitiveHeaders?: boolean; reviewMutation?: boolean },
	): PageNetworkCurlResult;
	dispose(): Promise<void>;
}

export interface CreatePageNetworkEngineOptions {
	cdp: CdpSession;
	getScope: () => PageDriverScope;
	maxEntries?: number;
	maxBodyBytes?: number;
	secretStore?: NetworkSecretStore;
	sensitiveFields?: string[];
}

type CapturePhase = "starting" | "active" | "stopping" | "inactive";

interface CaptureLifecycle {
	epoch: number;
	owner: string;
	phase: CapturePhase;
	acquired: boolean;
	transportClosed: boolean;
	stopRequested: boolean;
	removeListeners: Array<() => void>;
}

interface BoundedText {
	text: string;
	originalBytes: number;
	storedBytes: number;
	truncated: boolean;
}

let nextEngineId = 1;

export function createPageNetworkEngine(options: CreatePageNetworkEngineOptions): PageNetworkEngine {
	return new CdpPageNetworkEngine(options);
}

class CdpPageNetworkEngine implements PageNetworkEngine {
	private readonly cdp: CdpSession;
	private readonly getScope: () => PageDriverScope;
	private readonly ownerPrefix: string;
	private readonly requests = new Map<string, PageNetworkRequest>();
	private order: string[] = [];
	private maxEntries: number;
	private maxBodyBytes: number;
	private redactor: NetworkRedactor;
	private readonly secretStore?: NetworkSecretStore;
	private storedBodyBytes = 0;
	private evictedRequests = 0;
	private nextEpoch = 1;
	private lifecycle?: CaptureLifecycle;
	private startPromise?: Promise<PageNetworkStats>;
	private stopPromise?: Promise<PageNetworkStats>;
	private disposed = false;
	private transportClosed = false;

	constructor(options: CreatePageNetworkEngineOptions) {
		this.cdp = options.cdp;
		this.getScope = options.getScope;
		this.maxEntries = normalizePositiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries");
		this.maxBodyBytes = normalizeNonNegativeInteger(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, "maxBodyBytes");
		this.secretStore = options.secretStore;
		this.redactor = new NetworkRedactor({
			store: this.secretStore,
			sensitiveFields: options.sensitiveFields,
		});
		this.ownerPrefix = `page-network:${nextEngineId++}`;
	}

	async start(options: PageNetworkCaptureOptions = {}): Promise<PageNetworkStats> {
		if (this.disposed) throw new Error("Page network engine is disposed");
		if (this.transportClosed) throw new Error("Page CDP session is closed");
		throwIfAborted(options.signal);
		if (this.lifecycle?.phase === "active") return this.stats();
		if (this.startPromise) return this.startPromise;
		if (this.stopPromise) await this.stopPromise;

		this.maxEntries = normalizePositiveInteger(options.maxEntries, this.maxEntries, "maxEntries");
		this.maxBodyBytes = normalizeNonNegativeInteger(options.maxBodyBytes, this.maxBodyBytes, "maxBodyBytes");
		if (options.sensitiveFields) {
			this.redactor = new NetworkRedactor({
				store: this.secretStore,
				sensitiveFields: options.sensitiveFields,
			});
		}
		this.evictOverflow();

		const epoch = this.nextEpoch++;
		const lifecycle: CaptureLifecycle = {
			epoch,
			owner: `${this.ownerPrefix}:${epoch}`,
			phase: "starting",
			acquired: false,
			transportClosed: false,
			stopRequested: false,
			removeListeners: [],
		};
		this.lifecycle = lifecycle;
		this.startPromise = this.startLifecycle(lifecycle, options.signal);
		try {
			return await this.startPromise;
		} finally {
			this.startPromise = undefined;
		}
	}

	async stop(): Promise<PageNetworkStats> {
		if (this.startPromise && this.lifecycle?.phase === "starting") {
			this.lifecycle.stopRequested = true;
			await this.startPromise.catch(() => undefined);
		}
		const lifecycle = this.lifecycle;
		if (!lifecycle || lifecycle.phase === "inactive") return this.stats();
		if (this.stopPromise) return this.stopPromise;
		this.stopPromise = this.stopLifecycle(lifecycle);
		try {
			return await this.stopPromise;
		} finally {
			this.stopPromise = undefined;
		}
	}

	clear(): PageNetworkStats {
		this.requests.clear();
		this.order = [];
		this.storedBodyBytes = 0;
		this.evictedRequests = 0;
		return this.stats();
	}

	stats(): PageNetworkStats {
		return {
			scope: this.getScope(),
			active: this.lifecycle?.phase === "active",
			requestCount: this.requests.size,
			storedBodyBytes: this.storedBodyBytes,
			evictedRequests: this.evictedRequests,
		};
	}

	list(options: PageNetworkListOptions = {}): PageNetworkListResult {
		const search = options.search?.toLowerCase();
		const requests = this.order
			.map((requestId) => this.requests.get(requestId))
			.filter((request): request is PageNetworkRequest => request !== undefined)
			.filter(
				(request) =>
					!search || request.url.toLowerCase().includes(search) || request.method.toLowerCase().includes(search),
			);
		const limit = normalizeLimit(options.limit, requests.length);
		return {
			scope: this.getScope(),
			requests: requests
				.slice(-limit)
				.reverse()
				.map((request) => cloneRequest(request, { redactSensitiveHeaders: true, omitBodies: true })),
		};
	}

	get(requestId: string): PageNetworkGetResult {
		return {
			scope: this.getScope(),
			request: cloneRequest(this.requireRequest(requestId)),
		};
	}

	body(requestId: string): PageNetworkBodyResult {
		const request = this.requireRequest(requestId);
		return {
			scope: this.getScope(),
			requestId,
			requestBody: request.requestBody,
			responseBody: request.responseBody,
			requestBodyTruncated: request.requestBodyTruncated === true,
			responseBodyTruncated: request.responseBodyTruncated === true,
			requestBodyOmitted: request.requestBodyOmitted === true,
			responseBodyOmitted: request.responseBodyOmitted === true,
			redactedFields: [...(request.redactedFields ?? [])],
			secretReferences: [...(request.secretReferences ?? [])],
		};
	}

	toCurl(
		requestId: string,
		options: { redactSensitiveHeaders?: boolean; reviewMutation?: boolean } = {},
	): PageNetworkCurlResult {
		const request = this.requireRequest(requestId);
		if (isMutationMethod(request.method) && options.reviewMutation !== true) {
			throw new Error(
				`Refusing to export replay command for mutating ${request.method} request without explicit mutation review`,
			);
		}
		const parts = ["curl", "-X", shellEscape(request.method), shellEscape(request.url)];
		for (const [key, value] of Object.entries(request.requestHeaders ?? {})) {
			parts.push("-H", shellEscape(`${key}: ${value}`));
		}
		if (request.requestBody !== undefined) parts.push("--data-raw", shellEscape(request.requestBody));
		return {
			scope: this.getScope(),
			requestId,
			command: parts.join(" "),
			redactedHeaders: [...(request.redactedHeaders ?? [])],
		};
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await this.stop();
	}

	private async startLifecycle(lifecycle: CaptureLifecycle, signal?: AbortSignal): Promise<PageNetworkStats> {
		try {
			await this.cdp.acquire(lifecycle.owner);
			lifecycle.acquired = true;
			this.assertStartCanContinue(lifecycle, signal);
			this.installListeners(lifecycle);
			await this.cdp.ensureDomain("Network");
			this.assertStartCanContinue(lifecycle, signal);
			lifecycle.phase = "active";
			return this.stats();
		} catch (error) {
			await this.cleanupLifecycle(lifecycle, true).catch(() => undefined);
			throw error;
		}
	}

	private assertStartCanContinue(lifecycle: CaptureLifecycle, signal?: AbortSignal): void {
		throwIfAborted(signal);
		if (lifecycle.stopRequested || this.disposed) throw new Error("Page network capture start was stopped");
		if (lifecycle.transportClosed || this.transportClosed)
			throw new Error("Page CDP session closed during network start");
		if (this.lifecycle !== lifecycle) throw new Error("Page network capture was superseded");
	}

	private installListeners(lifecycle: CaptureLifecycle): void {
		lifecycle.removeListeners.push(
			this.cdp.onEvent("Network.requestWillBeSent", (payload) => this.upsertRequest(lifecycle, payload)),
		);
		lifecycle.removeListeners.push(
			this.cdp.onEvent("Network.responseReceived", (payload) => this.updateResponse(lifecycle, payload)),
		);
		lifecycle.removeListeners.push(
			this.cdp.onEvent("Network.loadingFinished", (payload) => {
				void this.finishRequest(lifecycle, payload);
			}),
		);
		lifecycle.removeListeners.push(
			this.cdp.onEvent("Network.loadingFailed", (payload) => this.failRequest(lifecycle, payload)),
		);
		lifecycle.removeListeners.push(this.cdp.onClose(() => this.handleTransportClose(lifecycle)));
	}

	private async stopLifecycle(lifecycle: CaptureLifecycle): Promise<PageNetworkStats> {
		lifecycle.phase = "stopping";
		let releaseError: unknown;
		try {
			await this.cleanupLifecycle(lifecycle, true);
		} catch (error) {
			releaseError = error;
		}
		if (releaseError) throw releaseError;
		return this.stats();
	}

	private async cleanupLifecycle(lifecycle: CaptureLifecycle, release: boolean): Promise<void> {
		this.removeLifecycleListeners(lifecycle);
		lifecycle.phase = "inactive";
		if (this.lifecycle === lifecycle) this.lifecycle = undefined;
		if (release && lifecycle.acquired && !lifecycle.transportClosed) {
			lifecycle.acquired = false;
			await this.cdp.release(lifecycle.owner);
		}
	}

	private removeLifecycleListeners(lifecycle: CaptureLifecycle): void {
		for (const remove of lifecycle.removeListeners.splice(0)) {
			try {
				remove();
			} catch {
				// Cleanup is best-effort and must continue through all subscriptions.
			}
		}
	}

	private handleTransportClose(lifecycle: CaptureLifecycle): void {
		if (!this.isCurrentLifecycle(lifecycle)) return;
		lifecycle.transportClosed = true;
		lifecycle.acquired = false;
		lifecycle.phase = "inactive";
		this.transportClosed = true;
		this.removeLifecycleListeners(lifecycle);
		if (this.lifecycle === lifecycle) this.lifecycle = undefined;
	}

	private isCurrentLifecycle(lifecycle: CaptureLifecycle): boolean {
		return (
			this.lifecycle === lifecycle &&
			(lifecycle.phase === "starting" || lifecycle.phase === "active") &&
			!lifecycle.transportClosed
		);
	}

	private upsertRequest(lifecycle: CaptureLifecycle, payload: Record<string, unknown>): void {
		if (!this.isCurrentLifecycle(lifecycle)) return;
		const requestId = stringValue(payload.requestId);
		if (!requestId) return;
		const requestPayload = asRecord(payload.request);
		const existing = this.requests.get(requestId);
		const rawUrl = stringValue(requestPayload?.url);
		const request: PageNetworkRequest = existing ?? {
			requestId,
			method: stringValue(requestPayload?.method) || "GET",
			url: rawUrl,
			startedAt: Date.now(),
			hasRequestBody: false,
			hasResponseBody: false,
		};
		request.method = stringValue(requestPayload?.method) || request.method;
		const source = networkSecretSource(rawUrl || request.url, "request");
		const redactedUrl = this.redactor.redactUrl(rawUrl || request.url, `${source}.url`);
		request.url = redactedUrl.url;
		request.redactedFields = uniqueStrings([...(request.redactedFields ?? []), ...redactedUrl.redactedFields]);
		request.secretReferences = uniqueStrings([...(request.secretReferences ?? []), ...redactedUrl.secretReferences]);
		request.resourceType = optionalString(payload.type) ?? request.resourceType;
		const rawHeaders = stringMapFrom(requestPayload?.headers);
		const headers = this.redactor.redactHeaders(rawHeaders, `${source}.header`);
		request.requestHeaders = headers.headers;
		request.redactedHeaders = uniqueStrings([...(request.redactedHeaders ?? []), ...headers.redactedHeaders]);
		request.secretReferences = uniqueStrings([...(request.secretReferences ?? []), ...headers.secretReferences]);
		this.setRequestBody(
			request,
			optionalString(requestPayload?.postData),
			headerValue(rawHeaders, "content-type"),
			`${source}.body`,
		);
		if (!existing) this.order.push(requestId);
		this.requests.set(requestId, request);
		this.evictOverflow();
	}

	private updateResponse(lifecycle: CaptureLifecycle, payload: Record<string, unknown>): void {
		if (!this.isCurrentLifecycle(lifecycle)) return;
		const request = this.requests.get(stringValue(payload.requestId));
		if (!request) return;
		const response = asRecord(payload.response);
		request.status = typeof response?.status === "number" ? response.status : request.status;
		const rawHeaders = stringMapFrom(response?.headers);
		const headers = this.redactor.redactHeaders(rawHeaders, `${networkSecretSource(request.url, "response")}.header`);
		request.responseHeaders = headers.headers;
		request.redactedHeaders = uniqueStrings([...(request.redactedHeaders ?? []), ...headers.redactedHeaders]);
		request.secretReferences = uniqueStrings([...(request.secretReferences ?? []), ...headers.secretReferences]);
		request.contentType =
			optionalString(response?.mimeType) ?? headerValue(rawHeaders, "content-type") ?? request.contentType;
	}

	private async finishRequest(lifecycle: CaptureLifecycle, payload: Record<string, unknown>): Promise<void> {
		if (!this.isCurrentLifecycle(lifecycle)) return;
		const requestId = stringValue(payload.requestId);
		const request = this.requests.get(requestId);
		if (!request) return;
		request.endedAt = Date.now();
		request.durationMs = request.endedAt - request.startedAt;
		try {
			const result = await this.cdp.send<{ body?: string; base64Encoded?: boolean }>("Network.getResponseBody", {
				requestId,
			});
			if (!this.isCurrentLifecycle(lifecycle) || this.requests.get(requestId) !== request) return;
			const body = result.base64Encoded === true ? undefined : optionalString(result.body);
			this.setResponseBody(request, body);
		} catch {
			// CDP does not expose bodies for every resource type.
		}
	}

	private failRequest(lifecycle: CaptureLifecycle, payload: Record<string, unknown>): void {
		if (!this.isCurrentLifecycle(lifecycle)) return;
		const request = this.requests.get(stringValue(payload.requestId));
		if (!request) return;
		request.endedAt = Date.now();
		request.durationMs = request.endedAt - request.startedAt;
	}

	private setRequestBody(
		request: PageNetworkRequest,
		body: string | undefined,
		contentType: string | undefined,
		source: string,
	): void {
		this.storedBodyBytes -= utf8ByteLength(request.requestBody);
		if (body === undefined) {
			request.requestBody = undefined;
			request.requestBodySize = undefined;
			request.requestBodyTruncated = false;
			request.requestBodyOmitted = false;
			request.hasRequestBody = false;
			return;
		}
		const redacted = this.redactor.redactBody(body, contentType, source);
		request.redactedFields = uniqueStrings([...(request.redactedFields ?? []), ...redacted.redactedFields]);
		request.secretReferences = uniqueStrings([...(request.secretReferences ?? []), ...redacted.secretReferences]);
		request.requestBodyOmitted = redacted.omitted;
		request.requestBodySize = utf8ByteLength(body);
		request.hasRequestBody = true;
		if (redacted.text === undefined) {
			request.requestBody = undefined;
			request.requestBodyTruncated = false;
			return;
		}
		const bounded = boundUtf8Text(redacted.text, this.maxBodyBytes);
		request.requestBody = bounded.text;
		request.requestBodyTruncated = bounded.truncated;
		this.storedBodyBytes += bounded.storedBytes;
	}

	private setResponseBody(request: PageNetworkRequest, body: string | undefined): void {
		this.storedBodyBytes -= utf8ByteLength(request.responseBody);
		if (body === undefined) {
			request.responseBody = undefined;
			request.responseBodySize = undefined;
			request.responseBodyTruncated = false;
			request.responseBodyOmitted = false;
			request.hasResponseBody = false;
			return;
		}
		const redacted = this.redactor.redactBody(
			body,
			request.contentType,
			`${networkSecretSource(request.url, "response")}.body`,
		);
		request.redactedFields = uniqueStrings([...(request.redactedFields ?? []), ...redacted.redactedFields]);
		request.secretReferences = uniqueStrings([...(request.secretReferences ?? []), ...redacted.secretReferences]);
		request.responseBodyOmitted = redacted.omitted;
		request.responseBodySize = utf8ByteLength(body);
		request.hasResponseBody = true;
		if (redacted.text === undefined) {
			request.responseBody = undefined;
			request.responseBodyTruncated = false;
			return;
		}
		const bounded = boundUtf8Text(redacted.text, this.maxBodyBytes);
		request.responseBody = bounded.text;
		request.responseBodyTruncated = bounded.truncated;
		this.storedBodyBytes += bounded.storedBytes;
	}

	private evictOverflow(): void {
		while (this.order.length > this.maxEntries) {
			const oldestId = this.order.shift();
			if (!oldestId) break;
			const removed = this.requests.get(oldestId);
			if (!removed) continue;
			this.storedBodyBytes -= utf8ByteLength(removed.requestBody) + utf8ByteLength(removed.responseBody);
			this.requests.delete(oldestId);
			this.evictedRequests += 1;
		}
		this.storedBodyBytes = Math.max(0, this.storedBodyBytes);
	}

	private requireRequest(requestId: string): PageNetworkRequest {
		const request = this.requests.get(requestId);
		if (!request) throw new Error(`Captured request ${requestId} was not found`);
		return request;
	}
}

function boundUtf8Text(value: string, maxBytes: number): BoundedText {
	const originalBytes = utf8ByteLength(value);
	if (originalBytes <= maxBytes) {
		return { text: value, originalBytes, storedBytes: originalBytes, truncated: false };
	}
	let storedBytes = 0;
	const parts: string[] = [];
	for (const character of value) {
		const characterBytes = utf8ByteLength(character);
		if (storedBytes + characterBytes > maxBytes) break;
		parts.push(character);
		storedBytes += characterBytes;
	}
	return { text: parts.join(""), originalBytes, storedBytes, truncated: true };
}

function cloneRequest(
	request: PageNetworkRequest,
	options: { redactSensitiveHeaders?: boolean; omitBodies?: boolean } = {},
): PageNetworkRequest {
	const cloned: PageNetworkRequest = {
		...request,
		requestHeaders: cloneHeaders(request.requestHeaders),
		responseHeaders: cloneHeaders(request.responseHeaders),
		redactedHeaders: [...(request.redactedHeaders ?? [])],
		redactedFields: [...(request.redactedFields ?? [])],
		secretReferences: [...(request.secretReferences ?? [])],
	};
	if (options.omitBodies) {
		delete cloned.requestBody;
		delete cloned.responseBody;
	}
	return cloned;
}

function cloneHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	return { ...headers };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringMapFrom(value: unknown): Record<string, string> | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(record)) result[key] = String(entry);
	return Object.keys(result).length > 0 ? result : undefined;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function utf8ByteLength(value: string | undefined): number {
	return value === undefined ? 0 : new TextEncoder().encode(value).length;
}

function normalizePositiveInteger(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
	return value;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
	return value;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("limit must be a non-negative safe integer");
	return value;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Page network capture start aborted");
}

function shellEscape(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
	return entry?.[1];
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function isMutationMethod(method: string): boolean {
	return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function networkSecretSource(url: string, direction: "request" | "response"): string {
	try {
		const parsed = new URL(url);
		if (parsed.protocol === "http:" || parsed.protocol === "https:") return `${direction}.${parsed.origin}`;
	} catch {
		// Invalid and non-network URLs receive a non-origin-specific fail-closed slot.
	}
	return `${direction}.unknown-origin`;
}
