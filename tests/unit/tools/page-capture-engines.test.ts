import type {
	CdpSession,
	CdpSessionCloseListener,
	CdpSessionDomain,
	CdpSessionEnsureDomainOptions,
	CdpSessionEventListener,
	CdpSessionTarget,
	CdpSessionTraceOptions,
} from "@shuvgeist/driver/cdp-session";
import {
	createPageDriverScope,
	createPageIdentity,
	type PageDriverScope,
} from "@shuvgeist/driver/page-driver-identity";
import { createPageNetworkEngine } from "@shuvgeist/driver/page-network-engine";
import {
	createPageScreencastEngine,
	type PageScreencastHandlers,
} from "@shuvgeist/driver/page-screencast-engine";

interface BodyResponse {
	body?: string;
	base64Encoded?: boolean;
}

class FakeCdpSession implements CdpSession {
	readonly target: CdpSessionTarget;
	readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
	readonly acquiredOwners: string[] = [];
	readonly releasedOwners: string[] = [];
	readonly ensuredDomains: CdpSessionDomain[] = [];
	private readonly eventListeners = new Map<string, Set<CdpSessionEventListener>>();
	private readonly closeListeners = new Set<CdpSessionCloseListener>();
	private readonly bodyResponses = new Map<string, BodyResponse | Promise<BodyResponse>>();
	private readonly failedMethods = new Map<string, Error>();
	private generation = 0;

	constructor(id: string) {
		this.target = { kind: "electron-ws", id };
	}

	get navigationGeneration(): number {
		return this.generation;
	}

	async acquire(owner: string, _trace?: CdpSessionTraceOptions): Promise<void> {
		this.acquiredOwners.push(owner);
	}

	async release(owner: string, _trace?: CdpSessionTraceOptions): Promise<void> {
		this.releasedOwners.push(owner);
	}

	async ensureDomain(domain: CdpSessionDomain, _options?: CdpSessionEnsureDomainOptions): Promise<void> {
		this.ensuredDomains.push(domain);
	}

	async send<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		_trace?: CdpSessionTraceOptions,
	): Promise<T> {
		this.calls.push({ method, params });
		const failure = this.failedMethods.get(method);
		if (failure) throw failure;
		if (method === "Network.getResponseBody") {
			const requestId = String(params?.requestId ?? "");
			return (await (this.bodyResponses.get(requestId) ?? {})) as T;
		}
		if (method === "Page.captureScreenshot") return { data: "c2VlZA==" } as T;
		return {} as T;
	}

	onEvent(method: string, listener: CdpSessionEventListener): () => void {
		const listeners = this.eventListeners.get(method) ?? new Set<CdpSessionEventListener>();
		listeners.add(listener);
		this.eventListeners.set(method, listeners);
		return () => listeners.delete(listener);
	}

	onClose(listener: CdpSessionCloseListener): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	emit(method: string, params: Record<string, unknown> = {}): void {
		if (method === "Page.frameNavigated") this.generation += 1;
		for (const listener of this.eventListeners.get(method) ?? []) listener(params);
	}

	closeWithReason(reason: unknown = "target_closed"): void {
		this.generation += 1;
		for (const listener of Array.from(this.closeListeners)) listener(reason);
	}

	setBody(requestId: string, response: BodyResponse | Promise<BodyResponse>): void {
		this.bodyResponses.set(requestId, response);
	}

	fail(method: string, message: string): void {
		this.failedMethods.set(method, new Error(message));
	}

	listenerCount(method: string): number {
		return this.eventListeners.get(method)?.size ?? 0;
	}
}

function scopeFor(cdp: FakeCdpSession, pageId: string): () => PageDriverScope {
	const identity = createPageIdentity("websocket-cdp", {
		sessionId: `session-${pageId}`,
		windowId: `window-${pageId}`,
		pageId,
	});
	return () => createPageDriverScope(identity, cdp.navigationGeneration);
}

function emitRequest(
	cdp: FakeCdpSession,
	requestId: string,
	options: { url?: string; headers?: Record<string, string>; postData?: string } = {},
): void {
	cdp.emit("Network.requestWillBeSent", {
		requestId,
		type: "Fetch",
		request: {
			method: options.postData === undefined ? "GET" : "POST",
			url: options.url ?? `https://example.test/${requestId}`,
			headers: options.headers,
			postData: options.postData,
		},
	});
}

function createScreencastHandlers() {
	return {
		onFrame: vi.fn<PageScreencastHandlers["onFrame"]>(),
		onComplete: vi.fn<PageScreencastHandlers["onComplete"]>(),
	};
}

describe("page capture engines", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps bounded network state isolated per page and counts stored UTF-8 body bytes", async () => {
		const firstCdp = new FakeCdpSession("first");
		const secondCdp = new FakeCdpSession("second");
		const first = createPageNetworkEngine({ cdp: firstCdp, getScope: scopeFor(firstCdp, "first") });
		const second = createPageNetworkEngine({ cdp: secondCdp, getScope: scopeFor(secondCdp, "second") });
		await first.start({ maxEntries: 2, maxBodyBytes: 5 });
		await second.start();

		emitRequest(firstCdp, "oldest");
		emitRequest(firstCdp, "body");
		firstCdp.emit("Page.frameNavigated");
		emitRequest(firstCdp, "secret", {
			headers: { Authorization: "Bearer secret", "X-Trace": "visible" },
			postData: "x",
		});
		firstCdp.emit("Network.responseReceived", {
			requestId: "secret",
			response: { status: 200, headers: { "Set-Cookie": "session=secret", Server: "fixture" } },
		});
		emitRequest(secondCdp, "other");
		firstCdp.setBody("body", { body: "ééé", base64Encoded: false });
		firstCdp.emit("Network.loadingFinished", { requestId: "body", encodedDataLength: 99 });

		await vi.waitFor(() => expect(first.get("body").request.hasResponseBody).toBe(true));
		expect(first.list().requests.map((request) => request.requestId)).toEqual(["secret", "body"]);
		expect(first.list().requests[0]).toMatchObject({
			requestHeaders: { Authorization: "<redacted>", "X-Trace": "visible" },
			responseHeaders: { "Set-Cookie": "<redacted>", Server: "fixture" },
			hasRequestBody: true,
		});
		expect(first.list().requests[0]).not.toHaveProperty("requestBody");
		expect(first.list().requests[1]).not.toHaveProperty("responseBody");
		expect(second.list().requests.map((request) => request.requestId)).toEqual(["other"]);
		expect(first.get("body").request).toMatchObject({
			responseBody: "éé",
			responseBodySize: 6,
			responseBodyTruncated: true,
		});
		expect(first.stats()).toMatchObject({ active: true, requestCount: 2, storedBodyBytes: 5, evictedRequests: 1 });
		expect(first.stats().scope).toMatchObject({ page: { pageId: "first" }, navigationGeneration: 1 });
		expect(second.stats().scope.page.pageId).toBe("second");
		expect(firstCdp.ensuredDomains).toEqual(["Network"]);

		const redacted = first.toCurl("secret");
		expect(redacted.command).toContain("Authorization: <redacted>");
		expect(redacted.command).toContain("X-Trace: visible");
		expect(redacted.redactedHeaders).toEqual(["Authorization"]);
		expect(first.toCurl("secret", { redactSensitiveHeaders: false }).command).toContain(
			"Authorization: Bearer secret",
		);

		await first.stop();
		expect(first.stats().active).toBe(false);
		expect(firstCdp.releasedOwners).toHaveLength(1);
		expect(firstCdp.listenerCount("Network.requestWillBeSent")).toBe(0);
	});

	it("invalidates late network bodies and cleans up safely when the CDP session closes", async () => {
		const cdp = new FakeCdpSession("late-body");
		let resolveBody!: (response: BodyResponse) => void;
		const delayedBody = new Promise<BodyResponse>((resolve) => {
			resolveBody = resolve;
		});
		cdp.setBody("request-1", delayedBody);
		const engine = createPageNetworkEngine({ cdp, getScope: scopeFor(cdp, "late-body") });
		await engine.start();
		emitRequest(cdp, "request-1");
		cdp.emit("Network.loadingFinished", { requestId: "request-1" });
		engine.clear();
		resolveBody({ body: "late response", base64Encoded: false });
		await Promise.resolve();
		await Promise.resolve();
		expect(engine.stats()).toMatchObject({ requestCount: 0, storedBodyBytes: 0 });

		cdp.closeWithReason();
		expect(engine.stats()).toMatchObject({ active: false });
		expect(engine.stats().scope.navigationGeneration).toBe(1);
		expect(cdp.releasedOwners).toEqual([]);
		expect(cdp.listenerCount("Network.loadingFinished")).toBe(0);
		await engine.dispose();
	});

	it("ACKs screencast frames, reports decoded source bytes, and completes user stop once", async () => {
		const cdp = new FakeCdpSession("record-user");
		const handlers = createScreencastHandlers();
		const engine = createPageScreencastEngine({
			cdp,
			getScope: scopeFor(cdp, "record-user"),
			captureSeedFrame: false,
		});
		const started = await engine.start({ maxDurationMs: 5_000 }, handlers);
		expect(cdp.ensuredDomains).toEqual(["Page"]);
		cdp.emit("Page.frameNavigated");
		cdp.emit("Page.screencastFrame", {
			data: "YWJj",
			sessionId: 7,
			metadata: { deviceWidth: 800 },
		});
		await vi.waitFor(() => expect(handlers.onFrame).toHaveBeenCalledOnce());

		expect(cdp.calls).toContainEqual({ method: "Page.screencastFrameAck", params: { sessionId: 7 } });
		expect(handlers.onFrame).toHaveBeenCalledWith(
			expect.objectContaining({
				recordingId: started.recordingId,
				seq: 0,
				dataBase64: "YWJj",
				metadata: { deviceWidth: 800 },
				scope: expect.objectContaining({ navigationGeneration: 1 }),
			}),
		);
		expect(engine.status()).toMatchObject({ active: true, sourceBytes: 3, frameCount: 1 });

		const summary = await engine.stop(started.recordingId);
		expect(summary).toMatchObject({ reason: "user", sourceBytes: 3, frameCount: 1 });
		expect(summary).not.toHaveProperty("encodedSizeBytes");
		expect(handlers.onComplete).toHaveBeenCalledOnce();
		expect(cdp.calls).toContainEqual({ method: "Page.stopScreencast", params: undefined });
		expect(cdp.releasedOwners).toHaveLength(1);
		cdp.closeWithReason();
		expect(handlers.onComplete).toHaveBeenCalledOnce();
	});

	it("completes autonomously at max duration and max decoded source bytes", async () => {
		vi.useFakeTimers();
		const durationCdp = new FakeCdpSession("max-duration");
		const durationHandlers = createScreencastHandlers();
		const durationEngine = createPageScreencastEngine({
			cdp: durationCdp,
			getScope: scopeFor(durationCdp, "max-duration"),
			captureSeedFrame: false,
		});
		await durationEngine.start({ maxDurationMs: 10 }, durationHandlers);
		await vi.advanceTimersByTimeAsync(10);
		await vi.waitFor(() => expect(durationHandlers.onComplete).toHaveBeenCalledOnce());
		expect(durationHandlers.onComplete).toHaveBeenCalledWith(expect.objectContaining({ reason: "max-duration" }));

		const bytesCdp = new FakeCdpSession("max-bytes");
		const bytesHandlers = createScreencastHandlers();
		const bytesEngine = createPageScreencastEngine({
			cdp: bytesCdp,
			getScope: scopeFor(bytesCdp, "max-bytes"),
			maxSourceBytes: 3,
			captureSeedFrame: false,
		});
		await bytesEngine.start({ maxDurationMs: 1_000 }, bytesHandlers);
		bytesCdp.emit("Page.screencastFrame", { data: "YWJjZA==", sessionId: 2 });
		await vi.waitFor(() => expect(bytesHandlers.onComplete).toHaveBeenCalledOnce());
		expect(bytesHandlers.onComplete).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "max-bytes", sourceBytes: 4, frameCount: 1 }),
		);
	});

	it("completes exactly once for abort, target close, and frame ACK errors", async () => {
		const abortCdp = new FakeCdpSession("abort");
		const abortHandlers = createScreencastHandlers();
		const abortController = new AbortController();
		const abortEngine = createPageScreencastEngine({
			cdp: abortCdp,
			getScope: scopeFor(abortCdp, "abort"),
			captureSeedFrame: false,
		});
		await abortEngine.start({ maxDurationMs: 1_000, signal: abortController.signal }, abortHandlers);
		abortController.abort("cancelled");
		await vi.waitFor(() => expect(abortHandlers.onComplete).toHaveBeenCalledOnce());
		expect(abortHandlers.onComplete).toHaveBeenCalledWith(expect.objectContaining({ reason: "abort" }));

		const closeCdp = new FakeCdpSession("close");
		const closeHandlers = createScreencastHandlers();
		const closeEngine = createPageScreencastEngine({
			cdp: closeCdp,
			getScope: scopeFor(closeCdp, "close"),
			captureSeedFrame: false,
		});
		await closeEngine.start({ maxDurationMs: 1_000 }, closeHandlers);
		closeCdp.closeWithReason("gone");
		await vi.waitFor(() => expect(closeHandlers.onComplete).toHaveBeenCalledOnce());
		expect(closeHandlers.onComplete).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "target-closed", lastError: "gone" }),
		);
		expect(closeCdp.releasedOwners).toEqual([]);
		await closeEngine.dispose();
		expect(closeHandlers.onComplete).toHaveBeenCalledOnce();

		const errorCdp = new FakeCdpSession("error");
		errorCdp.fail("Page.screencastFrameAck", "ack failed");
		const errorHandlers = createScreencastHandlers();
		const errorEngine = createPageScreencastEngine({
			cdp: errorCdp,
			getScope: scopeFor(errorCdp, "error"),
			captureSeedFrame: false,
		});
		await errorEngine.start({ maxDurationMs: 1_000 }, errorHandlers);
		errorCdp.emit("Page.screencastFrame", { data: "YWJj", sessionId: 4 });
		await vi.waitFor(() => expect(errorHandlers.onComplete).toHaveBeenCalledOnce());
		expect(errorHandlers.onComplete).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "error", lastError: "ack failed" }),
		);
		errorCdp.closeWithReason();
		expect(errorHandlers.onComplete).toHaveBeenCalledOnce();
	});
});
