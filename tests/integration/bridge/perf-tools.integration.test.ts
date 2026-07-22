import { PerformanceTools } from "@shuvgeist/extension/tools/performance-tools";

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

describe("performance tools integration (module-level)", () => {
	it("supports trace lifecycle with timeout fallback", async () => {
		const manager = new FakeDebuggerManager();
		const perf = new PerformanceTools({ debuggerManager: manager });

		await perf.startTrace(44, { timeoutMs: 10, maxEvents: 5, categories: ["timeline"] });
		manager.emit(44, "Tracing.dataCollected", { value: [{ name: "event-a" }] });

		const result = await perf.stopTrace(44);
		expect(result.tabId).toBe(44);
		expect(result.eventCount).toBe(1);
		expect(result.timedOut).toBe(true);
		expect(perf.isTraceActive(44)).toBe(false);
	});
});
