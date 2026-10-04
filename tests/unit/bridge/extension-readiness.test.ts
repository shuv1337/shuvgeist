import type { BridgeServerStatus } from "@shuvgeist/protocol/protocol";
import { describe, expect, it, vi } from "vitest";
import {
	extensionConnectBudgetMs,
	EXTENSION_CONNECT_COLD_START_MS,
	EXTENSION_CONNECT_FAIL_FAST_MS,
	extensionWaitDisposition,
	waitForBridgeReadiness,
} from "shuvgeist/extension-readiness";

const STATUS_URL = "http://127.0.0.1:19285/status";

function statusFixture(connected: boolean, liveElectron = false): BridgeServerStatus {
	return {
		ok: true,
		protocolVersion: 4,
		minProtocolVersion: 4,
		serverVersion: "2.0.1",
		extension: connected
			? { connected: true, protocolVersion: 4, minProtocolVersion: 4 }
			: { connected: false },
		clients: { total: 1, cli: 0, extension: connected ? 1 : 0 },
		electron: {
			sessions: liveElectron
				? [
						{
							id: "e1",
							port: 9229,
							launched: false,
							startedAt: "2026-08-28T00:00:00.000Z",
							live: true,
							windows: [],
						},
					]
				: [],
		},
		pendingRequests: 0,
	};
}

function clock() {
	let now = 0;
	return {
		now: () => now,
		sleep: async (milliseconds: number) => {
			now += milliseconds;
		},
		elapsed: () => now,
	};
}

describe("extension readiness", () => {
	it("keeps the 30s budget for a bridge this process just started and fails fast when one is already healthy", () => {
		expect(extensionConnectBudgetMs(false)).toBe(EXTENSION_CONNECT_COLD_START_MS);
		expect(extensionConnectBudgetMs(true)).toBe(EXTENSION_CONNECT_FAIL_FAST_MS);
		expect(EXTENSION_CONNECT_FAIL_FAST_MS).toBeLessThan(EXTENSION_CONNECT_COLD_START_MS);
	});

	it("returns as soon as the extension is connected", async () => {
		const time = clock();
		const sleep = vi.fn(time.sleep);
		const readiness = await waitForBridgeReadiness({
			statusUrl: STATUS_URL,
			timeoutMs: EXTENSION_CONNECT_COLD_START_MS,
			alreadyHealthy: false,
			fetchStatus: async () => statusFixture(true),
			now: time.now,
			sleep,
		});

		expect(readiness).toMatchObject({ ok: true, waitedMs: 0 });
		expect(sleep).not.toHaveBeenCalled();
	});

	it("accepts a live Electron session for status without an extension", async () => {
		const time = clock();
		const readiness = await waitForBridgeReadiness({
			statusUrl: STATUS_URL,
			timeoutMs: EXTENSION_CONNECT_FAIL_FAST_MS,
			alreadyHealthy: true,
			acceptElectron: true,
			fetchStatus: async () => statusFixture(false, true),
			now: time.now,
			sleep: time.sleep,
		});

		expect(readiness.ok).toBe(true);
	});

	it("fails fast at extension-registration when an already-healthy bridge has no extension", async () => {
		const time = clock();
		const hints: string[] = [];
		const readiness = await waitForBridgeReadiness({
			statusUrl: STATUS_URL,
			timeoutMs: extensionConnectBudgetMs(true),
			alreadyHealthy: true,
			fetchStatus: async () => statusFixture(false),
			now: time.now,
			sleep: time.sleep,
			onHint: (message) => hints.push(message),
		});

		expect(time.elapsed()).toBe(EXTENSION_CONNECT_FAIL_FAST_MS);
		expect(readiness).toMatchObject({
			ok: false,
			stage: "extension-registration",
			waitedMs: EXTENSION_CONNECT_FAIL_FAST_MS,
			status: { extension: { connected: false } },
		});
		if (readiness.ok) return;
		expect(readiness.message).toBe(
			`Blocked at extension-registration: bridge status at ${STATUS_URL} is already reachable, but no browser extension is connected.`,
		);
		expect(hints).toEqual([
			`Waiting at extension-registration: bridge status at ${STATUS_URL} is reachable, but the browser extension is not connected.\n`,
		]);
		expect(extensionWaitDisposition("extension-command", readiness)).toEqual({
			action: "fail",
			message: readiness.message,
			exitCode: 2,
		});
		expect(extensionWaitDisposition("status", readiness)).toEqual({
			action: "report-status",
			notice: readiness.message,
		});
	});

	it("names bridge-status when the status endpoint never answers and does not report a status snapshot", async () => {
		const time = clock();
		const readiness = await waitForBridgeReadiness({
			statusUrl: STATUS_URL,
			timeoutMs: 0,
			alreadyHealthy: true,
			silent: true,
			fetchStatus: async () => null,
			now: time.now,
			sleep: time.sleep,
			onHint: () => {
				throw new Error("silent waits must not print a hint");
			},
		});

		expect(time.elapsed()).toBe(0);
		expect(readiness).toMatchObject({
			ok: false,
			stage: "bridge-status",
			waitedMs: 0,
		});
		if (readiness.ok) return;
		expect(readiness.status).toBeUndefined();
		expect(readiness.message).toBe(`Blocked at bridge-status: ${STATUS_URL} did not respond within 0ms.`);
		expect(extensionWaitDisposition("status", readiness)).toEqual({
			action: "fail",
			message: readiness.message,
			exitCode: 3,
		});
	});

	it("returns during the cold-start budget as soon as the extension connects", async () => {
		const time = clock();
		let calls = 0;
		const readiness = await waitForBridgeReadiness({
			statusUrl: STATUS_URL,
			timeoutMs: EXTENSION_CONNECT_COLD_START_MS,
			alreadyHealthy: false,
			silent: true,
			fetchStatus: async () => {
				calls += 1;
				return calls < 3 ? statusFixture(false) : statusFixture(true);
			},
			now: time.now,
			sleep: time.sleep,
		});

		expect(readiness.ok).toBe(true);
		expect(time.elapsed()).toBeLessThan(EXTENSION_CONNECT_COLD_START_MS);
		expect(extensionWaitDisposition("extension-command", readiness)).toEqual({ action: "continue" });
	});

	it("uses the cold-start message after the full reconnect budget", async () => {
		const time = clock();
		const readiness = await waitForBridgeReadiness({
			statusUrl: STATUS_URL,
			timeoutMs: EXTENSION_CONNECT_COLD_START_MS,
			alreadyHealthy: false,
			silent: true,
			fetchStatus: async () => statusFixture(false),
			now: time.now,
			sleep: time.sleep,
		});

		expect(time.elapsed()).toBe(EXTENSION_CONNECT_COLD_START_MS);
		expect(readiness).toMatchObject({ ok: false, stage: "extension-registration" });
		if (readiness.ok) return;
		expect(readiness.message).toBe(
			`Blocked at extension-registration: bridge status at ${STATUS_URL} is reachable, but no browser extension connected within ${EXTENSION_CONNECT_COLD_START_MS}ms.`,
		);
	});
});
