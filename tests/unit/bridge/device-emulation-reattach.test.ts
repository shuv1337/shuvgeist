import type { ChromePageDriverRegistryLike } from "@shuvgeist/extension/bridge/chrome-page-driver-registry";
import { afterEach, describe, expect, it, vi } from "vitest";

interface DebuggerCommand {
	tabId: number;
	method: string;
	params?: Record<string, unknown>;
}

const commands: DebuggerCommand[] = [];
const attached = new Set<number>();

function emulationCommands(): DebuggerCommand[] {
	return commands.filter((command) => command.method.startsWith("Emulation."));
}

globalThis.chrome = {
	tabs: {
		get: vi.fn(async (tabId: number) => ({
			id: tabId,
			windowId: 7,
			url: "https://example.com/",
		})),
		query: vi.fn(async () => []),
	},
	runtime: {
		getURL: vi.fn((value: string) => `chrome-extension://test/${value}`),
	},
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
			commands.push({ tabId: target.tabId, method, params });
			return {};
		}),
		onEvent: { addListener: vi.fn() },
		onDetach: { addListener: vi.fn() },
	},
} as unknown as typeof chrome;

const { BrowserCommandExecutor } = await import("@shuvgeist/extension/bridge/browser-command-executor");
const { getSharedDebuggerManager } = await import("@shuvgeist/extension/tools/helpers/debugger-manager");

function createExecutor(): InstanceType<typeof BrowserCommandExecutor> {
	const registry = {
		resolve: vi.fn(),
		getByTabId: vi.fn(),
		release: vi.fn(async () => undefined),
		dispose: vi.fn(async () => undefined),
	} satisfies ChromePageDriverRegistryLike;
	return new BrowserCommandExecutor({
		windowId: 7,
		sensitiveAccessEnabled: false,
		pageDriverRegistry: registry,
	});
}

describe("device emulation survives debugger reattach", () => {
	afterEach(() => {
		commands.length = 0;
		attached.clear();
	});

	it("reapplies emulate overrides on the next debugger attach and clears them on reset", async () => {
		const executor = createExecutor();
		const manager = getSharedDebuggerManager();

		await executor.dispatch("device_emulate", {
			tabId: 22,
			viewport: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
			touch: false,
			userAgent: "EmulatedUA",
		});
		expect(attached.has(22)).toBe(false);
		expect(emulationCommands().map((command) => command.method)).toEqual([
			"Emulation.setDeviceMetricsOverride",
			"Emulation.setTouchEmulationEnabled",
			"Emulation.setUserAgentOverride",
		]);
		expect(emulationCommands()[0]?.params).toMatchObject({
			width: 1440,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false,
		});

		commands.length = 0;
		await manager.acquire(22, "eval");
		expect(emulationCommands().map((command) => command.method)).toEqual([
			"Emulation.setDeviceMetricsOverride",
			"Emulation.setTouchEmulationEnabled",
			"Emulation.setUserAgentOverride",
		]);
		expect(emulationCommands()[2]?.params).toEqual({ userAgent: "EmulatedUA" });
		await manager.release(22, "eval");

		commands.length = 0;
		await executor.dispatch("device_reset", { tabId: 22 });
		expect(emulationCommands().map((command) => command.method)).toEqual([
			"Emulation.setDeviceMetricsOverride",
			"Emulation.setTouchEmulationEnabled",
			"Emulation.setUserAgentOverride",
			"Emulation.clearDeviceMetricsOverride",
			"Emulation.setTouchEmulationEnabled",
			"Emulation.setUserAgentOverride",
		]);

		commands.length = 0;
		await manager.acquire(22, "screenshot");
		expect(emulationCommands()).toEqual([]);
		await manager.release(22, "screenshot");
	});
});
