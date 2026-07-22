import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyBridgeUrl,
	createNodeConfigOwner,
	isBridgeUrlSafeForAutoStart,
	NodeConfigError,
	parseBridgeNodeConfig,
	parseDiscoveryNodeConfig,
	resolveBridgeConnection,
	resolveBridgeServeBinding,
	resolveDiscoveryCandidates,
	resolveDiscoveryPreferences,
	resolveNodeOtelConfig,
	type NodeConfigFileSystem,
} from "@shuvgeist/server/node-config";

class MemoryFileSystem implements NodeConfigFileSystem {
	readonly files = new Map<string, string>();
	readonly directories: string[] = [];
	readonly writePaths: string[] = [];
	readonly renamePairs: Array<[string, string]> = [];
	readonly unlinkPaths: string[] = [];
	failWrite = false;
	failRename = false;
	renameErrorCode: string | undefined;
	collideOnWrite = false;

	seed(path: string, value: unknown): void {
		this.files.set(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
	}

	existsSync(path: string): boolean {
		return this.files.has(path);
	}

	readFileSync(path: string): string {
		const contents = this.files.get(path);
		if (contents === undefined) throw new Error(`ENOENT: ${path}`);
		return contents;
	}

	mkdirSync(path: string): void {
		this.directories.push(path);
	}

	writeFileSync(path: string, contents: string): void {
		this.writePaths.push(path);
		if (this.failWrite) throw new Error("simulated write failure");
		if (this.collideOnWrite) {
			this.files.set(path, "other writer's temporary data");
			const error = new Error(`EEXIST: ${path}`) as Error & { code: string };
			error.code = "EEXIST";
			throw error;
		}
		if (this.files.has(path)) throw new Error(`EEXIST: ${path}`);
		this.files.set(path, contents);
	}

	renameSync(from: string, to: string): void {
		this.renamePairs.push([from, to]);
		if (this.failRename) {
			const error = new Error("simulated rename failure") as Error & { code?: string };
			error.code = this.renameErrorCode;
			throw error;
		}
		const contents = this.files.get(from);
		if (contents === undefined) throw new Error(`ENOENT: ${from}`);
		this.files.set(to, contents);
		this.files.delete(from);
	}

	unlinkSync(path: string): void {
		this.unlinkPaths.push(path);
		this.files.delete(path);
	}
}

function createOwner(
	fs = new MemoryFileSystem(),
	env: Record<string, string | undefined> = {},
) {
	return {
		fs,
		owner: createNodeConfigOwner({
			fs,
			env,
			homeDirectory: "/home/tester",
			processId: 42,
			now: () => 1_700_000_000_000,
			random: () => 0.25,
		}),
	};
}

describe("Node config owner", () => {
	it("uses default paths and honors both custom config paths for every operation", () => {
		const customPath = "/workspace/config/custom-bridge.json";
		const customDiscoveryPath = "/workspace/config/custom-discovery.json";
		const { fs, owner } = createOwner(new MemoryFileSystem(), {
			SHUVGEIST_BRIDGE_CONFIG: customPath,
			SHUVGEIST_CONFIG: customDiscoveryPath,
		});
		fs.seed(customPath, { url: "ws://custom.test:4010/ws", token: "custom-token" });
		fs.seed(customDiscoveryPath, { browser: "custom-browser" });

		expect(owner.paths).toEqual({
			bridge: customPath,
			discovery: customDiscoveryPath,
		});
		expect(owner.readBridgeConfig()).toMatchObject({ token: "custom-token" });
		expect(owner.resolveBridgeConnection()).toMatchObject({
			url: "ws://custom.test:4010/ws",
			token: "custom-token",
			configPath: customPath,
		});

		owner.updateBridgeConfig({ token: "updated-token" });
		expect(JSON.parse(fs.files.get(customPath) ?? "null")).toMatchObject({
			url: "ws://custom.test:4010/ws",
			token: "updated-token",
		});
		expect(fs.renamePairs.at(-1)?.[1]).toBe(customPath);
		expect(owner.resolveDiscoveryCandidates().browser).toEqual([
			{ value: "custom-browser", source: "file" },
		]);
		owner.updateDiscoveryConfig({ extensionPath: "/custom-extension" });
		expect(fs.renamePairs.at(-1)?.[1]).toBe(customDiscoveryPath);
	});

	it("rejects empty custom config path environment values", () => {
		expect(() => createOwner(new MemoryFileSystem(), { SHUVGEIST_BRIDGE_CONFIG: "  " })).toThrowError(
			expect.objectContaining({ code: "INVALID_OVERRIDE" }),
		);
		expect(() => createOwner(new MemoryFileSystem(), { SHUVGEIST_CONFIG: "" })).toThrowError(
			expect.objectContaining({ code: "INVALID_OVERRIDE" }),
		);
	});

	it("normalizes relative custom config paths against the owner's original working directory", () => {
		const owner = createNodeConfigOwner({
			fs: new MemoryFileSystem(),
			env: {
				SHUVGEIST_BRIDGE_CONFIG: "state/bridge.json",
				SHUVGEIST_CONFIG: "state/discovery.json",
			},
			homeDirectory: "/home/tester",
			currentWorkingDirectory: "/original/cwd",
		});
		expect(owner.paths).toEqual({
			bridge: "/original/cwd/state/bridge.json",
			discovery: "/original/cwd/state/discovery.json",
		});
	});

	it("reports malformed JSON instead of silently falling back", () => {
		const { fs, owner } = createOwner();
		fs.seed(owner.paths.bridge, '{ "token": ');

		expect(() => owner.readBridgeConfig()).toThrowError(NodeConfigError);
		try {
			owner.readBridgeConfig();
		} catch (error) {
			expect(error).toMatchObject({ code: "INVALID_JSON", path: owner.paths.bridge });
			expect((error as Error).message).toContain("malformed configuration is not ignored");
			expect((error as Error).message).toContain(owner.paths.bridge);
		}

		fs.files.delete(owner.paths.bridge);
		fs.seed(owner.paths.discovery, '{ "browser": ');
		expect(() => owner.readDiscoveryConfig()).toThrowError(
			expect.objectContaining({ code: "INVALID_JSON", path: owner.paths.discovery }),
		);
	});

	it("validates malformed known bridge fields with their exact field paths", () => {
		const invalidConfigs: Array<[unknown, string]> = [
			[{ url: 42 }, "url"],
			[{ url: "https://bridge.example/ws" }, "url"],
			[{ token: false }, "token"],
			[{ serve: { host: "http://localhost" } }, "serve.host"],
			[{ serve: { port: 0 } }, "serve.port"],
			[{ electron: { allowlist: ["ok", 3] } }, "electron.allowlist[1]"],
			[{ electron: { portRange: [9400, 9300] } }, "electron.portRange"],
			[{ electron: { defaultFlags: { app: "--flag" } } }, "electron.defaultFlags.app"],
			[{ electron: { capabilities: { app: { eval: "yes" } } } }, "electron.capabilities.app.eval"],
			[{ electron: { capabilities: { app: { cdp_input: "yes" } } } }, "electron.capabilities.app.cdp_input"],
			[{ otel: { enabled: "yes" } }, "otel.enabled"],
			[{ otel: { ingestUrl: "ws://localhost:3474" } }, "otel.ingestUrl"],
		];

		for (const [config, field] of invalidConfigs) {
			expect(() => parseBridgeNodeConfig(config, "/config/bridge.json")).toThrowError(
				expect.objectContaining({ code: "INVALID_SCHEMA", path: "/config/bridge.json" }),
			);
			try {
				parseBridgeNodeConfig(config, "/config/bridge.json");
			} catch (error) {
				expect((error as Error).message).toContain(field);
			}
		}
	});

	it("validates discovery config fields and retains unknown JSON fields", () => {
		expect(() => parseDiscoveryNodeConfig({ browser: 42 }, "/config/config.json")).toThrowError(
			expect.objectContaining({ code: "INVALID_SCHEMA", path: "/config/config.json" }),
		);
		expect(
			parseDiscoveryNodeConfig({
				browser: "chromium",
				extensionPath: "/extension",
				futureDiscovery: { channel: "beta" },
			}),
		).toEqual({
			browser: "chromium",
			extensionPath: "/extension",
			futureDiscovery: { channel: "beta" },
		});
	});

	it("resolves full URLs and tokens with flags over environment over file over defaults", () => {
		const file = { url: "ws://file.test:3001/ws", token: "file-token" };
		const env = {
			SHUVGEIST_BRIDGE_URL: "ws://env.test:4001/ws",
			SHUVGEIST_BRIDGE_TOKEN: "env-token",
		};

		expect(
			resolveBridgeConnection({
				flags: { url: "wss://flag.test:5001/ws", token: "flag-token" },
				env,
				file,
				defaults: { token: "default-token" },
			}),
		).toMatchObject({
			url: "wss://flag.test:5001/ws",
			token: "flag-token",
			sources: { url: "flags", token: "flags" },
		});
		expect(resolveBridgeConnection({ env, file })).toMatchObject({
			url: "ws://env.test:4001/ws",
			token: "env-token",
			sources: { url: "environment", token: "environment" },
		});
		expect(resolveBridgeConnection({ file })).toMatchObject({
			url: "ws://file.test:3001/ws",
			token: "file-token",
			sources: { url: "file", token: "file" },
		});
		expect(resolveBridgeConnection({ defaults: { token: "default-token" } })).toMatchObject({
			url: "ws://127.0.0.1:19285/ws",
			token: "default-token",
			sources: { url: "defaults", token: "defaults" },
		});
	});

	it("applies host and port overrides by layer without discarding the lower-layer URL path", () => {
		const resolved = resolveBridgeConnection({
			flags: { port: "5002" },
			env: { SHUVGEIST_BRIDGE_HOST: "env.test", SHUVGEIST_BRIDGE_PORT: "4002" },
			file: { url: "ws://file.test:3002/custom-ws", token: "token" },
		});

		expect(resolved).toMatchObject({
			url: "ws://env.test:5002/custom-ws",
			host: "env.test",
			port: 5002,
			sources: { url: "flags" },
		});
		expect(() => resolveBridgeConnection({ flags: { port: "12x" } })).toThrowError(
			expect.objectContaining({ code: "INVALID_OVERRIDE" }),
		);
		expect(() => resolveBridgeConnection({ env: { SHUVGEIST_BRIDGE_PORT: "70000" } })).toThrowError(
			expect.objectContaining({ code: "INVALID_OVERRIDE" }),
		);
		expect(() => resolveBridgeConnection({ flags: { host: "example.com:19285" } })).toThrowError(
			expect.objectContaining({ code: "INVALID_OVERRIDE" }),
		);
		expect(
			resolveBridgeConnection({
				flags: { host: "localhost" },
				file: { url: "ws://remote.example/other?mode=external#fragment" },
			}),
		).toMatchObject({
			url: "ws://localhost/other?mode=external#fragment",
			canAutoStart: false,
		});
	});

	it("keeps loopback classification broad but automatic startup deliberately strict", () => {
		for (const url of [
			"ws://localhost:19285/ws",
			"ws://LOCALHOST.:19285/ws",
			"ws://127.0.0.1:19285/ws",
			"ws://[::1]:19285/ws",
		]) {
			expect(classifyBridgeUrl(url)).toBe("loopback");
			expect(isBridgeUrlSafeForAutoStart(url)).toBe(true);
			expect(resolveBridgeConnection({ flags: { url } })).toMatchObject({
				locality: "loopback",
				canAutoStart: true,
			});
		}

		for (const url of [
			"wss://localhost:19285/ws",
			"ws://localhost:19285/other",
			"ws://localhost:19285/ws?mode=other",
			"ws://localhost:19285/ws#other",
			"ws://localhost:19285/ws?",
			"ws://localhost:19285/ws#",
			"ws://127.0.0.2:19285/ws",
			"ws://127.1:19285/ws",
			"ws://2130706433:19285/ws",
			"ws://0x7f000001:19285/ws",
			"ws://[0:0:0:0:0:0:0:1]:19285/ws",
			"ws://[::ffff:127.0.0.1]:19285/ws",
			"ws://0.0.0.0:19285/ws",
			"ws://[::]:19285/ws",
			"ws://192.168.1.20:19285/ws",
			"wss://bridge.example/ws",
		]) {
			expect(isBridgeUrlSafeForAutoStart(url)).toBe(false);
			expect(resolveBridgeConnection({ flags: { url } }).canAutoStart).toBe(false);
		}
		expect(classifyBridgeUrl("wss://localhost:19285/ws")).toBe("loopback");
		expect(classifyBridgeUrl("ws://127.0.0.2:19285/ws")).toBe("loopback");
		expect(classifyBridgeUrl("ws://0.0.0.0:19285/ws")).toBe("remote");
	});

	it("resolves serve bind configuration independently from the client URL", () => {
		const file = {
			url: "wss://remote.example:443/custom-client-path",
			token: "file-token",
			serve: { host: "127.0.0.1", port: 20001 },
		};
		expect(resolveBridgeConnection({ file })).toMatchObject({
			url: "wss://remote.example/custom-client-path",
			host: "remote.example",
			port: 443,
		});
		expect(resolveBridgeServeBinding({ file })).toEqual({
			host: "127.0.0.1",
			port: 20001,
			token: "file-token",
			configPath: "<bridge config>",
			sources: { host: "file", port: "file", token: "file" },
		});
		expect(
			resolveBridgeServeBinding({
				flags: { port: "20003" },
				env: { SHUVGEIST_BRIDGE_HOST: "::1", SHUVGEIST_BRIDGE_PORT: "20002" },
				file,
			}),
		).toMatchObject({
			host: "::1",
			port: 20003,
			sources: { host: "environment", port: "flags", token: "file" },
		});
	});

	it("fails closed on malformed connection and serve environment even when flags would win", () => {
		expect(() =>
			resolveBridgeConnection({
				flags: { url: "ws://localhost:19285/ws" },
				env: { SHUVGEIST_BRIDGE_PORT: "not-a-port" },
			}),
		).toThrowError(expect.objectContaining({ code: "INVALID_OVERRIDE" }));
		expect(() =>
			resolveBridgeServeBinding({
				flags: { port: 19285 },
				env: { SHUVGEIST_BRIDGE_HOST: "" },
			}),
		).toThrowError(expect.objectContaining({ code: "INVALID_OVERRIDE" }));
		for (const resolve of [resolveBridgeConnection, resolveBridgeServeBinding]) {
			expect(() => resolve({ flags: { token: "" }, file: { token: "must-not-reactivate" } })).toThrowError(
				expect.objectContaining({ code: "INVALID_OVERRIDE" }),
			);
			expect(() =>
				resolve({
					env: { SHUVGEIST_BRIDGE_TOKEN: "   " },
					file: { token: "must-not-reactivate" },
				}),
			).toThrowError(expect.objectContaining({ code: "INVALID_OVERRIDE" }));
		}
	});

	it("owns OTEL precedence and rejects malformed environment instead of falling back", () => {
		const file = {
			otel: {
				enabled: false,
				ingestUrl: "http://file.example:3474",
				privateIngestKey: "file-key",
			},
		};
		expect(
			resolveNodeOtelConfig({
				env: {
					SHUVGEIST_OTEL_ENABLED: "yes",
					SHUVGEIST_OTEL_INGEST_URL: "https://env.example/ingest",
					SHUVGEIST_OTEL_PRIVATE_INGEST_KEY: "",
				},
				file,
			}),
		).toEqual({
			enabled: true,
			ingestUrl: "https://env.example/ingest",
			privateIngestKey: "",
			configPath: "<bridge config>",
			sources: {
				enabled: "environment",
				ingestUrl: "environment",
				privateIngestKey: "environment",
			},
		});
		expect(resolveNodeOtelConfig({ file })).toMatchObject({
			enabled: false,
			ingestUrl: "http://file.example:3474",
			privateIngestKey: "file-key",
			sources: { enabled: "file", ingestUrl: "file", privateIngestKey: "file" },
		});
		expect(() =>
			resolveNodeOtelConfig({
				env: { SHUVGEIST_OTEL_ENABLED: "sometimes" },
				file: { otel: { enabled: true } },
			}),
		).toThrowError(expect.objectContaining({ code: "INVALID_OVERRIDE" }));
		expect(() =>
			resolveNodeOtelConfig({ env: { SHUVGEIST_OTEL_INGEST_URL: "ws://localhost:3474" } }),
		).toThrowError(expect.objectContaining({ code: "INVALID_OVERRIDE" }));
	});

	it("resolves discovery preferences with the same flags, environment, file, defaults precedence", () => {
		expect(
			resolveDiscoveryPreferences({
				flags: { browser: "flag-browser" },
				env: { SHUVGEIST_BROWSER: "env-browser", SHUVGEIST_EXTENSION_PATH: "/env-extension" },
				file: { browser: "file-browser", extensionPath: "/file-extension" },
				defaults: { browser: "default-browser", extensionPath: "/default-extension" },
			}),
		).toEqual({
			browser: "flag-browser",
			extensionPath: "/env-extension",
			sources: { browser: "flags", extensionPath: "environment" },
		});
	});

	it("returns every discovery candidate in precedence order and de-duplicates exact values", () => {
		expect(
			resolveDiscoveryCandidates({
				flags: { browser: "flag-browser", extensionPath: "/same-extension" },
				env: { SHUVGEIST_BROWSER: "env-browser", SHUVGEIST_EXTENSION_PATH: "/same-extension" },
				file: { browser: "file-browser", extensionPath: "/file-extension" },
				defaults: { browser: "default-browser", extensionPath: "/default-extension" },
			}),
		).toEqual({
			extensionPath: [
				{ value: "/same-extension", source: "flags" },
				{ value: "/file-extension", source: "file" },
				{ value: "/default-extension", source: "defaults" },
			],
			browser: [
				{ value: "flag-browser", source: "flags" },
				{ value: "env-browser", source: "environment" },
				{ value: "file-browser", source: "file" },
				{ value: "default-browser", source: "defaults" },
			],
		});
		expect(() =>
			resolveDiscoveryCandidates({
				flags: { browser: "flag-browser" },
				env: { SHUVGEIST_BROWSER: "  " },
			}),
		).toThrowError(expect.objectContaining({ code: "INVALID_OVERRIDE" }));
	});

	it("deep-merges updates so unknown top-level and nested fields survive", () => {
		const { fs, owner } = createOwner();
		fs.seed(owner.paths.bridge, {
			$schema: "https://shuvgeist.dev/schema.json",
			token: "old-token",
			futureTopLevel: { mode: "preserve-me" },
			electron: {
				allowlist: ["old-app"],
				futureElectron: { enabled: true },
			},
		});

		const next = owner.updateBridgeConfig({
			token: "new-token",
			electron: { allowlist: ["new-app"] },
		});

		expect(next).toEqual({
			$schema: "https://shuvgeist.dev/schema.json",
			token: "new-token",
			futureTopLevel: { mode: "preserve-me" },
			electron: {
				allowlist: ["new-app"],
				futureElectron: { enabled: true },
			},
		});
		expect(JSON.parse(fs.files.get(owner.paths.bridge) ?? "null")).toEqual(next);

		fs.seed(owner.paths.discovery, {
			browser: "chromium",
			futureDiscovery: { channel: "stable" },
		});
		expect(owner.updateDiscoveryConfig({ extensionPath: "/extension" })).toEqual({
			browser: "chromium",
			extensionPath: "/extension",
			futureDiscovery: { channel: "stable" },
		});
	});

	it("writes through an exclusive same-directory temporary file before rename", () => {
		const { fs, owner } = createOwner();
		owner.writeBridgeConfig({ token: "token" });

		expect(fs.writePaths).toHaveLength(1);
		expect(dirname(fs.writePaths[0])).toBe(dirname(owner.paths.bridge));
		expect(fs.writePaths[0]).not.toBe(owner.paths.bridge);
		expect(fs.renamePairs).toEqual([[fs.writePaths[0], owner.paths.bridge]]);
		expect(fs.files.has(fs.writePaths[0])).toBe(false);
		expect(JSON.parse(fs.files.get(owner.paths.bridge) ?? "null")).toEqual({ token: "token" });
	});

	it("leaves the original intact and cleans the temp file when atomic rename fails", () => {
		const { fs, owner } = createOwner();
		fs.seed(owner.paths.bridge, { token: "original" });
		fs.failRename = true;

		expect(() => owner.updateBridgeConfig({ token: "replacement" })).toThrowError(
			expect.objectContaining({ code: "ATOMIC_WRITE_FAILED", path: owner.paths.bridge }),
		);
		expect(JSON.parse(fs.files.get(owner.paths.bridge) ?? "null")).toEqual({ token: "original" });
		expect(fs.unlinkPaths).toEqual([fs.writePaths[0]]);
		expect(fs.files.has(fs.writePaths[0])).toBe(false);
	});

	it("cleans its successfully-created temp when rename reports EEXIST", () => {
		const { fs, owner } = createOwner();
		fs.seed(owner.paths.bridge, { token: "original" });
		fs.failRename = true;
		fs.renameErrorCode = "EEXIST";

		expect(() => owner.updateBridgeConfig({ token: "replacement" })).toThrowError(
			expect.objectContaining({ code: "ATOMIC_WRITE_FAILED", path: owner.paths.bridge }),
		);
		expect(JSON.parse(fs.files.get(owner.paths.bridge) ?? "null")).toEqual({ token: "original" });
		expect(fs.unlinkPaths).toEqual([fs.writePaths[0]]);
		expect(fs.files.has(fs.writePaths[0])).toBe(false);
	});

	it("leaves the original intact when the temporary write itself fails", () => {
		const { fs, owner } = createOwner();
		fs.seed(owner.paths.bridge, { token: "original" });
		fs.failWrite = true;

		expect(() => owner.updateBridgeConfig({ token: "replacement" })).toThrowError(
			expect.objectContaining({ code: "ATOMIC_WRITE_FAILED", path: owner.paths.bridge }),
		);
		expect(JSON.parse(fs.files.get(owner.paths.bridge) ?? "null")).toEqual({ token: "original" });
		expect(fs.renamePairs).toEqual([]);
	});

	it("does not delete another writer's temporary file after an exclusive-create collision", () => {
		const { fs, owner } = createOwner();
		fs.seed(owner.paths.bridge, { token: "original" });
		fs.collideOnWrite = true;

		expect(() => owner.updateBridgeConfig({ token: "replacement" })).toThrowError(
			expect.objectContaining({ code: "ATOMIC_WRITE_FAILED", path: owner.paths.bridge }),
		);
		expect(JSON.parse(fs.files.get(owner.paths.bridge) ?? "null")).toEqual({ token: "original" });
		expect(fs.unlinkPaths).toEqual([]);
		expect(fs.files.get(fs.writePaths[0])).toBe("other writer's temporary data");
	});
});
