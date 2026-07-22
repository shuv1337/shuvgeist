const { buildBrowserJsWrapperFunctionCode, generateBridgeCode, navigateExecute } = vi.hoisted(() => ({
	buildBrowserJsWrapperFunctionCode: vi.fn(
		() => "async function() { return { success: true, lastValue: null }; }",
	),
	generateBridgeCode: vi.fn(() => "window.sendRuntimeMessage = () => {};"),
	navigateExecute: vi.fn(),
}));

vi.mock("@shuv1337/pi-web-ui/sandbox/RuntimeMessageBridge.js", () => ({
	RuntimeMessageBridge: {
		generateBridgeCode,
	},
}));

vi.mock("@shuvgeist/extension/storage/app-storage", () => ({
	getShuvgeistStorage: vi.fn(() => ({
		skills: {
			getSkillsForUrl: vi.fn().mockResolvedValue([]),
		},
	})),
}));

vi.mock("@shuvgeist/extension/tools/helpers/browser-target", () => ({
	isProtectedTabUrl: vi.fn((url: string | undefined) => url?.startsWith("chrome://") === true),
	resolveTabTarget: vi.fn().mockResolvedValue({
		tab: { id: 42, url: "https://example.com" },
		tabId: 42,
		frameId: 0,
	}),
}));

vi.mock("@shuvgeist/extension/tools/helpers/debugger-manager", () => ({
	getSharedDebuggerManager: vi.fn(() => ({})),
}));

vi.mock("@shuvgeist/extension/tools/NativeInputEventsRuntimeProvider", () => ({
	NativeInputEventsRuntimeProvider: class {
		getRuntime() {
			return () => {};
		}

		async handleMessage(_message: unknown, respond: (response: unknown) => void) {
			respond({ success: true });
		}
	},
}));

vi.mock("@shuvgeist/extension/tools/navigate", () => ({
	NavigateTool: class {
		execute = navigateExecute;
	},
}));

vi.mock("@shuvgeist/extension/tools/repl/userscripts-helpers", () => ({
	checkUserScriptsAvailability: vi.fn().mockResolvedValue({ available: true }),
	buildBrowserJsWrapperFunctionCode,
}));

import {
	handleBgBrowserJs,
	handleBgNavigate,
	resolveBackgroundUserScriptMessage,
} from "@shuvgeist/extension/bridge/background-runtime-handler";

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
		buildBrowserJsWrapperFunctionCode.mockClear();
		installChromeMock({
			configureWorld: vi.fn().mockResolvedValue(undefined),
			execute: vi.fn().mockResolvedValue([
				{
					result: {
						success: true,
						value: { success: true, lastValue: { title: "Example" } },
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

	it("injects offscreen attachment and artifact snapshots through the canonical generated wrapper", async () => {
		await handleBgBrowserJs(
			{
				code: "() => [listAttachments(), getArtifact('report.json')]",
				args: "[]",
				providerData: {
					attachments: [{ id: "attachment-1", fileName: "notes.txt", content: "aGVsbG8=" }],
					artifacts: { "report.json": '{"ok":true}' },
				},
				providerRuntimes: ["function (_sandboxId) { window.listAttachments = () => window.attachments; }"],
			},
			7,
		);

		expect(buildBrowserJsWrapperFunctionCode).toHaveBeenCalledTimes(1);
		const options = buildBrowserJsWrapperFunctionCode.mock.calls[0]?.[0];
		expect(options).toMatchObject({
			userCode: "() => [listAttachments(), getArtifact('report.json')]",
			args: [],
		});
		expect(options?.setupCode).toContain('window["attachments"] =');
		expect(options?.setupCode).toContain('window["artifacts"] =');
		expect(options?.setupCode).toContain("window.listAttachments");
	});

	it("returns nested browserjs artifact writes and deletes to the exact offscreen caller", async () => {
		userScriptsMock().execute.mockImplementation(async () => {
			const sandboxId = generateBridgeCode.mock.calls.at(-1)?.[0].sandboxId;
			if (typeof sandboxId !== "string") throw new Error("sandbox id missing");
			const responses: unknown[] = [];
			resolveBackgroundUserScriptMessage(
				{
					type: "artifact-operation",
					action: "createOrUpdate",
					filename: "created.json",
					content: '{"created":true}',
					sandboxId,
				},
				{},
				(response) => responses.push(response),
			);
			resolveBackgroundUserScriptMessage(
				{ type: "artifact-operation", action: "delete", filename: "old.txt", sandboxId },
				{},
				(response) => responses.push(response),
			);
			expect(responses).toHaveLength(2);
			return [
				{
					result: {
						success: true,
						value: { success: true, lastValue: "done" },
						console: [],
					},
				},
			];
		});

		await expect(
			handleBgBrowserJs(
				{
					code: "async () => 'done'",
					args: "[]",
					providerData: { artifacts: { "old.txt": "old" } },
				},
				7,
			),
		).resolves.toMatchObject({
			success: true,
			result: "done",
			artifactMutations: [
				{ action: "put", filename: "created.json", content: '{"created":true}' },
				{ action: "delete", filename: "old.txt" },
			],
		});
	});

	it("preserves the background browserjs error envelope", async () => {
		userScriptsMock().execute.mockResolvedValue([
			{
				result: {
					success: true,
					value: { success: false, error: "boom", stack: "stack" },
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
