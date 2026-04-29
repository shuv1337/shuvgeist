const navigateExecute = vi.fn();
const selectExecute = vi.fn();
const extractExecute = vi.fn();
const debuggerExecute = vi.fn();

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

vi.mock("../../../src/tools/debugger.js", () => ({
	DebuggerTool: class {
		execute = debuggerExecute;
		executeBridge = debuggerExecute;
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
		chrome.tabs.query.mockReset();
		chrome.runtime.getURL.mockClear();
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
});
