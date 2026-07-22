import { isUsableWindowId, resolveTabTarget } from "@shuvgeist/extension/tools/helpers/browser-target";

declare global {
	// biome-ignore lint/style/noVar: test-only global augmentation
	var chrome: {
		tabs: {
			query: ReturnType<typeof vi.fn>;
			get: ReturnType<typeof vi.fn>;
		};
		windows?: {
			WINDOW_ID_NONE: number;
		};
	};
}

describe("isUsableWindowId", () => {
	it("accepts positive integer window ids", () => {
		expect(isUsableWindowId(1)).toBe(true);
		expect(isUsableWindowId(7)).toBe(true);
		expect(isUsableWindowId(987654)).toBe(true);
	});

	it("rejects undefined", () => {
		expect(isUsableWindowId(undefined)).toBe(false);
	});

	it("rejects zero", () => {
		expect(isUsableWindowId(0)).toBe(false);
	});

	it("rejects negative ids", () => {
		expect(isUsableWindowId(-1)).toBe(false);
		expect(isUsableWindowId(-999)).toBe(false);
	});

	it("rejects chrome.windows.WINDOW_ID_NONE (-1)", () => {
		// chrome.windows.WINDOW_ID_NONE is -1 in the Chrome API.
		const WINDOW_ID_NONE = -1;
		expect(isUsableWindowId(WINDOW_ID_NONE)).toBe(false);
	});

	it("rejects non-integer or non-finite numbers", () => {
		expect(isUsableWindowId(1.5)).toBe(false);
		expect(isUsableWindowId(Number.NaN)).toBe(false);
		expect(isUsableWindowId(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isUsableWindowId(Number.NEGATIVE_INFINITY)).toBe(false);
	});
});

describe("resolveTabTarget", () => {
	beforeEach(() => {
		globalThis.chrome = {
			tabs: {
				query: vi.fn(),
				get: vi.fn(),
			},
		};
	});

	it("uses explicit windowId when valid", async () => {
		chrome.tabs.query.mockResolvedValue([{ id: 42, url: "https://example.com" }]);
		const result = await resolveTabTarget({ windowId: 7 });
		expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, windowId: 7 });
		expect(result.tabId).toBe(42);
		expect(result.source).toBe("active");
	});

	it("falls back to currentWindow when windowId is 0", async () => {
		chrome.tabs.query.mockResolvedValue([{ id: 42 }]);
		await resolveTabTarget({ windowId: 0 });
		expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
	});

	it("falls back to currentWindow when windowId is undefined", async () => {
		chrome.tabs.query.mockResolvedValue([{ id: 42 }]);
		await resolveTabTarget({});
		expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
	});

	it("falls back to currentWindow for negative window ids", async () => {
		chrome.tabs.query.mockResolvedValue([{ id: 42 }]);
		await resolveTabTarget({ windowId: -1 });
		expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
	});

	it("falls back to currentWindow for chrome.windows.WINDOW_ID_NONE", async () => {
		chrome.tabs.query.mockResolvedValue([{ id: 42 }]);
		// chrome.windows.WINDOW_ID_NONE is -1 in the Chrome API.
		await resolveTabTarget({ windowId: -1 });
		expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
	});

	it("uses chrome.tabs.get for an explicit tab when no usable window restriction exists", async () => {
		chrome.tabs.get.mockResolvedValue({ id: 99, url: "https://example.com/x" });
		const result = await resolveTabTarget({ tabId: 99, windowId: 0 });
		expect(chrome.tabs.get).toHaveBeenCalledWith(99);
		expect(chrome.tabs.query).not.toHaveBeenCalled();
		expect(result.tabId).toBe(99);
		expect(result.source).toBe("explicit");
	});

	it("rejects an explicit tab that belongs to another authorized window", async () => {
		chrome.tabs.get.mockResolvedValue({ id: 99, windowId: 8, url: "https://example.com/x" });
		await expect(resolveTabTarget({ tabId: 99, windowId: 7 })).rejects.toThrow(
			"Tab 99 belongs to window 8, not authorized window 7",
		);
		expect(chrome.tabs.query).not.toHaveBeenCalled();
	});

	it("accepts an explicit tab in the authorized window", async () => {
		chrome.tabs.get.mockResolvedValue({ id: 99, windowId: 7, url: "https://example.com/x" });
		await expect(resolveTabTarget({ tabId: 99, windowId: 7 })).resolves.toMatchObject({
			tabId: 99,
			source: "explicit",
		});
	});

	it("throws when no active tab can be resolved", async () => {
		chrome.tabs.query.mockResolvedValue([]);
		await expect(resolveTabTarget({})).rejects.toThrow("No active tab found");
	});
});
