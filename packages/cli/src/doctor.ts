import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BRIDGE_PROTOCOL_MIN_VERSION,
	BRIDGE_PROTOCOL_VERSION,
	type BridgeServerStatus,
	isBridgeProtocolCompatible,
	type RegisterResult,
} from "@shuvgeist/protocol/protocol";
import type { BuildIdentity } from "@shuvgeist/protocol/version";
import { WebSocket } from "ws";
import { type DiscoveryDependencies, type DiscoveryResult, discoverExtensionPath } from "./discovery.js";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
	id: string;
	status: DoctorCheckStatus;
	code: string;
	message: string;
}

export interface DoctorExtensionArtifact {
	path: string;
	source: string;
	version?: string;
}

export interface DoctorReport {
	schemaVersion: 1;
	ok: boolean;
	generatedAt: string;
	cli: {
		version: string;
		build: BuildIdentity;
		protocolVersion: number;
		minProtocolVersion: number;
	};
	bridge: {
		url: string;
		reachable: boolean;
		authenticated: boolean;
		status?: BridgeServerStatus;
	};
	extensionArtifact?: DoctorExtensionArtifact;
	checks: DoctorCheck[];
}

export interface DoctorObservations {
	generatedAt: string;
	cliVersion: string;
	cliBuild: BuildIdentity;
	bridgeUrl: string;
	bridgeStatus?: BridgeServerStatus;
	bridgeStatusError?: string;
	registrationError?: string;
	extensionArtifact?: DoctorExtensionArtifact;
	extensionArtifactError?: string;
	ffmpegAvailable: boolean;
}

function check(id: string, status: DoctorCheckStatus, code: string, message: string): DoctorCheck {
	return { id, status, code, message };
}

function buildMatchCheck(
	id: string,
	label: string,
	actual: BuildIdentity | undefined,
	expected: BuildIdentity,
): DoctorCheck {
	if (!actual) {
		return check(
			id,
			"warn",
			`${id.toUpperCase()}_BUILD_UNKNOWN`,
			`${label} did not report an exact build identity. Rebuild and restart it.`,
		);
	}
	if (actual.id !== expected.id || actual.kind !== expected.kind) {
		return check(
			id,
			"fail",
			`${id.toUpperCase()}_BUILD_MISMATCH`,
			`${label} build ${actual.id} (${actual.kind}) does not match CLI build ${expected.id} (${expected.kind}). Rebuild and restart it.`,
		);
	}
	return check(id, "pass", `${id.toUpperCase()}_BUILD_MATCH`, `${label} exact build matches the CLI.`);
}

function protocolCheck(
	id: string,
	label: string,
	protocolVersion: number | undefined,
	minProtocolVersion: number | undefined,
): DoctorCheck {
	if (!isBridgeProtocolCompatible(protocolVersion, minProtocolVersion ?? protocolVersion)) {
		return check(
			id,
			"fail",
			`${id.toUpperCase()}_PROTOCOL_MISMATCH`,
			`${label} protocol range ${minProtocolVersion ?? "missing"}-${protocolVersion ?? "missing"} is incompatible with CLI range ${BRIDGE_PROTOCOL_MIN_VERSION}-${BRIDGE_PROTOCOL_VERSION}.`,
		);
	}
	return check(id, "pass", `${id.toUpperCase()}_PROTOCOL_COMPATIBLE`, `${label} protocol is compatible with the CLI.`);
}

export function evaluateDoctorReport(observations: DoctorObservations): DoctorReport {
	const checks: DoctorCheck[] = [
		check(
			"cli-build",
			"pass",
			"CLI_BUILD_IDENTIFIED",
			`CLI exact build is ${observations.cliBuild.id} (${observations.cliBuild.kind}).`,
		),
	];
	const status = observations.bridgeStatus;
	if (!status) {
		checks.push(
			check(
				"bridge-reachable",
				"fail",
				"BRIDGE_UNREACHABLE",
				`Bridge status is unavailable: ${observations.bridgeStatusError ?? "unknown error"}`,
			),
		);
	} else {
		checks.push(check("bridge-reachable", "pass", "BRIDGE_REACHABLE", "Bridge status endpoint is reachable."));
		checks.push(
			protocolCheck("bridge", "Bridge", status.protocolVersion, status.minProtocolVersion),
			buildMatchCheck("bridge", "Bridge", status.serverBuild, observations.cliBuild),
		);
		if (observations.cliVersion === "dev" || status.serverVersion === observations.cliVersion) {
			checks.push(
				check(
					"bridge-version",
					"pass",
					"BRIDGE_VERSION_MATCH",
					`Bridge package version ${status.serverVersion} is compatible with CLI ${observations.cliVersion}.`,
				),
			);
		} else {
			checks.push(
				check(
					"bridge-version",
					"fail",
					"BRIDGE_VERSION_MISMATCH",
					`Bridge package version ${status.serverVersion} does not match CLI ${observations.cliVersion}.`,
				),
			);
		}
	}

	checks.push(
		observations.registrationError
			? check(
					"bridge-auth",
					"fail",
					"BRIDGE_REGISTRATION_FAILED",
					`Authenticated bridge registration failed: ${observations.registrationError}`,
				)
			: check("bridge-auth", "pass", "BRIDGE_REGISTRATION_OK", "Authenticated bridge registration succeeded."),
	);

	if (!observations.extensionArtifact) {
		checks.push(
			check(
				"extension-artifact",
				status?.extension.connected ? "warn" : "fail",
				"EXTENSION_ARTIFACT_MISSING",
				`No valid Shuvgeist extension artifact was discovered: ${observations.extensionArtifactError ?? "not found"}`,
			),
		);
	} else {
		checks.push(
			check(
				"extension-artifact",
				"pass",
				"EXTENSION_ARTIFACT_FOUND",
				`Extension ${observations.extensionArtifact.version ?? "unknown version"} found at ${observations.extensionArtifact.path} (${observations.extensionArtifact.source}).`,
			),
		);
	}

	if (!status?.extension.connected) {
		checks.push(
			check(
				"extension-connected",
				"warn",
				"EXTENSION_DISCONNECTED",
				"No browser extension is currently connected to the bridge.",
			),
		);
	} else {
		checks.push(
			check("extension-connected", "pass", "EXTENSION_CONNECTED", "Browser extension is connected."),
			protocolCheck("extension", "Extension", status.extension.protocolVersion, status.extension.minProtocolVersion),
			buildMatchCheck("extension", "Extension", status.extension.build, observations.cliBuild),
		);
		const artifactVersion = observations.extensionArtifact?.version;
		if (
			observations.cliVersion !== "dev" &&
			status.extension.appVersion &&
			status.extension.appVersion !== observations.cliVersion
		) {
			checks.push(
				check(
					"extension-version",
					"fail",
					"EXTENSION_VERSION_MISMATCH",
					`Connected extension package version ${status.extension.appVersion} does not match CLI ${observations.cliVersion}.`,
				),
			);
		} else if (artifactVersion && status.extension.appVersion && artifactVersion !== status.extension.appVersion) {
			checks.push(
				check(
					"extension-version",
					"warn",
					"EXTENSION_ARTIFACT_VERSION_DIFFERS",
					`Discovered extension artifact version ${artifactVersion} differs from connected extension ${status.extension.appVersion}.`,
				),
			);
		} else {
			checks.push(
				check(
					"extension-version",
					"pass",
					"EXTENSION_VERSION_MATCH",
					`Connected extension package version is ${status.extension.appVersion ?? "unknown"}.`,
				),
			);
		}
	}

	checks.push(
		observations.ffmpegAvailable
			? check("ffmpeg", "pass", "FFMPEG_AVAILABLE", "ffmpeg is available for recording.")
			: check(
					"ffmpeg",
					"warn",
					"FFMPEG_MISSING",
					"ffmpeg is unavailable; install it before using shuvgeist record.",
				),
	);

	return {
		schemaVersion: 1,
		ok: !checks.some((entry) => entry.status === "fail"),
		generatedAt: observations.generatedAt,
		cli: {
			version: observations.cliVersion,
			build: observations.cliBuild,
			protocolVersion: BRIDGE_PROTOCOL_VERSION,
			minProtocolVersion: BRIDGE_PROTOCOL_MIN_VERSION,
		},
		bridge: {
			url: observations.bridgeUrl,
			reachable: Boolean(status),
			authenticated: !observations.registrationError,
			...(status ? { status } : {}),
		},
		...(observations.extensionArtifact ? { extensionArtifact: observations.extensionArtifact } : {}),
		checks,
	};
}

interface DoctorConnection {
	url: string;
	token?: string;
}

export interface CollectDoctorReportOptions {
	connection: DoctorConnection;
	cliVersion: string;
	cliBuild: BuildIdentity;
	timeoutMs: number;
	developmentRoot?: string;
	configOwner?: DiscoveryDependencies["configOwner"];
}

function bridgeStatusUrl(webSocketUrl: string): string {
	const parsed = new URL(webSocketUrl);
	parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
	parsed.pathname = "/status";
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString();
}

async function fetchStatus(url: string, timeoutMs: number): Promise<BridgeServerStatus> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return (await response.json()) as BridgeServerStatus;
	} finally {
		clearTimeout(timeout);
	}
}

function probeRegistration(
	url: string,
	token: string | undefined,
	version: string,
	build: BuildIdentity,
	timeoutMs: number,
): Promise<void> {
	if (!token) return Promise.reject(new Error("bridge token is not configured"));
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			socket.close();
			error ? reject(error) : resolve();
		};
		const timeout = setTimeout(() => finish(new Error(`registration timed out after ${timeoutMs}ms`)), timeoutMs);
		socket.on("open", () => {
			socket.send(
				JSON.stringify({
					type: "register",
					role: "cli",
					token,
					protocolVersion: BRIDGE_PROTOCOL_VERSION,
					minProtocolVersion: BRIDGE_PROTOCOL_MIN_VERSION,
					appVersion: version,
					build,
					name: "shuvgeist-doctor",
				}),
			);
		});
		socket.on("message", (data: Buffer | string) => {
			let message: RegisterResult;
			try {
				message = JSON.parse(typeof data === "string" ? data : data.toString("utf8")) as RegisterResult;
			} catch {
				finish(new Error("bridge returned invalid JSON"));
				return;
			}
			if (message.type !== "register_result") return;
			finish(message.ok ? undefined : new Error(message.error ?? "registration rejected"));
		});
		socket.on("error", (error) => finish(error));
		socket.on("close", () => finish(new Error("bridge closed before registration completed")));
	});
}

function readExtensionArtifact(
	developmentRoot: string | undefined,
	configOwner: CollectDoctorReportOptions["configOwner"],
): DoctorExtensionArtifact | undefined {
	const discovered: DiscoveryResult | null = discoverExtensionPath(undefined, {
		developmentRoot,
		...(configOwner ? { configOwner } : {}),
	});
	if (!discovered) return undefined;
	const manifest = JSON.parse(readFileSync(join(discovered.extensionPath, "manifest.json"), "utf8")) as {
		name?: string;
		version?: string;
	};
	if (manifest.name !== "Shuvgeist") throw new Error("discovered manifest is not Shuvgeist");
	return {
		path: discovered.extensionPath,
		source: discovered.source,
		...(manifest.version ? { version: manifest.version } : {}),
	};
}

export async function collectDoctorReport(options: CollectDoctorReportOptions): Promise<DoctorReport> {
	let bridgeStatus: BridgeServerStatus | undefined;
	let bridgeStatusError: string | undefined;
	try {
		bridgeStatus = await fetchStatus(bridgeStatusUrl(options.connection.url), options.timeoutMs);
	} catch (error) {
		bridgeStatusError = error instanceof Error ? error.message : String(error);
	}

	let registrationError: string | undefined;
	try {
		await probeRegistration(
			options.connection.url,
			options.connection.token,
			options.cliVersion,
			options.cliBuild,
			options.timeoutMs,
		);
	} catch (error) {
		registrationError = error instanceof Error ? error.message : String(error);
	}

	let extensionArtifact: DoctorExtensionArtifact | undefined;
	let extensionArtifactError: string | undefined;
	try {
		extensionArtifact = readExtensionArtifact(options.developmentRoot, options.configOwner);
		if (!extensionArtifact) extensionArtifactError = "not found";
	} catch (error) {
		extensionArtifactError = error instanceof Error ? error.message : String(error);
	}

	const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8", timeout: options.timeoutMs });
	return evaluateDoctorReport({
		generatedAt: new Date().toISOString(),
		cliVersion: options.cliVersion,
		cliBuild: options.cliBuild,
		bridgeUrl: options.connection.url,
		...(bridgeStatus ? { bridgeStatus } : {}),
		...(bridgeStatusError ? { bridgeStatusError } : {}),
		...(registrationError ? { registrationError } : {}),
		...(extensionArtifact ? { extensionArtifact } : {}),
		...(extensionArtifactError ? { extensionArtifactError } : {}),
		ffmpegAvailable: ffmpeg.status === 0,
	});
}

export function formatDoctorReportText(report: DoctorReport): string[] {
	const lines = [
		`Shuvgeist doctor: ${report.ok ? "ready" : "not ready"}`,
		`CLI: ${report.cli.version}; ${report.cli.build.id} (${report.cli.build.kind}); protocol ${report.cli.minProtocolVersion}-${report.cli.protocolVersion}`,
		`Bridge: ${report.bridge.url}`,
	];
	for (const entry of report.checks) {
		lines.push(`[${entry.status.toUpperCase()}] ${entry.code}: ${entry.message}`);
	}
	return lines;
}
