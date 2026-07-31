import { NetworkCaptureEngine } from "@shuvgeist/extension/tools/network-capture";

type DebuggerListener = (
	method: string,
	params: Record<string, unknown> | undefined,
	source: chrome.debugger.Debuggee,
) => void;

class FakeDebuggerManager {
	acquire = vi.fn(async (_tabId: number, _owner: string) => undefined);
	release = vi.fn(async (_tabId: number, _owner: string) => undefined);
	ensureDomain = vi.fn(
		async (
			_tabId: number,
			_domain: "Runtime" | "Network" | "Page" | "Performance" | "Tracing",
		) => undefined,
	);
	sendCommand = vi.fn(async (_tabId: number, method: string, params?: Record<string, unknown>) => {
		if (method === "Network.getResponseBody") {
			const requestId = String(params?.requestId ?? "");
			return this.responseBodies.get(requestId) ?? {};
		}
		return {};
	});

	private readonly listeners = new Map<number, Set<DebuggerListener>>();
	private readonly responseBodies = new Map<string, { body: string; base64Encoded?: boolean }>();

	addEventListener(tabId: number, listener: DebuggerListener): () => void {
		const set = this.listeners.get(tabId) ?? new Set<DebuggerListener>();
		set.add(listener);
		this.listeners.set(tabId, set);
		return () => {
			const current = this.listeners.get(tabId);
			current?.delete(listener);
		};
	}

	emit(tabId: number, method: string, params: Record<string, unknown> = {}): void {
		for (const listener of this.listeners.get(tabId) ?? []) {
			listener(method, params, { tabId });
		}
	}

	setResponseBody(requestId: string, body: string, base64Encoded = false): void {
		this.responseBodies.set(requestId, { body, base64Encoded });
	}
}

describe("NetworkCaptureEngine", () => {
	it("maintains a bounded ring buffer per tab", async () => {
		const manager = new FakeDebuggerManager();
		const engine = new NetworkCaptureEngine({
			debuggerManager: manager,
			maxRequestsPerTab: 2,
		});

		await engine.startCapture(10);
		manager.emit(10, "Network.requestWillBeSent", {
			requestId: "a",
			type: "Document",
			request: { url: "https://example.com/1", method: "GET" },
		});
		manager.emit(10, "Network.requestWillBeSent", {
			requestId: "b",
			type: "Document",
			request: { url: "https://example.com/2", method: "GET" },
		});
		manager.emit(10, "Network.requestWillBeSent", {
			requestId: "c",
			type: "Document",
			request: { url: "https://example.com/3", method: "GET" },
		});

		const list = engine.list(10);
		expect(list).toHaveLength(2);
		expect(list.map((entry) => entry.url)).toEqual(["https://example.com/3", "https://example.com/2"]);
		expect(engine.stats(10).evictedRequests).toBe(1);
	});

	it("captures response bodies with truncation caps", async () => {
		const manager = new FakeDebuggerManager();
		const engine = new NetworkCaptureEngine({
			debuggerManager: manager,
			maxBodyBytesPerEntry: 5,
		});

		await engine.startCapture(11);
		manager.setResponseBody("body-1", '{"value":"abcdefghij"}', false);
		manager.emit(11, "Network.requestWillBeSent", {
			requestId: "body-1",
			type: "XHR",
			request: { url: "https://api.example.com/items", method: "GET" },
		});
		manager.emit(11, "Network.responseReceived", {
			requestId: "body-1",
			response: { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
		});
		manager.emit(11, "Network.loadingFinished", {
			requestId: "body-1",
			encodedDataLength: 123,
		});

		const req = engine.list(11)[0];
		let body = engine.getBody(11, req.id, "response");
		for (let attempt = 0; !body && attempt < 4; attempt++) {
			await Promise.resolve();
			body = engine.getBody(11, req.id, "response");
		}
		expect(body).toBeDefined();
		expect(body?.text.length).toBeLessThanOrEqual(5);
		expect(body?.truncated).toBe(true);
	});

	it("exports redacted curl commands by default", async () => {
		const manager = new FakeDebuggerManager();
		const engine = new NetworkCaptureEngine({
			debuggerManager: manager,
		});

		await engine.startCapture(12);
		manager.emit(12, "Network.requestWillBeSent", {
			requestId: "curl-1",
			type: "Fetch",
			request: {
				url: "https://api.example.com/private",
				method: "POST",
				headers: {
					Authorization: "Bearer secret-token",
					Cookie: "session=s3cr3t",
					"Content-Type": "application/json",
					"X-Trace-Id": "trace-1",
				},
				postData: "{\"ok\":true}",
			},
		});

		const requestId = engine.list(12)[0].id;
		expect(() => engine.toCurl(12, requestId)).toThrow(/explicit mutation review/u);
		const redacted = engine.toCurl(12, requestId, { reviewMutation: true });
		expect(redacted.command).toContain("Authorization: {{shuvgeist-secret:");
		expect(redacted.command).toContain("Cookie: session={{shuvgeist-secret:");
		expect(redacted.command).toContain("X-Trace-Id: trace-1");
		expect(redacted.command).toContain("--data-raw");
		expect(redacted.redactedHeaders).toEqual(expect.arrayContaining(["Authorization", "Cookie"]));

		const rawRequested = engine.toCurl(12, requestId, {
			redactSensitiveHeaders: false,
			reviewMutation: true,
		});
		expect(rawRequested.command).not.toContain("Bearer secret-token");
		expect(rawRequested.command).not.toContain("session=s3cr3t");
	});
});
