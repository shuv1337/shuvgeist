import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	closeSync as nodeCloseSync,
	existsSync as nodeExistsSync,
	mkdirSync as nodeMkdirSync,
	openSync as nodeOpenSync,
	unlinkSync as nodeUnlinkSync,
	writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BridgeConnectionDefaults,
	type BridgeConnectionOverrides,
	bridgeStatusUrl,
	createNodeConfigOwner,
	isBridgeUrlSafeForAutoStart,
	NodeConfigError,
	type NodeConfigOwner,
	type ResolvedBridgeConnection,
} from "@shuvgeist/server/node-config";

export { bridgeStatusUrl } from "@shuvgeist/server/node-config";

// Injected by scripts/build-cli.mjs (esbuild `define`). Absent in unit tests.
declare const __SHUVGEIST_DEV_ROOT__: string;

export interface BridgeAutostartProcess {
	readonly pid?: number;
	unref(): void;
}

export interface BridgeAutostartSpawnOptions {
	detached: true;
	stdio: "ignore";
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BridgeAutostartSpawn = (
	command: string,
	args: readonly string[],
	options: BridgeAutostartSpawnOptions,
) => BridgeAutostartProcess;

export interface BridgeAutostartFileSystem {
	existsSync(path: string): boolean;
	mkdirSync(path: string): void;
	writePidFile(path: string, processId: number): void;
	acquireStartLock(path: string, processId: number): boolean;
	releaseStartLock(path: string): void;
}

export interface BridgeAutostartPlan {
	command: string;
	args: string[];
	pidPath: string;
	configPath: string;
	host: string;
	port: number;
	token: string;
	developmentRoot: string;
	tsxPath: string;
	cliSourcePath: string;
}

export interface BridgeAutostartStatePaths {
	pid: string;
	lock: string;
}

export type BridgeStatusProbe = (statusUrl: string, timeoutMs: number) => Promise<boolean>;

export interface EnsureBridgeServerOptions {
	owner?: NodeConfigOwner;
	connectionDefaults?: Partial<BridgeConnectionDefaults>;
	developmentRoot?: string;
	processEnvironment?: NodeJS.ProcessEnv;
	processId?: number;
	fs?: BridgeAutostartFileSystem;
	spawn?: BridgeAutostartSpawn;
	probe?: BridgeStatusProbe;
	probeTimeoutMs?: number;
	startupDelaysMs?: readonly number[];
	delay?: (milliseconds: number) => Promise<void>;
	createToken?: () => string;
}

const DEFAULT_STARTUP_DELAYS_MS = [100, 200, 400, 800, 1_000, 1_000, 1_000, 1_000] as const;

const DEFAULT_AUTOSTART_FILE_SYSTEM: BridgeAutostartFileSystem = {
	existsSync: nodeExistsSync,
	mkdirSync(path) {
		nodeMkdirSync(path, { recursive: true, mode: 0o700 });
	},
	writePidFile(path, processId) {
		nodeWriteFileSync(path, String(processId), { encoding: "utf8", mode: 0o600 });
	},
	acquireStartLock(path, processId) {
		let descriptor: number | undefined;
		let created = false;
		try {
			descriptor = nodeOpenSync(path, "wx", 0o600);
			created = true;
			nodeWriteFileSync(descriptor, `${processId}\n`, "utf8");
			return true;
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
				return false;
			}
			if (created) {
				try {
					if (descriptor !== undefined) {
						nodeCloseSync(descriptor);
						descriptor = undefined;
					}
					nodeUnlinkSync(path);
				} catch {
					// Preserve the lock acquisition error.
				}
			}
			throw error;
		} finally {
			if (descriptor !== undefined) nodeCloseSync(descriptor);
		}
	},
	releaseStartLock(path) {
		try {
			nodeUnlinkSync(path);
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
				throw error;
			}
		}
	},
};

interface StartInFlight {
	identity: string;
	promise: Promise<ResolvedBridgeConnection>;
}

const STARTS_IN_FLIGHT = new Map<string, StartInFlight>();

const DEFAULT_SPAWN: BridgeAutostartSpawn = (command, args, options) =>
	nodeSpawn(command, [...args], {
		detached: options.detached,
		stdio: options.stdio,
		cwd: options.cwd,
		env: options.env,
	});

function defaultDelay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

function createDefaultToken(): string {
	return randomBytes(32).toString("hex");
}

/** Preserve legacy default names while isolating sibling custom configs. */
export function bridgeAutostartStatePaths(configPath: string): BridgeAutostartStatePaths {
	const directory = dirname(configPath);
	const filename = basename(configPath);
	if (filename === "bridge.json") {
		return {
			pid: join(directory, "bridge.pid"),
			lock: join(directory, "bridge.start.lock"),
		};
	}
	return {
		pid: join(directory, `${filename}.bridge.pid`),
		lock: join(directory, `${filename}.bridge.start.lock`),
	};
}

export const probeBridgeStatus: BridgeStatusProbe = async (statusUrl, timeoutMs) => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(statusUrl, { signal: controller.signal });
		return response.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
};

/** Resolve the checkout whose source CLI must own automatic bridge startup. */
export function resolveBridgeDevelopmentRoot(explicitRoot?: string): string {
	if (explicitRoot !== undefined) {
		const root = explicitRoot.trim();
		if (!root) {
			throw new NodeConfigError(
				"AUTOSTART_FAILED",
				"<development root>",
				"Cannot auto-start the bridge: the development root is empty.",
			);
		}
		return root;
	}
	if (typeof __SHUVGEIST_DEV_ROOT__ !== "undefined" && __SHUVGEIST_DEV_ROOT__) {
		return __SHUVGEIST_DEV_ROOT__;
	}
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/**
 * Build the one permitted automatic-start command. The bind address is derived
 * from the already-vetted client URL, never from wildcard-oriented serve
 * defaults or persisted serve configuration.
 */
export function createBridgeAutostartPlan(
	connection: ResolvedBridgeConnection,
	options: { developmentRoot?: string } = {},
): BridgeAutostartPlan {
	if (!connection.canAutoStart || !isBridgeUrlSafeForAutoStart(connection.url)) {
		throw new NodeConfigError(
			"AUTOSTART_UNSAFE",
			connection.configPath,
			`Refusing to auto-start a bridge for ${connection.url}. Automatic startup requires an exact /ws endpoint with no query or fragment, plain ws:// transport, and host localhost, 127.0.0.1, or ::1; start this endpoint explicitly instead.`,
		);
	}
	if (!connection.token) {
		throw new NodeConfigError(
			"AUTOSTART_FAILED",
			connection.configPath,
			"Cannot auto-start the bridge without an authentication token.",
		);
	}

	const developmentRoot = resolveBridgeDevelopmentRoot(options.developmentRoot);
	const tsxPath = join(developmentRoot, "node_modules", ".bin", "tsx");
	const cliSourcePath = join(developmentRoot, "packages", "cli", "src", "cli.ts");
	const endpoint = new URL(connection.url);
	const host = endpoint.hostname
		.replace(/^\[|\]$/gu, "")
		.replace(/\.$/u, "")
		.toLowerCase();
	const port = endpoint.port ? Number.parseInt(endpoint.port, 10) : 80;
	const statePaths = bridgeAutostartStatePaths(connection.configPath);
	return {
		command: tsxPath,
		args: [cliSourcePath, "serve", "--host", host, "--port", String(port), "--token", connection.token],
		pidPath: statePaths.pid,
		configPath: connection.configPath,
		host,
		port,
		token: connection.token,
		developmentRoot,
		tsxPath,
		cliSourcePath,
	};
}

async function safelyProbe(probe: BridgeStatusProbe, statusUrl: string, timeoutMs: number): Promise<boolean> {
	try {
		return await probe(statusUrl, timeoutMs);
	} catch {
		return false;
	}
}

async function waitForCompetingStart(
	owner: NodeConfigOwner,
	flags: BridgeConnectionOverrides,
	options: EnsureBridgeServerOptions,
	statusUrl: string,
	probe: BridgeStatusProbe,
	probeTimeoutMs: number,
	lockPath: string,
): Promise<ResolvedBridgeConnection> {
	const delay = options.delay ?? defaultDelay;
	for (const milliseconds of options.startupDelaysMs ?? DEFAULT_STARTUP_DELAYS_MS) {
		await delay(milliseconds);
		if (await safelyProbe(probe, statusUrl, probeTimeoutMs)) {
			const connection = owner.resolveBridgeConnection(flags, options.connectionDefaults);
			if (!connection.token) {
				throw new NodeConfigError(
					"AUTOSTART_FAILED",
					connection.configPath,
					`The bridge became healthy at ${statusUrl}, but its transient startup token is unavailable to this process. Retry with an explicit --token or SHUVGEIST_BRIDGE_TOKEN value.`,
				);
			}
			return connection;
		}
	}
	throw new NodeConfigError(
		"AUTOSTART_FAILED",
		owner.paths.bridge,
		`Another process holds the bridge startup lock at ${lockPath}, but ${statusUrl} did not become healthy. Remove the stale lock only after verifying that no bridge startup is running.`,
	);
}

async function ensureBridgeServerExclusive(
	owner: NodeConfigOwner,
	flags: BridgeConnectionOverrides,
	options: EnsureBridgeServerOptions,
	initialConnection: ResolvedBridgeConnection,
): Promise<ResolvedBridgeConnection> {
	let connection = initialConnection;
	let statusUrl = bridgeStatusUrl(connection.url);
	const probe = options.probe ?? probeBridgeStatus;
	const probeTimeoutMs = options.probeTimeoutMs ?? 3_000;
	if (await safelyProbe(probe, statusUrl, probeTimeoutMs)) return connection;
	if (!connection.canAutoStart || !isBridgeUrlSafeForAutoStart(connection.url)) {
		// createBridgeAutostartPlan owns the stable, actionable policy error.
		createBridgeAutostartPlan(connection, { developmentRoot: options.developmentRoot });
	}
	const developmentRoot = resolveBridgeDevelopmentRoot(options.developmentRoot);
	const sourcePaths = {
		tsx: join(developmentRoot, "node_modules", ".bin", "tsx"),
		cli: join(developmentRoot, "packages", "cli", "src", "cli.ts"),
	};
	const fs = options.fs ?? DEFAULT_AUTOSTART_FILE_SYSTEM;
	if (!fs.existsSync(sourcePaths.tsx) || !fs.existsSync(sourcePaths.cli)) {
		throw new NodeConfigError(
			"AUTOSTART_FAILED",
			connection.configPath,
			`Cannot auto-start the bridge from source: expected ${sourcePaths.tsx} and ${sourcePaths.cli} to exist.`,
		);
	}
	const configDirectory = dirname(connection.configPath);
	const lockPath = bridgeAutostartStatePaths(connection.configPath).lock;
	try {
		fs.mkdirSync(configDirectory);
	} catch (error) {
		throw new NodeConfigError(
			"AUTOSTART_FAILED",
			connection.configPath,
			`Cannot prepare the bridge state directory at ${configDirectory}: ${error instanceof Error ? error.message : String(error)}.`,
			error,
		);
	}
	let acquiredLock: boolean;
	try {
		acquiredLock = fs.acquireStartLock(lockPath, options.processId ?? process.pid);
	} catch (error) {
		throw new NodeConfigError(
			"AUTOSTART_FAILED",
			connection.configPath,
			`Cannot acquire the bridge startup lock at ${lockPath}: ${error instanceof Error ? error.message : String(error)}.`,
			error,
		);
	}
	if (!acquiredLock) {
		return waitForCompetingStart(owner, flags, options, statusUrl, probe, probeTimeoutMs, lockPath);
	}

	try {
		// Configuration can change while this process waits for the cross-process
		// lock. Re-resolve and re-apply the safety policy before any mutation.
		connection = owner.resolveBridgeConnection(flags, options.connectionDefaults);
		statusUrl = bridgeStatusUrl(connection.url);
		if (!connection.canAutoStart || !isBridgeUrlSafeForAutoStart(connection.url)) {
			createBridgeAutostartPlan(connection, { developmentRoot });
		}
		// The endpoint may have become healthy between the initial probe and lock.
		if (await safelyProbe(probe, statusUrl, probeTimeoutMs)) return connection;

		if (!connection.token) {
			const token = (options.createToken ?? createDefaultToken)().trim();
			if (!token) {
				throw new NodeConfigError(
					"AUTOSTART_FAILED",
					connection.configPath,
					"Cannot auto-start the bridge because token generation returned an empty value.",
				);
			}
			if (connection.sources.url === "file" || connection.sources.url === "defaults") {
				owner.updateBridgeConfig({ token });
				connection = owner.resolveBridgeConnection(flags, options.connectionDefaults);
			} else {
				// A flag/environment endpoint is transient. Keep its credential out of
				// an unrelated persisted URL and return/propagate it to this caller.
				connection = {
					...connection,
					token,
					sources: { ...connection.sources, token: "flags" },
				};
			}
		}

		const plan = createBridgeAutostartPlan(connection, { developmentRoot });
		// Re-probe after config/token work to avoid racing an unmanaged starter.
		if (await safelyProbe(probe, statusUrl, probeTimeoutMs)) return connection;

		const environment: NodeJS.ProcessEnv = {
			...(options.processEnvironment ?? process.env),
			SHUVGEIST_BRIDGE_CONFIG: connection.configPath,
		};
		let child: BridgeAutostartProcess;
		try {
			child = (options.spawn ?? DEFAULT_SPAWN)(plan.command, plan.args, {
				detached: true,
				stdio: "ignore",
				cwd: plan.developmentRoot,
				env: environment,
			});
		} catch (error) {
			throw new NodeConfigError(
				"AUTOSTART_FAILED",
				connection.configPath,
				`Failed to start the bridge source process: ${error instanceof Error ? error.message : String(error)}.`,
				error,
			);
		}

		if (child.pid === undefined || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
			throw new NodeConfigError(
				"AUTOSTART_FAILED",
				connection.configPath,
				"Failed to start the bridge source process: the child process did not report a valid process id.",
			);
		}
		try {
			child.unref();
		} catch (error) {
			throw new NodeConfigError(
				"AUTOSTART_FAILED",
				connection.configPath,
				`Bridge process ${child.pid} started, but could not be detached: ${error instanceof Error ? error.message : String(error)}.`,
				error,
			);
		}
		try {
			fs.writePidFile(plan.pidPath, child.pid);
		} catch (error) {
			throw new NodeConfigError(
				"AUTOSTART_FAILED",
				connection.configPath,
				`Bridge process ${child.pid} started, but its pid file could not be written at ${plan.pidPath}: ${error instanceof Error ? error.message : String(error)}.`,
				error,
			);
		}

		const delay = options.delay ?? defaultDelay;
		for (const milliseconds of options.startupDelaysMs ?? DEFAULT_STARTUP_DELAYS_MS) {
			await delay(milliseconds);
			if (await safelyProbe(probe, statusUrl, probeTimeoutMs)) return connection;
		}
		throw new NodeConfigError(
			"AUTOSTART_FAILED",
			connection.configPath,
			`Bridge source process ${child.pid} did not become healthy at ${statusUrl}.`,
		);
	} finally {
		try {
			fs.releaseStartLock(lockPath);
		} catch {
			// The bridge outcome is more actionable than a secondary lock cleanup failure.
		}
	}
}

function propagateResolvedToken(flags: BridgeConnectionOverrides, connection: ResolvedBridgeConnection): void {
	if (flags.token || !connection.token) return;
	try {
		flags.token = connection.token;
	} catch {
		// Callers using immutable flags can consume the returned connection.
	}
}

/**
 * Return an existing bridge connection or start the checkout's source bridge
 * and wait for it to become healthy. Startup is serialized in-process and via
 * an exclusive per-config lock. Unsafe endpoints are only probed, never
 * spawned, mutated, or silently redirected to a local listener.
 */
export async function ensureBridgeServer(
	flags: BridgeConnectionOverrides = {},
	options: EnsureBridgeServerOptions = {},
): Promise<ResolvedBridgeConnection> {
	const owner = options.owner ?? createNodeConfigOwner();
	const initialConnection = owner.resolveBridgeConnection(flags, options.connectionDefaults);
	const key = `${initialConnection.configPath}\0${initialConnection.url}`;
	const identity = `${initialConnection.canAutoStart ? "safe" : "unsafe"}\0${initialConnection.token}`;
	let inFlight = STARTS_IN_FLIGHT.get(key);
	if (inFlight && inFlight.identity !== identity) {
		throw new NodeConfigError(
			"AUTOSTART_FAILED",
			initialConnection.configPath,
			`A bridge startup for ${initialConnection.url} is already in progress with a different safety policy or authentication token. Wait for it to finish before retrying.`,
		);
	}
	if (!inFlight) {
		inFlight = {
			identity,
			promise: ensureBridgeServerExclusive(owner, flags, options, initialConnection),
		};
		STARTS_IN_FLIGHT.set(key, inFlight);
	}
	try {
		const connection = await inFlight.promise;
		propagateResolvedToken(flags, connection);
		return connection;
	} finally {
		if (STARTS_IN_FLIGHT.get(key) === inFlight) STARTS_IN_FLIGHT.delete(key);
	}
}
