import { afterEach, describe, expect, it, vi } from "vitest";
import { DebuggerManager } from "@shuvgeist/extension/tools/helpers/debugger-manager";
import {
	FOREIGN_EXTENSION_FRAME_ERROR,
	removeForeignExtensionFrames,
} from "@shuvgeist/extension/tools/helpers/foreign-extension-frames";

const TAB_ID = 7;

describe("DebuggerManager foreign extension frames", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("attaches once when the tab has no foreign extension frame", async () => {
		const attach = vi.fn(async () => undefined);
		const executeScript = vi.fn();
		installChrome({ attach, executeScript });
		const manager = new DebuggerManager();

		await manager.acquire(TAB_ID, "screenshot");
		await manager.acquire(TAB_ID, "eval");

		expect(attach).toHaveBeenCalledTimes(1);
		expect(attach).toHaveBeenCalledWith({ tabId: TAB_ID }, "1.3");
		expect(executeScript).not.toHaveBeenCalled();
	});

	it("removes foreign frames from the top document and retries debugger attach", async () => {
		const attach = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error(FOREIGN_EXTENSION_FRAME_ERROR))
			.mockResolvedValueOnce(undefined);
		const executeScript = vi.fn(async () => [{ result: 1 }]);
		installChrome({ attach, executeScript, extensionId: "own-extension" });
		const manager = new DebuggerManager();

		await manager.acquire(TAB_ID, "screenshot");

		expect(attach).toHaveBeenCalledTimes(2);
		expect(executeScript).toHaveBeenCalledWith({
			target: { tabId: TAB_ID, allFrames: false },
			func: removeForeignExtensionFrames,
			args: ["own-extension"],
			injectImmediately: true,
		});
	});

	it("keeps the original error when no foreign frame can be removed", async () => {
		const attach = vi.fn(async () => {
			throw new Error(`Failed to attach: ${FOREIGN_EXTENSION_FRAME_ERROR}`);
		});
		const executeScript = vi.fn(async () => [{ result: 0 }]);
		installChrome({ attach, executeScript });
		const manager = new DebuggerManager();

		await expect(manager.acquire(TAB_ID, "eval")).rejects.toThrow(FOREIGN_EXTENSION_FRAME_ERROR);
		expect(attach).toHaveBeenCalledTimes(1);
	});

	it("does not retry unrelated debugger attach failures", async () => {
		const attach = vi.fn(async () => {
			throw new Error("Another debugger is already attached");
		});
		const executeScript = vi.fn();
		installChrome({ attach, executeScript });
		const manager = new DebuggerManager();

		await expect(manager.acquire(TAB_ID, "screenshot")).rejects.toThrow("Another debugger is already attached");
		expect(executeScript).not.toHaveBeenCalled();
		expect(attach).toHaveBeenCalledTimes(1);
	});

	it("rethrows the original attach error when top-frame cleanup fails", async () => {
		const attach = vi.fn(async () => {
			throw new Error(FOREIGN_EXTENSION_FRAME_ERROR);
		});
		const executeScript = vi.fn(async () => {
			throw new Error("Cannot access contents of the page");
		});
		installChrome({ attach, executeScript });
		const manager = new DebuggerManager();

		await expect(manager.acquire(TAB_ID, "eval")).rejects.toThrow(FOREIGN_EXTENSION_FRAME_ERROR);
		expect(attach).toHaveBeenCalledTimes(1);
	});
});

function installChrome(options: {
	attach: ReturnType<typeof vi.fn>;
	executeScript?: ReturnType<typeof vi.fn>;
	extensionId?: string;
}): void {
	const chromeMock = {
		debugger: {
			attach: options.attach,
			detach: vi.fn(async () => undefined),
			onEvent: { addListener: vi.fn() },
			onDetach: { addListener: vi.fn() },
		},
		runtime: { id: options.extensionId ?? "own-extension" },
		scripting: { executeScript: options.executeScript ?? vi.fn() },
	};
	vi.stubGlobal("chrome", chromeMock);
}
