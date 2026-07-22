import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	bridgeAutostartStatePaths,
	bridgeStatusUrl,
	createBridgeAutostartPlan,
	ensureBridgeServer,
	type BridgeAutostartFileSystem,
	type BridgeAutostartSpawn,
	type BridgeStatusProbe,
} from "shuvgeist/bridge-autostart";
import {
	createNodeConfigOwner,
	NodeConfigError,
	resolveBridgeConnection,
	type NodeConfigFileSystem,
} from "@shuvgeist/server/node-config";

class ConfigMemoryFileSystem implements NodeConfigFileSystem {
	readonly files = new Map<string, string>();
	readonly writePaths: string[] = [];

	existsSync(path: string): boolean {
		return this.files.has(path);
	}

	readFileSync(path: string): string {
		const value = this.files.get(path);
		if (value === undefined) throw new Error(`ENOENT: ${path}`);
		return value;
	}

	mkdirSync(): void {}

	writeFileSync(path: string, contents: string): void {
		if (this.files.has(path)) throw new Error(`EEXIST: ${path}`);
		this.writePaths.push(path);
		this.files.set(path, contents);
	}

	renameSync(from: string, to: string): void {
		const value = this.files.get(from);
		if (value === undefined) throw new Error(`ENOENT: ${from}`);
		this.files.delete(from);
		this.files.set(to, value);
	}

	unlinkSync(path: string): void {
		this.files.delete(path);
	}
}

class AutostartMemoryFileSystem implements BridgeAutostartFileSystem {
	readonly existing = new Set<string>();
	readonly directories: string[] = [];
	readonly pidWrites: Array<[string, number]> = [];
	readonly lockAcquisitions: Array<[string, number]> = [];
	readonly lockReleases: string[] = [];
	failPidWrite = false;
	lockUnavailable = false;
	onAcquire: (() => void) | undefined;
	private readonly heldLocks = new Set<string>();

	existsSync(path: string): boolean {
		return this.existing.has(path);
	}

	mkdirSync(path: string): void {
		this.directories.push(path);
	}

	writePidFile(path: string, processId: number): void {
		if (this.failPidWrite) throw new Error("simulated pid write failure");
		this.pidWrites.push([path, processId]);
	}

	acquireStartLock(path: string, processId: number): boolean {
		this.lockAcquisitions.push([path, processId]);
		this.onAcquire?.();
		if (this.lockUnavailable || this.heldLocks.has(path)) return false;
		this.heldLocks.add(path);
		return true;
	}

	releaseStartLock(path: string): void {
		this.lockReleases.push(path);
		this.heldLocks.delete(path);
	}
}

const DEVELOPMENT_ROOT = "/workspace/shuvgeist";
const TSX_PATH = `${DEVELOPMENT_ROOT}/node_modules/.bin/tsx`;
const CLI_SOURCE_PATH = `${DEVELOPMENT_ROOT}/packages/cli/src/cli.ts`;
const CONFIG_PATH = "/custom/state/bridge.json";

function createOwnerAt(
	configPath: string,
	config: unknown = {},
	fs = new ConfigMemoryFileSystem(),
	extraEnv: Record<string, string | undefined> = {},
) {
	fs.files.set(configPath, typeof config === "string" ? config : `${JSON.stringify(config, null, 2)}\n`);
	const owner = createNodeConfigOwner({
		fs,
		env: { SHUVGEIST_BRIDGE_CONFIG: configPath, ...extraEnv },
		homeDirectory: "/home/tester",
		processId: 17,
		now: () => 123,
		random: () => 0.5,
	});
	return { owner, fs };
}

function createOwner(config: unknown = {}, extraEnv: Record<string, string | undefined> = {}) {
	return createOwnerAt(CONFIG_PATH, config, new ConfigMemoryFileSystem(), extraEnv);
}

function createAutostartFileSystem(): AutostartMemoryFileSystem {
	const fs = new AutostartMemoryFileSystem();
	fs.existing.add(TSX_PATH);
	fs.existing.add(CLI_SOURCE_PATH);
	return fs;
}

function sequenceProbe(sequence: readonly (boolean | Error)[]): BridgeStatusProbe {
	let index = 0;
	return vi.fn(async () => {
		const value = sequence[Math.min(index, sequence.length - 1)];
		index++;
		if (value instanceof Error) throw value;
		return value ?? false;
	});
}

describe("bridge source-tree autostart", () => {
	it("builds only the exact source-tree command and puts the pid beside a custom config", () => {
		const connection = resolveBridgeConnection({
			flags: { url: "ws://[::1]:20500/ws", token: "secret" },
			configPath: CONFIG_PATH,
		});
		const plan = createBridgeAutostartPlan(connection, { developmentRoot: DEVELOPMENT_ROOT });

		expect(plan).toMatchObject({
			command: TSX_PATH,
			args: [
				CLI_SOURCE_PATH,
				"serve",
				"--host",
				"::1",
				"--port",
				"20500",
				"--token",
				"secret",
			],
			pidPath: "/custom/state/bridge.pid",
			developmentRoot: DEVELOPMENT_ROOT,
		});
		expect(plan.command).not.toBe(process.execPath);
		expect(plan.args.join(" ")).not.toContain("dist-cli");
	});

	it("preserves default state filenames and namespaces sibling custom configs", () => {
		expect(bridgeAutostartStatePaths("/state/bridge.json")).toEqual({
			pid: "/state/bridge.pid",
			lock: "/state/bridge.start.lock",
		});
		expect(bridgeAutostartStatePaths("/state/alpha.json")).toEqual({
			pid: "/state/alpha.json.bridge.pid",
			lock: "/state/alpha.json.bridge.start.lock",
		});
		expect(bridgeAutostartStatePaths("/state/beta.json")).toEqual({
			pid: "/state/beta.json.bridge.pid",
			lock: "/state/beta.json.bridge.start.lock",
		});
	});

	it("converts ws and wss URLs into canonical status URLs", () => {
		expect(bridgeStatusUrl("ws://localhost:19285/custom?x=1#fragment")).toBe(
			"http://localhost:19285/status",
		);
		expect(bridgeStatusUrl("wss://bridge.example/ws")).toBe("https://bridge.example/status");
		expect(() => bridgeStatusUrl("http://localhost:19285/ws")).toThrowError("requires a ws:// or wss://");
	});

	it("derives bind host and port from the vetted URL instead of trusting inconsistent result fields", () => {
		const connection = resolveBridgeConnection({
			flags: { url: "ws://localhost:20400/ws", token: "token" },
			configPath: CONFIG_PATH,
		});
		const plan = createBridgeAutostartPlan(
			{ ...connection, host: "0.0.0.0", port: 1 },
			{ developmentRoot: DEVELOPMENT_ROOT },
		);
		expect(plan).toMatchObject({ host: "localhost", port: 20400 });
		expect(plan.args).toContain("localhost");
		expect(plan.args).not.toContain("0.0.0.0");

		expect(() =>
			createBridgeAutostartPlan(
				{ ...connection, url: "wss://localhost:20400/ws", canAutoStart: true },
				{ developmentRoot: DEVELOPMENT_ROOT },
			),
		).toThrowError(expect.objectContaining({ code: "AUTOSTART_UNSAFE" }));
	});

	it("starts from source, persists a generated token atomically, and preserves unknown config", async () => {
		const { owner, fs: configFs } = createOwner({
			url: "ws://127.0.0.1:19285/ws",
			futurePolicy: { preserve: true },
		});
		const fs = createAutostartFileSystem();
		const probe = sequenceProbe([false, false, false, true]);
		const delay = vi.fn(async () => {});
		let spawnCall:
			| {
					command: string;
					args: readonly string[];
					options: Parameters<BridgeAutostartSpawn>[2];
			  }
			| undefined;
		const unref = vi.fn();
		const spawn: BridgeAutostartSpawn = vi.fn((command, args, options) => {
			spawnCall = { command, args, options };
			return { pid: 4401, unref };
		});

		const result = await ensureBridgeServer(
			{},
			{
				owner,
				developmentRoot: DEVELOPMENT_ROOT,
				processEnvironment: { KEEP_ME: "yes" },
				fs,
				spawn,
				probe,
				delay,
				startupDelaysMs: [1],
				processId: 4400,
				createToken: () => "generated-token",
			},
		);

		expect(result.token).toBe("generated-token");
		expect(spawnCall).toEqual({
			command: TSX_PATH,
			args: [
				CLI_SOURCE_PATH,
				"serve",
				"--host",
				"127.0.0.1",
				"--port",
				"19285",
				"--token",
				"generated-token",
			],
			options: {
				detached: true,
				stdio: "ignore",
				cwd: DEVELOPMENT_ROOT,
				env: {
					KEEP_ME: "yes",
					SHUVGEIST_BRIDGE_CONFIG: CONFIG_PATH,
				},
			},
		});
		expect(fs.directories).toEqual([dirname(CONFIG_PATH)]);
		expect(fs.pidWrites).toEqual([["/custom/state/bridge.pid", 4401]]);
		expect(fs.lockAcquisitions).toEqual([["/custom/state/bridge.start.lock", 4400]]);
		expect(fs.lockReleases).toEqual(["/custom/state/bridge.start.lock"]);
		expect(unref).toHaveBeenCalledOnce();
		expect(delay).toHaveBeenCalledWith(1);
		expect(JSON.parse(configFs.files.get(CONFIG_PATH) ?? "null")).toEqual({
			url: "ws://127.0.0.1:19285/ws",
			futurePolicy: { preserve: true },
			token: "generated-token",
		});
	});

	it("keeps a generated token transient when a local override masks a persisted remote endpoint", async () => {
		const { owner, fs: configFs } = createOwner({
			url: "wss://remote.example/ws",
			futurePolicy: { preserve: true },
		});
		const fs = createAutostartFileSystem();
		const flags = { url: "ws://localhost:19285/ws" };
		const spawn = vi.fn<BridgeAutostartSpawn>(() => ({ pid: 4501, unref: vi.fn() }));

		const connection = await ensureBridgeServer(flags, {
			owner,
			developmentRoot: DEVELOPMENT_ROOT,
			fs,
			spawn,
			probe: sequenceProbe([false, false, false, true]),
			delay: async () => {},
			startupDelaysMs: [1],
			createToken: () => "transient-local-token",
		});

		expect(connection).toMatchObject({ url: "ws://localhost:19285/ws", token: "transient-local-token" });
		expect(flags).toEqual({ url: "ws://localhost:19285/ws", token: "transient-local-token" });
		expect(JSON.parse(configFs.files.get(CONFIG_PATH) ?? "null")).toEqual({
			url: "wss://remote.example/ws",
			futurePolicy: { preserve: true },
		});
		expect(spawn).toHaveBeenCalledOnce();
	});

	it("serializes concurrent starts so one token and one process win", async () => {
		const { owner, fs: configFs } = createOwner({ url: "ws://localhost:19285/ws" });
		const fs = createAutostartFileSystem();
		const spawn = vi.fn<BridgeAutostartSpawn>(() => ({ pid: 4601, unref: vi.fn() }));
		const createToken = vi.fn(() => "single-token");
		const probe = sequenceProbe([false, false, false, true]);
		const firstFlags: { token?: string } = {};
		const secondFlags: { token?: string } = {};
		const options = {
			owner,
			developmentRoot: DEVELOPMENT_ROOT,
			fs,
			spawn,
			probe,
			delay: async () => {},
			startupDelaysMs: [1],
			createToken,
		};

		const [first, second] = await Promise.all([
			ensureBridgeServer(firstFlags, options),
			ensureBridgeServer(secondFlags, options),
		]);

		expect(spawn).toHaveBeenCalledOnce();
		expect(createToken).toHaveBeenCalledOnce();
		expect(first.token).toBe("single-token");
		expect(second.token).toBe("single-token");
		expect(firstFlags.token).toBe("single-token");
		expect(secondFlags.token).toBe("single-token");
		expect(JSON.parse(configFs.files.get(CONFIG_PATH) ?? "null")).toMatchObject({ token: "single-token" });
		expect(fs.lockAcquisitions).toHaveLength(1);
	});

	it("re-resolves under the startup lock before mutating a config that changed to remote", async () => {
		const { owner, fs: configFs } = createOwner({ url: "ws://localhost:19285/ws", futurePolicy: true });
		const fs = createAutostartFileSystem();
		fs.onAcquire = () => {
			configFs.files.set(
				CONFIG_PATH,
				`${JSON.stringify({ url: "wss://remote.example/ws", futurePolicy: true }, null, 2)}\n`,
			);
		};
		const spawn = vi.fn<BridgeAutostartSpawn>();
		const createToken = vi.fn(() => "must-not-be-written");

		await expect(
			ensureBridgeServer(
				{},
				{
					owner,
					developmentRoot: DEVELOPMENT_ROOT,
					fs,
					spawn,
					probe: sequenceProbe([false]),
					createToken,
				},
			),
		).rejects.toMatchObject({ code: "AUTOSTART_UNSAFE", path: CONFIG_PATH });
		expect(JSON.parse(configFs.files.get(CONFIG_PATH) ?? "null")).toEqual({
			url: "wss://remote.example/ws",
			futurePolicy: true,
		});
		expect(createToken).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
		expect(fs.lockReleases).toEqual(["/custom/state/bridge.start.lock"]);
	});

	it("rejects a token-distinct caller instead of joining an incompatible in-flight start", async () => {
		const { owner } = createOwner({ url: "ws://localhost:19285/ws" });
		let resolveFirstProbe: ((healthy: boolean) => void) | undefined;
		const probe: BridgeStatusProbe = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolveFirstProbe = resolve;
				}),
		);
		const first = ensureBridgeServer({ token: "token-a" }, { owner, probe });

		await expect(ensureBridgeServer({ token: "token-b" }, { owner, probe })).rejects.toMatchObject({
			code: "AUTOSTART_FAILED",
			path: CONFIG_PATH,
		});
		resolveFirstProbe?.(true);
		await expect(first).resolves.toMatchObject({ token: "token-a" });
		expect(probe).toHaveBeenCalledOnce();
	});

	it("rejects a forbidden raw alias instead of inheriting a canonical-equivalent safe start", async () => {
		const { owner } = createOwner({});
		let resolveFirstProbe: ((healthy: boolean) => void) | undefined;
		const probe: BridgeStatusProbe = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolveFirstProbe = resolve;
				}),
		);
		const first = ensureBridgeServer(
			{ url: "ws://127.0.0.1:19285/ws", token: "token" },
			{ owner, probe },
		);

		await expect(
			ensureBridgeServer({ url: "ws://127.1:19285/ws", token: "token" }, { owner, probe }),
		).rejects.toMatchObject({ code: "AUTOSTART_FAILED", path: CONFIG_PATH });
		resolveFirstProbe?.(true);
		await expect(first).resolves.toMatchObject({ canAutoStart: true });
		expect(probe).toHaveBeenCalledOnce();
	});

	it("waits behind an exclusive lock instead of spawning a competing process", async () => {
		const { owner } = createOwner({ url: "ws://localhost:19285/ws", token: "shared-token" });
		const fs = createAutostartFileSystem();
		fs.lockUnavailable = true;
		const spawn = vi.fn<BridgeAutostartSpawn>();
		await expect(
			ensureBridgeServer(
				{},
				{
					owner,
					developmentRoot: DEVELOPMENT_ROOT,
					fs,
					spawn,
					probe: sequenceProbe([false, true]),
					delay: async () => {},
					startupDelaysMs: [1],
				},
			),
		).resolves.toMatchObject({ token: "shared-token" });
		expect(spawn).not.toHaveBeenCalled();
		expect(fs.lockReleases).toEqual([]);
	});

	it("starts sibling custom configs independently with distinct lock and pid paths", async () => {
		const configFs = new ConfigMemoryFileSystem();
		const firstPath = "/custom/state/alpha.json";
		const secondPath = "/custom/state/beta.json";
		const { owner: firstOwner } = createOwnerAt(
			firstPath,
			{ url: "ws://localhost:19301/ws", token: "alpha-token" },
			configFs,
		);
		const { owner: secondOwner } = createOwnerAt(
			secondPath,
			{ url: "ws://localhost:19302/ws", token: "beta-token" },
			configFs,
		);
		const fs = createAutostartFileSystem();
		let nextPid = 4700;
		const spawn = vi.fn<BridgeAutostartSpawn>(() => ({ pid: ++nextPid, unref: vi.fn() }));
		const common = {
			developmentRoot: DEVELOPMENT_ROOT,
			fs,
			spawn,
			delay: async () => {},
			startupDelaysMs: [1],
		};

		await Promise.all([
			ensureBridgeServer({}, { ...common, owner: firstOwner, probe: sequenceProbe([false, false, false, true]) }),
			ensureBridgeServer({}, { ...common, owner: secondOwner, probe: sequenceProbe([false, false, false, true]) }),
		]);

		expect(spawn).toHaveBeenCalledTimes(2);
		expect(fs.lockAcquisitions.map(([path]) => path).sort()).toEqual([
			"/custom/state/alpha.json.bridge.start.lock",
			"/custom/state/beta.json.bridge.start.lock",
		]);
		expect(fs.pidWrites.map(([path]) => path).sort()).toEqual([
			"/custom/state/alpha.json.bridge.pid",
			"/custom/state/beta.json.bridge.pid",
		]);
	});

	it("fails explicitly when a lock winner's transient token cannot be recovered", async () => {
		const { owner, fs: configFs } = createOwner({ url: "wss://remote.example/ws", futurePolicy: true });
		const fs = createAutostartFileSystem();
		fs.lockUnavailable = true;
		const spawn = vi.fn<BridgeAutostartSpawn>();
		const flags = { url: "ws://localhost:19285/ws" };

		await expect(
			ensureBridgeServer(flags, {
				owner,
				developmentRoot: DEVELOPMENT_ROOT,
				fs,
				spawn,
				probe: sequenceProbe([false, true]),
				delay: async () => {},
				startupDelaysMs: [1],
			}),
		).rejects.toThrowError("transient startup token is unavailable");
		expect(spawn).not.toHaveBeenCalled();
		expect(JSON.parse(configFs.files.get(CONFIG_PATH) ?? "null")).toEqual({
			url: "wss://remote.example/ws",
			futurePolicy: true,
		});
	});

	it("returns a healthy configured endpoint without checking source files or spawning", async () => {
		const { owner, fs: configFs } = createOwner({ url: "wss://remote.example/ws", token: "remote-token" });
		const fs = new AutostartMemoryFileSystem();
		const spawn = vi.fn<BridgeAutostartSpawn>();
		const result = await ensureBridgeServer({}, { owner, fs, spawn, probe: sequenceProbe([true]) });

		expect(result.url).toBe("wss://remote.example/ws");
		expect(spawn).not.toHaveBeenCalled();
		expect(configFs.writePaths).toEqual([]);
	});

	it("never mutates or spawns for unavailable TLS, alias-loopback, wildcard, or remote endpoints", async () => {
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
			"ws://192.168.1.10:19285/ws",
		]) {
			const { owner, fs: configFs } = createOwner({ url, futurePolicy: true });
			const spawn = vi.fn<BridgeAutostartSpawn>();
			const createToken = vi.fn(() => "must-not-be-used");

			await expect(
				ensureBridgeServer({}, { owner, spawn, probe: sequenceProbe([false]), createToken }),
			).rejects.toMatchObject({ code: "AUTOSTART_UNSAFE", path: CONFIG_PATH });
			expect(spawn).not.toHaveBeenCalled();
			expect(createToken).not.toHaveBeenCalled();
			expect(configFs.writePaths).toEqual([]);
		}
	});

	it("fails before token persistence when the required source checkout paths are absent", async () => {
		const { owner, fs: configFs } = createOwner({ url: "ws://localhost:19285/ws", futurePolicy: true });
		const fs = new AutostartMemoryFileSystem();
		fs.existing.add(TSX_PATH);
		const spawn = vi.fn<BridgeAutostartSpawn>();
		const createToken = vi.fn(() => "must-not-be-used");

		await expect(
			ensureBridgeServer({}, { owner, developmentRoot: DEVELOPMENT_ROOT, fs, spawn, probe: sequenceProbe([false]), createToken }),
		).rejects.toMatchObject({ code: "AUTOSTART_FAILED", path: CONFIG_PATH });
		expect(spawn).not.toHaveBeenCalled();
		expect(createToken).not.toHaveBeenCalled();
		expect(configFs.writePaths).toEqual([]);
	});

	it("rejects empty generated tokens before writing config or spawning", async () => {
		const { owner, fs: configFs } = createOwner({ url: "ws://localhost:19285/ws", futurePolicy: true });
		const fs = createAutostartFileSystem();
		const spawn = vi.fn<BridgeAutostartSpawn>();

		await expect(
			ensureBridgeServer(
				{},
				{
					owner,
					developmentRoot: DEVELOPMENT_ROOT,
					fs,
					spawn,
					probe: sequenceProbe([false]),
					createToken: () => "   ",
				},
			),
		).rejects.toMatchObject({ code: "AUTOSTART_FAILED", path: CONFIG_PATH });
		expect(configFs.writePaths).toEqual([]);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("fails closed on malformed config before probing or spawning", async () => {
		const { owner } = createOwner('{ "token": ');
		const probe = vi.fn<BridgeStatusProbe>();
		const spawn = vi.fn<BridgeAutostartSpawn>();

		await expect(ensureBridgeServer({}, { owner, probe, spawn })).rejects.toMatchObject({
			code: "INVALID_JSON",
			path: CONFIG_PATH,
		});
		expect(probe).not.toHaveBeenCalled();
		expect(spawn).not.toHaveBeenCalled();
	});

	it("surfaces spawn, invalid-pid, pid-write, and readiness failures as config-scoped errors", async () => {
		const cases: Array<{
			name: string;
			messageFragment: string;
			spawn: BridgeAutostartSpawn;
			configureFs?: (fs: AutostartMemoryFileSystem) => void;
			probes?: readonly boolean[];
		}> = [
			{
				name: "spawn",
				messageFragment: "spawn",
				spawn: () => {
					throw new Error("simulated spawn failure");
				},
			},
			{ name: "invalid pid", messageFragment: "valid process id", spawn: () => ({ unref: vi.fn() }) },
			{
				name: "pid write",
				messageFragment: "pid file",
				spawn: () => ({ pid: 99, unref: vi.fn() }),
				configureFs: (fs) => {
					fs.failPidWrite = true;
				},
			},
			{
				name: "detach",
				messageFragment: "could not be detached",
				spawn: () => ({
					pid: 101,
					unref() {
						throw new Error("simulated detach failure");
					},
				}),
			},
			{
				name: "readiness",
				messageFragment: "did not become healthy",
				spawn: () => ({ pid: 100, unref: vi.fn() }),
				probes: [false, false, false],
			},
		];

		for (const testCase of cases) {
			const { owner } = createOwner({ url: "ws://localhost:19285/ws", token: "token" });
			const fs = createAutostartFileSystem();
			testCase.configureFs?.(fs);
			await expect(
				ensureBridgeServer(
					{},
					{
						owner,
						developmentRoot: DEVELOPMENT_ROOT,
						fs,
						spawn: testCase.spawn,
						probe: sequenceProbe(testCase.probes ?? [false, false]),
						delay: async () => {},
						startupDelaysMs: [1],
					},
				),
			).rejects.toSatisfy((error: unknown) => {
				expect(error).toBeInstanceOf(NodeConfigError);
				expect(error).toMatchObject({ code: "AUTOSTART_FAILED", path: CONFIG_PATH });
				expect((error as Error).message.toLowerCase()).toContain(testCase.messageFragment);
				return true;
			});
		}
	});

	it("treats probe exceptions as unavailable and can still recover", async () => {
		const { owner } = createOwner({ url: "ws://localhost:19285/ws", token: "token" });
		const fs = createAutostartFileSystem();
		const spawn = vi.fn<BridgeAutostartSpawn>(() => ({ pid: 501, unref: vi.fn() }));
		await expect(
			ensureBridgeServer(
				{},
				{
					owner,
					developmentRoot: DEVELOPMENT_ROOT,
					fs,
					spawn,
					probe: sequenceProbe([new Error("probe failed"), false, false, true]),
					delay: async () => {},
					startupDelaysMs: [1],
				},
			),
		).resolves.toMatchObject({ token: "token" });
		expect(spawn).toHaveBeenCalledOnce();
	});
});
