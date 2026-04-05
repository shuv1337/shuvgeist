/**
 * Browser launch functionality for Shuvgeist CLI.
 *
 * Handles launching a browser with the extension loaded, waiting for
 * extension registration, and managing the browser process lifecycle.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	browserNotFoundMessage,
	discoverBrowser,
	discoverExtensionPath,
	extensionNotFoundMessage,
} from "./discovery.js";
import type { BridgeServerStatus } from "./protocol.js";

const SHUVGEIST_DIR = join(homedir(), ".shuvgeist");
const LAUNCH_PID_FILE = join(SHUVGEIST_DIR, "launch.pid");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LaunchOptions {
	browser?: string;
	extensionPath?: string;
	profile?: string;
	url?: string;
	headless?: boolean;
	foreground?: boolean;
}

export interface LaunchResult {
	pid: number;
	browserPath: string;
	extensionPath: string;
	browserName: string;
	alreadyRunning?: boolean;
}

export interface CloseResult {
	pid: number;
	killed: boolean;
	signal: string;
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/**
 * Launch a Chromium-based browser with the Shuvgeist extension loaded.
 */
export async function launchBrowser(options: LaunchOptions, statusUrl: string): Promise<LaunchResult> {
	// 1. Discover browser
	const browser = discoverBrowser(options.browser);
	if (!browser) {
		throw new Error(browserNotFoundMessage());
	}

	// 2. Discover extension
	const extension = discoverExtensionPath(options.extensionPath);
	if (!extension) {
		throw new Error(extensionNotFoundMessage());
	}

	// 3. Check if browser is already connected
	if (await isExtensionConnected(statusUrl)) {
		return {
			pid: 0,
			browserPath: browser.browserPath,
			extensionPath: extension.extensionPath,
			browserName: browser.browserName,
			alreadyRunning: true,
		};
	}

	// 4. Build Chrome flags
	const args: string[] = [
		`--load-extension=${extension.extensionPath}`,
		"--no-first-run",
		"--disable-default-apps",
		"--remote-debugging-port=0",
	];

	if (options.headless) {
		args.push("--headless=new");
	}

	if (options.profile) {
		args.push(`--profile-directory=${options.profile}`);
	}

	if (options.url) {
		args.push(options.url);
	}

	// 5. Launch browser
	const child = spawn(browser.browserPath, args, {
		detached: !options.foreground,
		stdio: options.foreground ? "inherit" : "ignore",
	});

	const pid = child.pid;
	if (!pid) {
		throw new Error("Failed to get browser PID");
	}

	if (!options.foreground) {
		child.unref();
	}

	// Write PID file
	writeFileSync(LAUNCH_PID_FILE, String(pid));

	// 6. Wait for extension registration
	await waitForLaunch(statusUrl, 15_000);

	return {
		pid,
		browserPath: browser.browserPath,
		extensionPath: extension.extensionPath,
		browserName: browser.browserName,
	};
}

/**
 * Check if a browser is already running with the extension connected.
 */
async function isExtensionConnected(statusUrl: string): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timeout = globalThis.setTimeout(() => controller.abort(), 3000);
		const response = await fetch(statusUrl, { signal: controller.signal });
		globalThis.clearTimeout(timeout);
		if (!response.ok) return false;
		const status = (await response.json()) as BridgeServerStatus;
		return status.extension.connected;
	} catch {
		return false;
	}
}

/**
 * Poll the bridge status endpoint until the extension registers,
 * with exponential backoff.
 */
async function waitForLaunch(statusUrl: string, timeoutMs: number): Promise<void> {
	const startedAt = Date.now();
	let delay = 200;

	while (Date.now() - startedAt < timeoutMs) {
		await sleep(delay);
		delay = Math.min(delay * 2, 2000);

		try {
			const controller = new AbortController();
			const timeout = globalThis.setTimeout(() => controller.abort(), 3000);
			const response = await fetch(statusUrl, { signal: controller.signal });
			globalThis.clearTimeout(timeout);
			if (response.ok) {
				const status = (await response.json()) as BridgeServerStatus;
				if (status.extension.connected) {
					return;
				}
			}
		} catch {
			// Bridge not ready yet, keep polling
		}
	}

	throw new Error(`Timed out waiting for extension to register (${timeoutMs}ms)`);
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

/**
 * Close the browser process that was launched by `shuvgeist launch`.
 */
export async function closeBrowser(): Promise<CloseResult> {
	const pid = readLaunchPid();
	if (!pid) {
		throw new Error("No browser launch PID found. Is a browser running?");
	}

	// Check if process is alive
	if (!isProcessAlive(pid)) {
		try {
			unlinkSync(LAUNCH_PID_FILE);
		} catch {
			// File may not exist
		}
		throw new Error(`Browser process ${pid} is not running (stale PID file removed)`);
	}

	// Send SIGTERM
	process.kill(pid, "SIGTERM");

	// Wait up to 5 seconds for graceful shutdown
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		await sleep(200);
		if (!isProcessAlive(pid)) {
			try {
				unlinkSync(LAUNCH_PID_FILE);
			} catch {
				// File may not exist
			}
			return { pid, killed: true, signal: "SIGTERM" };
		}
	}

	// Force kill
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already dead
	}

	try {
		unlinkSync(LAUNCH_PID_FILE);
	} catch {
		// File may not exist
	}

	return { pid, killed: true, signal: "SIGKILL" };
}

/**
 * Read the PID from the launch PID file, validating it's a real number.
 */
function readLaunchPid(): number | null {
	if (!existsSync(LAUNCH_PID_FILE)) return null;
	try {
		const content = readFileSync(LAUNCH_PID_FILE, "utf-8").trim();
		const pid = Number.parseInt(content, 10);
		return Number.isFinite(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Set up signal handlers for foreground mode.
 * Forwards SIGINT and SIGTERM to the browser process.
 */
export function setupForegroundHandlers(browserPid: number): void {
	const forward = (signal: NodeJS.Signals) => {
		try {
			process.kill(browserPid, signal);
		} catch {
			// Process may already be dead
		}
	};

	process.on("SIGINT", () => {
		forward("SIGINT");
		process.exit(0);
	});

	process.on("SIGTERM", () => {
		forward("SIGTERM");
		process.exit(0);
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		globalThis.setTimeout(resolve, ms);
	});
}
