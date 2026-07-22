import type {
	ChromePageDriverRegistryLike,
	ResolvedChromePageDriver,
} from "@shuvgeist/extension/bridge/chrome-page-driver-registry";
import type { PageDriver, PageRefActionRequest } from "@shuvgeist/driver/page-driver";
import { ShownSkillsState } from "@shuvgeist/extension/utils/shown-skills";

const navigateExecute = vi.fn();
const navigateConstruct = vi.fn();
const selectExecute = vi.fn();
const extractExecute = vi.fn();
const debuggerExecute = vi.fn();
const runPageAssert = vi.fn();

vi.mock("@shuvgeist/extension/tools/navigate", () => ({
	NavigateTool: class {
		constructor(options: unknown) {
			navigateConstruct(options);
		}

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

vi.mock("@shuvgeist/extension/tools/page-assert", () => ({
	runPageAssert,
	buildMainWorldExpressionAssertCode: vi.fn((expression: string) => `Boolean(${expression})`),
	buildPageAssertResult: vi.fn(
		(
			params: { kind: string; timeoutMs?: number },
			scope: {
				target: { kind: "chrome-tab"; tabId: number; frameId?: number };
				navigationGeneration: number;
				tabId: number;
				frameId: number;
			},
			ok: boolean,
			attempts: number,
			_startedAt: number,
			timeoutMs: number,
			check: { message: string; actual?: unknown; expected?: unknown },
		) => ({
			target: scope.target,
			navigationGeneration: scope.navigationGeneration,
			ok,
			kind: params.kind,
			message: check.message,
			actual: check.actual,
			expected: check.expected,
			attempts,
			durationMs: 0,
			timeoutMs,
			tabId: scope.tabId,
			frameId: scope.frameId,
		}),
	),
}));

vi.mock("@shuvgeist/extension/tools/page-snapshot", () => ({
	locateByRole: vi.fn(() => []),
	locateByText: vi.fn(() => []),
	locateByLabel: vi.fn(() => []),
}));

vi.mock("@shuvgeist/extension/tools/debugger", () => ({
	DebuggerTool: class {
		execute = debuggerExecute;
		executeBridge = debuggerExecute;
	},
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
		tabs: { query: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
		runtime: { getURL: ReturnType<typeof vi.fn> };
		webNavigation: { getAllFrames: ReturnType<typeof vi.fn> };
		userScripts: { configureWorld: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> };
		cookies: { set: ReturnType<typeof vi.fn> };
	};
}

globalThis.chrome = {
	tabs: {
		query: vi.fn(),
		get: vi.fn(),
	},
	runtime: {
		getURL: vi.fn((value: string) => `chrome-extension://test/${value}`),
	},
	webNavigation: {
		getAllFrames: vi.fn(),
	},
	userScripts: {
		configureWorld: vi.fn(),
		execute: vi.fn(),
	},
	cookies: {
		set: vi.fn(),
	},
};

const { BrowserCommandExecutor } = await import("@shuvgeist/extension/bridge/browser-command-executor");
const { getBridgeCapabilities } = await import("@shuvgeist/protocol/protocol");

function createPageDriverHarness(tabId = 42, frameId = 0) {
	const page = {
		transport: "chrome-debugger" as const,
		sessionId: "test-session",
		windowId: "7",
		pageId: String(tabId),
	};
	const scope = { page, navigationGeneration: 3 };
	const entry = {
		snapshotId: "login-input",
		frameId,
		selectorCandidates: ["#login"],
		role: "textbox",
		name: "Login",
		text: "",
		label: "Login",
		tagName: "input",
		attributes: { id: "login" },
		ordinalPath: [1, 2, 3],
		boundingBox: { x: 10, y: 20, width: 40, height: 20 },
		interactive: true,
	};
	const snapshot = vi.fn(async () => ({
		scope,
		snapshot: {
			url: "https://example.com/",
			title: "Example",
			generatedAt: 1,
			totalCandidates: 1,
			truncated: false,
			entries: [entry],
		},
	}));
	const actOnRef = vi.fn(async (request: PageRefActionRequest) => ({
		ok: true as const,
		scope,
		refId: request.refId,
		action: request.action,
		match: { entry, score: 1, reasons: ["stable id"] },
		execution:
			request.action.mode === "cdp-trusted"
				? { ok: true as const, kind: request.action.kind, point: { x: 30, y: 30 }, methods: ["Input"] }
				: { ok: true as const, kind: request.action.kind, strategy: "fresh-snapshot" as const },
	}));
	const evaluate = vi.fn(async (request: { expression: string }) => ({
		scope,
		value: request.expression === "document.title" ? "Example" : undefined,
		type: "string",
	}));
	const networkStats = () => ({
		scope,
		active: false,
		requestCount: 0,
		storedBodyBytes: 0,
		evictedRequests: 0,
	});
	const driver = {
		identity: page,
		scope,
		closed: false,
		snapshot,
		actOnRef,
		evaluate,
		dispose: vi.fn(async () => undefined),
		network: {
			start: vi.fn(async () => ({ ...networkStats(), active: true })),
			stop: vi.fn(async () => networkStats()),
			clear: vi.fn(networkStats),
			stats: vi.fn(networkStats),
			list: vi.fn(() => ({ scope, requests: [] })),
			get: vi.fn(),
			body: vi.fn(),
			toCurl: vi.fn(),
			dispose: vi.fn(async () => undefined),
		},
		screencast: {},
	} as unknown as PageDriver;
	const resolve = vi.fn(async (requestedTabId?: number) => {
		const resolvedTabId = requestedTabId ?? tabId;
		if (resolvedTabId !== tabId) throw new Error(`Unexpected test tab ${resolvedTabId}`);
		return {
			tabId,
			tab: { id: tabId, windowId: 7, url: "https://example.com/" } as chrome.tabs.Tab,
			source: "explicit" as const,
			driver,
		} satisfies ResolvedChromePageDriver;
	});
	const registry = {
		resolve,
		getByTabId: vi.fn(() => driver),
		release: vi.fn(async () => undefined),
		dispose: vi.fn(async () => undefined),
	} satisfies ChromePageDriverRegistryLike;
	return { registry, driver, snapshot, actOnRef, evaluate, entry, scope };
}

describe("BrowserCommandExecutor", () => {
	it("gates record capabilities behind sensitive access", () => {
		expect(getBridgeCapabilities(false)).not.toEqual(expect.arrayContaining(["record_start", "record_stop", "record_status"]));
		expect(getBridgeCapabilities(true)).toEqual(expect.arrayContaining(["record_start", "record_stop", "record_status"]));
	});
	beforeEach(() => {
		navigateExecute.mockReset();
		navigateConstruct.mockReset();
		selectExecute.mockReset();
		extractExecute.mockReset();
		debuggerExecute.mockReset();
		runPageAssert.mockReset();
		chrome.tabs.query.mockReset();
		chrome.tabs.get.mockReset();
		chrome.runtime.getURL.mockClear();
		chrome.webNavigation.getAllFrames.mockReset();
		chrome.userScripts.configureWorld.mockReset();
		chrome.userScripts.execute.mockReset();
		chrome.cookies.set.mockReset();
	});

	it("owns isolated shown-skill state per executor and honors explicit injection", async () => {
		navigateExecute.mockResolvedValue({ details: { tabs: [] } });
		const injectedState = new ShownSkillsState();
		const first = new BrowserCommandExecutor({
			windowId: 7,
			sensitiveAccessEnabled: false,
			shownSkillsState: injectedState,
		});
		const second = new BrowserCommandExecutor({ windowId: 8, sensitiveAccessEnabled: false });

		await first.navigate({ listTabs: true });
		await second.navigate({ listTabs: true });

		expect(navigateConstruct).toHaveBeenNthCalledWith(1, {
			windowId: 7,
			shownSkillsState: injectedState,
		});
		expect(navigateConstruct).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				windowId: 8,
				shownSkillsState: expect.any(ShownSkillsState),
			}),
		);
		const firstOptions = navigateConstruct.mock.calls[0]?.[0] as { shownSkillsState: ShownSkillsState };
		const secondOptions = navigateConstruct.mock.calls[1]?.[0] as { shownSkillsState: ShownSkillsState };
		expect(secondOptions.shownSkillsState).not.toBe(firstOptions.shownSkillsState);
	});

	it("returns status with active tab and capabilities", async () => {
		chrome.tabs.query.mockResolvedValue([{ id: 9, url: "https://example.com", title: "Example" }]);
		const executor = new BrowserCommandExecutor({
			windowId: 7,
			sessionId: "session-7",
			sensitiveAccessEnabled: false,
		});

		await expect(executor.status()).resolves.toEqual({
			ok: true,
			ready: true,
			windowId: 7,
			sessionId: "session-7",
			capabilities: expect.not.arrayContaining(["eval"]),
			activeTab: {
				url: "https://example.com",
				title: "Example",
				tabId: 9,
			},
		});
	});

	it("dispatches navigate, repl, screenshot and select requests", async () => {
		navigateExecute.mockResolvedValue({ details: { finalUrl: "https://example.com" } });
		extractExecute.mockResolvedValue({
			content: [{ type: "image", data: "YWJj", mimeType: "image/webp" }],
			details: {
				screenshot: {
					imageWidth: 500,
					imageHeight: 250,
					cssWidth: 1000,
					cssHeight: 500,
					devicePixelRatio: 2,
					scale: 0.5,
				},
			},
		});
		selectExecute.mockResolvedValue({
			details: {
				selector: "#login",
				xpath: "//*[@id='login']",
				html: '<button id="login">Log in</button>',
				tagName: "BUTTON",
				attributes: { id: "login" },
				text: "Log in",
				boundingBox: { x: 10, y: 20, width: 80, height: 32 },
				computedStyles: { display: "block" },
				parentChain: ["body", "button#login"],
			},
		});
		const replRouter = {
			execute: vi.fn().mockResolvedValue({
				output: "done",
				files: [{ fileName: "out.txt", mimeType: "text/plain", size: 3, contentBase64: "YWJj" }],
			}),
		};

		const executor = new BrowserCommandExecutor({
			windowId: 7,
			sensitiveAccessEnabled: true,
			replRouter,
		});
		await expect(executor.dispatch("navigate", { url: "https://example.com" })).resolves.toEqual({
			finalUrl: "https://example.com",
		});
		expect(navigateExecute).toHaveBeenCalledWith("bridge", { url: "https://example.com" }, undefined);

		await expect(executor.dispatch("repl", { title: "CLI", code: "return 1", tabId: 42, frameId: 7 })).resolves.toEqual({
			output: "done",
			files: [{ fileName: "out.txt", mimeType: "text/plain", size: 3, contentBase64: "YWJj" }],
		});
		expect(replRouter.execute).toHaveBeenCalledWith(
			{ title: "CLI", code: "return 1", tabId: 42, frameId: 7 },
			undefined,
			undefined,
		);

		await expect(executor.dispatch("screenshot", { maxWidth: 500 })).resolves.toEqual({
			mimeType: "image/webp",
			dataUrl: "data:image/webp;base64,YWJj",
			imageWidth: 500,
			imageHeight: 250,
			cssWidth: 1000,
			cssHeight: 500,
			devicePixelRatio: 2,
			scale: 0.5,
		});
		expect(extractExecute).toHaveBeenCalledWith("bridge", { mode: "screenshot", maxWidth: 500 }, undefined);

		await expect(executor.dispatch("select_element", { message: "pick it" })).resolves.toMatchObject({
			selector: "#login",
			tagName: "BUTTON",
		});
		expect(selectExecute).toHaveBeenCalledWith("bridge", { message: "pick it" }, undefined);
	});

	it("dispatches user-world page assertions", async () => {
		const { registry } = createPageDriverHarness();
		runPageAssert.mockResolvedValue({
			target: { kind: "chrome-tab", tabId: 42, frameId: 3 },
			navigationGeneration: 3,
			ok: true,
			kind: "text",
			message: "Text assertion passed",
			attempts: 1,
			durationMs: 5,
			timeoutMs: 100,
			tabId: 42,
			frameId: 3,
		});
		chrome.tabs.query.mockResolvedValue([{ id: 42, url: "https://example.com" }]);
		const executor = new BrowserCommandExecutor({
			windowId: 7,
			sensitiveAccessEnabled: false,
			pageDriverRegistry: registry,
		});

		await expect(
			executor.dispatch("page_assert", { kind: "text", text: "Welcome", frameId: 3, timeoutMs: 100 }),
		).resolves.toMatchObject({
			ok: true,
			kind: "text",
			tabId: 42,
			frameId: 3,
		});
		expect(runPageAssert).toHaveBeenCalledWith(
			{ kind: "text", text: "Welcome", frameId: 3, timeoutMs: 100 },
			{
				target: { kind: "chrome-tab", tabId: 42, frameId: 3 },
				navigationGeneration: 3,
				tabId: 42,
				frameId: 3,
			},
			undefined,
		);
	});

	it("gates sensitive commands and routes Chrome eval through PageDriver", async () => {
		const disabled = new BrowserCommandExecutor({ windowId: 1, sensitiveAccessEnabled: false });
		await expect(disabled.evalCode({ code: "document.title" })).rejects.toMatchObject({ code: -32008 });
		await expect(disabled.cookies({})).rejects.toMatchObject({ code: -32008 });

		const { registry, evaluate } = createPageDriverHarness();
		debuggerExecute.mockResolvedValueOnce({ details: { value: [{ name: "auth_token", value: "secret" }] } });
		const enabled = new BrowserCommandExecutor({
			windowId: 1,
			sensitiveAccessEnabled: true,
			pageDriverRegistry: registry,
		});
		await expect(enabled.evalCode({ code: "document.title", tabId: 42, frameId: 0 })).resolves.toEqual({
			value: "Example",
		});
		expect(evaluate).toHaveBeenCalledWith({
			expression: "document.title",
			awaitPromise: true,
			returnByValue: true,
			signal: undefined,
		});
		await expect(enabled.evalCode({ code: "document.title", tabId: 42, frameId: 7 })).rejects.toThrow(
			"Frame-targeted eval requires frame context support",
		);
		await expect(enabled.cookies({})).resolves.toEqual({ value: [{ name: "auth_token", value: "secret" }] });
		expect(debuggerExecute).toHaveBeenCalledWith("bridge", { action: "cookies" }, undefined, undefined);
	});

	it("applies imported cookies only when sensitive access is enabled", async () => {
		const disabled = new BrowserCommandExecutor({ windowId: 1, sensitiveAccessEnabled: false });
		await expect(disabled.applyCookieImport({ cookies: [] })).rejects.toMatchObject({ code: -32008 });
		chrome.cookies.set.mockResolvedValue({});
		const enabled = new BrowserCommandExecutor({ windowId: 1, sensitiveAccessEnabled: true });
		await expect(
			enabled.applyCookieImport({
				cookies: [
					{
						url: "https://example.test/",
						name: "sid",
						value: "secret",
						domain: ".example.test",
						path: "/",
						secure: true,
						httpOnly: true,
						expirationDate: 1893456000,
					},
				],
			}),
		).resolves.toMatchObject({ ok: true, imported: 1, skipped: 0 });
		expect(chrome.cookies.set).toHaveBeenCalledWith({
			url: "https://example.test/",
			name: "sid",
			value: "secret",
			domain: ".example.test",
			path: "/",
			secure: true,
			httpOnly: true,
			expirationDate: 1893456000,
		});
	});

	it("dispatches record requests through the recording router", async () => {
		const recordingRouter = {
			start: vi.fn().mockResolvedValue({
				ok: true,
				target: { kind: "chrome-tab", tabId: 9, frameId: 0 },
				navigationGeneration: 1,
				recordingId: "rec-1",
				tabId: 9,
				startedAt: "2026-01-01T00:00:00.000Z",
				mimeType: "video/webm",
				maxDurationMs: 30_000,
			}),
			stop: vi.fn().mockResolvedValue({
				ok: true,
				target: { kind: "chrome-tab", tabId: 9, frameId: 0 },
				navigationGeneration: 1,
				recordingId: "rec-1",
				tabId: 9,
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: "2026-01-01T00:00:01.000Z",
				durationMs: 1000,
				mimeType: "video/webm",
				sourceBytes: 3,
				frameCount: 1,
				outcome: "stopped_user",
			}),
			status: vi.fn().mockResolvedValue({
				target: { kind: "chrome-tab", tabId: 9, frameId: 0 },
				navigationGeneration: 1,
				tabId: 9,
				frameId: 0,
				active: false,
			}),
		};
		const executor = new BrowserCommandExecutor({
			windowId: 7,
			sensitiveAccessEnabled: true,
			recordingRouter,
		});
		await expect(executor.dispatch("record_start", { tabId: 9, maxDurationMs: 5000 })).resolves.toMatchObject({
			recordingId: "rec-1",
		});
		await expect(executor.dispatch("record_status", { tabId: 9 })).resolves.toMatchObject({ active: false });
		await expect(executor.dispatch("record_stop", { tabId: 9 })).resolves.toMatchObject({ outcome: "stopped_user" });
		expect(recordingRouter.start).toHaveBeenCalledWith({ tabId: 9, maxDurationMs: 5000 }, undefined, undefined);
		expect(recordingRouter.status).toHaveBeenCalledWith({ tabId: 9 }, undefined);
		expect(recordingRouter.stop).toHaveBeenCalledWith({ tabId: 9 }, undefined, undefined);
	});

	it("rejects record requests when sensitive access is disabled", async () => {
		const executor = new BrowserCommandExecutor({
			windowId: 7,
			sensitiveAccessEnabled: false,
			recordingRouter: {
				start: vi.fn(),
				stop: vi.fn(),
				status: vi.fn(),
			},
		});
		await expect(executor.dispatch("record_start", {})).rejects.toMatchObject({ code: -32008 });
		await expect(executor.dispatch("record_status", {})).rejects.toMatchObject({ code: -32008 });
		await expect(executor.dispatch("record_stop", {})).rejects.toMatchObject({ code: -32008 });
	});

	it("bridges session operations through the session adapter", async () => {
		const sessionBridge = {
			getSnapshot: vi.fn(() => ({
				sessionId: "session-1",
				persisted: true,
				title: "Session",
				model: { provider: "anthropic", id: "claude-sonnet-4-6" },
				isStreaming: false,
				messageCount: 2,
				lastMessageIndex: 1,
				messages: [
					{ messageIndex: 0, role: "user", text: "hello" },
					{ messageIndex: 1, role: "assistant", text: "world" },
				],
			})),
			waitForIdle: vi.fn(),
			appendInjectedMessage: vi.fn().mockResolvedValue({ ok: true, sessionId: "session-1", messageIndex: 2 }),
			newSession: vi.fn().mockResolvedValue({ ok: true, sessionId: "session-2" }),
			setModel: vi.fn().mockResolvedValue({ ok: true, model: { provider: "anthropic", id: "claude-opus-4-6" } }),
			getArtifacts: vi.fn(() => ({ sessionId: "session-1", artifacts: [{ filename: "note.md", content: "# hi", createdAt: "a", updatedAt: "b" }] })),
			subscribe: vi.fn(),
		};
		const executor = new BrowserCommandExecutor({ windowId: 7, sensitiveAccessEnabled: true, sessionBridge });

		await expect(executor.sessionHistory({ last: 1 })).resolves.toMatchObject({
			sessionId: "session-1",
			messages: [{ messageIndex: 1, role: "assistant", text: "world" }],
		});
		await expect(
			executor.sessionInject({ expectedSessionId: "session-1", role: "user", content: "hello" }),
		).resolves.toEqual({ ok: true, sessionId: "session-1", messageIndex: 2 });
		await expect(executor.sessionNew({ model: "anthropic/claude-opus-4-6" })).resolves.toEqual({ ok: true, sessionId: "session-2" });
		await expect(executor.sessionSetModel({ model: "anthropic/claude-opus-4-6" })).resolves.toEqual({
			ok: true,
			model: { provider: "anthropic", id: "claude-opus-4-6" },
		});
		await expect(executor.sessionArtifacts()).resolves.toEqual({
			sessionId: "session-1",
			artifacts: [{ filename: "note.md", content: "# hi", createdAt: "a", updatedAt: "b" }],
		});
	});

	it("rejects session operations without a session bridge and respects aborts", async () => {
		const executor = new BrowserCommandExecutor({ windowId: 7, sensitiveAccessEnabled: true });
		await expect(executor.sessionHistory({})).rejects.toThrow("Session bridge is not available");
		await expect(executor.sessionNew({})).rejects.toThrow("Session bridge is not available");
		await expect(executor.sessionSetModel({ model: "anthropic/claude-opus-4-6" })).rejects.toThrow(
			"Session bridge is not available",
		);
		await expect(executor.sessionArtifacts()).rejects.toThrow("Session bridge is not available");

		const sessionBridge = {
			getSnapshot: vi.fn(),
			waitForIdle: vi.fn(),
			appendInjectedMessage: vi.fn(),
			newSession: vi.fn(),
			setModel: vi.fn(),
			getArtifacts: vi.fn(),
			subscribe: vi.fn(),
		};
		const aborted = new AbortController();
		aborted.abort();
		const bridged = new BrowserCommandExecutor({ windowId: 7, sensitiveAccessEnabled: true, sessionBridge });
		await expect(
			bridged.sessionInject({ expectedSessionId: "session-1", role: "user", content: "hello" }, aborted.signal),
		).rejects.toMatchObject({ code: -32005, message: "Session injection aborted" });
	});

	it("routes legacy native and trusted ref clicks through PageDriver trusted input", async () => {
		const { registry, actOnRef } = createPageDriverHarness();
		const executor = new BrowserCommandExecutor({
			windowId: 7,
			sensitiveAccessEnabled: false,
			pageDriverRegistry: registry,
		});

		await expect(executor.pageSnapshot({ tabId: 42 })).resolves.toMatchObject({
			target: { kind: "chrome-tab", tabId: 42, frameId: 0 },
			navigationGeneration: 3,
		});
		await expect(executor.refClick({ refId: "login-input", native: true })).resolves.toMatchObject({
			ok: true,
			native: true,
			mode: "cdp-trusted",
			execution: { methods: ["Input"] },
		});
		await expect(executor.refClick({ refId: "login-input", trusted: true })).resolves.toMatchObject({
			ok: true,
			mode: "cdp-trusted",
		});
		expect(actOnRef).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ action: expect.objectContaining({ kind: "click", mode: "cdp-trusted" }) }),
		);
		expect(actOnRef).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ action: expect.objectContaining({ kind: "click", mode: "cdp-trusted" }) }),
		);
	});

	it("routes default ref actions through the one-call DOM PageDriver path", async () => {
		const { registry, actOnRef } = createPageDriverHarness();
		const executor = new BrowserCommandExecutor({
			windowId: 7,
			sensitiveAccessEnabled: false,
			pageDriverRegistry: registry,
		});
		await executor.pageSnapshot({ tabId: 42 });

		await expect(executor.refFill({ refId: "login-input", value: "alice" })).resolves.toMatchObject({
			ok: true,
			action: "fill",
			mode: "dom",
			execution: { strategy: "fresh-snapshot" },
		});
		expect(actOnRef).toHaveBeenCalledWith(
			expect.objectContaining({
				refId: "login-input",
				action: { kind: "fill", mode: "dom", value: "alice" },
			}),
		);
	});

	it("preserves Chrome subframe snapshot and ref routing through PageDriver", async () => {
		const { registry, actOnRef } = createPageDriverHarness(42, 17);
		const executor = new BrowserCommandExecutor({
			windowId: 7,
			sensitiveAccessEnabled: false,
			pageDriverRegistry: registry,
		});

		await expect(executor.pageSnapshot({ tabId: 42, frameId: 17 })).resolves.toMatchObject({
			target: { kind: "chrome-tab", tabId: 42, frameId: 17 },
			frameId: 17,
			entries: [{ frameId: 17 }],
		});
		await expect(executor.refClick({ tabId: 42, refId: "login-input", native: true })).resolves.toMatchObject({
			ok: true,
			mode: "cdp-trusted",
			target: { kind: "chrome-tab", tabId: 42, frameId: 17 },
			frameId: 17,
		});
		await expect(executor.refFill({ refId: "login-input", value: "alice" })).resolves.toMatchObject({
			ok: true,
			mode: "dom",
			target: { kind: "chrome-tab", tabId: 42, frameId: 17 },
			frameId: 17,
		});
		expect(actOnRef).toHaveBeenCalledWith(
			expect.objectContaining({ action: expect.objectContaining({ kind: "click", mode: "cdp-trusted" }) }),
		);
		expect(actOnRef).toHaveBeenCalledWith(
			expect.objectContaining({ action: expect.objectContaining({ kind: "fill", mode: "dom" }) }),
		);
	});

	it("returns structured stale and ambiguous ref failures without unsafe selectors", async () => {
		const { registry, actOnRef, scope } = createPageDriverHarness();
		const executor = new BrowserCommandExecutor({
			windowId: 7,
			sensitiveAccessEnabled: false,
			pageDriverRegistry: registry,
		});
		await executor.pageSnapshot({ tabId: 42 });
		actOnRef.mockResolvedValueOnce({
			ok: false,
			scope,
			refId: "login-input",
			action: { kind: "click", mode: "dom" },
			reason: "ambiguous_match",
			message: "Reference matched two buttons equally",
		});

		const result = await executor.refClick({ refId: "login-input" });
		expect(result).toMatchObject({ ok: false, reason: "ambiguous_match" });
		expect(result).not.toHaveProperty("selector");
		expect(result).not.toHaveProperty("point");
	});

	it("releases closed tab drivers but preserves them for dry-run close", async () => {
		const { registry } = createPageDriverHarness();
		const executor = new BrowserCommandExecutor({
			windowId: 7,
			sensitiveAccessEnabled: false,
			pageDriverRegistry: registry,
		});
		await executor.pageSnapshot({ tabId: 42 });
		navigateExecute.mockResolvedValueOnce({
			details: { closedTabIds: [42], skipped: [], dryRun: true, ok: true },
		});
		await executor.navigate({ closeTab: 42, dryRun: true });
		expect(registry.release).not.toHaveBeenCalled();

		navigateExecute.mockResolvedValueOnce({
			details: { closedTabIds: [42], skipped: [], dryRun: false, ok: true },
		});
		await executor.navigate({ closeTab: 42 });
		expect(registry.release).toHaveBeenCalledWith(42);
	});

	it("waits for bounded same-tab stability after a successful driver ref click", async () => {
		const { registry } = createPageDriverHarness();
		chrome.tabs.get.mockResolvedValue({ id: 42, url: "https://example.com/done", status: "complete" });
		const executor = new BrowserCommandExecutor({
			windowId: 7,
			sensitiveAccessEnabled: false,
			pageDriverRegistry: registry,
		});
		await executor.pageSnapshot({ tabId: 42 });

		await expect(executor.refClick({ refId: "login-input", waitMs: 250 })).resolves.toMatchObject({
			ok: true,
			wait: {
				tabId: 42,
				finalUrl: "https://example.com/done",
				status: "complete",
				timedOut: false,
			},
		});
	});

	it("fails closed when trusted input dispatch fails", async () => {
		const { registry, actOnRef } = createPageDriverHarness();
		actOnRef.mockRejectedValueOnce(new Error("debugger attach failed"));
		const executor = new BrowserCommandExecutor({
			windowId: 7,
			sensitiveAccessEnabled: false,
			pageDriverRegistry: registry,
		});
		await executor.pageSnapshot({ tabId: 42 });

		await expect(
			executor.refFill({ refId: "login-input", value: "alice", native: true }),
		).rejects.toThrow("debugger attach failed");
		expect(actOnRef).toHaveBeenCalledTimes(1);
	});
});
