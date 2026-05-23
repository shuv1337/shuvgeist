import type { DebuggerManager } from "../../../src/tools/helpers/debugger-manager.js";

const resolveTabTarget = vi.fn();

vi.mock("../../../src/tools/helpers/browser-target.js", () => ({
	resolveTabTarget,
}));

const { NativeInputEventsRuntimeProvider } = await import("../../../src/tools/NativeInputEventsRuntimeProvider.js");

describe("NativeInputEventsRuntimeProvider typed input methods", () => {
	beforeEach(() => {
		resolveTabTarget.mockReset();
		resolveTabTarget.mockResolvedValue({ tabId: 42, tab: { id: 42 }, source: "explicit" });
	});

	it("dispatches trusted click events at explicit viewport coordinates", async () => {
		const manager = createDebuggerManager();
		const provider = new NativeInputEventsRuntimeProvider({
			tabId: 42,
			debuggerManager: manager as unknown as DebuggerManager,
		});

		await expect(provider.clickAt({ x: 120, y: 80 })).resolves.toEqual({ success: true, x: 120, y: 80 });

		expect(manager.acquireWithTrace).toHaveBeenCalledWith(42, "native-input-ref-click:42", expect.any(Object));
		expect(manager.sendCommandWithTrace).toHaveBeenNthCalledWith(
			1,
			42,
			"Input.dispatchMouseEvent",
			expect.objectContaining({ type: "mousePressed", x: 120, y: 80, button: "left" }),
			expect.any(Object),
		);
		expect(manager.sendCommandWithTrace).toHaveBeenNthCalledWith(
			2,
			42,
			"Input.dispatchMouseEvent",
			expect.objectContaining({ type: "mouseReleased", x: 120, y: 80, button: "left" }),
			expect.any(Object),
		);
		expect(manager.releaseWithTrace).toHaveBeenCalledWith(42, "native-input-ref-click:42", expect.any(Object));
	});

	it("clicks, clears, and types through debugger input for native fill", async () => {
		const manager = createDebuggerManager();
		const provider = new NativeInputEventsRuntimeProvider({
			tabId: 42,
			debuggerManager: manager as unknown as DebuggerManager,
		});

		await expect(provider.fillAt({ x: 11, y: 22 }, "ok")).resolves.toEqual({
			success: true,
			x: 11,
			y: 22,
			textLength: 2,
		});

		expect(manager.acquireWithTrace).toHaveBeenCalledWith(42, "native-input-ref-fill:42", expect.any(Object));
		expect(manager.sendCommandWithTrace).toHaveBeenCalledWith(
			42,
			"Input.dispatchKeyEvent",
			expect.objectContaining({ type: "keyDown", key: "Control" }),
			expect.any(Object),
		);
		expect(manager.sendCommandWithTrace).toHaveBeenCalledWith(
			42,
			"Input.dispatchKeyEvent",
			expect.objectContaining({ type: "keyDown", key: "a", modifiers: 2 }),
			expect.any(Object),
		);
		expect(manager.sendCommandWithTrace).toHaveBeenCalledWith(
			42,
			"Input.dispatchKeyEvent",
			expect.objectContaining({ type: "keyDown", key: "Backspace" }),
			expect.any(Object),
		);
		expect(manager.sendCommandWithTrace).toHaveBeenCalledWith(
			42,
			"Input.dispatchKeyEvent",
			expect.objectContaining({ type: "keyDown", text: "o" }),
			expect.any(Object),
		);
		expect(manager.releaseWithTrace).toHaveBeenCalledWith(42, "native-input-ref-fill:42", expect.any(Object));
	});

	it("releases the debugger when native fill dispatch fails", async () => {
		const manager = createDebuggerManager();
		manager.sendCommandWithTrace.mockRejectedValueOnce(new Error("dispatch failed"));
		const provider = new NativeInputEventsRuntimeProvider({
			tabId: 42,
			debuggerManager: manager as unknown as DebuggerManager,
		});

		await expect(provider.fillAt({ x: 11, y: 22 }, "ok")).rejects.toThrow("dispatch failed");
		expect(manager.releaseWithTrace).toHaveBeenCalledWith(42, "native-input-ref-fill:42", expect.any(Object));
	});
});

function createDebuggerManager() {
	return {
		acquireWithTrace: vi.fn().mockResolvedValue(undefined),
		releaseWithTrace: vi.fn().mockResolvedValue(undefined),
		sendCommandWithTrace: vi.fn().mockResolvedValue({}),
	};
}
