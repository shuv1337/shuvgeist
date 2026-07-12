const navigateExecute = vi.hoisted(() => vi.fn());

vi.mock("@shuv1337/pi-web-ui/sandbox/RuntimeMessageBridge.js", () => ({
	RuntimeMessageBridge: {
		generateBridgeCode: vi.fn(() => "window.sendRuntimeMessage = () => {};"),
	},
}));

vi.mock("../../../src/storage/app-storage.js", () => ({
	getShuvgeistStorage: vi.fn(() => ({
		skills: {
			getSkillsForUrl: vi.fn().mockResolvedValue([]),
		},
	})),
}));

vi.mock("../../../src/tools/helpers/browser-target.js", () => ({
	isProtectedTabUrl: vi.fn((url: string | undefined) => url?.startsWith("chrome://") === true),
	resolveTabTarget: vi.fn().mockResolvedValue({
		tab: { id: 42, url: "https://example.com" },
		tabId: 42,
		frameId: 0,
	}),
}));

vi.mock("../../../src/tools/helpers/debugger-manager.js", () => ({
	getSharedDebuggerManager: vi.fn(() => ({})),
}));

vi.mock("../../../src/tools/NativeInputEventsRuntimeProvider.js", () => ({
	NativeInputEventsRuntimeProvider: class {
		getRuntime() {
			return () => {};
		}

		async handleMessage(_message: unknown, respond: (response: unknown) => void) {
			respond({ success: true });
		}
	},
}));

vi.mock("../../../src/tools/navigate.js", () => ({
	NavigateTool: class {
		execute = navigateExecute;
	},
}));

vi.mock("../../../src/tools/repl/userscripts-helpers.js", () => ({
	checkUserScriptsAvailability: vi.fn().mockResolvedValue({ available: true }),
}));

import { handleBgBrowserJs, handleBgNavigate } from "../../../src/bridge/background-runtime-handler.js";

interface ChromeUserScriptsMock {
	configureWorld: ReturnType<typeof vi.fn>;
	execute: ReturnType<typeof vi.fn>;
	terminate: ReturnType<typeof vi.fn>;
}

function installChromeMock(userScripts: ChromeUserScriptsMock) {
	(globalThis as typeof globalThis & { chrome: { userScripts: ChromeUserScriptsMock } }).chrome = {
		userScripts,
	};
}

function userScriptsMock(): ChromeUserScriptsMock {
	return (globalThis as typeof globalThis & { chrome: { userScripts: ChromeUserScriptsMock } }).chrome.userScripts;
}

describe("handleBgBrowserJs", () => {
	beforeEach(() => {
		navigateExecute.mockReset();
		installChromeMock({
			configureWorld: vi.fn().mockResolvedValue(undefined),
			execute: vi.fn().mockResolvedValue([
				{
					result: {
						success: true,
						value: { title: "Example" },
						console: [{ type: "log", text: "loaded" }],
					},
				},
			]),
			terminate: vi.fn().mockResolvedValue(undefined),
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves the background browserjs success envelope", async () => {
		await expect(
			handleBgBrowserJs(
				{
					code: "() => ({ title: document.title })",
					args: "[]",
				},
				undefined,
			),
		).resolves.toEqual({
			success: true,
			result: { title: "Example" },
			console: [{ type: "log", text: "loaded" }],
		});

		expect(userScriptsMock().configureWorld).toHaveBeenCalledWith(
			expect.objectContaining({
				worldId: "shuvgeist-browser-script",
				messaging: true,
			}),
		);
		expect(userScriptsMock().execute).toHaveBeenCalledWith(
			expect.objectContaining({
				target: { tabId: 42, allFrames: false },
				world: "USER_SCRIPT",
				worldId: "shuvgeist-browser-script",
				executionId: expect.any(String),
			}),
		);
	});

	it("preserves the background browserjs error envelope", async () => {
		userScriptsMock().execute.mockResolvedValue([
			{
				result: {
					success: false,
					error: "boom",
					stack: "stack",
					console: [{ type: "error", text: "bad" }],
				},
			},
		]);

		await expect(
			handleBgBrowserJs(
				{
					code: "() => { throw new Error('boom') }",
					args: "[]",
				},
				undefined,
			),
		).resolves.toEqual({
			success: false,
			error: "boom",
			stack: "stack",
			console: [{ type: "error", text: "bad" }],
		});
	});

	it("preserves the existing no-result envelope", async () => {
		userScriptsMock().execute.mockResolvedValue([]);

		await expect(
			handleBgBrowserJs(
				{
					code: "() => 'missing'",
					args: "[]",
				},
				undefined,
			),
		).resolves.toEqual({
			success: true,
			error: "No result returned from script execution",
			console: [],
		});
	});

	it("preserves tabId in background navigate responses", async () => {
		navigateExecute.mockResolvedValue({
			details: {
				finalUrl: "https://example.com",
				title: "Example",
				tabId: 42,
				skills: [],
			},
		});

		await expect(handleBgNavigate({ url: "https://example.com" }, undefined)).resolves.toEqual({
			success: true,
			result: {
				finalUrl: "https://example.com",
				title: "Example",
				tabId: 42,
				skills: [],
			},
		});
	});

	it("preserves close/list fields in background navigate responses", async () => {
		navigateExecute.mockResolvedValue({
			details: {
				closedTabIds: [9, 10],
				skipped: [],
				dryRun: false,
				ok: true,
				tabs: [{ id: 1, url: "https://left.test", title: "Left", active: true, windowId: 1, index: 0, pinned: false }],
			},
		});

		await expect(handleBgNavigate({ closeTabs: [9, 10] }, undefined)).resolves.toEqual({
			success: true,
			result: {
				closedTabIds: [9, 10],
				skipped: [],
				dryRun: false,
				ok: true,
				tabs: [{ id: 1, url: "https://left.test", title: "Left", active: true, windowId: 1, index: 0, pinned: false }],
			},
		});
	});
});
