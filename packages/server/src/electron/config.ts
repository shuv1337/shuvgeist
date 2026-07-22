import { type BridgeNodeConfig, createNodeConfigOwner, type NodeConfigOwner } from "../node-config.js";

/** Server-owned Electron capability policy. */

export interface ElectronBridgeConfig {
	allowlist: string[];
	portRange: [number, number];
	defaultFlags: Record<string, string[]>;
	capabilities: Record<
		string,
		Partial<Record<"eval" | "cookies" | "main_inspect" | "ipc_tap" | "main_network_tap" | "cdp_input", boolean>>
	>;
}

export const DEFAULT_ELECTRON_PORT_RANGE: [number, number] = [9330, 9399];

export function normalizeElectronConfig(config: BridgeNodeConfig): ElectronBridgeConfig {
	const electron = config.electron ?? {};
	const rawRange = electron.portRange;
	const portRange: [number, number] =
		Array.isArray(rawRange) &&
		rawRange.length === 2 &&
		Number.isInteger(rawRange[0]) &&
		Number.isInteger(rawRange[1]) &&
		rawRange[0] > 0 &&
		rawRange[1] >= rawRange[0]
			? [rawRange[0], rawRange[1]]
			: DEFAULT_ELECTRON_PORT_RANGE;
	return {
		allowlist: Array.from(
			new Set((electron.allowlist ?? []).filter((id) => typeof id === "string" && id.length > 0)),
		),
		portRange,
		defaultFlags: electron.defaultFlags ?? {},
		capabilities: electron.capabilities ?? {},
	};
}

export function allowElectronApp(appId: string, owner: NodeConfigOwner = createNodeConfigOwner()): BridgeNodeConfig {
	const config = owner.readBridgeConfig();
	const electron = normalizeElectronConfig(config);
	if (electron.allowlist.includes(appId)) return config;
	return owner.updateBridgeConfig({ electron: { allowlist: [...electron.allowlist, appId] } });
}
