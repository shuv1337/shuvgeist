import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createCliNodeRuntime,
	type EnsureCliBridgeServer,
} from "shuvgeist/cli-node-runtime";
import type {
	NodeConfigOwner,
	ResolvedBridgeConnection,
} from "@shuvgeist/server/node-config";

const CONNECTION: ResolvedBridgeConnection = {
	url: "ws://127.0.0.1:20480/ws",
	token: "shared-token",
	host: "127.0.0.1",
	port: 20480,
	locality: "loopback",
	canAutoStart: true,
	configPath: "/custom/state/bridge.json",
	sources: { url: "file", token: "file" },
};

function createFakeOwner(connection = CONNECTION): NodeConfigOwner {
	return {
		paths: { bridge: connection.configPath, discovery: "/custom/state/discovery.json" },
		readBridgeConfig: vi.fn(() => ({})),
		readDiscoveryConfig: vi.fn(() => ({})),
		writeBridgeConfig: vi.fn(),
		writeDiscoveryConfig: vi.fn(),
		updateBridgeConfig: vi.fn(() => ({})),
		updateDiscoveryConfig: vi.fn(() => ({})),
		resolveBridgeConnection: vi.fn(() => connection),
		resolveBridgeServeBinding: vi.fn(() => ({
			host: "0.0.0.0",
			port: 20480,
			token: connection.token,
			configPath: connection.configPath,
			sources: { host: "defaults", port: "flags", token: "file" },
		})),
		resolveOtelConfig: vi.fn(() => ({
			enabled: false,
			ingestUrl: "http://localhost:3474",
			privateIngestKey: "",
			configPath: connection.configPath,
			sources: { enabled: "defaults", ingestUrl: "defaults", privateIngestKey: "defaults" },
		})),
		resolveDiscoveryCandidates: vi.fn(() => ({ extensionPath: [], browser: [] })),
		resolveDiscoveryPreferences: vi.fn(() => ({ sources: {} })),
	};
}

describe("CLI Node runtime composition", () => {
	it("threads one owner and one resolved connection through every bridge command family", async () => {
		const owner = createFakeOwner();
		let ensuredOwner: NodeConfigOwner | undefined;
		const ensureServer: EnsureCliBridgeServer = vi.fn(async (_flags, options) => {
			ensuredOwner = options.owner;
			return { ...CONNECTION, alreadyHealthy: true };
		});
		const runtime = createCliNodeRuntime({ owner, ensureServer });
		const commandFamilies = ["status", "one-shot", "record", "session-follow", "launch"] as const;

		for (const commandFamily of commandFamilies) {
			const resolved =
				commandFamily === "status"
					? runtime.resolveConnection({ host: "ignored-by-fixture" })
					: runtime.requireConnection({ host: "ignored-by-fixture" });
			expect(resolved).toBe(CONNECTION);
		}
		await expect(runtime.ensureServer({ host: "ignored-by-fixture" })).resolves.toEqual({
			...CONNECTION,
			alreadyHealthy: true,
		});

		expect(owner.resolveBridgeConnection).toHaveBeenCalledTimes(commandFamilies.length);
		expect(ensureServer).toHaveBeenCalledOnce();
		expect(ensuredOwner).toBe(owner);
	});

	it("routes manual serve and OTEL through that same owner", () => {
		const owner = createFakeOwner();
		const runtime = createCliNodeRuntime({ owner });

		expect(runtime.resolveServeBinding({ port: "20480" })).toMatchObject({ port: 20480 });
		expect(runtime.resolveOtelConfig()).toMatchObject({ enabled: false });
		expect(owner.resolveBridgeServeBinding).toHaveBeenCalledWith({ port: "20480" });
		expect(owner.resolveOtelConfig).toHaveBeenCalledOnce();
	});

	it("reports the owner's exact config path when a command requires a missing token", () => {
		const owner = createFakeOwner({ ...CONNECTION, token: "" });
		const runtime = createCliNodeRuntime({ owner });

		expect(() => runtime.requireConnection()).toThrowError(
			expect.objectContaining({ code: "EAUTH", message: expect.stringContaining(CONNECTION.configPath) }),
		);
	});

	it(
		"makes status, one-shot, record, session-follow, and launch fail closed on the same malformed custom config",
		() => {
			const directory = mkdtempSync(join(tmpdir(), "shuvgeist-cli-node-config-"));
			const configPath = join(directory, "custom-bridge.json");
			const malformed = '{ "token": ';
			writeFileSync(configPath, malformed);
			const commandFamilies: ReadonlyArray<readonly [string, ...string[]]> = [
				["status", "--json"],
				["tabs", "--json"],
				["record", "status", "--json"],
				["session", "--follow", "--json"],
				["launch", "--url", "about:blank", "--json"],
			];
			try {
				for (const args of commandFamilies) {
					const result = spawnSync(
						join(process.cwd(), "node_modules", ".bin", "tsx"),
						[join(process.cwd(), "packages", "cli", "src", "cli.ts"), ...args],
						{
							cwd: process.cwd(),
							encoding: "utf8",
							env: { ...process.env, SHUVGEIST_BRIDGE_CONFIG: configPath },
						},
					);
					expect(result.status, `${args.join(" ")} stderr:\n${result.stderr}`).toBe(3);
					expect(result.stderr).toContain(configPath);
					expect(readFileSync(configPath, "utf8")).toBe(malformed);
				}
				expect(() => readFileSync(join(directory, "bridge.pid"), "utf8")).toThrow();
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it(
		"names the blocked extension-registration stage within the fail-fast budget when the bridge is already healthy",
		async () => {
			const server = createServer((request, response) => {
				if (request.url !== "/status") {
					response.writeHead(404);
					response.end();
					return;
				}
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						ok: true,
						protocolVersion: 4,
						minProtocolVersion: 4,
						serverVersion: "dev",
						extension: { connected: false },
						clients: { total: 0, cli: 0, extension: 0 },
						electron: { sessions: [] },
						pendingRequests: 0,
					}),
				);
			});
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("expected the status server to bind a TCP port");
			const directory = mkdtempSync(join(tmpdir(), "shuvgeist-cli-readiness-"));
			const env = {
				...process.env,
				SHUVGEIST_BRIDGE_CONFIG: join(directory, "bridge.json"),
				SHUVGEIST_CONFIG: join(directory, "discovery.json"),
				SHUVGEIST_BRIDGE_URL: `ws://127.0.0.1:${address.port}/ws`,
				SHUVGEIST_BRIDGE_TOKEN: "test-token",
			};
			const cliPath = join(process.cwd(), "packages", "cli", "src", "cli.ts");
			const tsxPath = join(process.cwd(), "node_modules", ".bin", "tsx");
			const runCli = (args: readonly string[]) =>
				new Promise<{ code: number | null; stdout: string; stderr: string; elapsedMs: number }>((resolve, reject) => {
					const startedAt = Date.now();
					const child = spawn(tsxPath, [cliPath, ...args], {
						cwd: process.cwd(),
						env,
						stdio: ["ignore", "pipe", "pipe"],
					});
					let stdout = "";
					let stderr = "";
					const timer = setTimeout(() => {
						child.kill("SIGKILL");
						reject(new Error(`timed out\n${stderr}\n${stdout}`));
					}, 12_000);
					child.stdout.setEncoding("utf8");
					child.stderr.setEncoding("utf8");
					child.stdout.on("data", (chunk: string) => {
						stdout += chunk;
					});
					child.stderr.on("data", (chunk: string) => {
						stderr += chunk;
					});
					child.on("error", (error) => {
						clearTimeout(timer);
						reject(error);
					});
					child.on("exit", (code) => {
						clearTimeout(timer);
						resolve({ code, stdout, stderr, elapsedMs: Date.now() - startedAt });
					});
				});
			try {
				const tabs = await runCli(["tabs", "--json"]);
				expect(tabs.elapsedMs, tabs.stderr).toBeLessThan(12_000);
				expect(tabs.code, tabs.stderr).toBe(2);
				expect(tabs.stdout).toContain("Blocked at extension-registration");
				expect(tabs.stderr).not.toContain("Waiting for Shuvgeist extension to connect");

				const status = await runCli(["status"]);
				expect(status.code, `${status.stdout}\n${status.stderr}`).toBe(0);
				expect(status.stderr).toContain("Blocked at extension-registration");
				expect(status.stdout).toContain("Connected: no");
			} finally {
				server.close();
				rmSync(directory, { recursive: true, force: true });
			}
		},
		45_000,
	);

	it("contains invalid config-path overrides while help, version, and skill remain recovery-safe", () => {
		const cliPath = join(process.cwd(), "packages", "cli", "src", "cli.ts");
		const tsxPath = join(process.cwd(), "node_modules", ".bin", "tsx");
		const env = { ...process.env, SHUVGEIST_BRIDGE_CONFIG: "   " };
		const invalid = spawnSync(tsxPath, [cliPath, "status", "--json"], {
			cwd: process.cwd(),
			encoding: "utf8",
			env,
		});

		expect(invalid.status).toBe(3);
		expect(invalid.stdout).toBe("");
		expect(invalid.stderr).toContain("Fatal: Invalid SHUVGEIST_BRIDGE_CONFIG");
		expect(invalid.stderr).not.toContain("NodeConfigError:");
		expect(invalid.stderr).not.toContain("\n    at ");

		const localCommands: ReadonlyArray<{
			args: string[];
			assertOutput: (stdout: string) => void;
		}> = [
			{
				args: ["--help"],
				assertOutput: (stdout) => {
					expect(stdout).toContain("Usage:");
					expect(stdout).toContain("exact /ws path with no query or fragment");
				},
			},
			{ args: ["--version"], assertOutput: (stdout) => expect(stdout.trim()).toBe("dev") },
			{
				args: ["skill", "path", "--json"],
				assertOutput: (stdout) => expect(JSON.parse(stdout)).toEqual({ path: expect.any(String) }),
			},
		];
		for (const command of localCommands) {
			const result = spawnSync(tsxPath, [cliPath, ...command.args], {
				cwd: process.cwd(),
				encoding: "utf8",
				env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --no-deprecation`.trim() },
			});
			expect(result.status, `${command.args.join(" ")} stderr:\n${result.stderr}`).toBe(0);
			expect(result.stderr).toBe("");
			command.assertOutput(result.stdout);
		}
	});
});
