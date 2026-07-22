const navigateExecute = vi.fn();
const selectExecute = vi.fn();
const extractExecute = vi.fn();
const debuggerExecute = vi.fn();

vi.mock("@shuvgeist/extension/tools/navigate", () => ({
	NavigateTool: class {
		execute = navigateExecute;
	},
}));

vi.mock("@shuvgeist/extension/tools/ask-user-which-element", () => ({
	AskUserWhichElementTool: class {
		execute = selectExecute;
	},
}));

vi.mock("@shuvgeist/extension/tools/extract-image", () => ({
	ExtractImageTool: class {
		windowId?: number;
		execute = extractExecute;
	},
}));

vi.mock("@shuvgeist/extension/tools/debugger", () => ({
	DebuggerTool: class {
		execute = debuggerExecute;
	},
}));

vi.mock("@shuvgeist/extension/tools/NativeInputEventsRuntimeProvider", () => ({
	NativeInputEventsRuntimeProvider: class {},
}));

vi.mock("@shuvgeist/extension/tools/repl/runtime-providers", () => ({
	BrowserJsRuntimeProvider: class {
		constructor(_providers: unknown[]) {}
	},
	NavigateRuntimeProvider: class {
		constructor(_tool: unknown) {}
	},
}));

declare global {
	var chrome: {
		tabs: { query: ReturnType<typeof vi.fn> };
		runtime: { getURL: ReturnType<typeof vi.fn> };
	};
}

globalThis.chrome = {
	tabs: {
		query: vi.fn(),
	},
	runtime: {
		getURL: vi.fn((value: string) => `chrome-extension://test/${value}`),
	},
};

const { BrowserCommandExecutor } = await import("@shuvgeist/extension/bridge/browser-command-executor");

describe("BrowserCommandExecutor branch coverage", () => {
	beforeEach(() => {
		navigateExecute.mockReset();
		selectExecute.mockReset();
		extractExecute.mockReset();
		debuggerExecute.mockReset();
		chrome.tabs.query.mockReset();
	});

	it("handles missing tab data, missing screenshot payloads, repl without router, and unknown methods", async () => {
		chrome.tabs.query.mockResolvedValue([{}]);
		const executor = new BrowserCommandExecutor({ windowId: 7, sensitiveAccessEnabled: false });
		await expect(executor.status()).resolves.toMatchObject({ activeTab: { url: undefined, title: undefined, tabId: undefined } });

		extractExecute.mockResolvedValue({ content: [], details: {} });
		await expect(executor.screenshot({})).rejects.toThrow("Screenshot tool returned no image data");
		await expect(executor.repl({ title: "No router", code: "1" })).rejects.toMatchObject({
			code: -32008,
			message: "REPL router is not available",
		});
		await expect(executor.dispatch("unknown_method" as never, {})).rejects.toThrow("Unknown method: unknown_method");
	});
});
