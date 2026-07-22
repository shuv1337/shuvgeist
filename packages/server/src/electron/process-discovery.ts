/** Host process discovery for server-managed Electron sessions. */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";
import type { ElectronApp } from "./types.js";

const execFileAsync = promisify(execFile);

export interface ElectronProcessRow {
	pid: number;
	parentPid?: number;
	command: string;
	args?: string[];
	executablePath?: string;
	/** OS process creation identity. PID plus this key survives neither exit nor PID reuse. */
	generation?: string;
}

export interface ElectronProcessAppMatch {
	app: ElectronApp;
	process: ElectronProcessRow;
}

export interface ElectronProcessDiscovery {
	listProcesses(): Promise<ElectronProcessRow[]>;
	findListeningPidsForPort(port: number): Promise<number[] | undefined>;
}

interface CommandResult {
	stdout: string;
}

export interface ElectronProcessDiscoveryOptions {
	platform?: NodeJS.Platform;
	procRoot?: string;
	runCommand?: (executable: string, args: string[]) => Promise<CommandResult>;
}

export interface ElectronExecutableMatchOptions {
	platform?: NodeJS.Platform;
	homeDirectory?: string;
	environment?: NodeJS.ProcessEnv;
	realpath?: (path: string) => string;
}

const defaultRunCommand = async (executable: string, args: string[]): Promise<CommandResult> => {
	const { stdout } = await execFileAsync(executable, args, {
		encoding: "utf-8",
		timeout: 1500,
		maxBuffer: 16 * 1024 * 1024,
	});
	return { stdout: String(stdout) };
};

export function createElectronProcessDiscovery(
	options: ElectronProcessDiscoveryOptions = {},
): ElectronProcessDiscovery {
	const platform = options.platform ?? process.platform;
	const procRoot = options.procRoot ?? "/proc";
	const runCommand = options.runCommand ?? defaultRunCommand;
	return {
		listProcesses: async () => {
			if (platform === "linux") return listLinuxProcesses(procRoot);
			if (platform === "darwin") return listMacProcesses(runCommand);
			if (platform === "win32") return listWindowsProcesses(runCommand);
			return [];
		},
		findListeningPidsForPort: async (port) => {
			if (platform === "linux") {
				const procOwners = findLinuxListeningPids(port, procRoot);
				if (procOwners !== undefined) return procOwners;
				return findLsofListeningPids(port, runCommand);
			}
			if (platform === "darwin") return findLsofListeningPids(port, runCommand);
			if (platform === "win32") return findWindowsListeningPids(port, runCommand);
			return undefined;
		},
	};
}

const defaultDiscovery = createElectronProcessDiscovery();

export function parseRemoteDebuggingPort(commandOrArgs: string | readonly string[]): number | undefined {
	if (typeof commandOrArgs !== "string") {
		for (let index = 0; index < commandOrArgs.length; index++) {
			const argument = commandOrArgs[index] ?? "";
			const equalsMatch = /^--remote-debugging-port=(\d+)$/u.exec(argument);
			if (equalsMatch) return validPort(equalsMatch[1]);
			if (argument === "--remote-debugging-port") return validPort(commandOrArgs[index + 1]);
		}
		return undefined;
	}
	const equalsMatch = /(?:^|\s)--remote-debugging-port=(\d+)(?=\s|$)/u.exec(commandOrArgs);
	if (equalsMatch) return validPort(equalsMatch[1]);
	const splitMatch = /(?:^|\s)--remote-debugging-port\s+(\d+)(?=\s|$)/u.exec(commandOrArgs);
	return splitMatch ? validPort(splitMatch[1]) : undefined;
}

export function remoteDebuggingPortForProcess(processRow: ElectronProcessRow): number | undefined {
	const portFromArgs = processRow.args ? parseRemoteDebuggingPort(processRow.args) : undefined;
	return portFromArgs ?? parseRemoteDebuggingPort(processRow.command);
}

export async function discoverPortForPid(
	pid: number,
	processLoader: () => Promise<ElectronProcessRow[]> = listElectronProcesses,
): Promise<number | undefined> {
	const processRow = (await processLoader()).find((candidate) => candidate.pid === pid);
	return processRow ? remoteDebuggingPortForProcess(processRow) : undefined;
}

export function listElectronProcesses(): Promise<ElectronProcessRow[]> {
	return defaultDiscovery.listProcesses();
}

export function findListeningPidsForPort(port: number): Promise<number[] | undefined> {
	return defaultDiscovery.findListeningPidsForPort(port);
}

export interface ElectronPortOwnerResolutionOptions {
	processes?: ElectronProcessRow[];
	listeningPidsForPort?: (port: number) => Promise<number[] | undefined>;
}

export async function resolveElectronPortOwners(
	port: number,
	options: ElectronPortOwnerResolutionOptions = {},
): Promise<ElectronProcessRow[] | undefined> {
	const listeningPids = await (options.listeningPidsForPort ?? findListeningPidsForPort)(port);
	if (!listeningPids) return undefined;
	const processes = options.processes ?? (await listElectronProcesses());
	return processes.filter((processRow) => listeningPids.includes(processRow.pid));
}

/**
 * Authorizes only an OS-reported executable whose canonical path exactly
 * matches an existing canonical registry path. App ids, aliases, basenames,
 * argv values, and display names are deliberately never credentials.
 */
export function processMatchesElectronApp(
	processRow: ElectronProcessRow,
	app: ElectronApp,
	options: ElectronExecutableMatchOptions = {},
): boolean {
	if (!processRow.executablePath) return false;
	const platform = options.platform ?? process.platform;
	const executable = canonicalExecutablePath(processRow.executablePath, options);
	if (!executable) return false;
	return (app.paths[platform] ?? []).some((registryPath) => {
		const expanded = expandRegistryPath(
			registryPath,
			options.homeDirectory ?? homedir(),
			options.environment ?? process.env,
		);
		return canonicalExecutablePath(expanded, options) === executable;
	});
}

export function matchElectronAppsForProcesses(
	processes: ElectronProcessRow[],
	apps: readonly ElectronApp[],
	options: ElectronExecutableMatchOptions = {},
): ElectronProcessAppMatch[] {
	return processes.flatMap((processRow) =>
		apps
			.filter((app) => processMatchesElectronApp(processRow, app, options))
			.map((app) => ({ app, process: processRow })),
	);
}

export function canonicalExecutablePath(
	path: string,
	options: ElectronExecutableMatchOptions = {},
): string | undefined {
	if (!path.trim()) return undefined;
	const platform = options.platform ?? process.platform;
	try {
		const resolved = (options.realpath ?? realpathSync.native)(path);
		if (platform === "win32") return win32.normalize(resolved).replaceAll("/", "\\").toLowerCase();
		return posix.normalize(resolved.replaceAll("\\", "/"));
	} catch {
		return undefined;
	}
}

export function processFamilyRoot(
	processRow: ElectronProcessRow,
	processes: readonly ElectronProcessRow[],
	app: ElectronApp,
	matchOptions: ElectronExecutableMatchOptions = {},
): ElectronProcessRow | undefined {
	const byPid = new Map(processes.map((candidate) => [candidate.pid, candidate]));
	let current = processRow;
	const visited = new Set<number>();
	while (current.parentPid) {
		if (visited.has(current.pid)) return undefined;
		visited.add(current.pid);
		const parent = byPid.get(current.parentPid);
		if (!parent || !processMatchesElectronApp(parent, app, matchOptions)) break;
		if (!verifiedParentPrecedesChild(parent, current)) return undefined;
		current = parent;
	}
	return current;
}

export function processIsInFamily(
	processRow: ElectronProcessRow,
	familyRoot: ElectronProcessRow,
	processes: readonly ElectronProcessRow[],
	matchOptions: ElectronExecutableMatchOptions = {},
): boolean {
	const familyRootKey = processIdentityKey(familyRoot, matchOptions);
	if (!familyRootKey) return false;
	const byPid = new Map(processes.map((candidate) => [candidate.pid, candidate]));
	let current = processRow;
	const visited = new Set<number>();
	while (true) {
		if (current.pid === familyRoot.pid) {
			return processIdentityKey(current, matchOptions) === familyRootKey;
		}
		if (!current.parentPid || visited.has(current.pid)) return false;
		visited.add(current.pid);
		const parent = byPid.get(current.parentPid);
		if (!parent || !verifiedParentPrecedesChild(parent, current)) return false;
		current = parent;
	}
}

export function processIdentityKey(
	processRow: ElectronProcessRow,
	matchOptions: ElectronExecutableMatchOptions = {},
): string | undefined {
	if (!processRow.generation || !processRow.executablePath) return undefined;
	const executablePath = canonicalExecutablePath(processRow.executablePath, matchOptions);
	if (!executablePath) return undefined;
	return JSON.stringify([processRow.pid, processRow.generation, executablePath]);
}

export function processTerminationIdentityKey(
	processRow: ElectronProcessRow,
	matchOptions: ElectronExecutableMatchOptions = {},
): string | undefined {
	if (isMacProcessGeneration(processRow.generation)) return undefined;
	return processIdentityKey(processRow, matchOptions);
}

function listLinuxProcesses(procRoot: string): ElectronProcessRow[] {
	let entries: Array<{ isDirectory(): boolean; name: string }>;
	try {
		entries = readdirSync(procRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const rows: ElectronProcessRow[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
		const pid = Number.parseInt(entry.name, 10);
		const args = readNullSeparated(`${procRoot}/${pid}/cmdline`);
		const stat = readLinuxProcessStat(`${procRoot}/${pid}/stat`);
		let executablePath: string | undefined;
		try {
			executablePath = readlinkSync(`${procRoot}/${pid}/exe`);
		} catch {}
		rows.push({
			pid,
			...(stat?.parentPid !== undefined ? { parentPid: stat.parentPid } : {}),
			command: args?.join(" ") ?? "",
			...(args ? { args } : {}),
			...(executablePath ? { executablePath } : {}),
			...(stat?.generation ? { generation: stat.generation } : {}),
		});
	}
	return rows;
}

async function listMacProcesses(
	runCommand: (executable: string, args: string[]) => Promise<CommandResult>,
): Promise<ElectronProcessRow[]> {
	try {
		const [{ stdout: psOutput }, { stdout: lsofOutput }] = await Promise.all([
			runCommand("ps", ["-axo", "pid=,ppid=,lstart=,args="]),
			runCommand("lsof", ["-nP", "-d", "txt", "-Fpn"]),
		]);
		const executables = parseLsofExecutablePaths(lsofOutput);
		return psOutput
			.split("\n")
			.map(parseMacProcessLine)
			.filter((row): row is ElectronProcessRow => Boolean(row))
			.map((row) => {
				const executablePath = executables.get(row.pid);
				return executablePath ? { ...row, executablePath } : row;
			});
	} catch {
		return [];
	}
}

async function listWindowsProcesses(
	runCommand: (executable: string, args: string[]) => Promise<CommandResult>,
): Promise<ElectronProcessRow[]> {
	const script =
		"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress";
	const result = await runPowerShell(runCommand, script);
	if (!result) return [];
	try {
		const decoded = JSON.parse(result.stdout) as unknown;
		const items = Array.isArray(decoded) ? decoded : [decoded];
		return items.flatMap((value) => {
			if (!isRecord(value)) return [];
			const pid = numberValue(value.ProcessId);
			if (!pid) return [];
			const parentPid = numberValue(value.ParentProcessId);
			const command = stringValue(value.CommandLine) ?? "";
			const executablePath = stringValue(value.ExecutablePath);
			const generation = stringValue(value.CreationDate);
			return [
				{
					pid,
					...(parentPid !== undefined ? { parentPid } : {}),
					command,
					...(executablePath ? { executablePath } : {}),
					...(generation ? { generation } : {}),
				},
			];
		});
	} catch {
		return [];
	}
}

function findLinuxListeningPids(port: number, procRoot: string): number[] | undefined {
	const inodes = new Set<string>();
	let networkTablesRead = 0;
	for (const table of [`${procRoot}/net/tcp`, `${procRoot}/net/tcp6`]) {
		try {
			const contents = readFileSync(table, "utf-8");
			networkTablesRead++;
			for (const line of contents.split("\n").slice(1)) {
				const fields = line.trim().split(/\s+/u);
				if (fields.length < 10 || fields[3] !== "0A") continue;
				const localPort = Number.parseInt(fields[1]?.split(":").pop() ?? "", 16);
				if (localPort === port && fields[9]) inodes.add(fields[9]);
			}
		} catch {}
	}
	if (networkTablesRead !== 2) return undefined;
	if (inodes.size === 0) return [];
	let entries: Array<{ isDirectory(): boolean; name: string }>;
	try {
		entries = readdirSync(procRoot, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const owners = new Set<number>();
	const resolvedInodes = new Set<string>();
	let scanComplete = true;
	for (const entry of entries) {
		if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
		let descriptors: string[];
		try {
			descriptors = readdirSync(`${procRoot}/${entry.name}/fd`);
		} catch {
			scanComplete = false;
			continue;
		}
		for (const descriptor of descriptors) {
			try {
				const link = readlinkSync(`${procRoot}/${entry.name}/fd/${descriptor}`);
				const inode = /^socket:\[(\d+)\]$/u.exec(link)?.[1];
				if (inode && inodes.has(inode)) {
					resolvedInodes.add(inode);
					owners.add(Number.parseInt(entry.name, 10));
				}
			} catch {
				scanComplete = false;
			}
		}
	}
	if (!scanComplete || resolvedInodes.size !== inodes.size) return undefined;
	return [...owners].sort((left, right) => left - right);
}

function verifiedParentPrecedesChild(parent: ElectronProcessRow, child: ElectronProcessRow): boolean {
	const parentOrder = comparableGeneration(parent.generation);
	const childOrder = comparableGeneration(child.generation);
	return Boolean(
		parentOrder && childOrder && parentOrder.kind === childOrder.kind && parentOrder.value < childOrder.value,
	);
}

function comparableGeneration(
	generation: string | undefined,
): { kind: "counter" | "timestamp"; value: bigint } | undefined {
	if (!generation) return undefined;
	if (/^\d+$/u.test(generation)) return { kind: "counter", value: BigInt(generation) };
	const windowsTimestamp = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,6}))?([+-]\d{3})?$/u.exec(
		generation,
	);
	if (windowsTimestamp) {
		const [, year, month, day, hour, minute, second, fraction = "", offset = "+000"] = windowsTimestamp;
		const utcMilliseconds =
			Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) -
			Number(offset) * 60_000;
		if (!Number.isFinite(utcMilliseconds)) return undefined;
		return {
			kind: "timestamp",
			value: BigInt(utcMilliseconds) * 1000n + BigInt(fraction.padEnd(6, "0")),
		};
	}
	const dotNetTimestamp = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/u.exec(generation);
	if (dotNetTimestamp) return { kind: "timestamp", value: BigInt(dotNetTimestamp[1]) * 1000n };
	const isMacTimestamp = isMacProcessGeneration(generation);
	const isIsoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(generation);
	if (!isMacTimestamp && !isIsoTimestamp) return undefined;
	const parsedTimestamp = Date.parse(generation);
	if (!Number.isFinite(parsedTimestamp)) return undefined;
	return { kind: "timestamp", value: BigInt(parsedTimestamp) * 1000n };
}

function isMacProcessGeneration(generation: string | undefined): boolean {
	return Boolean(
		generation &&
			/^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u.test(
				generation,
			),
	);
}

async function findLsofListeningPids(
	port: number,
	runCommand: (executable: string, args: string[]) => Promise<CommandResult>,
): Promise<number[] | undefined> {
	try {
		const { stdout } = await runCommand("lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
		return parsePidFields(stdout);
	} catch (error) {
		return commandExitCode(error) === 1 ? [] : undefined;
	}
}

async function findWindowsListeningPids(
	port: number,
	runCommand: (executable: string, args: string[]) => Promise<CommandResult>,
): Promise<number[] | undefined> {
	const script = `@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique) | ConvertTo-Json -Compress`;
	const result = await runPowerShell(runCommand, script);
	if (!result) return undefined;
	try {
		const value = JSON.parse(result.stdout) as unknown;
		const values = Array.isArray(value) ? value : value === null ? [] : [value];
		return Array.from(new Set(values.map(numberValue).filter((pid): pid is number => pid !== undefined))).sort(
			(left, right) => left - right,
		);
	} catch {
		return undefined;
	}
}

async function runPowerShell(
	runCommand: (executable: string, args: string[]) => Promise<CommandResult>,
	script: string,
): Promise<CommandResult | undefined> {
	for (const executable of ["powershell.exe", "pwsh.exe", "pwsh"]) {
		try {
			return await runCommand(executable, ["-NoProfile", "-NonInteractive", "-Command", script]);
		} catch {}
	}
	return undefined;
}

function parseMacProcessLine(line: string): ElectronProcessRow | undefined {
	const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/u.exec(line);
	if (!match) return undefined;
	return {
		pid: Number.parseInt(match[1], 10),
		parentPid: Number.parseInt(match[2], 10),
		generation: match[3].replace(/\s+/gu, " "),
		command: match[4],
	};
}

function parseLsofExecutablePaths(output: string): Map<number, string> {
	const paths = new Map<number, string>();
	let pid: number | undefined;
	for (const line of output.split("\n")) {
		if (/^p\d+$/u.test(line)) pid = Number.parseInt(line.slice(1), 10);
		else if (pid && line.startsWith("n/") && !paths.has(pid)) paths.set(pid, line.slice(1));
	}
	return paths;
}

function parsePidFields(output: string): number[] {
	return Array.from(
		new Set(
			output
				.split("\n")
				.filter((line) => /^p\d+$/u.test(line))
				.map((line) => Number.parseInt(line.slice(1), 10)),
		),
	).sort((left, right) => left - right);
}

function readNullSeparated(path: string): string[] | undefined {
	try {
		return readFileSync(path, "utf-8").split("\0").filter(Boolean);
	} catch {
		return undefined;
	}
}

function readLinuxProcessStat(path: string): { parentPid: number; generation: string } | undefined {
	try {
		const value = readFileSync(path, "utf-8");
		const closeParen = value.lastIndexOf(")");
		if (closeParen < 0) return undefined;
		const fields = value
			.slice(closeParen + 1)
			.trim()
			.split(/\s+/u);
		const parentPid = Number.parseInt(fields[1] ?? "", 10);
		const generation = fields[19];
		if (!Number.isInteger(parentPid) || !generation) return undefined;
		return { parentPid, generation };
	} catch {
		return undefined;
	}
}

function expandRegistryPath(path: string, homeDirectory: string, environment: NodeJS.ProcessEnv): string {
	return path
		.replace(/^~(?=$|\/|\\)/u, homeDirectory)
		.replaceAll("%LOCALAPPDATA%", environment.LOCALAPPDATA ?? "")
		.replaceAll("%ProgramFiles%", environment.ProgramFiles ?? "C:\\Program Files");
}

function validPort(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const port = Number.parseInt(value, 10);
	return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function commandExitCode(error: unknown): number | undefined {
	if (!isRecord(error)) return undefined;
	return numberValue(error.code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && /^\d+$/u.test(value)) return Number.parseInt(value, 10);
	return undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}
