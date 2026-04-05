/**
 * Extension and browser discovery for the Shuvgeist CLI.
 *
 * Provides multi-tier lookup strategies for finding the extension path
 * and a suitable Chromium-based browser binary.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

declare const __SHUVGEIST_DEV_ROOT__: string;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ShuvgeistConfig {
	extensionPath?: string;
	browser?: string;
}

const SHUVGEIST_CONFIG_PATH = join(homedir(), ".shuvgeist", "config.json");

export function readShuvgeistConfig(): ShuvgeistConfig {
	if (!existsSync(SHUVGEIST_CONFIG_PATH)) return {};
	try {
		return JSON.parse(readFileSync(SHUVGEIST_CONFIG_PATH, "utf-8")) as ShuvgeistConfig;
	} catch {
		return {};
	}
}

// ---------------------------------------------------------------------------
// Extension discovery
// ---------------------------------------------------------------------------

export interface DiscoveryResult {
	extensionPath: string;
	source: string;
}

/**
 * Discover the extension path using a multi-tier lookup strategy:
 * 1. Explicit path (--extension-path flag)
 * 2. SHUVGEIST_EXTENSION_PATH environment variable
 * 3. ~/.shuvgeist/config.json -> extensionPath
 * 4. Development path (relative to CLI build)
 * 5. Installed extension directories (Helium, Chrome, Edge)
 */
export function discoverExtensionPath(explicitPath?: string): DiscoveryResult | null {
	// 1. Explicit path
	if (explicitPath) {
		const resolved = resolve(explicitPath);
		if (existsSync(resolved) && isValidExtensionDir(resolved)) {
			return { extensionPath: resolved, source: "--extension-path flag" };
		}
		if (existsSync(resolved)) {
			return { extensionPath: resolved, source: "--extension-path flag (unverified)" };
		}
		return null;
	}

	// 2. Environment variable
	const envPath = process.env.SHUVGEIST_EXTENSION_PATH;
	if (envPath) {
		const resolved = resolve(envPath);
		if (existsSync(resolved)) {
			return { extensionPath: resolved, source: "SHUVGEIST_EXTENSION_PATH env" };
		}
	}

	// 3. Config file
	const config = readShuvgeistConfig();
	if (config.extensionPath) {
		const resolved = resolve(config.extensionPath);
		if (existsSync(resolved)) {
			return { extensionPath: resolved, source: "~/.shuvgeist/config.json" };
		}
	}

	// 4. Development path
	const devRoot = typeof __SHUVGEIST_DEV_ROOT__ !== "undefined" ? __SHUVGEIST_DEV_ROOT__ : undefined;
	if (devRoot) {
		const devDist = join(devRoot, "dist-chrome");
		if (existsSync(devDist) && isValidExtensionDir(devDist)) {
			return { extensionPath: devDist, source: "development build" };
		}
	}

	// 5. Installed extension directories
	const installed = scanInstalledExtensions();
	if (installed) {
		return installed;
	}

	return null;
}

function isValidExtensionDir(dir: string): boolean {
	const manifestPath = join(dir, "manifest.json");
	if (!existsSync(manifestPath)) return false;
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		return manifest.name === "Shuvgeist";
	} catch {
		return false;
	}
}

/**
 * Scan known Chromium extension directories for an installed Shuvgeist extension.
 */
function scanInstalledExtensions(): DiscoveryResult | null {
	const home = homedir();
	const searchDirs = [
		{ base: join(home, ".config/net.imput.helium/Extensions"), name: "Helium" },
		{ base: join(home, ".config/google-chrome/Default/Extensions"), name: "Chrome" },
		{ base: join(home, ".config/microsoft-edge/Default/Extensions"), name: "Edge" },
	];

	for (const { base, name } of searchDirs) {
		if (!existsSync(base)) continue;
		try {
			// Extensions/<id>/<version>/manifest.json
			const extIds = readdirSync(base);
			for (const extId of extIds) {
				const extDir = join(base, extId);
				try {
					const versions = readdirSync(extDir);
					for (const version of versions) {
						const versionDir = join(extDir, version);
						if (isValidExtensionDir(versionDir)) {
							return { extensionPath: versionDir, source: `installed in ${name}` };
						}
					}
				} catch {
					// Not a directory or permission error
				}
			}
		} catch {
			// Permission error scanning
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Browser discovery
// ---------------------------------------------------------------------------

export interface BrowserDiscoveryResult {
	browserPath: string;
	browserName: string;
	source: string;
}

interface BrowserCandidate {
	names: string[];
	paths: string[];
	browserName: string;
}

const BROWSER_CANDIDATES: BrowserCandidate[] = [
	{
		browserName: "helium",
		names: ["helium"],
		paths: ["/opt/helium-browser-bin/helium"],
	},
	{
		browserName: "chrome",
		names: ["google-chrome", "google-chrome-stable"],
		paths: ["/opt/google/chrome/chrome"],
	},
	{
		browserName: "chromium",
		names: ["chromium", "chromium-browser"],
		paths: [],
	},
	{
		browserName: "brave",
		names: ["brave-browser", "brave"],
		paths: [],
	},
	{
		browserName: "edge",
		names: ["microsoft-edge"],
		paths: [],
	},
];

/**
 * Discover a Chromium-based browser binary using a multi-tier lookup strategy:
 * 1. Explicit path (--browser flag)
 * 2. SHUVGEIST_BROWSER environment variable
 * 3. ~/.shuvgeist/config.json -> browser
 * 4. PATH and known installation locations
 */
export function discoverBrowser(explicitPath?: string): BrowserDiscoveryResult | null {
	// 1. Explicit path
	if (explicitPath) {
		const resolved = resolve(explicitPath);
		if (existsSync(resolved)) {
			const name = guessBrowserName(resolved);
			return { browserPath: resolved, browserName: name, source: "--browser flag" };
		}
		// Try as a command name in PATH
		const found = whichSync(explicitPath);
		if (found) {
			const name = guessBrowserName(found);
			return { browserPath: found, browserName: name, source: "--browser flag (found in PATH)" };
		}
		return null;
	}

	// 2. Environment variable
	const envBrowser = process.env.SHUVGEIST_BROWSER;
	if (envBrowser) {
		const resolved = resolve(envBrowser);
		if (existsSync(resolved)) {
			return { browserPath: resolved, browserName: guessBrowserName(resolved), source: "SHUVGEIST_BROWSER env" };
		}
		const found = whichSync(envBrowser);
		if (found) {
			return { browserPath: found, browserName: guessBrowserName(found), source: "SHUVGEIST_BROWSER env" };
		}
	}

	// 3. Config file
	const config = readShuvgeistConfig();
	if (config.browser) {
		const resolved = resolve(config.browser);
		if (existsSync(resolved)) {
			return {
				browserPath: resolved,
				browserName: guessBrowserName(resolved),
				source: "~/.shuvgeist/config.json",
			};
		}
		const found = whichSync(config.browser);
		if (found) {
			return {
				browserPath: found,
				browserName: guessBrowserName(found),
				source: "~/.shuvgeist/config.json",
			};
		}
	}

	// 4. Search PATH and known locations
	for (const candidate of BROWSER_CANDIDATES) {
		// Check known absolute paths first
		for (const path of candidate.paths) {
			if (existsSync(path)) {
				return { browserPath: path, browserName: candidate.browserName, source: "known location" };
			}
		}
		// Check PATH
		for (const name of candidate.names) {
			const found = whichSync(name);
			if (found) {
				return { browserPath: found, browserName: candidate.browserName, source: "PATH" };
			}
		}
	}

	return null;
}

function whichSync(name: string): string | null {
	try {
		const result = execFileSync("which", [name], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
		return result.trim() || null;
	} catch {
		return null;
	}
}

function guessBrowserName(path: string): string {
	const lower = path.toLowerCase();
	if (lower.includes("helium")) return "helium";
	if (lower.includes("brave")) return "brave";
	if (lower.includes("edge")) return "edge";
	if (lower.includes("chromium")) return "chromium";
	if (lower.includes("chrome")) return "chrome";
	return "chromium";
}

// ---------------------------------------------------------------------------
// Error message helpers
// ---------------------------------------------------------------------------

export function extensionNotFoundMessage(): string {
	return [
		"Could not find the Shuvgeist extension.",
		"",
		"Searched:",
		"  1. --extension-path flag",
		"  2. SHUVGEIST_EXTENSION_PATH environment variable",
		"  3. ~/.shuvgeist/config.json -> extensionPath",
		"  4. Development build (dist-chrome/)",
		"  5. Installed extensions (Helium, Chrome, Edge)",
		"",
		"To configure, set SHUVGEIST_EXTENSION_PATH or add to ~/.shuvgeist/config.json:",
		'  { "extensionPath": "/path/to/shuvgeist/dist-chrome" }',
	].join("\n");
}

export function browserNotFoundMessage(): string {
	return [
		"Could not find a Chromium-based browser.",
		"",
		"Searched:",
		"  1. --browser flag",
		"  2. SHUVGEIST_BROWSER environment variable",
		"  3. ~/.shuvgeist/config.json -> browser",
		"  4. PATH: helium, google-chrome, chromium, brave-browser, microsoft-edge",
		"  5. Known locations: /opt/helium-browser-bin/helium, /opt/google/chrome/chrome",
		"",
		"To configure, set SHUVGEIST_BROWSER or add to ~/.shuvgeist/config.json:",
		'  { "browser": "/path/to/browser" }',
	].join("\n");
}
