import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CliConfigFile } from "../protocol.js";

export interface ElectronBridgeConfig {
	allowlist: string[];
	portRange: [number, number];
	defaultFlags: Record<string, string[]>;
	capabilities: Record<
		string,
		Partial<Record<"eval" | "cookies" | "main_inspect" | "ipc_tap" | "main_network_tap", boolean>>
	>;
}

export const DEFAULT_ELECTRON_PORT_RANGE: [number, number] = [9330, 9399];

export function bridgeConfigPath(): string {
	return process.env.SHUVGEIST_BRIDGE_CONFIG || join(homedir(), ".shuvgeist", "bridge.json");
}

export function normalizeElectronConfig(config: CliConfigFile): ElectronBridgeConfig {
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

export function readBridgeConfig(path = bridgeConfigPath()): CliConfigFile {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as CliConfigFile;
	} catch {
		return {};
	}
}

export function writeBridgeConfig(config: CliConfigFile, path = bridgeConfigPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}

export function allowElectronApp(appId: string, path = bridgeConfigPath()): CliConfigFile {
	const config = readBridgeConfig(path);
	const electron = normalizeElectronConfig(config);
	if (!electron.allowlist.includes(appId)) electron.allowlist.push(appId);
	const next: CliConfigFile = {
		...config,
		electron: {
			...config.electron,
			allowlist: electron.allowlist,
			portRange: electron.portRange,
			defaultFlags: electron.defaultFlags,
			capabilities: electron.capabilities,
		},
	};
	writeBridgeConfig(next, path);
	return next;
}
