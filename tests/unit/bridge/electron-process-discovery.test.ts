import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createElectronProcessDiscovery,
	parseRemoteDebuggingPort,
	processFamilyRoot,
	processIdentityKey,
	processMatchesElectronApp,
	processTerminationIdentityKey,
	remoteDebuggingPortForProcess,
} from "@shuvgeist/server/electron/process-discovery";
import type { ElectronApp } from "@shuvgeist/server/electron/types";

describe("electron process discovery", () => {
	const directories: string[] = [];

	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("matches only canonical registry executable paths and rejects basename or alias spoofing", () => {
		const directory = mkdtempSync(join(tmpdir(), "shuvgeist-electron-identity-"));
		directories.push(directory);
		const trusted = join(directory, "Trusted Electron");
		const registryLink = join(directory, "code");
		const rogue = join(directory, "rogue", "code");
		writeFileSync(trusted, "trusted");
		mkdirSync(join(directory, "rogue"));
		writeFileSync(rogue, "rogue");
		symlinkSync(trusted, registryLink);
		const app = testApp({ linux: [registryLink] });

		expect(
			processMatchesElectronApp({ pid: 10, command: trusted, executablePath: trusted, generation: "1" }, app),
		).toBe(true);
		expect(
			processMatchesElectronApp(
				{ pid: 11, command: `${rogue} code`, args: [rogue, "code"], executablePath: rogue, generation: "1" },
				app,
			),
		).toBe(false);
		expect(processMatchesElectronApp({ pid: 12, command: registryLink, args: [registryLink] }, app)).toBe(false);
	});

	it("normalizes Windows path case and separators without parsing a spaced path as credentials", () => {
		const app = testApp({ win32: ["C:\\Program Files\\Trusted App\\Trusted.exe"] });
		const realpath = (path: string) => path;
		expect(
			processMatchesElectronApp(
				{
					pid: 20,
					command: '"c:\\program files\\trusted app\\trusted.exe" --remote-debugging-port=9333',
					executablePath: "c:/program files/trusted app/trusted.exe",
					generation: "20260721",
				},
				app,
				{ platform: "win32", realpath },
			),
		).toBe(true);
		expect(parseRemoteDebuggingPort('"C:\\Program Files\\Trusted App\\Trusted.exe" --remote-debugging-port 9333')).toBe(
			9333,
		);
	});

	it("falls back to the command string when a launcher flattens every argument into one argv field", () => {
		const command =
			"/opt/codex-desktop/codex-desktop-electron --no-sandbox --remote-debugging-port=9228";
		expect(
			remoteDebuggingPortForProcess({
				pid: 21,
				command,
				args: [command],
				executablePath: "/opt/codex-desktop/codex-desktop-electron",
				generation: "20260722",
			}),
		).toBe(9228);
	});

	it("discovers Linux process generations and inherited listening socket owners from procfs", async () => {
		const procRoot = mkdtempSync(join(tmpdir(), "shuvgeist-proc-"));
		directories.push(procRoot);
		const executable = join(procRoot, "Trusted Electron");
		writeFileSync(executable, "binary");
		mkdirSync(join(procRoot, "net"));
		mkdirSync(join(procRoot, "101", "fd"), { recursive: true });
		writeFileSync(join(procRoot, "101", "cmdline"), `${executable}\0--remote-debugging-port=9333\0`);
		const statFields = ["S", "1", ...Array.from({ length: 17 }, () => "0"), "4242"];
		writeFileSync(join(procRoot, "101", "stat"), `101 (Trusted Electron) ${statFields.join(" ")}\n`);
		symlinkSync(executable, join(procRoot, "101", "exe"));
		symlinkSync("socket:[999]", join(procRoot, "101", "fd", "7"));
		writeFileSync(
			join(procRoot, "net", "tcp"),
			"  sl  local_address rem_address   st tx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:2475 00000000:0000 0A 0:0 00:0 0 1000 0 999\n",
		);
		writeFileSync(join(procRoot, "net", "tcp6"), "  sl  local_address rem_address   st\n");
		const discovery = createElectronProcessDiscovery({ platform: "linux", procRoot });

		await expect(discovery.listProcesses()).resolves.toEqual([
			expect.objectContaining({
				pid: 101,
				parentPid: 1,
				generation: "4242",
				executablePath: executable,
				args: [executable, "--remote-debugging-port=9333"],
			}),
		]);
		await expect(discovery.findListeningPidsForPort(9333)).resolves.toEqual([101]);
		await expect(discovery.findListeningPidsForPort(9444)).resolves.toEqual([]);
	});

	it("falls back when Linux procfs cannot account for every listener inode", async () => {
		const procRoot = mkdtempSync(join(tmpdir(), "shuvgeist-proc-partial-"));
		directories.push(procRoot);
		mkdirSync(join(procRoot, "net"));
		mkdirSync(join(procRoot, "101", "fd"), { recursive: true });
		mkdirSync(join(procRoot, "202"), { recursive: true });
		symlinkSync("socket:[999]", join(procRoot, "101", "fd", "7"));
		writeFileSync(
			join(procRoot, "net", "tcp"),
			"  sl  local_address rem_address   st tx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:2475 00000000:0000 0A 0:0 00:0 0 1000 0 999\n   1: 0100007F:2475 00000000:0000 0A 0:0 00:0 0 1000 0 1000\n",
		);
		writeFileSync(join(procRoot, "net", "tcp6"), "  sl  local_address rem_address   st\n");
		const runCommand = vi.fn(async () => ({ stdout: "p101\np202\n" }));
		const discovery = createElectronProcessDiscovery({ platform: "linux", procRoot, runCommand });

		await expect(discovery.findListeningPidsForPort(9333)).resolves.toEqual([101, 202]);
		expect(runCommand).toHaveBeenCalledWith("lsof", ["-nP", "-a", "-iTCP:9333", "-sTCP:LISTEN", "-Fp"]);
	});

	it("falls back when either Linux procfs network table is unreadable", async () => {
		const procRoot = mkdtempSync(join(tmpdir(), "shuvgeist-proc-missing-table-"));
		directories.push(procRoot);
		mkdirSync(join(procRoot, "net"));
		mkdirSync(join(procRoot, "101", "fd"), { recursive: true });
		symlinkSync("socket:[999]", join(procRoot, "101", "fd", "7"));
		writeFileSync(
			join(procRoot, "net", "tcp"),
			"  sl  local_address rem_address   st tx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:2475 00000000:0000 0A 0:0 00:0 0 1000 0 999\n",
		);
		const runCommand = vi.fn(async () => ({ stdout: "p101\np202\n" }));
		const discovery = createElectronProcessDiscovery({ platform: "linux", procRoot, runCommand });

		await expect(discovery.findListeningPidsForPort(9333)).resolves.toEqual([101, 202]);
		expect(runCommand).toHaveBeenCalledWith("lsof", ["-nP", "-a", "-iTCP:9333", "-sTCP:LISTEN", "-Fp"]);
	});

	it("parses macOS structured process and lsof fields with executable paths containing spaces", async () => {
		const runCommand = vi.fn(async (executable: string) => {
			if (executable === "ps") {
				return {
					stdout:
						" 41 1 Tue Jul 21 18:00:00 2026 /Applications/Trusted App.app/Contents/MacOS/Trusted App --remote-debugging-port=9333\n",
				};
			}
			return { stdout: "p41\nn/Applications/Trusted App.app/Contents/MacOS/Trusted App\n" };
		});
		const discovery = createElectronProcessDiscovery({ platform: "darwin", runCommand });
		const [row] = await discovery.listProcesses();

		expect(row).toMatchObject({
			pid: 41,
			parentPid: 1,
			generation: "Tue Jul 21 18:00:00 2026",
			executablePath: "/Applications/Trusted App.app/Contents/MacOS/Trusted App",
		});
		expect(
			processMatchesElectronApp(row!, testApp({ darwin: [row!.executablePath!] }), {
				platform: "darwin",
				realpath: (path) => path,
			}),
		).toBe(true);
	});

	it("parses Windows CIM and listener JSON and fails closed when platform tooling is unavailable", async () => {
		const runCommand = vi.fn(async (_executable: string, args: string[]) => {
			const script = args.at(-1) ?? "";
			if (script.includes("Get-NetTCPConnection")) return { stdout: "[51,52]" };
			return {
				stdout: JSON.stringify({
					ProcessId: 51,
					ParentProcessId: 1,
					ExecutablePath: "C:\\Program Files\\Trusted App\\Trusted.exe",
					CommandLine: '"C:\\Program Files\\Trusted App\\Trusted.exe" --remote-debugging-port=9333',
					CreationDate: "20260721180000.000000-420",
				}),
			};
		});
		const discovery = createElectronProcessDiscovery({ platform: "win32", runCommand });

		await expect(discovery.listProcesses()).resolves.toEqual([
			expect.objectContaining({ pid: 51, parentPid: 1, generation: "20260721180000.000000-420" }),
		]);
		await expect(discovery.findListeningPidsForPort(9333)).resolves.toEqual([51, 52]);

		const unavailable = createElectronProcessDiscovery({
			platform: "darwin",
			runCommand: async () => {
				throw new Error("ENOENT");
			},
		});
		await expect(unavailable.listProcesses()).resolves.toEqual([]);
		await expect(unavailable.findListeningPidsForPort(9333)).resolves.toBeUndefined();
	});

	it("rejects a reused Windows parent PID that is not older than its child", () => {
		const executablePath = "C:\\Program Files\\Trusted App\\Trusted.exe";
		const app = testApp({ win32: [executablePath] });
		const child = {
			pid: 52,
			parentPid: 51,
			command: executablePath,
			executablePath,
			generation: "20260721180000.000000-420",
		};
		const staleParent = {
			pid: 51,
			parentPid: 1,
			command: executablePath,
			executablePath,
			generation: "20260721190000.000000-420",
		};
		const olderParent = { ...staleParent, generation: "20260721170000.000000-420" };
		const opaqueParent = { ...staleParent, generation: "unknown-generation" };
		const matchOptions = { platform: "win32" as const, realpath: (path: string) => path };

		expect(processFamilyRoot(child, [staleParent, child], app, matchOptions)).toBeUndefined();
		expect(processFamilyRoot(child, [opaqueParent, child], app, matchOptions)).toBeUndefined();
		expect(processFamilyRoot(child, [olderParent, child], app, matchOptions)).toEqual(olderParent);
	});

	it("fails closed on macOS second-level ancestry collisions and keys executable identity", () => {
		const firstPath = "/Applications/Trusted App.app/Contents/MacOS/Trusted App";
		const replacementPath = "/Applications/Rogue App.app/Contents/MacOS/Rogue App";
		const generation = "Tue Jul 21 18:00:00 2026";
		const parent = { pid: 61, parentPid: 1, command: firstPath, executablePath: firstPath, generation };
		const child = { pid: 62, parentPid: 61, command: firstPath, executablePath: firstPath, generation };
		const matchOptions = { platform: "darwin" as const, realpath: (path: string) => path };

		expect(processFamilyRoot(child, [parent, child], testApp({ darwin: [firstPath] }), matchOptions)).toBeUndefined();
		expect(processIdentityKey(parent, matchOptions)).not.toBe(
			processIdentityKey({ ...parent, executablePath: replacementPath }, matchOptions),
		);
		expect(processTerminationIdentityKey(parent, matchOptions)).toBeUndefined();
	});
});

function testApp(paths: ElectronApp["paths"]): ElectronApp {
	return {
		id: "test.trusted",
		aliases: ["trusted"],
		displayName: "Trusted App",
		paths,
		defaultArgs: [],
		singleInstance: "unknown",
		mainInspectSupported: true,
	};
}
