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
