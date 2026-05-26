import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ElectronApp, ElectronRegistryEntry } from "./types.js";

function expandPath(path: string): string {
	return path
		.replace(/^~(?=$|\/|\\)/, homedir())
		.replaceAll("%LOCALAPPDATA%", process.env.LOCALAPPDATA ?? "")
		.replaceAll("%ProgramFiles%", process.env.ProgramFiles ?? "C:\\Program Files");
}

export const KNOWN_ELECTRON_APPS: ElectronApp[] = [
	{
		id: "com.microsoft.VSCode",
		aliases: ["vscode", "code"],
		displayName: "Visual Studio Code",
		paths: {
			darwin: ["/Applications/Visual Studio Code.app/Contents/MacOS/Electron"],
			linux: ["/usr/bin/code", "/usr/share/code/code", join(homedir(), ".local/bin/code")],
			win32: ["%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe"],
		},
		defaultArgs: ["--new-window"],
		singleInstance: "tolerant",
		mainInspectSupported: true,
	},
	{
		id: "dev.shuv.shuvscode",
		aliases: ["shuvscode"],
		displayName: "shuvscode",
		paths: {
			darwin: [],
			linux: ["/usr/bin/shuvscode", "/home/shuv/repos/shuvscode/shuvscode-linux-x64/bin/shuvscode"],
			win32: [],
		},
		defaultArgs: ["--new-window"],
		singleInstance: "tolerant",
		mainInspectSupported: true,
		notes: "Shuv's VS Code fork. This is intentionally separate from shuvcode.",
	},
	{
		id: "com.tinyspeck.slackmacgap",
		aliases: ["slack"],
		displayName: "Slack",
		paths: {
			darwin: ["/Applications/Slack.app/Contents/MacOS/Slack"],
			linux: ["/usr/bin/slack", "/snap/bin/slack"],
			win32: ["%LOCALAPPDATA%\\slack\\slack.exe"],
		},
		defaultArgs: [],
		singleInstance: "strict",
		mainInspectSupported: false,
		notes: "Slack is often single-instance locked; attach-to-running is usually more reliable than launch.",
	},
	{
		id: "dev.legcord.Legcord",
		aliases: ["legcord"],
		displayName: "Legcord",
		paths: {
			darwin: [],
			linux: ["/usr/bin/legcord"],
			win32: [],
		},
		defaultArgs: [],
		singleInstance: "strict",
		mainInspectSupported: false,
		notes: "Legcord is often single-instance locked; attach-to-running is usually more reliable than launch.",
	},
	{
		id: "org.signal.Signal",
		aliases: ["signal", "signal-desktop"],
		displayName: "Signal",
		paths: {
			darwin: ["/Applications/Signal.app/Contents/MacOS/Signal"],
			linux: ["/usr/bin/signal-desktop", "/usr/lib/signal-desktop/signal-desktop"],
			win32: ["%LOCALAPPDATA%\\Programs\\signal-desktop\\Signal.exe"],
		},
		defaultArgs: [],
		singleInstance: "strict",
		mainInspectSupported: false,
		notes: "Signal is often single-instance locked; attach-to-running is usually more reliable than launch.",
	},
	{
		id: "md.obsidian.Obsidian",
		aliases: ["obsidian"],
		displayName: "Obsidian",
		paths: {
			darwin: ["/Applications/Obsidian.app/Contents/MacOS/Obsidian"],
			linux: ["/usr/bin/obsidian"],
			win32: ["%LOCALAPPDATA%\\Obsidian\\Obsidian.exe"],
		},
		defaultArgs: [],
		singleInstance: "strict",
		mainInspectSupported: false,
		notes: "Obsidian is often single-instance locked; attach-to-running is usually more reliable than launch.",
	},
];

export function resolveElectronApp(idOrAlias: string): ElectronApp | undefined {
	const normalized = idOrAlias.trim().toLowerCase();
	return KNOWN_ELECTRON_APPS.find(
		(app) => app.id.toLowerCase() === normalized || app.aliases.some((alias) => alias.toLowerCase() === normalized),
	);
}

export function resolveExecutable(app: ElectronApp, platform: NodeJS.Platform = process.platform): string | undefined {
	for (const path of app.paths[platform] ?? []) {
		const expanded = expandPath(path);
		if (expanded && existsSync(expanded)) return expanded;
	}
	return undefined;
}

export function listElectronRegistryEntries(allowedAppIds: Set<string>): ElectronRegistryEntry[] {
	return KNOWN_ELECTRON_APPS.map((app) => ({
		id: app.id,
		aliases: app.aliases,
		displayName: app.displayName,
		path: resolveExecutable(app),
		installed: Boolean(resolveExecutable(app)),
		allowed: allowedAppIds.has(app.id),
		singleInstance: app.singleInstance,
		mainInspectSupported: app.mainInspectSupported,
		notes: app.notes,
	}));
}
