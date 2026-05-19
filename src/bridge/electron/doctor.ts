import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { BridgeDefaults } from "../protocol.js";
import { listElectronRegistryEntries } from "./app-registry.js";
import { bridgeConfigPath, normalizeElectronConfig, readBridgeConfig } from "./config.js";
import { readSkillSnapshot, skillSnapshotPath } from "./skill-snapshot-store.js";

export type ElectronDoctorStatus = "pass" | "warn" | "fail";

export interface ElectronDoctorCheck {
	id: string;
	status: ElectronDoctorStatus;
	label: string;
	detail: string;
	fix?: string;
}

export interface ElectronDoctorResult {
	ok: boolean;
	summary: string;
	checks: ElectronDoctorCheck[];
	fixes: string[];
	runningCdpApps: ElectronRunningCdpApp[];
	text: string;
}

export interface ElectronRunningCdpApp {
	port: number;
	browser?: string;
	webSocketDebuggerUrl?: string;
}

interface CdpVersionResponse {
	Browser?: string;
	webSocketDebuggerUrl?: string;
}

async function readJsonFile(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf-8")) as unknown;
}

async function probeCdpPort(port: number): Promise<ElectronRunningCdpApp | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 200);
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
		if (!response.ok) return undefined;
		const version = (await response.json()) as CdpVersionResponse;
		return { port, browser: version.Browser, webSocketDebuggerUrl: version.webSocketDebuggerUrl };
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

async function scanCdpPorts([start, end]: [number, number]): Promise<ElectronRunningCdpApp[]> {
	const probes: Array<Promise<ElectronRunningCdpApp | undefined>> = [];
	for (let port = start; port <= end; port++) probes.push(probeCdpPort(port));
	return (await Promise.all(probes)).filter((app): app is ElectronRunningCdpApp => Boolean(app));
}

function check(
	checks: ElectronDoctorCheck[],
	status: ElectronDoctorStatus,
	id: string,
	label: string,
	detail: string,
	fix?: string,
): void {
	checks.push({ id, status, label, detail, ...(fix ? { fix } : {}) });
}

function renderDoctorText(checks: ElectronDoctorCheck[], runningCdpApps: ElectronRunningCdpApp[]): string {
	const lines = ["Electron doctor"];
	for (const item of checks) {
		const marker = item.status === "pass" ? "PASS" : item.status === "warn" ? "WARN" : "FAIL";
		lines.push(`${marker} ${item.label}: ${item.detail}`);
		if (item.fix) lines.push(`  Fix: ${item.fix}`);
	}
	if (runningCdpApps.length > 0) {
		lines.push("Running CDP apps:");
		for (const app of runningCdpApps) {
			lines.push(`  ${app.port}: ${app.browser ?? "unknown Chromium"}`);
		}
	}
	return lines.join("\n");
}

export async function runElectronDoctor(params: { appRef?: string } = {}): Promise<ElectronDoctorResult> {
	const checks: ElectronDoctorCheck[] = [];
	const configPath = bridgeConfigPath();
	const config = readBridgeConfig(configPath);
	const electron = normalizeElectronConfig(config);
	const apps = listElectronRegistryEntries(new Set(electron.allowlist));
	const app = params.appRef
		? apps.find((entry) => entry.id === params.appRef || entry.aliases.includes(params.appRef ?? ""))
		: undefined;

	check(
		checks,
		existsSync(configPath) ? "pass" : "fail",
		"token_file",
		"Bridge token file",
		existsSync(configPath) ? configPath : `Missing ${configPath}`,
		existsSync(configPath) ? undefined : `Run 'shuvgeist serve' once to create ${configPath}.`,
	);
	if (existsSync(configPath)) {
		const rawConfig = await readJsonFile(configPath).catch(() => undefined);
		const hasToken = Boolean((rawConfig as { token?: unknown } | undefined)?.token);
		check(
			checks,
			hasToken ? "pass" : "fail",
			"token_value",
			"Bridge token value",
			hasToken ? "Configured" : "Missing token in bridge config",
			hasToken ? undefined : "Regenerate the bridge config with 'shuvgeist serve --token <token>'.",
		);
	}
	check(
		checks,
		electron.allowlist.length > 0 ? "pass" : "warn",
		"allowlist",
		"Electron allowlist",
		electron.allowlist.length > 0 ? electron.allowlist.join(", ") : "No apps are allowlisted",
		electron.allowlist.length > 0 ? undefined : "Run 'shuvgeist electron allow <app-id-or-alias>'.",
	);
	check(
		checks,
		electron.portRange[0] <= electron.portRange[1] ? "pass" : "fail",
		"port_range",
		"Electron CDP port range",
		`${electron.portRange[0]}-${electron.portRange[1]}`,
		electron.portRange[0] <= electron.portRange[1]
			? undefined
			: "Set electron.portRange to a valid ascending range in the bridge config.",
	);
	const snapshot = readSkillSnapshot();
	check(
		checks,
		snapshot.status.state === "fresh" ? "pass" : "warn",
		"skill_snapshot",
		"Bridge skill snapshot",
		`${snapshot.status.state}: ${snapshot.status.message ?? skillSnapshotPath()}`,
		snapshot.status.state === "fresh"
			? undefined
			: "Open the extension after build so it can sync the skill snapshot to the bridge.",
	);
	const installedApps = params.appRef ? apps.filter((entry) => entry === app) : apps;
	if (params.appRef && !app) {
		check(
			checks,
			"fail",
			"app_path",
			"Requested app path",
			`Unknown Electron app '${params.appRef}'`,
			"Run 'shuvgeist electron list' to see known apps.",
		);
	} else {
		for (const entry of installedApps) {
			check(
				checks,
				entry.installed ? "pass" : "warn",
				`app_path:${entry.id}`,
				`${entry.displayName} path`,
				entry.path ?? "Not found on this host",
				entry.installed
					? undefined
					: `Install ${entry.displayName} or update the registry path before launch/attach.`,
			);
		}
	}
	const runningCdpApps = await scanCdpPorts(electron.portRange);
	check(
		checks,
		runningCdpApps.length > 0 ? "pass" : "warn",
		"running_cdp",
		"Running CDP apps",
		runningCdpApps.length > 0 ? `${runningCdpApps.length} port(s) responding` : "No CDP apps found in range",
		runningCdpApps.length > 0
			? undefined
			: "Launch with 'shuvgeist electron launch <app>' or start the app with --remote-debugging-port=<port>.",
	);
	const chromiumVersion = runningCdpApps.find((candidate) => candidate.browser)?.browser;
	check(
		checks,
		chromiumVersion ? "pass" : "warn",
		"chromium_version",
		"Chromium version",
		chromiumVersion ?? "No running CDP app exposed /json/version",
		chromiumVersion ? undefined : "Attach or launch a CDP-enabled Electron app, then rerun doctor.",
	);
	check(
		checks,
		"pass",
		"extensionless_commands",
		"Extensionless Electron commands",
		`Bridge-local Electron methods are available without a browser extension on port ${BridgeDefaults.PORT}.`,
	);
	const fixes = checks.filter((item) => item.status !== "pass" && item.fix).map((item) => item.fix as string);
	const failed = checks.filter((item) => item.status === "fail").length;
	const warned = checks.filter((item) => item.status === "warn").length;
	const summary = `${failed} failed, ${warned} warning(s), ${checks.length - failed - warned} passed`;
	return {
		ok: failed === 0,
		summary,
		checks,
		fixes,
		runningCdpApps,
		text: renderDoctorText(checks, runningCdpApps),
	};
}
