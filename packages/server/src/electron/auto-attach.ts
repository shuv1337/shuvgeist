/** Host-side Electron auto-attach integration. */
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { resolveElectronApp, resolveExecutable } from "./app-registry.js";

export type ElectronAutoAttachAction = "status" | "install" | "uninstall";

export interface ElectronAutoAttachResult {
	ok: boolean;
	supported: boolean;
	action: ElectronAutoAttachAction;
	appRef: string;
	appId?: string;
	path?: string;
	installed: boolean;
	message: string;
	text: string;
}

function shimPath(appId: string): string {
	return join(homedir(), ".local", "bin", `shuvgeist-electron-${appId.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`);
}

function installedShimStatus(path: string): boolean {
	if (!existsSync(path)) return false;
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) return readlinkSync(path).includes("shuvgeist-electron-shim");
	return true;
}

function unsupported(action: ElectronAutoAttachAction, appRef: string): ElectronAutoAttachResult {
	const message = `Electron auto-attach shims are currently supported on Linux only; ${process.platform} is unsupported.`;
	return { ok: false, supported: false, action, appRef, installed: false, message, text: message };
}

export async function manageElectronAutoAttach(
	action: ElectronAutoAttachAction,
	appRef: string,
): Promise<ElectronAutoAttachResult> {
	if (process.platform !== "linux") return unsupported(action, appRef);
	const app = resolveElectronApp(appRef);
	if (!app) throw new Error(`Unknown Electron app '${appRef}'. Run 'shuvgeist electron list' to see known apps.`);
	const executable = resolveExecutable(app);
	if (!executable) throw new Error(`Electron app '${appRef}' is not installed or its executable path is unknown.`);
	const path = shimPath(app.id);
	const shimScript = `${path}.shuvgeist-electron-shim`;

	if (action === "install") {
		await mkdir(join(homedir(), ".local", "bin"), { recursive: true });
		if (existsSync(path) && !installedShimStatus(path)) {
			throw new Error(`Refusing to overwrite existing non-shuvgeist file: ${path}`);
		}
		await writeFile(
			shimScript,
			`#!/usr/bin/env bash\nexec ${JSON.stringify(executable)} --remote-debugging-port="\${SHUVGEIST_ELECTRON_PORT:-9330}" "$@"\n`,
			{ mode: 0o755 },
		);
		if (!existsSync(path)) await symlink(basename(shimScript), path);
		const message = `Installed reversible auto-attach shim at ${path}.`;
		return {
			ok: true,
			supported: true,
			action,
			appRef,
			appId: app.id,
			path,
			installed: true,
			message,
			text: message,
		};
	}

	if (action === "uninstall") {
		await rm(path, { force: true });
		await rm(shimScript, { force: true });
		const message = `Removed auto-attach shim at ${path}.`;
		return {
			ok: true,
			supported: true,
			action,
			appRef,
			appId: app.id,
			path,
			installed: false,
			message,
			text: message,
		};
	}

	const installed = installedShimStatus(path);
	const message = installed
		? `Auto-attach shim is installed at ${path}.`
		: `Auto-attach shim is not installed at ${path}.`;
	return { ok: true, supported: true, action, appRef, appId: app.id, path, installed, message, text: message };
}
