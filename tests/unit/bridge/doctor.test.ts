import {
	evaluateDoctorReport,
	formatDoctorReportText,
	type DoctorObservations,
} from "shuvgeist/doctor";
import {
	BRIDGE_PROTOCOL_MIN_VERSION,
	BRIDGE_PROTOCOL_VERSION,
	type BridgeServerStatus,
} from "@shuvgeist/protocol/protocol";

const build = { id: "development-0123456789abcdef01234567", kind: "development" } as const;

function status(overrides: Partial<BridgeServerStatus> = {}): BridgeServerStatus {
	return {
		ok: true,
		protocolVersion: BRIDGE_PROTOCOL_VERSION,
		minProtocolVersion: BRIDGE_PROTOCOL_MIN_VERSION,
		serverVersion: "dev",
		serverBuild: build,
		extension: {
			connected: true,
			protocolVersion: BRIDGE_PROTOCOL_VERSION,
			minProtocolVersion: BRIDGE_PROTOCOL_MIN_VERSION,
			appVersion: "2.0.0",
			build,
		},
		clients: { total: 1, cli: 0, extension: 1 },
		electron: { sessions: [] },
		pendingRequests: 0,
		...overrides,
	};
}

function observations(overrides: Partial<DoctorObservations> = {}): DoctorObservations {
	return {
		generatedAt: "2026-07-31T12:00:00.000Z",
		cliVersion: "dev",
		cliBuild: build,
		bridgeUrl: "ws://127.0.0.1:19285/ws",
		bridgeStatus: status(),
		extensionArtifact: {
			path: "/repo/dist-chrome",
			source: "development build",
			version: "2.0.0",
		},
		ffmpegAvailable: true,
		...overrides,
	};
}

describe("shuvgeist doctor", () => {
	it("reports package, protocol, exact build, artifact, auth, and ffmpeg readiness", () => {
		const report = evaluateDoctorReport(observations());
		expect(report.ok).toBe(true);
		expect(report.schemaVersion).toBe(1);
		expect(report.checks.map((entry) => entry.code)).toEqual(
			expect.arrayContaining([
				"CLI_BUILD_IDENTIFIED",
				"BRIDGE_PROTOCOL_COMPATIBLE",
				"BRIDGE_BUILD_MATCH",
				"BRIDGE_REGISTRATION_OK",
				"EXTENSION_ARTIFACT_FOUND",
				"EXTENSION_PROTOCOL_COMPATIBLE",
				"EXTENSION_BUILD_MATCH",
				"FFMPEG_AVAILABLE",
			]),
		);
		expect(formatDoctorReportText(report)[0]).toBe("Shuvgeist doctor: ready");
		expect(JSON.stringify(report)).not.toContain("token");
	});

	it("makes stale source instances explicit with stable failure codes", () => {
		const stale = { id: "development-fedcba9876543210fedcba98", kind: "development" } as const;
		const report = evaluateDoctorReport(
			observations({
				bridgeStatus: status({
					serverBuild: stale,
					extension: {
						connected: true,
						protocolVersion: BRIDGE_PROTOCOL_VERSION,
						minProtocolVersion: BRIDGE_PROTOCOL_MIN_VERSION,
						appVersion: "2.0.0",
						build: stale,
					},
				}),
			}),
		);
		expect(report.ok).toBe(false);
		expect(report.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ status: "fail", code: "BRIDGE_BUILD_MISMATCH" }),
				expect.objectContaining({ status: "fail", code: "EXTENSION_BUILD_MISMATCH" }),
			]),
		);
	});

	it("reports unreachable, unauthenticated, and missing-artifact states without secrets", () => {
		const report = evaluateDoctorReport(
			observations({
				bridgeStatus: undefined,
				bridgeStatusError: "connect ECONNREFUSED",
				registrationError: "Invalid token",
				extensionArtifact: undefined,
				extensionArtifactError: "not found",
				ffmpegAvailable: false,
			}),
		);
		expect(report.ok).toBe(false);
		expect(report.bridge).toEqual({
			url: "ws://127.0.0.1:19285/ws",
			reachable: false,
			authenticated: false,
		});
		expect(report.checks.map((entry) => entry.code)).toEqual(
			expect.arrayContaining([
				"BRIDGE_UNREACHABLE",
				"BRIDGE_REGISTRATION_FAILED",
				"EXTENSION_ARTIFACT_MISSING",
				"FFMPEG_MISSING",
			]),
		);
	});
});
