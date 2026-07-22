import type { ElectronSessionManager } from "@shuvgeist/server/electron/session-manager";
import {
	ElectronTargetCommandHandlers,
	executeElectronTargetCommand,
	isElectronTargetBridgeMethod,
} from "@shuvgeist/server/electron/target-handler-registry";

describe("electron target command handlers", () => {
	it("forwards frame identity for handlers that do not otherwise need params", async () => {
		const screenshot = vi.fn(async () => ({ mimeType: "image/png", dataUrl: "data:image/png;base64," }));
		const evaluate = vi.fn(async () => ({ output: "ok", result: "ok" }));
		const recordStop = vi.fn(async () => ({ ok: true }));
		const recordStatus = vi.fn(async () => ({ active: false }));
		const sessions = { screenshot, evaluate, recordStop, recordStatus } as unknown as ElectronSessionManager;
		const target = { kind: "electron-window" as const, sessionId: "e1", windowRef: "w1" };
		const context = { sessions, target, emitRecordFrame: vi.fn() };

		await ElectronTargetCommandHandlers.screenshot(context, { maxWidth: 320, frameId: 4 });
		await ElectronTargetCommandHandlers.eval(context, { code: "document.title", frameId: 5 });
		await ElectronTargetCommandHandlers.record_stop(context, { frameId: 6 });
		await ElectronTargetCommandHandlers.record_status(context, { frameId: 7 });

		expect(screenshot).toHaveBeenCalledWith(target, 320, 4);
		expect(evaluate).toHaveBeenCalledWith(target, "document.title", 5);
		expect(recordStop).toHaveBeenCalledWith(target, 6);
		expect(recordStatus).toHaveBeenCalledWith(target, 7);
	});

	it.each(["tabId", "tabRef", "windowId"])(
		"rejects contradictory Chrome selector %s before Electron dispatch",
		(selector) => {
			const screenshot = vi.fn();
			const sessions = { screenshot } as unknown as ElectronSessionManager;
			const target = { kind: "electron-window" as const, sessionId: "e1", windowRef: "w1" };
			const params = { maxWidth: 320, [selector]: selector === "tabRef" ? "active" : 42 };

			expect(() =>
				executeElectronTargetCommand({ sessions, target, emitRecordFrame: vi.fn() }, "screenshot", params),
		).toThrow(`Electron target parameters cannot include Chrome selectors: ${selector}`);
			expect(screenshot).not.toHaveBeenCalled();
		},
	);

	it("keeps browser cookie access outside the Electron target command surface", () => {
		expect(isElectronTargetBridgeMethod("cookies")).toBe(false);
		expect(Object.hasOwn(ElectronTargetCommandHandlers, "cookies")).toBe(false);
	});
});
