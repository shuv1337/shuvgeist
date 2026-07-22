import {
	PerformanceTools,
	parsePerformanceMetrics,
	summarizePerformanceMetrics,
} from "@shuvgeist/extension/tools/performance-tools";

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
	sendCommand = vi.fn(async (_tabId: number, method: string, _params?: Record<string, unknown>) => {
		if (method === "Performance.getMetrics") {
			return {
				metrics: [
					{ name: "NavigationStart", value: 1 },
					{ name: "DomContentLoaded", value: 12 },
					{ name: "LoadEvent", value: 20 },
					{ name: "JSHeapUsedSize", value: 1024 },
				],
			};
		}
		return {};
	});
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

describe("performance-tools helpers", () => {
	it("parses and summarizes metric maps", () => {
		const parsed = parsePerformanceMetrics([
			{ name: "NavigationStart", value: 10 },
			{ name: "DomContentLoaded", value: 50 },
			{ name: "LoadEvent", value: 80 },
		]);
		expect(parsed).toEqual({
			NavigationStart: 10,
			DomContentLoaded: 50,
			LoadEvent: 80,
		});
		expect(summarizePerformanceMetrics(parsed)).toMatchObject({
			navigationStart: 10,
			domContentLoaded: 50,
			loadEventEnd: 80,
			domContentLoadedDeltaMs: 40,
		});
	});
});

describe("PerformanceTools", () => {
	it("collects one-shot metrics", async () => {
		const manager = new FakeDebuggerManager();
		const tools = new PerformanceTools({ debuggerManager: manager });

		const result = await tools.collectMetrics(5);
		expect(result.tabId).toBe(5);
		expect(result.metrics.NavigationStart).toBe(1);
		expect(result.summary.domContentLoadedDeltaMs).toBe(11);
		expect(manager.ensureDomain).toHaveBeenCalledWith(5, "Performance");
	});

	it("captures bounded trace events and returns summary on stop", async () => {
		const manager = new FakeDebuggerManager();
		const tools = new PerformanceTools({ debuggerManager: manager });

		await tools.startTrace(6, { maxEvents: 2, timeoutMs: 1000, categories: ["cat-a"] });
		manager.emit(6, "Tracing.dataCollected", { value: [{ id: 1 }, { id: 2 }, { id: 3 }] });
		manager.emit(6, "Tracing.tracingComplete", {});

		const result = await tools.stopTrace(6);
		expect(result.tabId).toBe(6);
		expect(result.eventCount).toBe(2);
		expect(result.truncated).toBe(true);
		expect(result.timedOut).toBe(false);
		expect(result.categories).toEqual(["cat-a"]);
		expect(manager.release).toHaveBeenCalled();
	});
});
