import type { CdpSession, ChromeDebuggerDetachListener } from "@shuvgeist/driver/cdp-session";
import type { PageDriver, PageDriverFactoryOptions } from "@shuvgeist/driver/page-driver";
import { ChromePageDriverRegistry } from "@shuvgeist/extension/bridge/chrome-page-driver-registry";

function tab(id: number, windowId: number): chrome.tabs.Tab {
	return { id, windowId, index: 0, pinned: false, highlighted: false, active: true, incognito: false };
}

describe("ChromePageDriverRegistry", () => {
	it("reuses one driver for a stable tab identity and rejects it after a foreign-window move", async () => {
		let currentWindowId = 7;
		const dispose = vi.fn(async () => {});
		const created: PageDriverFactoryOptions[] = [];
		const manager = createManager();
		const registry = new ChromePageDriverRegistry({
			ownerWindowId: 7,
			sessionId: "bridge-session",
			debuggerManager: manager,
			resolveTarget: async () => ({ tabId: 42, tab: tab(42, currentWindowId), source: "explicit" }),
			createDriver: (_cdp, options) => {
				created.push(options);
				return { dispose } as unknown as PageDriver;
			},
		});

		const first = await registry.resolve(42);
		const second = await registry.resolve(42);
		expect(second.driver).toBe(first.driver);
		expect(created).toHaveLength(1);
		expect(created[0]?.identity).toEqual({
			transport: "chrome-debugger",
			sessionId: "bridge-session",
			windowId: "7",
			pageId: "42",
		});

		currentWindowId = 9;
		await expect(registry.resolve(42)).rejects.toThrow(
			"Chrome tab 42 belongs to window 9, not authorized window 7",
		);
		expect(dispose).toHaveBeenCalledOnce();
		expect(created).toHaveLength(1);
		expect(registry.getByTabId(42)).toBeUndefined();
	});

	it("evicts on debugger detach and disposes every remaining driver exactly once", async () => {
		const disposals = new Map<number, ReturnType<typeof vi.fn>>();
		const manager = createManager();
		const registry = new ChromePageDriverRegistry({
			ownerWindowId: 7,
			debuggerManager: manager,
			resolveTarget: async ({ tabId }) => {
				const resolvedId = tabId ?? 1;
				return { tabId: resolvedId, tab: tab(resolvedId, 7), source: "explicit" };
			},
			createDriver: (_cdp, options) => {
				const pageId = Number(options.identity.pageId);
				const dispose = vi.fn(async () => {});
				disposals.set(pageId, dispose);
				return { dispose } as unknown as PageDriver;
			},
		});

		await registry.resolve(1);
		await registry.resolve(2);
		manager.detach(1);
		await vi.waitFor(() => expect(disposals.get(1)).toHaveBeenCalledOnce());
		expect(registry.getByTabId(1)).toBeUndefined();
		expect(registry.getByTabId(2)).toBeDefined();

		await registry.dispose();
		expect(disposals.get(1)).toHaveBeenCalledOnce();
		expect(disposals.get(2)).toHaveBeenCalledOnce();
		await expect(registry.resolve(2)).rejects.toThrow("disposed");
	});

	it("evicts a driver whose lifetime initialization fails so the next resolve retries", async () => {
		const manager = createManager();
		const disposals: Array<ReturnType<typeof vi.fn>> = [];
		let attempts = 0;
		const registry = new ChromePageDriverRegistry({
			ownerWindowId: 7,
			debuggerManager: manager,
			resolveTarget: async () => ({ tabId: 42, tab: tab(42, 7), source: "explicit" }),
			createDriver: () => {
				attempts += 1;
				const dispose = vi.fn(async () => {});
				disposals.push(dispose);
				return {
					ready: attempts === 1 ? Promise.reject(new Error("Page.enable failed")) : Promise.resolve(),
					dispose,
				} as unknown as PageDriver;
			},
		});

		await expect(registry.resolve(42)).rejects.toThrow("Page.enable failed");
		expect(disposals[0]).toHaveBeenCalledOnce();
		expect(registry.getByTabId(42)).toBeUndefined();
		await expect(registry.resolve(42)).resolves.toMatchObject({ tabId: 42 });
		expect(attempts).toBe(2);
	});
});

function createManager(): {
	cdpSession(tabId: number): CdpSession;
	addDetachListener(tabId: number, listener: ChromeDebuggerDetachListener): () => void;
	detach(tabId: number): void;
} {
	const listeners = new Map<number, Set<ChromeDebuggerDetachListener>>();
	return {
		cdpSession(tabId) {
			return { target: { kind: "chrome-debugger", id: String(tabId) } } as unknown as CdpSession;
		},
		addDetachListener(tabId, listener) {
			let set = listeners.get(tabId);
			if (!set) {
				set = new Set();
				listeners.set(tabId, set);
			}
			set.add(listener);
			return () => set?.delete(listener);
		},
		detach(tabId) {
			for (const listener of [...(listeners.get(tabId) ?? [])]) listener({ tabId, reason: "target_closed" });
		},
	};
}
