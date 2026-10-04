import { createServer, type Server } from "node:http";
import type { BridgeServerStatus } from "@shuvgeist/protocol/protocol";
import {
	bridgeConnectivityDiagnostics,
	classifyBridgeConnectivityFailure,
	decideStatusPoll,
	formatBridgeConnectivityMessage,
	formatBridgeStatusText,
	hasUsableElectronSessions,
	isBridgeStatusReady,
	readBridgeStatus,
	STATUS_COMMAND_TIMEOUT_MS,
	StatusDeadlineError,
	statusPollDelayMs,
} from "shuvgeist/cli-status";

function statusFixture(overrides: Partial<BridgeServerStatus> = {}): BridgeServerStatus {
	return {
		ok: true,
		protocolVersion: 2,
		minProtocolVersion: 2,
		serverVersion: "2.0.0",
		extension: { connected: false },
		clients: { total: 1, cli: 1, extension: 0 },
		electron: { sessions: [] },
		pendingRequests: 0,
		...overrides,
	};
}

describe("CLI bridge status formatting", () => {
	it("reports disconnected extension and usable Electron sessions as separate surfaces", () => {
		const status = statusFixture({
			electron: {
				sessions: [
					{
						id: "e1",
						appId: "codex-desktop",
						appRef: "codex",
						port: 9228,
						browser: "\u001b[31mChrome/148.0.7778.97\u001b[0m",
						launched: false,
						startedAt: "2026-07-22T00:00:00.000Z",
						live: true,
						livePageTargetCount: 1,
						livenessCheckedAt: "2026-07-22T00:00:01.000Z",
						livenessReason: "ok",
						windows: [
							{
								ref: "w1",
								label: "main",
								type: "page",
								title: "\u001b[31mCodex\u001b[0m\u0007 title",
								url: "app://-/index.html",
								isPrimary: true,
							},
							{
								ref: "w2",
								type: "page",
								title: "Closed window",
								isPrimary: false,
								closed: true,
							},
						],
					},
				],
			},
		});

		const lines = formatBridgeStatusText(status, {
			cliVersion: "2.0.0",
			statusUrl: "http://127.0.0.1:19285/status",
		});

		expect(lines).toEqual(
			expect.arrayContaining([
				"Browser extension:",
				"  Connected: no",
				"Electron:",
				"  Sessions: 1 (1 live, 0 stale, 0 unverified)",
				"  e1: codex; attached; port 9228; live; page targets 1 current; targets 1/2 current; Chrome/148.0.7778.97",
				"    w1 (main) [primary, current]: Codex title",
				"    w2 [closed]: Closed window",
				"  Extension disconnected; Electron control remains usable through 1 bridge-local session(s).",
			]),
		);
		expect(hasUsableElectronSessions(status)).toBe(true);
		expect(isBridgeStatusReady(status, true)).toBe(true);
		expect(isBridgeStatusReady(status, false)).toBe(false);
	});

	it("does not call a stale Electron session usable from cached windows", () => {
		const status = statusFixture({
			electron: {
				sessions: [
					{
						id: "e1",
						port: 9228,
						launched: false,
						startedAt: "2026-07-22T00:00:00.000Z",
						live: false,
						livePageTargetCount: 0,
						livenessCheckedAt: "2026-07-22T00:00:01.000Z",
						livenessReason: "cdp_unreachable",
						windows: [
							{ ref: "w1", type: "page", title: "Codex", isPrimary: true },
						],
					},
				],
			},
		});

		expect(hasUsableElectronSessions(status)).toBe(false);
		expect(isBridgeStatusReady(status, true)).toBe(false);
		const lines = formatBridgeStatusText(status, { cliVersion: "2.0.0", statusUrl: "status" });
		expect(lines).toEqual(
			expect.arrayContaining([
				"  Sessions: 1 (0 live, 1 stale, 0 unverified)",
				"  e1: unknown app; attached; port 9228; stale: cdp unreachable; target records 1 tracked",
				"    w1 [primary, tracked]: Codex",
			]),
		);
		expect(lines).not.toContain(
			"  Extension disconnected; Electron control remains usable through 1 bridge-local session(s).",
		);
	});

	it("does not trust cached windows from an older server without a live signal", () => {
		const status = statusFixture({
			electron: {
				sessions: [
					{
						id: "e1",
						port: 9228,
						launched: false,
						startedAt: "2026-07-22T00:00:00.000Z",
						windows: [{ ref: "w1", type: "page", title: "Codex", isPrimary: true }],
					},
				],
			},
		});

		expect(hasUsableElectronSessions(status)).toBe(false);
		expect(isBridgeStatusReady(status, true)).toBe(false);
		expect(formatBridgeStatusText(status, { cliVersion: "2.0.0", statusUrl: "status" })).toEqual(
			expect.arrayContaining([
				"  Sessions: 1 (0 live, 0 stale, 1 unverified)",
				"  e1: unknown app; attached; port 9228; unverified; target records 1 tracked",
			]),
		);
	});

	it("treats a connected browser extension as ready without Electron", () => {
		const status = statusFixture({
			extension: {
				connected: true,
				windowId: 7,
				sessionId: "session-1",
				protocolVersion: 2,
				appVersion: "2.0.0",
				capabilities: ["snapshot"],
				remoteAddress: "127.0.0.1",
			},
		});

		expect(isBridgeStatusReady(status, false)).toBe(true);
		expect(formatBridgeStatusText(status, { cliVersion: "2.0.0", statusUrl: "status" })).toEqual(
			expect.arrayContaining(["  Connected: yes", "  Window ID: 7", "  Capabilities: snapshot"]),
		);
	});
});

describe("status command deadline", () => {
	it("defaults to a 5 second bound and returns the last snapshot when the deadline hits", () => {
		expect(STATUS_COMMAND_TIMEOUT_MS).toBe(5_000);
		expect(decideStatusPoll({ snapshotReady: true, hasSnapshot: true, remainingMs: 4_000 })).toBe("return");
		expect(decideStatusPoll({ snapshotReady: false, hasSnapshot: true, remainingMs: 1_000 })).toBe("wait");
		expect(decideStatusPoll({ snapshotReady: false, hasSnapshot: true, remainingMs: 0 })).toBe("return");
		expect(decideStatusPoll({ snapshotReady: false, hasSnapshot: false, remainingMs: 0 })).toBe("fail");
		expect(decideStatusPoll({ snapshotReady: false, hasSnapshot: false, remainingMs: undefined })).toBe("wait");
		expect(statusPollDelayMs(800, undefined)).toBe(500);
		expect(statusPollDelayMs(200, 50)).toBe(50);
	});

	it("classifies bridge connectivity failures", () => {
		const refused = new TypeError("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }),
		});
		expect(classifyBridgeConnectivityFailure(refused).reason).toBe("connection_refused");

		const autostart = new Error("Bridge source process 9 did not become healthy.");
		autostart.name = "NodeConfigError";
		Object.assign(autostart, { code: "AUTOSTART_FAILED" });
		expect(classifyBridgeConnectivityFailure(autostart)).toEqual({
			reason: "autostart_failed",
			detail: "Bridge source process 9 did not become healthy.",
		});

		const diagnostics = bridgeConnectivityDiagnostics({
			statusUrl: "http://127.0.0.1:19285/status",
			timeoutMs: STATUS_COMMAND_TIMEOUT_MS,
			error: new StatusDeadlineError(),
			lastFailure: classifyBridgeConnectivityFailure(refused),
		});
		expect(diagnostics).toMatchObject({
			statusUrl: "http://127.0.0.1:19285/status",
			timeoutMs: 5_000,
			bridgeReachable: false,
			extensionConnected: false,
			reason: "connection_refused",
		});
		expect(formatBridgeConnectivityMessage(diagnostics)).toContain("refused the connection");
		expect(formatBridgeConnectivityMessage(diagnostics)).toContain("Stopped after 5000ms.");
	});
});

describe("readBridgeStatus", () => {
	async function listen(server: Server): Promise<string> {
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("expected a TCP port");
		return `http://127.0.0.1:${address.port}/status`;
	}

	async function stop(server: Server): Promise<void> {
		server.closeAllConnections();
		if (!server.listening) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	it("returns status JSON", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(statusFixture({ extension: { connected: true, sessionId: "s1" } })));
		});
		const url = await listen(server);
		try {
			const result = await readBridgeStatus(url, 1_000);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.status.extension.connected).toBe(true);
		} finally {
			await stop(server);
		}
	});

	it("reports an HTTP error without hanging", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(503);
			response.end("unavailable");
		});
		const url = await listen(server);
		try {
			const result = await readBridgeStatus(url, 1_000);
			expect(result).toMatchObject({ ok: false, reason: "http_error", httpStatus: 503 });
		} finally {
			await stop(server);
		}
	});

	it("bounds a stalled status body", async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "application/json" });
			response.write('{"ok":true');
		});
		const url = await listen(server);
		const startedAt = Date.now();
		try {
			const result = await readBridgeStatus(url, 200);
			expect(result).toMatchObject({ ok: false, reason: "timeout" });
			expect(Date.now() - startedAt).toBeLessThan(2_000);
		} finally {
			await stop(server);
		}
	});

	it("reports connection refused", async () => {
		const server = createServer();
		const url = await listen(server);
		await stop(server);
		const result = await readBridgeStatus(url, 1_000);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("connection_refused");
	});
});
