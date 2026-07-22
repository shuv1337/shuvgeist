import { existsSync } from "node:fs";
import { BridgeDefaults } from "@shuvgeist/protocol/protocol";
import { createNodeConfigOwner, type NodeConfigOwner } from "../node-config.js";
import { listElectronRegistryEntries, resolveElectronApp } from "./app-registry.js";
import { normalizeElectronConfig } from "./config.js";
import {
	type ElectronProcessRow,
	findListeningPidsForPort,
	listElectronProcesses,
	parseRemoteDebuggingPort,
	processMatchesElectronApp,
	resolveElectronPortOwners,
} from "./process-discovery.js";
import { readSkillSnapshot, skillSnapshotPath } from "./skill-snapshot-store.js";
import type { ElectronApp } from "./types.js";

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

export interface ElectronDoctorParams {
	appRef?: string;
	configOwner?: NodeConfigOwner;
	listProcesses?: () => Promise<ElectronProcessRow[]>;
	listeningPidsForPort?: (port: number) => Promise<number[] | undefined>;
	processMatchesApp?: (processRow: ElectronProcessRow, app: ElectronApp) => boolean;
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

async function scanCdpPorts(ports: Iterable<number>): Promise<ElectronRunningCdpApp[]> {
	const probes = Array.from(new Set(ports), (port) => probeCdpPort(port));
	return (await Promise.all(probes)).filter((app): app is ElectronRunningCdpApp => Boolean(app));
}

function portsInRange([start, end]: [number, number]): number[] {
	const ports: number[] = [];
	for (let port = start; port <= end; port++) ports.push(port);
	return ports;
}

async function discoverOwnedCdpPortsForApp(
	app: ElectronApp,
	processLoader: () => Promise<ElectronProcessRow[]>,
	listenerLoader: (port: number) => Promise<number[] | undefined>,
	processMatcher: (processRow: ElectronProcessRow, app: ElectronApp) => boolean,
): Promise<{ ports: number[]; ownershipUnavailable: boolean }> {
	const ports = new Set<number>();
	let ownershipUnavailable = false;
	const processes = await processLoader();
	for (const processRow of processes) {
		if (!processMatcher(processRow, app)) continue;
		const port = parseRemoteDebuggingPort(processRow.command);
		if (!port) continue;
		const owners = await resolveElectronPortOwners(port, {
			processes,
			listeningPidsForPort: listenerLoader,
		});
		if (!owners) {
			ownershipUnavailable = true;
			continue;
		}
		if (owners.some((owner) => owner.pid === processRow.pid)) ports.add(port);
	}
	return { ports: [...ports], ownershipUnavailable };
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

export async function runElectronDoctor(params: ElectronDoctorParams = {}): Promise<ElectronDoctorResult> {
	const checks: ElectronDoctorCheck[] = [];
	const configOwner = params.configOwner ?? createNodeConfigOwner();
	const configPath = configOwner.paths.bridge;
	const config = configOwner.readBridgeConfig();
	const electron = normalizeElectronConfig(config);
	const apps = listElectronRegistryEntries(new Set(electron.allowlist));
	const requestedApp = params.appRef ? resolveElectronApp(params.appRef) : undefined;
	const app = requestedApp ? apps.find((entry) => entry.id === requestedApp.id) : undefined;
	const requestedAppAllowed = requestedApp ? electron.allowlist.includes(requestedApp.id) : false;

	check(
		checks,
		existsSync(configPath) ? "pass" : "fail",
		"token_file",
		"Bridge token file",
		existsSync(configPath) ? configPath : `Missing ${configPath}`,
		existsSync(configPath) ? undefined : `Run 'shuvgeist serve' once to create ${configPath}.`,
	);
	if (existsSync(configPath)) {
		const hasToken = Boolean(config.token);
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
		params.appRef ? (requestedAppAllowed ? "pass" : "warn") : electron.allowlist.length > 0 ? "pass" : "warn",
		"allowlist",
		"Electron allowlist",
		params.appRef
			? requestedAppAllowed
				? `${requestedApp?.displayName ?? params.appRef} is allowlisted`
				: `${requestedApp?.displayName ?? params.appRef} is not allowlisted`
			: electron.allowlist.length > 0
				? electron.allowlist.join(", ")
				: "No apps are allowlisted",
		params.appRef
			? requestedAppAllowed
				? undefined
				: `Run 'shuvgeist electron allow ${params.appRef}'.`
			: electron.allowlist.length > 0
				? undefined
				: "Run 'shuvgeist electron allow <app-id-or-alias>'.",
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
	const snapshot = readSkillSnapshot(configOwner);
	check(
		checks,
		snapshot.status.state === "fresh" ? "pass" : "warn",
		"skill_snapshot",
		"Bridge skill snapshot",
		`${snapshot.status.state}: ${snapshot.status.message ?? skillSnapshotPath(configOwner)}`,
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
	const targetedDiscovery = requestedApp
		? await discoverOwnedCdpPortsForApp(
				requestedApp,
				params.listProcesses ?? listElectronProcesses,
				params.listeningPidsForPort ?? findListeningPidsForPort,
				params.processMatchesApp ?? processMatchesElectronApp,
			)
		: undefined;
	if (targetedDiscovery?.ownershipUnavailable) {
		check(
			checks,
			"warn",
			"port_ownership",
			"Electron CDP port ownership",
			`Could not verify listening PID ownership for ${requestedApp?.displayName ?? params.appRef}`,
			"Install or enable lsof, then rerun the targeted doctor check.",
		);
	}
	const portsToProbe = targetedDiscovery
		? targetedDiscovery.ports
		: params.appRef
			? []
			: portsInRange(electron.portRange);
	const runningCdpApps = await scanCdpPorts(portsToProbe);
	check(
		checks,
		runningCdpApps.length > 0 ? "pass" : "warn",
		"running_cdp",
		"Running CDP apps",
		runningCdpApps.length > 0
			? `${runningCdpApps.length} port(s) responding: ${runningCdpApps.map((candidate) => candidate.port).join(", ")}`
			: targetedDiscovery?.ownershipUnavailable
				? `CDP listener ownership for ${requestedApp?.displayName ?? params.appRef} could not be verified`
				: app
					? `No CDP endpoint owned by ${app.displayName} is listening`
					: "No CDP apps found in the configured range",
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
