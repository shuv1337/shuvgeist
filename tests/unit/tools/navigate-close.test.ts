import { NavigateTool } from "../../../src/tools/navigate.js";

declare global {
	// biome-ignore lint/style/noVar: test-only global augmentation
	var chrome: {
		tabs: {
			query: ReturnType<typeof vi.fn>;
			get: ReturnType<typeof vi.fn>;
			remove: ReturnType<typeof vi.fn>;
			update: ReturnType<typeof vi.fn>;
			create: ReturnType<typeof vi.fn>;
			onUpdated: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
		};
		windows: {
			getAll: ReturnType<typeof vi.fn>;
			get: ReturnType<typeof vi.fn>;
			remove: ReturnType<typeof vi.fn>;
			update: ReturnType<typeof vi.fn>;
		};
		webNavigation: {
			onDOMContentLoaded: { addListener: ReturnType<typeof vi.fn>; removeListener: ReturnType<typeof vi.fn> };
		};
	};
}

function makeTab(
	partial: Partial<chrome.tabs.Tab> & { id: number; url?: string; title?: string },
): chrome.tabs.Tab {
	return {
		index: 0,
		pinned: false,
		highlighted: false,
		windowId: 1,
		active: false,
		incognito: false,
		selected: false,
		discarded: false,
		autoDiscardable: true,
		groupId: -1,
		title: partial.title ?? "Untitled",
		url: partial.url ?? "https://example.com",
		status: "complete",
		...partial,
	} as chrome.tabs.Tab;
}

describe("NavigateTool close + list enrichment", () => {
	let tool: NavigateTool;

	beforeEach(() => {
		tool = new NavigateTool();
		globalThis.chrome = {
			tabs: {
				query: vi.fn(),
				get: vi.fn(),
				remove: vi.fn().mockResolvedValue(undefined),
				update: vi.fn(),
				create: vi.fn(),
				onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
			},
			windows: {
				getAll: vi.fn().mockResolvedValue([
					{ id: 10, focused: true, type: "normal" },
					{ id: 20, focused: false, type: "normal" },
				]),
				get: vi.fn(),
				remove: vi.fn().mockResolvedValue(undefined),
				update: vi.fn(),
			},
			webNavigation: {
				onDOMContentLoaded: { addListener: vi.fn(), removeListener: vi.fn() },
			},
		};
	});

	it("listTabs returns windowId, index, pinned, status and windows summary", async () => {
		chrome.tabs.query.mockResolvedValue([
			makeTab({ id: 1, windowId: 10, index: 0, pinned: true, active: true, title: "A", url: "https://a.test" }),
			makeTab({ id: 2, windowId: 20, index: 1, pinned: false, active: true, title: "B", url: "https://b.test" }),
		]);

		const result = await tool.execute("t1", { listTabs: true });
		expect(result.details.tabs).toEqual([
			expect.objectContaining({
				id: 1,
				windowId: 10,
				index: 0,
				pinned: true,
				active: true,
				status: "complete",
				title: "A",
				url: "https://a.test",
			}),
			expect.objectContaining({
				id: 2,
				windowId: 20,
				index: 1,
				pinned: false,
			}),
		]);
		expect(result.details.windows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 10, focused: true, tabCount: 1 }),
				expect.objectContaining({ id: 20, focused: false, tabCount: 1 }),
			]),
		);
	});

	it("closeTab removes existing tab and returns closedTabIds", async () => {
		chrome.tabs.get.mockResolvedValue(makeTab({ id: 5, title: "Close me", url: "https://x.test" }));
		chrome.tabs.query.mockResolvedValue([]);
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", { closeTab: 5 });
		expect(chrome.tabs.remove).toHaveBeenCalledWith(5);
		expect(result.details.closedTabIds).toEqual([5]);
		expect(result.details.skipped).toEqual([]);
		expect(result.details.ok).toBe(true);
		expect(result.details.dryRun).toBe(false);
	});

	it("closeTab missing id is skipped and ok is false", async () => {
		chrome.tabs.get.mockRejectedValue(new Error("No tab with id: 999"));
		chrome.tabs.query.mockResolvedValue([]);
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", { closeTab: 999 });
		expect(chrome.tabs.remove).not.toHaveBeenCalled();
		expect(result.details.closedTabIds).toEqual([]);
		expect(result.details.skipped).toEqual([
			expect.objectContaining({ tabId: 999, reason: expect.stringContaining("No tab") }),
		]);
		expect(result.details.ok).toBe(false);
	});

	it("closeTabs partial failure closes what exists", async () => {
		chrome.tabs.get.mockImplementation(async (id: number) => {
			if (id === 1) return makeTab({ id: 1 });
			throw new Error("No tab with id: 2");
		});
		chrome.tabs.query.mockResolvedValue([]);
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", { closeTabs: [1, 2] });
		expect(chrome.tabs.remove).toHaveBeenCalledTimes(1);
		expect(chrome.tabs.remove).toHaveBeenCalledWith(1);
		expect(result.details.closedTabIds).toEqual([1]);
		expect(result.details.skipped).toEqual([expect.objectContaining({ tabId: 2 })]);
		expect(result.details.ok).toBe(false);
	});

	it("closeTabFilter titleIncludes only matches", async () => {
		chrome.tabs.query
			.mockResolvedValueOnce([
				makeTab({ id: 1, title: "shuvplan home", url: "http://localhost/a" }),
				makeTab({ id: 2, title: "other", url: "http://localhost/b" }),
				makeTab({ id: 3, title: "more shuvplan", url: "http://localhost/c" }),
			])
			.mockResolvedValueOnce([]);
		chrome.tabs.get.mockImplementation(async (id: number) => makeTab({ id, title: `t${id}` }));
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", { closeTabFilter: { titleIncludes: "shuvplan" } });
		expect(chrome.tabs.remove).toHaveBeenCalledWith(1);
		expect(chrome.tabs.remove).toHaveBeenCalledWith(3);
		expect(chrome.tabs.remove).not.toHaveBeenCalledWith(2);
		expect(result.details.closedTabIds).toEqual([1, 3]);
		expect(result.details.ok).toBe(true);
	});

	it("dryRun filter never calls remove", async () => {
		chrome.tabs.query
			.mockResolvedValueOnce([makeTab({ id: 7, title: "shuvplan", url: "http://x" })])
			.mockResolvedValueOnce([makeTab({ id: 7, title: "shuvplan", url: "http://x" })]);
		chrome.tabs.get.mockResolvedValue(makeTab({ id: 7, title: "shuvplan" }));
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", {
			closeTabFilter: { titleIncludes: "shuvplan" },
			dryRun: true,
		});
		expect(chrome.tabs.remove).not.toHaveBeenCalled();
		expect(result.details.closedTabIds).toEqual([7]);
		expect(result.details.dryRun).toBe(true);
		expect(result.details.ok).toBe(true);
	});

	it("skips pinned tabs by default in filters", async () => {
		chrome.tabs.query
			.mockResolvedValueOnce([
				makeTab({ id: 1, title: "pin me", pinned: true, url: "https://example.com/p" }),
				makeTab({ id: 2, title: "pin me free", pinned: false, url: "https://example.com/f" }),
			])
			.mockResolvedValueOnce([]);
		chrome.tabs.get.mockImplementation(async (id: number) => makeTab({ id }));
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", { closeTabFilter: { titleIncludes: "pin me" } });
		expect(chrome.tabs.remove).toHaveBeenCalledTimes(1);
		expect(chrome.tabs.remove).toHaveBeenCalledWith(2);
		expect(result.details.skipped).toEqual([
			expect.objectContaining({ tabId: 1, reason: expect.stringContaining("pinned") }),
		]);
	});

	it("skips protected URLs by default in filters", async () => {
		chrome.tabs.query
			.mockResolvedValueOnce([
				makeTab({ id: 1, title: "Settings", url: "chrome://settings" }),
				makeTab({ id: 2, title: "Settings clone", url: "https://example.com/settings" }),
			])
			.mockResolvedValueOnce([]);
		chrome.tabs.get.mockImplementation(async (id: number) => makeTab({ id }));
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", { closeTabFilter: { titleIncludes: "Settings" } });
		expect(chrome.tabs.remove).toHaveBeenCalledWith(2);
		expect(result.details.skipped).toEqual([
			expect.objectContaining({ tabId: 1, reason: expect.stringContaining("protected") }),
		]);
	});

	it("rejects url + closeTab combo", async () => {
		await expect(tool.execute("t1", { url: "https://example.com", closeTab: 1 })).rejects.toThrow(
			/mutually exclusive/i,
		);
		expect(chrome.tabs.remove).not.toHaveBeenCalled();
	});

	it("listWindows returns window summary", async () => {
		chrome.tabs.query.mockResolvedValue([
			makeTab({ id: 1, windowId: 10 }),
			makeTab({ id: 2, windowId: 10 }),
			makeTab({ id: 3, windowId: 20 }),
		]);

		const result = await tool.execute("t1", { listWindows: true });
		expect(result.details.windows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 10, tabCount: 2 }),
				expect.objectContaining({ id: 20, tabCount: 1 }),
			]),
		);
	});

	it("closeWindow dryRun does not remove", async () => {
		chrome.windows.get.mockResolvedValue({
			id: 10,
			tabs: [makeTab({ id: 1, title: "A" }), makeTab({ id: 2, title: "B" })],
		});
		chrome.tabs.query.mockResolvedValue([
			makeTab({ id: 1, title: "A" }),
			makeTab({ id: 2, title: "B" }),
		]);
		chrome.windows.getAll.mockResolvedValue([{ id: 10, focused: true, type: "normal" }]);

		const result = await tool.execute("t1", { closeWindow: 10, dryRun: true });
		expect(chrome.windows.remove).not.toHaveBeenCalled();
		expect(result.details.closedWindowIds).toEqual([10]);
		expect(result.details.closedTabIds).toEqual([1, 2]);
		expect(result.details.dryRun).toBe(true);
		expect(result.details.tabs).toBeDefined();
	});

	it("closeWindow removes window", async () => {
		chrome.windows.get.mockResolvedValue({
			id: 10,
			tabs: [makeTab({ id: 1 })],
		});
		chrome.tabs.query.mockResolvedValue([]);
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", { closeWindow: 10 });
		expect(chrome.windows.remove).toHaveBeenCalledWith(10);
		expect(result.details.closedWindowIds).toEqual([10]);
		expect(result.details.ok).toBe(true);
		expect(result.details.tabs).toEqual([]);
	});

	it("requireMatch sets ok false when nothing closed", async () => {
		chrome.tabs.query.mockResolvedValue([makeTab({ id: 1, title: "other" })]);
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", {
			closeTabFilter: { titleIncludes: "nomatch" },
			requireMatch: true,
		});
		expect(result.details.closedTabIds).toEqual([]);
		expect(result.details.ok).toBe(false);
	});

	it("includePinned allows closing pinned filter matches", async () => {
		chrome.tabs.query
			.mockResolvedValueOnce([makeTab({ id: 1, title: "pin me", pinned: true, url: "https://example.com/p" })])
			.mockResolvedValueOnce([]);
		chrome.tabs.get.mockResolvedValue(makeTab({ id: 1, title: "pin me", pinned: true }));
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", {
			closeTabFilter: { titleIncludes: "pin me", includePinned: true },
		});
		expect(chrome.tabs.remove).toHaveBeenCalledWith(1);
		expect(result.details.closedTabIds).toEqual([1]);
		expect(result.details.ok).toBe(true);
	});

	it("includeProtected allows closing chrome:// filter matches", async () => {
		chrome.tabs.query
			.mockResolvedValueOnce([makeTab({ id: 1, title: "Settings", url: "chrome://settings" })])
			.mockResolvedValueOnce([]);
		chrome.tabs.get.mockResolvedValue(makeTab({ id: 1, title: "Settings", url: "chrome://settings" }));
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", {
			closeTabFilter: { titleIncludes: "Settings", includeProtected: true },
		});
		expect(chrome.tabs.remove).toHaveBeenCalledWith(1);
		expect(result.details.closedTabIds).toEqual([1]);
	});

	it("does not treat about:blank as protected", async () => {
		chrome.tabs.query
			.mockResolvedValueOnce([makeTab({ id: 1, title: "New Tab", url: "about:blank" })])
			.mockResolvedValueOnce([]);
		chrome.tabs.get.mockResolvedValue(makeTab({ id: 1, title: "New Tab", url: "about:blank" }));
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", { closeTabFilter: { urlIncludes: "about:blank" } });
		expect(chrome.tabs.remove).toHaveBeenCalledWith(1);
		expect(result.details.closedTabIds).toEqual([1]);
	});

	it("sets ok false when every filter match is policy-skipped", async () => {
		chrome.tabs.query
			.mockResolvedValueOnce([makeTab({ id: 1, title: "x", pinned: true, url: "https://example.com" })])
			.mockResolvedValueOnce([makeTab({ id: 1, title: "x", pinned: true })]);
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", { closeTabFilter: { titleIncludes: "x" } });
		expect(chrome.tabs.remove).not.toHaveBeenCalled();
		expect(result.details.closedTabIds).toEqual([]);
		expect(result.details.skipped?.length).toBe(1);
		expect(result.details.ok).toBe(false);
	});

	it("sets ok false when filter remove-phase fails", async () => {
		chrome.tabs.query
			.mockResolvedValueOnce([makeTab({ id: 5, title: "race", url: "https://example.com" })])
			.mockResolvedValueOnce([]);
		chrome.tabs.get.mockRejectedValue(new Error("No tab with id: 5"));
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", { closeTabFilter: { titleIncludes: "race" } });
		expect(result.details.closedTabIds).toEqual([]);
		expect(result.details.skipped).toEqual([expect.objectContaining({ tabId: 5 })]);
		expect(result.details.ok).toBe(false);
	});

	it("closes explicit pinned and protected tabs without needing include flags", async () => {
		chrome.tabs.get.mockImplementation(async (id: number) => {
			if (id === 1) return makeTab({ id: 1, pinned: true, url: "https://example.com" });
			return makeTab({ id: 2, url: "chrome://settings" });
		});
		chrome.tabs.query.mockResolvedValue([]);
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", { closeTabs: [1, 2] });
		expect(chrome.tabs.remove).toHaveBeenCalledWith(1);
		expect(chrome.tabs.remove).toHaveBeenCalledWith(2);
		expect(result.details.closedTabIds).toEqual([1, 2]);
		expect(result.details.ok).toBe(true);
	});

	it("rejects closeWindow + closeTab combo", async () => {
		await expect(tool.execute("t1", { closeWindow: 10, closeTab: 1 })).rejects.toThrow(/mutually exclusive/i);
	});

	it("rejects closeTab + closeTabFilter combo", async () => {
		await expect(
			tool.execute("t1", { closeTab: 1, closeTabFilter: { titleIncludes: "x" } }),
		).rejects.toThrow(/mutually exclusive/i);
	});

	it("filters by urlIncludes, titlePattern, urlPattern, and windowId", async () => {
		chrome.tabs.query
			.mockResolvedValueOnce([
				makeTab({ id: 1, title: "alpha-end", url: "https://a.test/path", windowId: 10 }),
				makeTab({ id: 2, title: "beta", url: "https://b.test/path", windowId: 10 }),
				makeTab({ id: 3, title: "alpha-end", url: "https://a.test/other", windowId: 20 }),
			])
			.mockResolvedValueOnce([]);
		chrome.tabs.get.mockImplementation(async (id: number) => makeTab({ id }));
		chrome.windows.getAll.mockResolvedValue([]);

		const byUrl = await tool.execute("t1", { closeTabFilter: { urlIncludes: "b.test" } });
		expect(byUrl.details.closedTabIds).toEqual([2]);

		chrome.tabs.remove.mockClear();
		chrome.tabs.query
			.mockResolvedValueOnce([
				makeTab({ id: 1, title: "alpha-end", url: "https://a.test/path", windowId: 10 }),
				makeTab({ id: 3, title: "alpha-end", url: "https://a.test/other", windowId: 20 }),
			])
			.mockResolvedValueOnce([]);
		const byTitlePattern = await tool.execute("t1", { closeTabFilter: { titlePattern: "end$" } });
		expect(byTitlePattern.details.closedTabIds).toEqual([1, 3]);

		chrome.tabs.remove.mockClear();
		chrome.tabs.query
			.mockResolvedValueOnce([
				makeTab({ id: 1, title: "x", url: "https://match.example/page", windowId: 10 }),
				makeTab({ id: 2, title: "y", url: "https://other.example/page", windowId: 10 }),
			])
			.mockResolvedValueOnce([]);
		const byUrlPattern = await tool.execute("t1", { closeTabFilter: { urlPattern: "match\\.example" } });
		expect(byUrlPattern.details.closedTabIds).toEqual([1]);

		chrome.tabs.remove.mockClear();
		chrome.tabs.query
			.mockResolvedValueOnce([
				makeTab({ id: 1, title: "alpha-end", url: "https://a.test/path", windowId: 10 }),
				makeTab({ id: 3, title: "alpha-end", url: "https://a.test/other", windowId: 20 }),
			])
			.mockResolvedValueOnce([]);
		const byWindow = await tool.execute("t1", { closeTabFilter: { windowId: 20 } });
		expect(byWindow.details.closedTabIds).toEqual([3]);
	});

	it("rejects invalid titlePattern regex", async () => {
		await expect(tool.execute("t1", { closeTabFilter: { titlePattern: "(" } })).rejects.toThrow(/Invalid titlePattern/);
	});

	it("rejects empty closeTabFilter without matchers", async () => {
		await expect(tool.execute("t1", { closeTabFilter: {} })).rejects.toThrow(/requires at least one/);
	});

	it("closeWindow attaches remaining tabs inventory", async () => {
		chrome.windows.get.mockResolvedValue({
			id: 10,
			tabs: [makeTab({ id: 1 })],
		});
		chrome.tabs.query.mockResolvedValue([makeTab({ id: 99, windowId: 20, title: "survives" })]);
		chrome.windows.getAll.mockResolvedValue([{ id: 20, focused: true, type: "normal" }]);

		const result = await tool.execute("t1", { closeWindow: 10 });
		expect(result.details.tabs).toEqual([expect.objectContaining({ id: 99 })]);
		expect(result.details.windows).toEqual([expect.objectContaining({ id: 20, tabCount: 1 })]);
	});

	it("closeWindow missing id is ok false and includes inventory", async () => {
		chrome.windows.get.mockRejectedValue(new Error("No window with id: 404"));
		chrome.tabs.query.mockResolvedValue([makeTab({ id: 1 })]);
		chrome.windows.getAll.mockResolvedValue([{ id: 1, focused: true, type: "normal" }]);

		const result = await tool.execute("t1", { closeWindow: 404 });
		expect(result.details.ok).toBe(false);
		expect(result.details.closedWindowIds).toEqual([]);
		expect(result.details.tabs).toEqual([expect.objectContaining({ id: 1 })]);
	});

	it("window dry-run requireMatch with no tabs sets ok false", async () => {
		chrome.windows.get.mockResolvedValue({ id: 10, tabs: [] });
		chrome.tabs.query.mockResolvedValue([]);
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", { closeWindow: 10, dryRun: true, requireMatch: true });
		expect(result.details.dryRun).toBe(true);
		expect(result.details.closedTabIds).toEqual([]);
		expect(result.details.ok).toBe(false);
	});

	it("dryRun closeTabs never calls remove and lists would-close ids", async () => {
		chrome.tabs.get.mockImplementation(async (id: number) => makeTab({ id }));
		chrome.tabs.query.mockResolvedValue([makeTab({ id: 1 }), makeTab({ id: 2 })]);
		chrome.windows.getAll.mockResolvedValue([]);

		const result = await tool.execute("t1", { closeTabs: [1, 2], dryRun: true });
		expect(chrome.tabs.remove).not.toHaveBeenCalled();
		expect(result.details.closedTabIds).toEqual([1, 2]);
		expect(result.details.dryRun).toBe(true);
		expect(result.details.ok).toBe(true);
	});
});
