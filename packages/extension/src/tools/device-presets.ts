import { type DebuggerManager, getSharedDebuggerManager } from "./helpers/debugger-manager.js";

export interface DevicePreset {
	name: string;
	width: number;
	height: number;
	deviceScaleFactor: number;
	mobile: boolean;
	touch: boolean;
	userAgent: string;
}

export interface DeviceEmulationRequest {
	preset?: string;
	viewport?: {
		width: number;
		height: number;
		deviceScaleFactor?: number;
		mobile?: boolean;
	};
	touch?: boolean;
	userAgent?: string;
}

export interface NormalizedDeviceEmulation {
	presetName?: string;
	width: number;
	height: number;
	deviceScaleFactor: number;
	mobile: boolean;
	touch: boolean;
	userAgent: string;
}

export const DEVICE_PRESETS: DevicePreset[] = [
	{
		name: "iphone-14-pro",
		width: 393,
		height: 852,
		deviceScaleFactor: 3,
		mobile: true,
		touch: true,
		userAgent:
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
	},
	{
		name: "pixel-7",
		width: 412,
		height: 915,
		deviceScaleFactor: 2.625,
		mobile: true,
		touch: true,
		userAgent:
			"Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
	},
	{
		name: "ipad-air",
		width: 820,
		height: 1180,
		deviceScaleFactor: 2,
		mobile: true,
		touch: true,
		userAgent:
			"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
	},
	{
		name: "desktop-1440",
		width: 1440,
		height: 900,
		deviceScaleFactor: 1,
		mobile: false,
		touch: false,
		userAgent:
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
	},
];

export function resolveDevicePreset(name: string): DevicePreset | undefined {
	const normalized = name.trim().toLowerCase();
	return DEVICE_PRESETS.find((preset) => preset.name.toLowerCase() === normalized);
}

export class DevicePresetController {
	private readonly debuggerManager: DebuggerManager;
	private readonly active = new Map<number, NormalizedDeviceEmulation>();

	constructor(options: { debuggerManager?: DebuggerManager } = {}) {
		this.debuggerManager = options.debuggerManager ?? getSharedDebuggerManager();
	}

	listPresets(): DevicePreset[] {
		return [...DEVICE_PRESETS];
	}

	getActive(tabId: number): NormalizedDeviceEmulation | undefined {
		return this.active.get(tabId);
	}

	normalizeRequest(request: DeviceEmulationRequest): NormalizedDeviceEmulation {
		const preset = request.preset ? resolveDevicePreset(request.preset) : undefined;
		if (request.preset && !preset) {
			throw new Error(`Unknown device preset: ${request.preset}`);
		}
		return {
			presetName: preset?.name,
			width: request.viewport?.width ?? preset?.width ?? 1280,
			height: request.viewport?.height ?? preset?.height ?? 720,
			deviceScaleFactor: request.viewport?.deviceScaleFactor ?? preset?.deviceScaleFactor ?? 1,
			mobile: request.viewport?.mobile ?? preset?.mobile ?? false,
			touch: request.touch ?? preset?.touch ?? false,
			userAgent: request.userAgent ?? preset?.userAgent ?? "",
		};
	}

	async apply(tabId: number, request: DeviceEmulationRequest): Promise<NormalizedDeviceEmulation & { tabId: number }> {
		const normalized = this.normalizeRequest(request);
		const owner = `device-emulation:${tabId}:${Date.now()}`;
		await this.debuggerManager.acquire(tabId, owner);
		try {
			await this.debuggerManager.sendCommand(tabId, "Emulation.setDeviceMetricsOverride", {
				width: normalized.width,
				height: normalized.height,
				deviceScaleFactor: normalized.deviceScaleFactor,
				mobile: normalized.mobile,
			});
			await this.debuggerManager.sendCommand(tabId, "Emulation.setTouchEmulationEnabled", {
				enabled: normalized.touch,
				configuration: normalized.touch ? "mobile" : "desktop",
			});
			await this.debuggerManager.sendCommand(tabId, "Emulation.setUserAgentOverride", {
				userAgent: normalized.userAgent,
			});
			this.active.set(tabId, normalized);
			return { tabId, ...normalized };
		} finally {
			await this.debuggerManager.release(tabId, owner);
		}
	}

	async reset(tabId: number): Promise<{ tabId: number; wasEmulated: boolean }> {
		const owner = `device-reset:${tabId}:${Date.now()}`;
		await this.debuggerManager.acquire(tabId, owner);
		try {
			await this.debuggerManager.sendCommand(tabId, "Emulation.clearDeviceMetricsOverride");
			await this.debuggerManager.sendCommand(tabId, "Emulation.setTouchEmulationEnabled", {
				enabled: false,
				configuration: "desktop",
			});
			await this.debuggerManager.sendCommand(tabId, "Emulation.setUserAgentOverride", {
				userAgent: "",
			});
			const wasEmulated = this.active.delete(tabId);
			return { tabId, wasEmulated };
		} finally {
			await this.debuggerManager.release(tabId, owner);
		}
	}
}

export function createDevicePresetController(
	options: { debuggerManager?: DebuggerManager } = {},
): DevicePresetController {
	return new DevicePresetController(options);
}

export function normalizeDeviceEmulationRequest(request: DeviceEmulationRequest): {
	preset?: string;
	viewport: { width: number; height: number; deviceScaleFactor: number; mobile: boolean };
	touch: boolean;
	userAgent: string;
} {
	const controller = new DevicePresetController();
	const normalized = controller.normalizeRequest(request);
	return {
		preset: normalized.presetName,
		viewport: {
			width: normalized.width,
			height: normalized.height,
			deviceScaleFactor: normalized.deviceScaleFactor,
			mobile: normalized.mobile,
		},
		touch: normalized.touch,
		userAgent: normalized.userAgent,
	};
}
