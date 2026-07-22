import {
	DevicePresetController,
	resolveDevicePreset,
	type DeviceEmulationRequest,
} from "@shuvgeist/extension/tools/device-presets";

class FakeDebuggerManager {
	acquire = vi.fn(async (_tabId: number, _owner: string) => undefined);
	release = vi.fn(async (_tabId: number, _owner: string) => undefined);
	ensureDomain = vi.fn(
		async (
			_tabId: number,
			_domain: "Runtime" | "Network" | "Page" | "Performance" | "Tracing",
		) => undefined,
	);
	sendCommand = vi.fn(async (_tabId: number, _method: string, _params?: Record<string, unknown>) => ({}));
	addEventListener = vi.fn(
		(
			_tabId: number,
			_listener: (
				method: string,
				params: Record<string, unknown> | undefined,
				source: chrome.debugger.Debuggee,
			) => void,
		) => () => undefined,
	);
}

describe("device-presets", () => {
	it("resolves presets by case-insensitive name", () => {
		const iphone = resolveDevicePreset("IPHONE-14-PRO");
		expect(iphone).toBeDefined();
		expect(iphone?.mobile).toBe(true);
		expect(resolveDevicePreset("unknown-preset")).toBeUndefined();
	});

	it("normalizes request by merging preset defaults with overrides", () => {
		const controller = new DevicePresetController({ debuggerManager: new FakeDebuggerManager() });
		const request: DeviceEmulationRequest = {
			preset: "pixel-7",
			viewport: { width: 500, height: 1000, deviceScaleFactor: 2 },
			touch: false,
		};
		const normalized = controller.normalizeRequest(request);
		expect(normalized).toMatchObject({
			presetName: "pixel-7",
			width: 500,
			height: 1000,
			deviceScaleFactor: 2,
			mobile: true,
			touch: false,
		});
		expect(normalized.userAgent.length).toBeGreaterThan(10);
	});

	it("applies and resets emulation via debugger commands", async () => {
		const manager = new FakeDebuggerManager();
		const controller = new DevicePresetController({ debuggerManager: manager });

		const applied = await controller.apply(22, { preset: "iphone-14-pro" });
		expect(applied.tabId).toBe(22);
		expect(applied.mobile).toBe(true);
		expect(controller.getActive(22)).toBeDefined();
		expect(manager.sendCommand).toHaveBeenCalledWith(22, "Emulation.setDeviceMetricsOverride", expect.any(Object));
		expect(manager.sendCommand).toHaveBeenCalledWith(22, "Emulation.setTouchEmulationEnabled", expect.any(Object));
		expect(manager.sendCommand).toHaveBeenCalledWith(22, "Emulation.setUserAgentOverride", expect.any(Object));

		const reset = await controller.reset(22);
		expect(reset).toEqual({ tabId: 22, wasEmulated: true });
		expect(controller.getActive(22)).toBeUndefined();
		expect(manager.sendCommand).toHaveBeenCalledWith(22, "Emulation.clearDeviceMetricsOverride");
	});
});
