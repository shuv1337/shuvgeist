import { afterEach, describe, expect, it, vi } from "vitest";

interface DebuggerCommand {
	tabId: number;
	method: string;
	params?: Record<string, unknown>;
}

type DetachListener = (source: { tabId?: number }, reason: string) => void;

function installDebuggerChrome() {
	const attached = new Set<number>();
	const commands: DebuggerCommand[] = [];
	const detachListeners: DetachListener[] = [];
	const failMethods = new Set<string>();
	const chromeApi = {
		debugger: {
			attach: vi.fn(async (target: { tabId: number }) => {
				if (attached.has(target.tabId)) throw new Error(`Already attached to ${target.tabId}`);
				attached.add(target.tabId);
			}),
			detach: vi.fn(async (target: { tabId: number }) => {
				attached.delete(target.tabId);
			}),
			sendCommand: vi.fn(async (target: { tabId: number }, method: string, params?: Record<string, unknown>) => {
				if (!attached.has(target.tabId)) throw new Error(`Debugger is not attached to ${target.tabId}`);
				if (failMethods.has(method)) throw new Error(`forced failure: ${method}`);
				commands.push({ tabId: target.tabId, method, params });
				return {};
			}),
			onEvent: { addListener: vi.fn() },
			onDetach: {
				addListener: vi.fn((listener: DetachListener) => {
					detachListeners.push(listener);
				}),
			},
		},
	};
	vi.stubGlobal("chrome", chromeApi);
	return { attached, commands, detachListeners, failMethods, chromeApi };
}

const emulation = {
	width: 1440,
	height: 900,
	deviceScaleFactor: 1,
	mobile: false,
	touch: false,
	userAgent: "EmulatedUA",
};

async function loadManager() {
	const { DebuggerManager } = await import("@shuvgeist/extension/tools/helpers/debugger-manager");
	return new DebuggerManager();
}

describe("DebuggerManager device emulation reapply", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("reapplies stored metrics, touch, and user agent on every fresh attach", async () => {
		const harness = installDebuggerChrome();
		const manager = await loadManager();
		manager.rememberDeviceEmulation(22, emulation);

		await manager.acquire(22, "device-emulate");
		expect(harness.commands.map((command) => command.method)).toEqual([
			"Emulation.setDeviceMetricsOverride",
			"Emulation.setTouchEmulationEnabled",
			"Emulation.setUserAgentOverride",
		]);
		expect(harness.commands[0]?.params).toEqual({
			width: 1440,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});
		expect(harness.commands[2]?.params).toEqual({ userAgent: "EmulatedUA" });

		await manager.release(22, "device-emulate");
		harness.commands.length = 0;
		await manager.acquire(22, "screenshot");
		expect(harness.commands.map((command) => command.method)).toEqual([
			"Emulation.setDeviceMetricsOverride",
			"Emulation.setTouchEmulationEnabled",
			"Emulation.setUserAgentOverride",
		]);
		expect(harness.attached.has(22)).toBe(true);
	});

	it("does not reapply while the same debugger session stays attached", async () => {
		const harness = installDebuggerChrome();
		const manager = await loadManager();
		manager.rememberDeviceEmulation(22, emulation);

		await manager.acquire(22, "lifetime");
		const afterFirstAttach = harness.commands.length;
		await manager.acquire(22, "eval");
		expect(harness.commands).toHaveLength(afterFirstAttach);
		expect(harness.chromeApi.debugger.attach).toHaveBeenCalledTimes(1);
	});

	it("skips an empty user agent and stops reapplying after reset", async () => {
		const harness = installDebuggerChrome();
		const manager = await loadManager();
		manager.rememberDeviceEmulation(22, { ...emulation, userAgent: "" });

		await manager.acquire(22, "first");
		expect(harness.commands.map((command) => command.method)).toEqual([
			"Emulation.setDeviceMetricsOverride",
			"Emulation.setTouchEmulationEnabled",
		]);
		await manager.release(22, "first");
		manager.forgetDeviceEmulation(22);
		harness.commands.length = 0;

		await manager.acquire(22, "second");
		expect(harness.commands).toEqual([]);
	});

	it("detaches and rejects acquire when reapply fails", async () => {
		const harness = installDebuggerChrome();
		harness.failMethods.add("Emulation.setDeviceMetricsOverride");
		const manager = await loadManager();
		manager.rememberDeviceEmulation(22, emulation);

		await expect(manager.acquire(22, "screenshot")).rejects.toThrow(
			"forced failure: Emulation.setDeviceMetricsOverride",
		);
		expect(harness.attached.has(22)).toBe(false);

		harness.failMethods.delete("Emulation.setDeviceMetricsOverride");
		await manager.acquire(22, "retry");
		expect(harness.attached.has(22)).toBe(true);
		expect(harness.commands.some((command) => command.method === "Emulation.setDeviceMetricsOverride")).toBe(true);
	});

	it("reapplies after the user cancels the debugger", async () => {
		const harness = installDebuggerChrome();
		const manager = await loadManager();
		manager.rememberDeviceEmulation(22, emulation);
		await manager.acquire(22, "held");

		harness.attached.delete(22);
		harness.detachListeners.at(-1)?.({ tabId: 22 }, "canceled_by_user");
		harness.commands.length = 0;
		await manager.acquire(22, "after-cancel");
		expect(harness.commands.map((command) => command.method)).toContain("Emulation.setDeviceMetricsOverride");
	});

	it("drops emulation when the tab closes", async () => {
		const harness = installDebuggerChrome();
		const manager = await loadManager();
		manager.rememberDeviceEmulation(22, emulation);
		await manager.acquire(22, "held");

		harness.attached.delete(22);
		harness.detachListeners.at(-1)?.({ tabId: 22 }, "target_closed");
		harness.commands.length = 0;
		await manager.acquire(22, "after-close");
		expect(harness.commands).toEqual([]);
	});
});
