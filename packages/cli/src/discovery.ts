/**
 * Extension and browser discovery for the Shuvgeist CLI.
 *
 * Configuration precedence belongs to NodeConfigOwner. This module only
 * validates the ordered candidates against the local machine and continues to
 * the next candidate when a configured path or command cannot be found.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync as nodeExistsSync,
	readdirSync as nodeReaddirSync,
	readFileSync as nodeReadFileSync,
} from "node:fs";
import { homedir as nodeHomeDirectory } from "node:os";
import { join, resolve as nodeResolvePath } from "node:path";
import type {
	ConfigValueSource,
	DiscoveryCandidate,
	DiscoveryOverrides,
	NodeConfigOwner,
	ResolvedDiscoveryCandidates,
} from "@shuvgeist/server/node-config";
import { createNodeConfigOwner } from "@shuvgeist/server/node-config";

declare const __SHUVGEIST_DEV_ROOT__: string;

type DiscoveryConfigOwner = Pick<NodeConfigOwner, "paths" | "resolveDiscoveryCandidates">;

export interface DiscoveryDependencies {
	/** The single owner of discovery config paths, parsing, and precedence. */
	configOwner?: DiscoveryConfigOwner;
	existsSync?: (path: string) => boolean;
	readFileSync?: (path: string) => string;
	readdirSync?: (path: string) => string[];
	resolvePath?: (path: string) => string;
	which?: (command: string) => string | null;
	homeDirectory?: string;
	developmentRoot?: string;
}

interface ResolvedDiscoveryDependencies {
	configOwner: DiscoveryConfigOwner;
	existsSync: (path: string) => boolean;
	readFileSync: (path: string) => string;
	readdirSync: (path: string) => string[];
	resolvePath: (path: string) => string;
	which: (command: string) => string | null;
	homeDirectory: string;
	developmentRoot?: string;
}

function defaultDevelopmentRoot(): string | undefined {
	return typeof __SHUVGEIST_DEV_ROOT__ !== "undefined" ? __SHUVGEIST_DEV_ROOT__ : undefined;
}

function resolveDependencies(dependencies: DiscoveryDependencies = {}): ResolvedDiscoveryDependencies {
	return {
		configOwner: dependencies.configOwner ?? createNodeConfigOwner(),
		existsSync: dependencies.existsSync ?? nodeExistsSync,
		readFileSync: dependencies.readFileSync ?? ((path) => nodeReadFileSync(path, "utf8")),
		readdirSync: dependencies.readdirSync ?? ((path) => nodeReaddirSync(path)),
		resolvePath: dependencies.resolvePath ?? nodeResolvePath,
		which: dependencies.which ?? whichSync,
		homeDirectory: dependencies.homeDirectory ?? nodeHomeDirectory(),
		developmentRoot: dependencies.developmentRoot ?? defaultDevelopmentRoot(),
	};
}

// ---------------------------------------------------------------------------
// Extension discovery
// ---------------------------------------------------------------------------

export interface DiscoveryResult {
	extensionPath: string;
	source: string;
}

function configSourceLabel(kind: "extension" | "browser", source: ConfigValueSource, configPath: string): string {
	if (source === "flags") return kind === "extension" ? "--extension-path flag" : "--browser flag";
	if (source === "environment") {
		return kind === "extension"
			? "SHUVGEIST_EXTENSION_PATH environment variable"
			: "SHUVGEIST_BROWSER environment variable";
	}
	if (source === "file") return `config file (${configPath})`;
	return "configured default";
}

function resolveCandidates(
	overrides: DiscoveryOverrides,
	dependencies: ResolvedDiscoveryDependencies,
): ResolvedDiscoveryCandidates {
	// This read is deliberately eager. A malformed or unreadable config file is
	// an operator error and must not be hidden by a viable flag, environment
	// value, development build, or installed-browser fallback.
	return dependencies.configOwner.resolveDiscoveryCandidates(overrides);
}

function discoverExtensionFromCandidates(
	candidates: readonly DiscoveryCandidate[],
	dependencies: ResolvedDiscoveryDependencies,
): DiscoveryResult | null {
	for (const candidate of candidates) {
		const resolved = dependencies.resolvePath(candidate.value);
		if (!dependencies.existsSync(resolved)) continue;
		const source = configSourceLabel("extension", candidate.source, dependencies.configOwner.paths.discovery);
		if (isValidExtensionDir(resolved, dependencies) || candidate.source !== "flags") {
			return { extensionPath: resolved, source };
		}
		return { extensionPath: resolved, source: `${source} (unverified)` };
	}

	if (dependencies.developmentRoot) {
		const devDist = join(dependencies.developmentRoot, "dist-chrome");
		if (dependencies.existsSync(devDist) && isValidExtensionDir(devDist, dependencies)) {
			return { extensionPath: devDist, source: "development build" };
		}
	}

	return scanInstalledExtensions(dependencies);
}

/**
 * Discover the extension path using this ordered lookup strategy:
 * flag -> environment -> config file -> development build -> installed scan.
 * Missing configured candidates do not suppress lower-precedence fallbacks.
 */
export function discoverExtensionPath(
	explicitPath?: string,
	dependencies: DiscoveryDependencies = {},
): DiscoveryResult | null {
	const resolvedDependencies = resolveDependencies(dependencies);
	const candidates = resolveCandidates({ extensionPath: explicitPath }, resolvedDependencies);
	return discoverExtensionFromCandidates(candidates.extensionPath, resolvedDependencies);
}

function isValidExtensionDir(dir: string, dependencies: ResolvedDiscoveryDependencies): boolean {
	const manifestPath = join(dir, "manifest.json");
	if (!dependencies.existsSync(manifestPath)) return false;
	try {
		const manifest: unknown = JSON.parse(dependencies.readFileSync(manifestPath));
		return typeof manifest === "object" && manifest !== null && "name" in manifest && manifest.name === "Shuvgeist";
	} catch {
		return false;
	}
}

/** Scan known Chromium extension directories for an installed Shuvgeist extension. */
function scanInstalledExtensions(dependencies: ResolvedDiscoveryDependencies): DiscoveryResult | null {
	const searchDirs = [
		{ base: join(dependencies.homeDirectory, ".config/net.imput.helium/Extensions"), name: "Helium" },
		{ base: join(dependencies.homeDirectory, ".config/google-chrome/Default/Extensions"), name: "Chrome" },
		{ base: join(dependencies.homeDirectory, ".config/microsoft-edge/Default/Extensions"), name: "Edge" },
	];

	for (const { base, name } of searchDirs) {
		if (!dependencies.existsSync(base)) continue;
		try {
			for (const extensionId of dependencies.readdirSync(base)) {
				const extensionDirectory = join(base, extensionId);
				try {
					for (const version of dependencies.readdirSync(extensionDirectory)) {
						const versionDirectory = join(extensionDirectory, version);
						if (isValidExtensionDir(versionDirectory, dependencies)) {
							return { extensionPath: versionDirectory, source: `installed in ${name}` };
						}
					}
				} catch {
					// Ignore individual non-directories and permission failures while scanning.
				}
			}
		} catch {
			// Ignore an inaccessible installation root and continue to the next browser.
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

function discoverBrowserFromCandidates(
	candidates: readonly DiscoveryCandidate[],
	dependencies: ResolvedDiscoveryDependencies,
): BrowserDiscoveryResult | null {
	for (const candidate of candidates) {
		const source = configSourceLabel("browser", candidate.source, dependencies.configOwner.paths.discovery);
		const resolved = dependencies.resolvePath(candidate.value);
		if (dependencies.existsSync(resolved)) {
			return { browserPath: resolved, browserName: guessBrowserName(resolved), source };
		}
		const found = dependencies.which(candidate.value);
		if (found) {
			return {
				browserPath: found,
				browserName: guessBrowserName(found),
				source: `${source} (found in PATH)`,
			};
		}
	}

	for (const candidate of BROWSER_CANDIDATES) {
		for (const path of candidate.paths) {
			if (dependencies.existsSync(path)) {
				return { browserPath: path, browserName: candidate.browserName, source: "known location" };
			}
		}
		for (const name of candidate.names) {
			const found = dependencies.which(name);
			if (found) {
				return { browserPath: found, browserName: candidate.browserName, source: "PATH" };
			}
		}
	}

	return null;
}

/**
 * Discover a Chromium-based browser using this ordered lookup strategy:
 * flag -> environment -> config file -> known locations/PATH.
 * Missing configured candidates do not suppress lower-precedence fallbacks.
 */
export function discoverBrowser(
	explicitPath?: string,
	dependencies: DiscoveryDependencies = {},
): BrowserDiscoveryResult | null {
	const resolvedDependencies = resolveDependencies(dependencies);
	const candidates = resolveCandidates({ browser: explicitPath }, resolvedDependencies);
	return discoverBrowserFromCandidates(candidates.browser, resolvedDependencies);
}

function whichSync(command: string): string | null {
	try {
		const result = execFileSync("which", [command], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
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
		"  3. Discovery config (SHUVGEIST_DISCOVERY_CONFIG, SHUVGEIST_CONFIG, or ~/.shuvgeist/config.json)",
		"  4. Development build (dist-chrome/)",
		"  5. Installed extensions (Helium, Chrome, Edge)",
		"",
		"To configure, set SHUVGEIST_EXTENSION_PATH or add to the discovery config:",
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
		"  3. Discovery config (SHUVGEIST_DISCOVERY_CONFIG, SHUVGEIST_CONFIG, or ~/.shuvgeist/config.json)",
		"  4. PATH: helium, google-chrome, chromium, brave-browser, microsoft-edge",
		"  5. Known locations: /opt/helium-browser-bin/helium, /opt/google/chrome/chrome",
		"",
		"To configure, set SHUVGEIST_BROWSER or add to the discovery config:",
		'  { "browser": "/path/to/browser" }',
	].join("\n");
}
