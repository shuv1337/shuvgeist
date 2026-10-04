/**
 * Extension-registration wait for CLI commands that already have a bridge.
 *
 * Bridge process startup fails on its own with a config error. This module
 * only decides how long to wait for the browser extension afterwards, and
 * which stage is blocked when that wait expires.
 */

import type { BridgeServerStatus } from "@shuvgeist/protocol/protocol";
import { isBridgeStatusReady } from "./cli-status.js";

/** Cold-start budget after this process brings the bridge up. Covers the extension's 15s reconnect cap. */
export const EXTENSION_CONNECT_COLD_START_MS = 30_000;

/**
 * Budget when the status endpoint was already healthy. Warm extension
 * connections land well under 2 seconds; a longer wait only hides a bridge
 * that is up with no extension.
 */
export const EXTENSION_CONNECT_FAIL_FAST_MS = 2_000;

/** Print one stderr hint once a wait has lasted this long. */
export const EXTENSION_CONNECT_HINT_MS = 1_500;

export type BridgeReadinessStage = "bridge-status" | "extension-registration";

export interface BridgeReadinessBlocked {
	ok: false;
	stage: BridgeReadinessStage;
	statusUrl: string;
	waitedMs: number;
	message: string;
	status?: BridgeServerStatus;
}

export interface BridgeReadinessReady {
	ok: true;
	status: BridgeServerStatus;
	waitedMs: number;
}

export type BridgeReadiness = BridgeReadinessReady | BridgeReadinessBlocked;

export type ExtensionWaitCommand = "status" | "extension-command";

export type ExtensionWaitDisposition =
	| { action: "continue" }
	| { action: "report-status"; notice: string }
	| { action: "fail"; message: string; exitCode: 2 | 3 };

export interface WaitForBridgeReadinessOptions {
	statusUrl: string;
	timeoutMs: number;
	alreadyHealthy: boolean;
	acceptElectron?: boolean;
	silent?: boolean;
	hintAfterMs?: number;
	fetchStatus: (statusUrl: string) => Promise<BridgeServerStatus | null>;
	sleep?: (milliseconds: number) => Promise<void>;
	now?: () => number;
	onHint?: (message: string) => void;
}

export function extensionConnectBudgetMs(alreadyHealthy: boolean): number {
	return alreadyHealthy ? EXTENSION_CONNECT_FAIL_FAST_MS : EXTENSION_CONNECT_COLD_START_MS;
}

export function describeBlockedBridgeStage(input: {
	stage: BridgeReadinessStage;
	statusUrl: string;
	waitedMs: number;
	alreadyHealthy: boolean;
}): string {
	switch (input.stage) {
		case "bridge-status":
			return `Blocked at bridge-status: ${input.statusUrl} did not respond within ${input.waitedMs}ms.`;
		case "extension-registration":
			if (input.alreadyHealthy) {
				return `Blocked at extension-registration: bridge status at ${input.statusUrl} is already reachable, but no browser extension is connected.`;
			}
			return `Blocked at extension-registration: bridge status at ${input.statusUrl} is reachable, but no browser extension connected within ${input.waitedMs}ms.`;
		default: {
			const unreachable: never = input.stage;
			return unreachable;
		}
	}
}

export function bridgeReadinessWaitingHint(stage: BridgeReadinessStage, statusUrl: string): string {
	switch (stage) {
		case "bridge-status":
			return `Waiting at bridge-status: ${statusUrl} has not responded.\n`;
		case "extension-registration":
			return `Waiting at extension-registration: bridge status at ${statusUrl} is reachable, but the browser extension is not connected.\n`;
		default: {
			const unreachable: never = stage;
			return unreachable;
		}
	}
}

export function exitCodeForBlockedStage(stage: BridgeReadinessStage): 2 | 3 {
	switch (stage) {
		case "extension-registration":
			return 2;
		case "bridge-status":
			return 3;
		default: {
			const unreachable: never = stage;
			return unreachable;
		}
	}
}

/**
 * `status` reports a disconnected extension when the bridge answered.
 * Extension-backed commands stop at the blocked stage instead of opening
 * another request that can only time out.
 */
export function extensionWaitDisposition(
	command: ExtensionWaitCommand,
	readiness: BridgeReadiness,
): ExtensionWaitDisposition {
	if (readiness.ok) return { action: "continue" };
	if (command === "status" && readiness.status) {
		return { action: "report-status", notice: readiness.message };
	}
	return {
		action: "fail",
		message: readiness.message,
		exitCode: exitCodeForBlockedStage(readiness.stage),
	};
}

function defaultSleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

export async function waitForBridgeReadiness(options: WaitForBridgeReadinessOptions): Promise<BridgeReadiness> {
	const sleep = options.sleep ?? defaultSleep;
	const now = options.now ?? Date.now;
	const hintAfterMs = options.hintAfterMs ?? EXTENSION_CONNECT_HINT_MS;
	const startedAt = now();
	let hintPrinted = false;
	let delay = 100;
	let sawStatus = false;
	let lastStatus: BridgeServerStatus | undefined;

	const blocked = (waitedMs: number): BridgeReadinessBlocked => {
		const stage: BridgeReadinessStage = sawStatus ? "extension-registration" : "bridge-status";
		return {
			ok: false,
			stage,
			statusUrl: options.statusUrl,
			waitedMs,
			...(lastStatus ? { status: lastStatus } : {}),
			message: describeBlockedBridgeStage({
				stage,
				statusUrl: options.statusUrl,
				waitedMs,
				alreadyHealthy: options.alreadyHealthy,
			}),
		};
	};

	while (true) {
		const status = await options.fetchStatus(options.statusUrl);
		if (status) {
			sawStatus = true;
			lastStatus = status;
			if (isBridgeStatusReady(status, options.acceptElectron === true)) {
				return { ok: true, status, waitedMs: Math.max(0, now() - startedAt) };
			}
		}

		const elapsed = Math.max(0, now() - startedAt);
		if (elapsed >= options.timeoutMs) return blocked(elapsed);

		if (!hintPrinted && !options.silent && elapsed >= hintAfterMs) {
			options.onHint?.(
				bridgeReadinessWaitingHint(sawStatus ? "extension-registration" : "bridge-status", options.statusUrl),
			);
			hintPrinted = true;
		}

		const remaining = options.timeoutMs - elapsed;
		const sleepMs = Math.min(delay, remaining);
		if (sleepMs <= 0) return blocked(elapsed);
		await sleep(sleepMs);
		delay = Math.min(delay * 2, 500);
	}
}
