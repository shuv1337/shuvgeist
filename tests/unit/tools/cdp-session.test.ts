import {
	ChromeDebuggerSession,
	type ChromeDebuggerDetachListener,
	type ChromeDebuggerEventListener,
	type ChromeDebuggerManagerLike,
	type CdpSessionDomain,
} from "@shuvgeist/driver/cdp-session";

class FakeChromeDebuggerManager implements ChromeDebuggerManagerLike {
	readonly acquireCalls: Array<{ tabId: number; owner: string }> = [];
	readonly releaseCalls: Array<{ tabId: number; owner: string }> = [];
	readonly ensureDomainCalls: Array<{ tabId: number; domain: CdpSessionDomain }> = [];
	readonly sendCalls: Array<{ tabId: number; method: string; params?: Record<string, unknown> }> = [];
	private readonly eventListeners = new Map<number, Set<ChromeDebuggerEventListener>>();
	private readonly detachListeners = new Map<number, Set<ChromeDebuggerDetachListener>>();
	nextResult: unknown = { ok: true };

	async acquireWithTrace(tabId: number, owner: string): Promise<void> {
		this.acquireCalls.push({ tabId, owner });
	}

	async releaseWithTrace(tabId: number, owner: string): Promise<void> {
		this.releaseCalls.push({ tabId, owner });
	}

	async ensureDomainWithTrace(tabId: number, domain: CdpSessionDomain): Promise<void> {
		this.ensureDomainCalls.push({ tabId, domain });
	}

	async sendCommandWithTrace<T = unknown>(
		tabId: number,
		method: string,
		params?: Record<string, unknown>,
	): Promise<T> {
		this.sendCalls.push({ tabId, method, params });
		return this.nextResult as T;
	}

	addEventListener(tabId: number, listener: ChromeDebuggerEventListener): () => void {
		const listeners = this.eventListeners.get(tabId) ?? new Set<ChromeDebuggerEventListener>();
		listeners.add(listener);
		this.eventListeners.set(tabId, listeners);
		return () => listeners.delete(listener);
	}

	addDetachListener(tabId: number, listener: ChromeDebuggerDetachListener): () => void {
		const listeners = this.detachListeners.get(tabId) ?? new Set<ChromeDebuggerDetachListener>();
		listeners.add(listener);
		this.detachListeners.set(tabId, listeners);
		return () => listeners.delete(listener);
	}

	emit(tabId: number, method: string, params: Record<string, unknown> = {}): void {
		for (const listener of this.eventListeners.get(tabId) ?? []) listener(method, params, { tabId });
	}

	detach(tabId: number, reason: string): void {
		for (const listener of this.detachListeners.get(tabId) ?? []) listener({ tabId, reason });
	}
}

describe("ChromeDebuggerSession", () => {
	it("acquires, releases, ensures domains, and sends through the debugger manager", async () => {
		const manager = new FakeChromeDebuggerManager();
		manager.nextResult = { result: 4 };
		const session = new ChromeDebuggerSession({ tabId: 44, manager });

		await session.acquire("owner-a");
		await session.ensureDomain("Page");
		await session.ensureDomain("Runtime", { suppressRuntimeEnable: true });
		await expect(session.send("Runtime.evaluate", { expression: "2 + 2" })).resolves.toEqual({ result: 4 });
		await session.release("owner-a");

		expect(manager.acquireCalls).toEqual([{ tabId: 44, owner: "owner-a" }]);
		expect(manager.ensureDomainCalls).toEqual([{ tabId: 44, domain: "Page" }]);
		expect(manager.sendCalls).toEqual([{ tabId: 44, method: "Runtime.evaluate", params: { expression: "2 + 2" } }]);
		expect(manager.releaseCalls).toEqual([{ tabId: 44, owner: "owner-a" }]);
	});

	it("tracks navigation generation from page navigation and detach events", async () => {
		const manager = new FakeChromeDebuggerManager();
		const session = new ChromeDebuggerSession({ tabId: 45, manager });
		const closeReasons: unknown[] = [];
		session.onClose((reason) => closeReasons.push(reason));

		expect(session.navigationGeneration).toBe(0);
		manager.emit(45, "Network.requestWillBeSent");
		expect(session.navigationGeneration).toBe(0);
		manager.emit(45, "Page.frameNavigated");
		expect(session.navigationGeneration).toBe(1);
		manager.detach(45, "target_closed");
		expect(session.navigationGeneration).toBe(2);
		expect(closeReasons).toEqual(["target_closed"]);
	});
});
