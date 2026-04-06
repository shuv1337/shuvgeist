import {
	buildRefLocatorBundle,
	capturePageSnapshot,
	locateByLabel,
	locateByRole,
	locateByText,
	PageSnapshotTool,
	type PageSnapshotResult,
} from "../../../src/tools/page-snapshot.js";

declare global {
	// biome-ignore lint/style/noVar: test-only global augmentation
	var chrome: {
		tabs: {
			query: ReturnType<typeof vi.fn>;
		};
		userScripts: {
			configureWorld: ReturnType<typeof vi.fn>;
			execute: ReturnType<typeof vi.fn>;
		};
	};
}

function fixtureSnapshot(): PageSnapshotResult {
	return {
		tabId: 15,
		frameId: 0,
		url: "https://example.com/login",
		title: "Login",
		generatedAt: 1,
		totalCandidates: 3,
		truncated: false,
		entries: [
			{
				snapshotId: "e1",
				tabId: 15,
				frameId: 0,
				tagName: "button",
				role: "button",
				name: "Sign in",
				text: "Sign in",
				label: "Sign in",
				attributes: { id: "login-button" },
				selectorCandidates: ["#login-button", "button.primary"],
				ordinalPath: [0, 1, 0],
				boundingBox: { x: 100, y: 100, width: 120, height: 36 },
				interactive: true,
			},
			{
				snapshotId: "e2",
				tabId: 15,
				frameId: 0,
				tagName: "input",
				role: "textbox",
				name: "Email",
				label: "Email address",
				attributes: { placeholder: "name@example.com" },
				selectorCandidates: ["input[name=email]"],
				ordinalPath: [0, 0, 1],
				boundingBox: { x: 100, y: 40, width: 200, height: 32 },
				interactive: true,
			},
			{
				snapshotId: "e3",
				tabId: 15,
				frameId: 0,
				tagName: "a",
				role: "link",
				name: "Forgot password",
				text: "Forgot password",
				attributes: { href: "/forgot" },
				selectorCandidates: ["a[href='/forgot']"],
				ordinalPath: [0, 2, 0],
				boundingBox: { x: 100, y: 160, width: 140, height: 22 },
				interactive: true,
			},
		],
	};
}

describe("page-snapshot helpers", () => {
	it("ranks locator matches and builds ref locator bundles", () => {
		const snapshot = fixtureSnapshot();

		expect(locateByRole(snapshot, "button")[0].entry.snapshotId).toBe("e1");
		expect(locateByText(snapshot, "forgot password")[0].entry.snapshotId).toBe("e3");
		expect(locateByLabel(snapshot, "email address")[0].entry.snapshotId).toBe("e2");

		const locator = buildRefLocatorBundle(snapshot.entries[0]);
		expect(locator).toEqual({
			selectorCandidates: ["#login-button", "button.primary"],
			semantic: {
				role: "button",
				name: "Sign in",
				text: "Sign in",
				label: "Sign in",
			},
			tagName: "button",
			attributes: { id: "login-button" },
			ordinalPath: [0, 1, 0],
			lastKnownBoundingBox: { x: 100, y: 100, width: 120, height: 36 },
		});
	});
});

describe("PageSnapshotTool", () => {
	beforeEach(() => {
		globalThis.chrome = {
			tabs: {
				query: vi.fn(),
			},
			userScripts: {
				configureWorld: vi.fn(),
				execute: vi.fn(),
			},
		};
	});

	it("captures snapshot data through chrome.userScripts", async () => {
		chrome.userScripts.execute.mockResolvedValue([
			{
				result: {
					success: true,
					result: {
						url: "https://example.com",
						title: "Example",
						generatedAt: 10,
						totalCandidates: 2,
						truncated: false,
						entries: [
							{
								snapshotId: "e1",
								frameId: 0,
								tagName: "button",
								role: "button",
								name: "Save",
								text: "Save",
								label: "Save",
								attributes: { id: "save" },
								selectorCandidates: ["#save"],
								ordinalPath: [1, 2, 0],
								boundingBox: { x: 1, y: 2, width: 3, height: 4 },
								interactive: true,
							},
						],
					},
				},
			},
		]);
		await expect(capturePageSnapshot({ tabId: 55 })).resolves.toMatchObject({
			tabId: 55,
			frameId: 0,
			url: "https://example.com",
			title: "Example",
			entries: [{ snapshotId: "e1", tabId: 55, frameId: 0 }],
		});
		expect(chrome.userScripts.configureWorld).toHaveBeenCalledWith({
			worldId: "shuvgeist-page-snapshot",
			messaging: true,
		});
		expect(chrome.userScripts.execute).toHaveBeenCalled();
	});

	it("resolves active tab fallback in tool execution", async () => {
		chrome.tabs.query.mockResolvedValue([{ id: 90 }]);
		chrome.userScripts.execute.mockResolvedValue([
			{
				result: {
					success: true,
					result: {
						url: "https://example.com",
						title: "Example",
						generatedAt: 10,
						totalCandidates: 0,
						truncated: false,
						entries: [],
					},
				},
			},
		]);

		const tool = new PageSnapshotTool();
		tool.windowId = 7;
		await expect(tool.execute("tool-call", {}, undefined)).resolves.toMatchObject({
			details: { tabId: 90, frameId: 0 },
		});
		expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, windowId: 7 });
	});

	it("falls back to currentWindow when windowId is 0 (unset target)", async () => {
		chrome.tabs.query.mockResolvedValue([{ id: 91 }]);
		chrome.userScripts.execute.mockResolvedValue([
			{
				result: {
					success: true,
					result: {
						url: "https://example.com",
						title: "Example",
						generatedAt: 10,
						totalCandidates: 0,
						truncated: false,
						entries: [],
					},
				},
			},
		]);

		const tool = new PageSnapshotTool();
		tool.windowId = 0;
		await expect(tool.execute("tool-call", {}, undefined)).resolves.toMatchObject({
			details: { tabId: 91, frameId: 0 },
		});
		expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
	});

	it("falls back to currentWindow when windowId is undefined", async () => {
		chrome.tabs.query.mockResolvedValue([{ id: 92 }]);
		chrome.userScripts.execute.mockResolvedValue([
			{
				result: {
					success: true,
					result: {
						url: "https://example.com",
						title: "Example",
						generatedAt: 10,
						totalCandidates: 0,
						truncated: false,
						entries: [],
					},
				},
			},
		]);

		const tool = new PageSnapshotTool();
		await expect(tool.execute("tool-call", {}, undefined)).resolves.toMatchObject({
			details: { tabId: 92, frameId: 0 },
		});
		expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
	});
});
