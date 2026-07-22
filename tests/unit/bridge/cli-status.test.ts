import {
	formatBridgeStatusText,
	hasUsableElectronSessions,
	isBridgeStatusReady,
} from "shuvgeist/cli-status";
import type { BridgeServerStatus } from "@shuvgeist/protocol/protocol";

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
