const navigateExecute = vi.fn();
const selectExecute = vi.fn();
const extractExecute = vi.fn();
const debuggerExecute = vi.fn();
const runPageAssert = vi.fn();
const pageSnapshotExecute = vi.fn();
const capturePageSnapshot = vi.fn();
const nativeClickAt = vi.fn();
const nativeFillAt = vi.fn();
const nativeProviderOptions = vi.fn();

vi.mock("../../../src/tools/navigate.js", () => ({
	NavigateTool: class {
		execute = navigateExecute;
	},
}));

vi.mock("../../../src/tools/ask-user-which-element.js", () => ({
	AskUserWhichElementTool: class {
		execute = selectExecute;
	},
}));

vi.mock("../../../src/tools/extract-image.js", () => ({
	ExtractImageTool: class {
		windowId?: number;
		execute = extractExecute;
	},
}));

vi.mock("../../../src/tools/page-assert.js", () => ({
	runPageAssert,
	buildMainWorldExpressionAssertCode: vi.fn((expression: string) => `Boolean(${expression})`),
	buildPageAssertResult: vi.fn(
		(
			params: { kind: string; timeoutMs?: number },
			target: { tabId: number; frameId?: number },
			ok: boolean,
			attempts: number,
			_startedAt: number,
			timeoutMs: number,
			check: { message: string; actual?: unknown; expected?: unknown },
		) => ({
			ok,
			kind: params.kind,
			message: check.message,
			actual: check.actual,
			expected: check.expected,
			attempts,
			durationMs: 0,
			timeoutMs,
			tabId: target.tabId,
			frameId: target.frameId ?? 0,
		}),
	),
}));

vi.mock("../../../src/tools/page-snapshot.js", () => ({
	PageSnapshotTool: class {
		windowId?: number;
		execute = pageSnapshotExecute;
	},
	capturePageSnapshot,
	buildRefLocatorBundle: vi.fn(
		(entry: {
			selectorCandidates?: string[];
			role?: string;
			name?: string;
			text?: string;
			label?: string;
			tagName?: string;
			attributes?: Record<string, string>;
			ordinalPath?: number[];
			boundingBox?: { x: number; y: number; width: number; height: number };
		}) => ({
		selectorCandidates: entry.selectorCandidates,
		semantic: {
			role: entry.role,
			name: entry.name,
			text: entry.text,
			label: entry.label,
		},
		tagName: entry.tagName,
		attributes: entry.attributes,
		ordinalPath: entry.ordinalPath,
		lastKnownBoundingBox: entry.boundingBox,
	}),
	),
	locateByRole: vi.fn(() => []),
	locateByText: vi.fn(() => []),
	locateByLabel: vi.fn(() => []),
}));

vi.mock("../../../src/tools/debugger.js", () => ({
	DebuggerTool: class {
		execute = debuggerExecute;
		executeBridge = debuggerExecute;
	},
}));

vi.mock("../../../src/tools/NativeInputEventsRuntimeProvider.js", () => ({
	NativeInputEventsRuntimeProvider: class {
		constructor(options: unknown) {
			nativeProviderOptions(options);
		}
		clickAt = nativeClickAt;
		fillAt = nativeFillAt;
	},
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
		tabs: { query: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
		runtime: { getURL: ReturnType<typeof vi.fn> };
		webNavigation: { getAllFrames: ReturnType<typeof vi.fn> };
		userScripts: { configureWorld: ReturnType<typeof vi.fn>; execute: ReturnType<typeof vi.fn> };
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
};

const { BrowserCommandExecutor } = await import("../../../src/bridge/browser-command-executor.js");
const { getBridgeCapabilities } = await import("../../../src/bridge/protocol.js");

describe("BrowserCommandExecutor", () => {
	it("gates record capabilities behind sensitive access", () => {
		expect(getBridgeCapabilities(false)).not.toEqual(expect.arrayContaining(["record_start", "record_stop", "record_status"]));
		expect(getBridgeCapabilities(true)).toEqual(expect.arrayContaining(["record_start", "record_stop", "record_status"]));
	});
	beforeEach(() => {
		navigateExecute.mockReset();
		selectExecute.mockReset();
		extractExecute.mockReset();
		debuggerExecute.mockReset();
		runPageAssert.mockReset();
		pageSnapshotExecute.mockReset();
		capturePageSnapshot.mockReset();
		nativeClickAt.mockReset();
		nativeFillAt.mockReset();
		nativeProviderOptions.mockReset();
		chrome.tabs.query.mockReset();
		chrome.tabs.get.mockReset();
		chrome.runtime.getURL.mockClear();
		chrome.webNavigation.getAllFrames.mockReset();
		chrome.userScripts.configureWorld.mockReset();
		chrome.userScripts.execute.mockReset();
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
		selectExecute.mockResolvedValue({ details: { selector: "#login" } });
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

		await expect(executor.dispatch("select_element", { message: "pick it" })).resolves.toEqual({ selector: "#login" });
		expect(selectExecute).toHaveBeenCalledWith("bridge", { message: "pick it" }, undefined);
	});

	it("dispatches user-world page assertions", async () => {
		runPageAssert.mockResolvedValue({
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
		const executor = new BrowserCommandExecutor({ windowId: 7, sensitiveAccessEnabled: false });

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
			{ tabId: 42, frameId: 3 },
			undefined,
		);
	});

	it("gates eval/cookies by sensitive access and proxies debugger results", async () => {
		const disabled = new BrowserCommandExecutor({ windowId: 1, sensitiveAccessEnabled: false });
		await expect(disabled.evalCode({ code: "document.title" })).rejects.toMatchObject({ code: -32008 });
		await expect(disabled.cookies({})).rejects.toMatchObject({ code: -32008 });

		debuggerExecute.mockResolvedValueOnce({ details: { value: "Example" } }).mockResolvedValueOnce({
			details: { value: [{ name: "auth_token", value: "secret" }] },
		});
		const enabled = new BrowserCommandExecutor({ windowId: 1, sensitiveAccessEnabled: true });
		await expect(enabled.evalCode({ code: "document.title", tabId: 42, frameId: 7 })).resolves.toEqual({ value: "Example" });
		expect(debuggerExecute).toHaveBeenCalledWith(
			"bridge",
			{ action: "eval", code: "document.title", tabId: 42, frameId: 7 },
			undefined,
			undefined,
		);
		await expect(enabled.cookies({})).resolves.toEqual({ value: [{ name: "auth_token", value: "secret" }] });
		expect(debuggerExecute).toHaveBeenCalledWith("bridge", { action: "cookies" }, undefined, undefined);
	});

	it("dispatches record requests through the recording router", async () => {
		const recordingRouter = {
			start: vi.fn().mockResolvedValue({
				ok: true,
				recordingId: "rec-1",
				tabId: 9,
				startedAt: "2026-01-01T00:00:00.000Z",
				mimeType: "video/webm",
				maxDurationMs: 30_000,
			}),
			stop: vi.fn().mockResolvedValue({
				ok: true,
				recordingId: "rec-1",
				tabId: 9,
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: "2026-01-01T00:00:01.000Z",
				durationMs: 1000,
				mimeType: "video/webm",
				sizeBytes: 3,
				chunkCount: 1,
				outcome: "stopped_user",
			}),
			status: vi.fn().mockResolvedValue({ active: false }),
		};
		const executor = new BrowserCommandExecutor({
			windowId: 7,
			sensitiveAccessEnabled: true,
			recordingRouter,
		});
		await expect(executor.dispatch("record_start", { tabId: 9, maxDurationMs: 5000 })).resolves.toMatchObject({
			recordingId: "rec-1",
		});
		await expect(executor.dispatch("record_status", { tabId: 9 })).resolves.toEqual({ active: false });
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

	it("routes native ref click through debugger-backed input at frame coordinates", async () => {
		const snapshot = buildRefSnapshot();
		pageSnapshotExecute.mockResolvedValue({ details: snapshot });
		capturePageSnapshot.mockResolvedValue(snapshot);
		chrome.webNavigation.getAllFrames.mockResolvedValue([
			{ frameId: 0, url: "https://example.com/" },
			{ frameId: 7, parentFrameId: 0, url: "https://example.com/frame" },
		]);
		chrome.userScripts.execute.mockResolvedValueOnce([
			{ result: { success: true, value: { ok: true, x: 120, y: 80 }, console: [] } },
		]).mockResolvedValueOnce([
			{ result: { success: true, value: { ok: true, x: 0, y: 0 }, console: [] } },
		]);
		nativeClickAt.mockResolvedValue({ success: true, x: 120, y: 80 });
		const executor = new BrowserCommandExecutor({ windowId: 7, sensitiveAccessEnabled: false });

		await executor.pageSnapshot({ tabId: 42, frameId: 7 });
		await expect(executor.refClick({ refId: "login-input", native: true })).resolves.toMatchObject({
			ok: true,
			refId: "login-input",
			tabId: 42,
			frameId: 7,
			native: true,
			point: { x: 120, y: 80 },
		});

		expect(chrome.userScripts.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				target: { tabId: 42, frameIds: [7] },
				worldId: "shuvgeist-native-ref-coordinate",
			}),
		);
		expect(nativeProviderOptions).toHaveBeenCalledWith(expect.objectContaining({ windowId: 7, tabId: 42, frameId: 7 }));
		expect(nativeClickAt).toHaveBeenCalledWith({ x: 120, y: 80 });
		expect(nativeFillAt).not.toHaveBeenCalled();
	});

	it("keeps synthetic ref click unchanged when native is not requested", async () => {
		const snapshot = buildRefSnapshot();
		pageSnapshotExecute.mockResolvedValue({ details: snapshot });
		capturePageSnapshot.mockResolvedValue(snapshot);
		chrome.userScripts.execute.mockResolvedValue([{ result: { success: true, value: { ok: true }, console: [] } }]);
		const executor = new BrowserCommandExecutor({ windowId: 7, sensitiveAccessEnabled: false });

		await executor.pageSnapshot({ tabId: 42, frameId: 7 });
		await expect(executor.refClick({ refId: "login-input" })).resolves.toMatchObject({
			ok: true,
			refId: "login-input",
			tabId: 42,
			frameId: 7,
			selector: "#login",
		});

		expect(chrome.userScripts.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				target: { tabId: 42, frameIds: [7] },
				worldId: "shuvgeist-ref-action",
			}),
		);
		expect(nativeClickAt).not.toHaveBeenCalled();
	});

	it("waits for bounded same-tab stability when requested after ref click", async () => {
		const snapshot = buildRefSnapshot();
		pageSnapshotExecute.mockResolvedValue({ details: snapshot });
		capturePageSnapshot.mockResolvedValue(snapshot);
		chrome.userScripts.execute.mockResolvedValue([{ result: { success: true, value: { ok: true }, console: [] } }]);
		chrome.tabs.get.mockResolvedValue({ id: 42, url: "https://example.com/done", status: "complete" });
		const executor = new BrowserCommandExecutor({ windowId: 7, sensitiveAccessEnabled: false });

		await executor.pageSnapshot({ tabId: 42, frameId: 7 });
		await expect(executor.refClick({ refId: "login-input", waitMs: 250 })).resolves.toMatchObject({
			ok: true,
			refId: "login-input",
			wait: {
				tabId: 42,
				finalUrl: "https://example.com/done",
				status: "complete",
				timedOut: false,
			},
		});
		expect(chrome.tabs.get).toHaveBeenCalledWith(42);
	});

	it("does not fall back to synthetic fill when native ref input fails", async () => {
		const snapshot = buildRefSnapshot();
		pageSnapshotExecute.mockResolvedValue({ details: snapshot });
		capturePageSnapshot.mockResolvedValue(snapshot);
		chrome.webNavigation.getAllFrames.mockResolvedValue([
			{ frameId: 0, url: "https://example.com/" },
			{ frameId: 7, parentFrameId: 0, url: "https://example.com/frame" },
		]);
		chrome.userScripts.execute.mockResolvedValueOnce([
			{ result: { success: true, value: { ok: true, x: 120, y: 80 }, console: [] } },
		]).mockResolvedValueOnce([
			{ result: { success: true, value: { ok: true, x: 0, y: 0 }, console: [] } },
		]);
		nativeFillAt.mockRejectedValue(new Error("debugger attach failed"));
		const executor = new BrowserCommandExecutor({ windowId: 7, sensitiveAccessEnabled: false });

		await executor.pageSnapshot({ tabId: 42, frameId: 7 });
		await expect(executor.refFill({ refId: "login-input", value: "alice", native: true })).rejects.toThrow(
			"debugger attach failed",
		);

		expect(nativeFillAt).toHaveBeenCalledWith({ x: 120, y: 80 }, "alice");
		expect(chrome.userScripts.execute).toHaveBeenCalledTimes(2);
		expect(chrome.userScripts.execute).toHaveBeenCalledWith(
			expect.objectContaining({ worldId: "shuvgeist-native-ref-coordinate" }),
		);
	});
});

function buildRefSnapshot() {
	const entry = {
		snapshotId: "login-input",
		tabId: 42,
		frameId: 7,
		selectorCandidates: ["#login"],
		role: "textbox",
		name: "Login",
		text: "",
		label: "Login",
		tagName: "input",
		attributes: { id: "login" },
		ordinalPath: [1, 2, 3],
		boundingBox: { x: 10, y: 20, width: 40, height: 20 },
	};
	return { tabId: 42, frameId: 7, entries: [entry] };
}
