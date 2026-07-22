import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	discoverBrowser,
	discoverExtensionPath,
	type DiscoveryDependencies,
} from "shuvgeist/discovery";
import {
	createNodeConfigOwner,
	type NodeConfigEnvironment,
	type NodeConfigFileSystem,
} from "@shuvgeist/server/node-config";

interface ConfigFileOptions {
	path?: string;
	contents?: string;
	readError?: Error;
	env?: NodeConfigEnvironment;
}

function createConfigOwner(options: ConfigFileOptions = {}) {
	const path = options.path ?? "/custom/discovery.json";
	const fs: NodeConfigFileSystem = {
		existsSync: (candidate) => candidate === path,
		readFileSync: () => {
			if (options.readError) throw options.readError;
			return options.contents ?? "{}";
		},
		mkdirSync: () => undefined,
		writeFileSync: () => undefined,
		renameSync: () => undefined,
		unlinkSync: () => undefined,
	};
	return createNodeConfigOwner({
		fs,
		homeDirectory: "/home/test",
		env: { SHUVGEIST_DISCOVERY_CONFIG: path, ...options.env },
	});
}

interface MachineOptions {
	existing?: string[];
	files?: Record<string, string>;
	directories?: Record<string, string[]>;
	commands?: Record<string, string>;
	developmentRoot?: string;
	homeDirectory?: string;
}

function machineDependencies(
	configOwner: ReturnType<typeof createConfigOwner>,
	options: MachineOptions = {},
): DiscoveryDependencies {
	const existing = new Set(options.existing ?? []);
	const files = new Map(Object.entries(options.files ?? {}));
	for (const path of files.keys()) existing.add(path);
	const directories = new Map(Object.entries(options.directories ?? {}));
	for (const path of directories.keys()) existing.add(path);
	const commands = new Map(Object.entries(options.commands ?? {}));
	return {
		configOwner,
		existsSync: (path) => existing.has(path),
		readFileSync: (path) => {
			const contents = files.get(path);
			if (contents === undefined) throw new Error(`Missing virtual file: ${path}`);
			return contents;
		},
		readdirSync: (path) => {
			const entries = directories.get(path);
			if (!entries) throw new Error(`Missing virtual directory: ${path}`);
			return entries;
		},
		resolvePath: resolve,
		which: (command) => commands.get(command) ?? null,
		developmentRoot: options.developmentRoot ?? "/repo-without-build",
		homeDirectory: options.homeDirectory ?? "/home/test",
	};
}

describe("extension discovery", () => {
	it("continues from missing flag and environment candidates to the custom config file", () => {
		const configPath = "/settings/discovery.json";
		const configOwner = createConfigOwner({
			path: configPath,
			contents: JSON.stringify({ extensionPath: "/extension-from-file" }),
			env: { SHUVGEIST_EXTENSION_PATH: "/missing-environment-extension" },
		});
		const dependencies = machineDependencies(configOwner, {
			existing: ["/extension-from-file"],
			files: {
				"/extension-from-file/manifest.json": JSON.stringify({ name: "Shuvgeist" }),
			},
		});

		expect(discoverExtensionPath("/missing-flag-extension", dependencies)).toEqual({
			extensionPath: "/extension-from-file",
			source: `config file (${configPath})`,
		});
	});

	it("uses a valid environment extension after a missing flag candidate", () => {
		const configOwner = createConfigOwner({
			contents: JSON.stringify({ extensionPath: "/extension-from-file" }),
			env: { SHUVGEIST_EXTENSION_PATH: "/extension-from-environment" },
		});
		const dependencies = machineDependencies(configOwner, {
			existing: ["/extension-from-environment", "/extension-from-file"],
			files: {
				"/extension-from-environment/manifest.json": JSON.stringify({ name: "Shuvgeist" }),
				"/extension-from-file/manifest.json": JSON.stringify({ name: "Shuvgeist" }),
			},
		});

		expect(discoverExtensionPath("/missing-flag-extension", dependencies)).toEqual({
			extensionPath: "/extension-from-environment",
			source: "SHUVGEIST_EXTENSION_PATH environment variable",
		});
	});

	it("falls through unavailable configured candidates to the development build", () => {
		const configOwner = createConfigOwner({
			contents: JSON.stringify({ extensionPath: "/missing-file-extension" }),
			env: { SHUVGEIST_EXTENSION_PATH: "/missing-environment-extension" },
		});
		const dependencies = machineDependencies(configOwner, {
			developmentRoot: "/repo",
			existing: ["/repo/dist-chrome"],
			files: { "/repo/dist-chrome/manifest.json": JSON.stringify({ name: "Shuvgeist" }) },
		});

		expect(discoverExtensionPath("/missing-flag-extension", dependencies)).toEqual({
			extensionPath: "/repo/dist-chrome",
			source: "development build",
		});
	});

	it("falls through to installed extension scanning when no development build exists", () => {
		const extensionRoot = "/home/test/.config/google-chrome/Default/Extensions";
		const installedVersion = `${extensionRoot}/extension-id/1.2.3`;
		const configOwner = createConfigOwner({ contents: "{}" });
		const dependencies = machineDependencies(configOwner, {
			directories: {
				[extensionRoot]: ["extension-id"],
				[`${extensionRoot}/extension-id`]: ["1.2.3"],
			},
			files: { [`${installedVersion}/manifest.json`]: JSON.stringify({ name: "Shuvgeist" }) },
		});

		expect(discoverExtensionPath(undefined, dependencies)).toEqual({
			extensionPath: installedVersion,
			source: "installed in Chrome",
		});
	});

	it("preserves an intentional existing explicit directory as unverified", () => {
		const configOwner = createConfigOwner({ contents: "{}" });
		const dependencies = machineDependencies(configOwner, { existing: ["/custom-unverified-extension"] });

		expect(discoverExtensionPath("/custom-unverified-extension", dependencies)).toEqual({
			extensionPath: "/custom-unverified-extension",
			source: "--extension-path flag (unverified)",
		});
	});
});

describe("browser discovery", () => {
	it("continues from missing flag and environment candidates to a config command on PATH", () => {
		const configPath = "/settings/discovery.json";
		const configOwner = createConfigOwner({
			path: configPath,
			contents: JSON.stringify({ browser: "configured-chrome" }),
			env: { SHUVGEIST_BROWSER: "missing-environment-browser" },
		});
		const dependencies = machineDependencies(configOwner, {
			commands: { "configured-chrome": "/usr/bin/google-chrome" },
		});

		expect(discoverBrowser("missing-flag-browser", dependencies)).toEqual({
			browserPath: "/usr/bin/google-chrome",
			browserName: "chrome",
			source: `config file (${configPath}) (found in PATH)`,
		});
	});

	it("falls through unavailable configured candidates to known locations", () => {
		const configOwner = createConfigOwner({
			contents: JSON.stringify({ browser: "missing-file-browser" }),
			env: { SHUVGEIST_BROWSER: "missing-environment-browser" },
		});
		const dependencies = machineDependencies(configOwner, {
			existing: ["/opt/helium-browser-bin/helium"],
		});

		expect(discoverBrowser("missing-flag-browser", dependencies)).toEqual({
			browserPath: "/opt/helium-browser-bin/helium",
			browserName: "helium",
			source: "known location",
		});
	});

	it("falls through unavailable configured and known candidates to PATH", () => {
		const configOwner = createConfigOwner({ contents: "{}" });
		const dependencies = machineDependencies(configOwner, {
			commands: { chromium: "/usr/bin/chromium" },
		});

		expect(discoverBrowser(undefined, dependencies)).toEqual({
			browserPath: "/usr/bin/chromium",
			browserName: "chromium",
			source: "PATH",
		});
	});
});

describe("discovery config failure policy", () => {
	it("does not mask malformed custom config with a valid development fallback", () => {
		const configPath = "/settings/malformed.json";
		const configOwner = createConfigOwner({ path: configPath, contents: "{" });
		const dependencies = machineDependencies(configOwner, {
			developmentRoot: "/repo",
			existing: ["/repo/dist-chrome"],
			files: { "/repo/dist-chrome/manifest.json": JSON.stringify({ name: "Shuvgeist" }) },
		});

		expect(() => discoverExtensionPath(undefined, dependencies)).toThrowError(
			expect.objectContaining({ code: "INVALID_JSON", path: configPath }),
		);
	});

	it("does not mask an unreadable custom config with a viable PATH browser", () => {
		const configPath = "/settings/unreadable.json";
		const readError = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const configOwner = createConfigOwner({ path: configPath, readError });
		const dependencies = machineDependencies(configOwner, {
			commands: { chromium: "/usr/bin/chromium" },
		});

		expect(() => discoverBrowser(undefined, dependencies)).toThrowError(
			expect.objectContaining({ code: "READ_FAILED", path: configPath }),
		);
	});
});
