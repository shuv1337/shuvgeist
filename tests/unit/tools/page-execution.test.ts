import {
	executePageFunction,
	PageExecutionAbortError,
	PageExecutionTimeoutError,
} from "../../../src/tools/helpers/page-execution.js";

interface ChromeUserScriptsMock {
	configureWorld: ReturnType<typeof vi.fn>;
	execute: ReturnType<typeof vi.fn>;
	terminate?: ReturnType<typeof vi.fn>;
}

interface ChromeScriptingMock {
	executeScript: ReturnType<typeof vi.fn>;
}

function installChromeMock(apis: { userScripts?: ChromeUserScriptsMock; scripting?: ChromeScriptingMock }) {
	(globalThis as typeof globalThis & { chrome: { userScripts?: ChromeUserScriptsMock; scripting?: ChromeScriptingMock } }).chrome = {
		...apis,
	};
}

function installUserScriptsMock(userScripts: ChromeUserScriptsMock) {
	installChromeMock({ userScripts });
}

function userScriptsMock(): ChromeUserScriptsMock {
	return (globalThis as typeof globalThis & { chrome: { userScripts: ChromeUserScriptsMock } }).chrome.userScripts;
}

function scriptingMock(): ChromeScriptingMock {
	return (globalThis as typeof globalThis & { chrome: { scripting: ChromeScriptingMock } }).chrome.scripting;
}

describe("executePageFunction", () => {
	beforeEach(() => {
		vi.useRealTimers();
		installUserScriptsMock({
			configureWorld: vi.fn().mockResolvedValue(undefined),
			execute: vi.fn().mockResolvedValue([
				{
					result: {
						success: true,
						value: "ok",
						console: [{ type: "log", text: "hello" }],
					},
				},
			]),
			terminate: vi.fn().mockResolvedValue(undefined),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("executes a page function in a configured user-script world", async () => {
		const result = await executePageFunction<string>({ tabId: 10 }, "() => 'ok'", {
			worldId: "test-world",
			csp: "default-src 'none'",
			args: ["a"],
			includeConsole: true,
		});

		expect(result).toMatchObject({
			success: true,
			value: "ok",
			console: [{ type: "log", text: "hello" }],
			tabId: 10,
			frameId: 0,
		});
		expect(userScriptsMock().configureWorld).toHaveBeenCalledWith({
			worldId: "test-world",
			messaging: true,
			csp: "default-src 'none'",
		});
		expect(userScriptsMock().execute).toHaveBeenCalledWith(
			expect.objectContaining({
				target: { tabId: 10, allFrames: false },
				world: "USER_SCRIPT",
				worldId: "test-world",
				injectImmediately: true,
				executionId: expect.any(String),
			}),
		);
	});

	it("targets a specific non-zero frame id", async () => {
		await executePageFunction({ tabId: 10, frameId: 7 }, "() => true", {
			worldId: "test-world",
		});

		expect(userScriptsMock().execute).toHaveBeenCalledWith(
			expect.objectContaining({
				target: { tabId: 10, frameIds: [7] },
			}),
		);
	});

	it("returns structured script failures without throwing", async () => {
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

		await expect(executePageFunction({ tabId: 10 }, "() => { throw new Error('boom') }", { worldId: "test-world" }))
			.resolves.toMatchObject({
				success: false,
				error: "boom",
				stack: "stack",
				console: [{ type: "error", text: "bad" }],
			});
	});

	it("throws an abort error before configuring when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(executePageFunction({ tabId: 10 }, "() => true", { worldId: "test-world", signal: controller.signal }))
			.rejects.toBeInstanceOf(PageExecutionAbortError);
		expect(userScriptsMock().configureWorld).not.toHaveBeenCalled();
	});

	it("terminates an active execution when aborted", async () => {
		const controller = new AbortController();
		let rejectExecute: ((error: Error) => void) | undefined;
		userScriptsMock().execute.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectExecute = reject;
				}),
		);

		const promise = executePageFunction({ tabId: 10 }, "() => new Promise(() => {})", {
			worldId: "test-world",
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(userScriptsMock().execute).toHaveBeenCalled());
		const executionId = userScriptsMock().execute.mock.calls[0]?.[0]?.executionId as string;

		controller.abort();
		await vi.waitFor(() => expect(userScriptsMock().terminate).toHaveBeenCalledWith(10, executionId));
		rejectExecute?.(new Error("Execution terminated"));

		await expect(promise).rejects.toBeInstanceOf(PageExecutionAbortError);
	});

	it("reports aborts after execution settles when terminate is unavailable", async () => {
		const controller = new AbortController();
		installUserScriptsMock({
			configureWorld: vi.fn().mockResolvedValue(undefined),
			execute: vi.fn().mockImplementation(async () => {
				controller.abort();
				return [{ result: { success: true, value: "late", console: [] } }];
			}),
		});

		await expect(
			executePageFunction({ tabId: 10 }, "() => true", { worldId: "test-world", signal: controller.signal }),
		).rejects.toBeInstanceOf(PageExecutionAbortError);
	});

	it("reports timeouts distinctly after execution settles", async () => {
		vi.useFakeTimers();
		userScriptsMock().execute.mockImplementation(
			() =>
				new Promise((resolve) => {
					setTimeout(() => resolve([{ result: { success: true, value: "late", console: [] } }]), 20);
				}),
		);

		const promise = executePageFunction({ tabId: 10 }, "() => true", {
			worldId: "test-world",
			timeoutMs: 5,
		});
		const expectation = expect(promise).rejects.toBeInstanceOf(PageExecutionTimeoutError);

		await vi.advanceTimersByTimeAsync(20);
		await expectation;
	});

	it("falls back to chrome.scripting.executeScript when userScripts is unavailable", async () => {
		installChromeMock({
			scripting: {
				executeScript: vi.fn().mockImplementation(async (config) => [
					{
						result: config.func(config.args[0]),
					},
				]),
			},
		});

		const result = await executePageFunction<number>({ tabId: 20 }, (value: number) => value + 1, {
			worldId: "test-world",
			args: [41],
			includeConsole: true,
		});

		expect(result).toMatchObject({
			success: true,
			value: 42,
			tabId: 20,
			frameId: 0,
		});
		expect(scriptingMock().executeScript).toHaveBeenCalledWith(
			expect.objectContaining({
				target: { tabId: 20, allFrames: false },
				world: "ISOLATED",
				injectImmediately: true,
			}),
		);
	});

	it("targets a specific frame with the chrome.scripting fallback", async () => {
		installChromeMock({
			scripting: {
				executeScript: vi.fn().mockResolvedValue([{ result: { success: true, value: true, console: [] } }]),
			},
		});

		await executePageFunction({ tabId: 20, frameId: 9 }, () => true, {
			worldId: "test-world",
		});

		expect(scriptingMock().executeScript).toHaveBeenCalledWith(
			expect.objectContaining({
				target: { tabId: 20, frameIds: [9] },
			}),
		);
	});

	it("does not use chrome.scripting when userScripts is required", async () => {
		installChromeMock({
			scripting: {
				executeScript: vi.fn().mockResolvedValue([{ result: { success: true, value: true, console: [] } }]),
			},
		});

		await expect(
			executePageFunction({ tabId: 20 }, "() => true", {
				worldId: "test-world",
				requireUserScripts: true,
			}),
		).rejects.toThrow("userScripts.execute() not available");
		expect(scriptingMock().executeScript).not.toHaveBeenCalled();
	});

	it("rejects string source when only chrome.scripting is available", async () => {
		installChromeMock({
			scripting: {
				executeScript: vi.fn().mockResolvedValue([{ result: true }]),
			},
		});

		await expect(executePageFunction({ tabId: 20 }, "() => true", { worldId: "test-world" })).rejects.toThrow(
			"String source requires userScripts.execute()",
		);
		expect(scriptingMock().executeScript).not.toHaveBeenCalled();
	});
});
