const navigateExecute = vi.fn();
const selectExecute = vi.fn();
const replExecute = vi.fn();
const extractExecute = vi.fn();
const debuggerExecute = vi.fn();

vi.mock("../../../src/tools/navigate.js", () => ({
	NavigateTool: class {
		execute = navigateExecute;
	},
}));

vi.mock("../../../src/tools/index.js", () => ({
	AskUserWhichElementTool: class {
		execute = selectExecute;
	},
}));

vi.mock("../../../src/tools/repl/repl.js", () => ({
	createReplTool: () => ({
		execute: replExecute,
		sandboxUrlProvider: undefined,
		runtimeProvidersFactory: undefined,
	}),
}));

vi.mock("../../../src/tools/extract-image.js", () => ({
	ExtractImageTool: class {
		windowId?: number;
		execute = extractExecute;
	},
}));

vi.mock("../../../src/tools/debugger.js", () => ({
	DebuggerTool: class {
		execute = debuggerExecute;
	},
}));

vi.mock("../../../src/tools/NativeInputEventsRuntimeProvider.js", () => ({
	NativeInputEventsRuntimeProvider: class {},
}));

vi.mock("../../../src/tools/repl/runtime-providers.js", () => ({
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

const { BrowserCommandExecutor } = await import("../../../src/bridge/browser-command-executor.js");

describe("BrowserCommandExecutor branch coverage", () => {
	beforeEach(() => {
		navigateExecute.mockReset();
		selectExecute.mockReset();
		replExecute.mockReset();
		extractExecute.mockReset();
		debuggerExecute.mockReset();
		chrome.tabs.query.mockReset();
	});

	it("handles missing tab data, missing screenshot payloads, and unknown methods", async () => {
		chrome.tabs.query.mockResolvedValue([{}]);
		const executor = new BrowserCommandExecutor({ windowId: 7, debuggerEnabled: false });
		await expect(executor.status()).resolves.toMatchObject({ activeTab: { url: undefined, title: undefined, tabId: undefined } });

		extractExecute.mockResolvedValue({ content: [], details: {} });
		await expect(executor.screenshot({})).rejects.toThrow("Screenshot tool returned no image data");
		await expect(executor.dispatch("unknown_method" as never, {})).rejects.toThrow("Unknown method: unknown_method");
	});
});
