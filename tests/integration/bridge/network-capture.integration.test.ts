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
	sendCommand = vi.fn(async (_tabId: number, _method: string, _params?: Record<string, unknown>) => ({}));
	private readonly listeners = new Map<number, Set<DebuggerListener>>();

	addEventListener(tabId: number, listener: DebuggerListener): () => void {
		const listeners = this.listeners.get(tabId) ?? new Set<DebuggerListener>();
		listeners.add(listener);
		this.listeners.set(tabId, listeners);
		return () => listeners.delete(listener);
	}

	emit(tabId: number, method: string, params: Record<string, unknown> = {}): void {
		for (const listener of this.listeners.get(tabId) ?? []) {
			listener(method, params, { tabId });
		}
	}
}

describe("network capture integration (module-level)", () => {
	it("runs start -> capture -> list -> stop lifecycle", async () => {
		const manager = new FakeDebuggerManager();
		const engine = new NetworkCaptureEngine({
			debuggerManager: manager,
			maxRequestsPerTab: 10,
		});

		const start = await engine.startCapture(33);
		expect(start.alreadyCapturing).toBe(false);
		expect(engine.isCapturing(33)).toBe(true);

		manager.emit(33, "Network.requestWillBeSent", {
			requestId: "req-1",
			type: "Fetch",
			request: { url: "https://example.com/api", method: "GET", headers: { Accept: "application/json" } },
		});
		manager.emit(33, "Network.responseReceived", {
			requestId: "req-1",
			response: { status: 200, statusText: "OK", headers: { "content-type": "application/json" } },
		});
		manager.emit(33, "Network.loadingFinished", { requestId: "req-1", encodedDataLength: 200 });
		await Promise.resolve();

		const listed = engine.list(33);
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			url: "https://example.com/api",
			method: "GET",
			status: 200,
		});

		const stop = await engine.stopCapture(33);
		expect(stop.stopped).toBe(true);
		expect(engine.isCapturing(33)).toBe(false);
		expect(manager.release).toHaveBeenCalled();
	});
});
