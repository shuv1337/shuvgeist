import { stripVTControlCharacters } from "node:util";
import type { BridgeServerStatus } from "@shuvgeist/protocol/protocol";
import type { BuildIdentity } from "@shuvgeist/protocol/version";

export interface BridgeStatusTextOptions {
	cliVersion: string;
	cliBuild?: BuildIdentity;
	statusUrl: string;
}

function oneLine(value: string): string {
	const withoutTerminalSequences = stripVTControlCharacters(value);
	const withoutControlCharacters = Array.from(withoutTerminalSequences, (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
	}).join("");
	return withoutControlCharacters.replace(/\s+/gu, " ").trim();
}

function livenessLabel(session: BridgeServerStatus["electron"]["sessions"][number]): string {
	if (session.live === true) return "live";
	if (session.live === false) {
		const reason = session.livenessReason ? `: ${session.livenessReason.replaceAll("_", " ")}` : "";
		return `stale${reason}`;
	}
	return "unverified";
}

export function hasUsableElectronSessions(status: BridgeServerStatus): boolean {
	return status.electron.sessions.some((session) => session.live === true);
}

export function isBridgeStatusReady(status: BridgeServerStatus, acceptElectron: boolean): boolean {
	return status.extension.connected || (acceptElectron && hasUsableElectronSessions(status));
}

export function formatBridgeStatusText(status: BridgeServerStatus, options: BridgeStatusTextOptions): string[] {
	const lines = [
		`CLI version: ${options.cliVersion}`,
		...(options.cliBuild ? [`CLI build: ${options.cliBuild.id} (${options.cliBuild.kind})`] : []),
		`Bridge: ${options.statusUrl}`,
		`Bridge version: ${status.serverVersion ?? "unknown"}`,
		`Bridge build: ${status.serverBuild ? `${status.serverBuild.id} (${status.serverBuild.kind})` : "unknown"}`,
		`Protocol: ${status.minProtocolVersion ?? "?"}-${status.protocolVersion ?? "?"}`,
		"Browser extension:",
		`  Connected: ${status.extension.connected ? "yes" : "no"}`,
	];

	if (status.extension.connected) {
		const rawWindowId = status.extension.windowId;
		const windowId =
			typeof rawWindowId === "number" && Number.isInteger(rawWindowId) && rawWindowId > 0
				? String(rawWindowId)
				: "unavailable";
		lines.push(`  Window ID: ${windowId}`);
		lines.push(`  Session ID: ${status.extension.sessionId ?? "unknown"}`);
		lines.push(`  Version: ${status.extension.appVersion ?? "unknown"}`);
		lines.push(
			`  Build: ${status.extension.build ? `${status.extension.build.id} (${status.extension.build.kind})` : "unknown"}`,
		);
		lines.push(`  Protocol: ${status.extension.protocolVersion ?? "unknown"}`);
		lines.push(`  Capabilities: ${(status.extension.capabilities || []).join(", ") || "none"}`);
		lines.push(`  Address: ${status.extension.remoteAddress ?? "unknown"}`);
	}

	const electronSessions = status.electron.sessions;
	const usableSessions = electronSessions.filter((session) => session.live === true);
	const staleSessions = electronSessions.filter((session) => session.live === false);
	const unverifiedSessions = electronSessions.filter((session) => session.live === undefined);
	lines.push("Electron:");
	lines.push(
		`  Sessions: ${electronSessions.length} (${usableSessions.length} live, ${staleSessions.length} stale, ${unverifiedSessions.length} unverified)`,
	);
	for (const session of electronSessions) {
		const app = session.appRef ?? session.appId ?? "unknown app";
		const launchMode = session.launched ? "launched" : "attached";
		const browser = session.browser ? `; ${oneLine(session.browser)}` : "";
		const targetSummary =
			session.live === true
				? `page targets ${session.livePageTargetCount ?? session.windows.filter((window) => window.type === "page" && !window.closed).length} current; targets ${session.windows.filter((window) => !window.closed).length}/${session.windows.length} current`
				: `target records ${session.windows.length} tracked`;
		lines.push(
			`  ${session.id}: ${oneLine(app)}; ${launchMode}; port ${session.port}; ${livenessLabel(session)}; ${targetSummary}${browser}`,
		);
		for (const window of session.windows) {
			const windowState = window.closed ? "closed" : session.live === true ? "current" : "tracked";
			const flags = [window.isPrimary ? "primary" : undefined, windowState].filter((value): value is string =>
				Boolean(value),
			);
			const label = window.label ? ` (${oneLine(window.label)})` : "";
			const target = window.title ?? window.url ?? "untitled";
			lines.push(`    ${window.ref}${label} [${flags.join(", ")}]: ${oneLine(target)}`);
		}
	}
	if (!status.extension.connected && usableSessions.length > 0) {
		lines.push(
			`  Extension disconnected; Electron control remains usable through ${usableSessions.length} bridge-local session(s).`,
		);
	}

	lines.push(`Clients: cli=${status.clients.cli} extension=${status.clients.extension} total=${status.clients.total}`);
	lines.push(`Pending requests: ${status.pendingRequests}`);
	return lines;
}

/** Default bound for `shuvgeist status`, including bridge startup and the status read. */
export const STATUS_COMMAND_TIMEOUT_MS = 5_000;

const BRIDGE_STATUS_TIMEOUT_DETAIL =
	"The status endpoint did not finish responding. Confirm `shuvgeist serve` is running and that --url, SHUVGEIST_BRIDGE_URL, and bridge.json point at that bridge.";

const BRIDGE_STATUS_REFUSED_DETAIL =
	"Nothing is accepting connections on that port. Start the bridge with `shuvgeist serve`, or use a loopback ws://host/ws URL so the CLI can auto-start it.";

export type BridgeConnectivityReason =
	| "timeout"
	| "connection_refused"
	| "dns"
	| "reset"
	| "http_error"
	| "invalid_response"
	| "autostart_failed"
	| "unreachable";

export interface BridgeStatusFailure {
	reason: BridgeConnectivityReason;
	detail: string;
	httpStatus?: number;
}

export type BridgeStatusReadResult = { ok: true; status: BridgeServerStatus } | ({ ok: false } & BridgeStatusFailure);

export interface BridgeConnectivityDiagnostics extends BridgeStatusFailure {
	statusUrl: string;
	timeoutMs?: number;
	bridgeReachable: false;
	extensionConnected: false;
}

export class StatusDeadlineError extends Error {
	readonly code = "ETIMEDOUT" as const;

	constructor() {
		super("Bridge status deadline exceeded");
		this.name = "TimeoutError";
	}
}

export function isStatusDeadlineError(error: unknown): error is StatusDeadlineError {
	return error instanceof StatusDeadlineError;
}

export type StatusPollDecision = "return" | "wait" | "fail";

/** Stop polling once a target is ready, or when the deadline hits with or without a snapshot. */
export function decideStatusPoll(input: {
	snapshotReady: boolean;
	hasSnapshot: boolean;
	remainingMs: number | undefined;
}): StatusPollDecision {
	if (input.snapshotReady) return "return";
	if (input.remainingMs !== undefined && input.remainingMs <= 0) {
		return input.hasSnapshot ? "return" : "fail";
	}
	return "wait";
}

/** Next status poll delay, capped at 500ms and at the time left on the deadline. */
export function statusPollDelayMs(attemptDelayMs: number, remainingMs: number | undefined): number {
	const cappedAttempt = Math.min(Math.max(0, attemptDelayMs), 500);
	if (remainingMs === undefined) return cappedAttempt;
	return Math.min(cappedAttempt, Math.max(0, remainingMs));
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message.trim();
	return String(error ?? "").trim();
}

function errorCode(error: unknown): string | undefined {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (typeof current === "object" && current !== null && !seen.has(current)) {
		seen.add(current);
		if ("code" in current && typeof current.code === "string" && current.code.length > 0) return current.code;
		if (!("cause" in current)) break;
		current = current.cause;
	}
	return undefined;
}

function isNodeConfigError(error: unknown): error is Error & { code: string } {
	return (
		error instanceof Error && error.name === "NodeConfigError" && "code" in error && typeof error.code === "string"
	);
}

function isAbortLike(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function classifyBridgeConnectivityFailure(error: unknown): BridgeStatusFailure {
	if (isNodeConfigError(error)) {
		const autostart = error.code === "AUTOSTART_FAILED" || error.code === "AUTOSTART_UNSAFE";
		return {
			reason: autostart ? "autostart_failed" : "unreachable",
			detail: error.message,
		};
	}
	const code = errorCode(error);
	if (
		isAbortLike(error) ||
		code === "ETIMEDOUT" ||
		code === "ABORT_ERR" ||
		code === "UND_ERR_CONNECT_TIMEOUT" ||
		code === "UND_ERR_HEADERS_TIMEOUT" ||
		code === "UND_ERR_BODY_TIMEOUT"
	) {
		return { reason: "timeout", detail: BRIDGE_STATUS_TIMEOUT_DETAIL };
	}
	if (code === "ECONNREFUSED") {
		return { reason: "connection_refused", detail: BRIDGE_STATUS_REFUSED_DETAIL };
	}
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
		return { reason: "dns", detail: errorMessage(error) || "The bridge host could not be resolved." };
	}
	if (code === "ECONNRESET" || code === "EPIPE" || code === "EHOSTUNREACH") {
		return { reason: "reset", detail: errorMessage(error) || "The connection to the bridge was closed." };
	}
	return { reason: "unreachable", detail: errorMessage(error) || "The status request failed." };
}

export function bridgeConnectivityDiagnostics(input: {
	statusUrl: string;
	timeoutMs?: number;
	error: unknown;
	lastFailure?: BridgeStatusFailure;
}): BridgeConnectivityDiagnostics {
	const failure = isStatusDeadlineError(input.error)
		? (input.lastFailure ?? classifyBridgeConnectivityFailure(input.error))
		: classifyBridgeConnectivityFailure(input.error);
	return {
		statusUrl: input.statusUrl,
		...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
		bridgeReachable: false,
		extensionConnected: false,
		reason: failure.reason,
		detail: failure.detail,
		...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
	};
}

function withBudget(sentence: string, timeoutMs: number | undefined): string {
	if (timeoutMs === undefined) return sentence;
	return `${sentence} Stopped after ${timeoutMs}ms.`;
}

export function formatBridgeConnectivityMessage(diagnostics: BridgeConnectivityDiagnostics): string {
	const detail = diagnostics.detail.trim();
	const suffix = detail.length > 0 ? ` ${detail}` : "";
	const timeoutMs = diagnostics.timeoutMs;
	switch (diagnostics.reason) {
		case "timeout":
			return withBudget(`Timed out waiting for bridge status at ${diagnostics.statusUrl}.`, timeoutMs) + suffix;
		case "connection_refused":
			return withBudget(`Bridge status at ${diagnostics.statusUrl} refused the connection.`, timeoutMs) + suffix;
		case "dns":
			return withBudget(`Could not resolve the bridge host for ${diagnostics.statusUrl}.`, timeoutMs) + suffix;
		case "reset":
			return (
				withBudget(`The connection to bridge status at ${diagnostics.statusUrl} was reset.`, timeoutMs) + suffix
			);
		case "http_error":
			return withBudget(`Bridge status at ${diagnostics.statusUrl} failed.`, timeoutMs) + suffix;
		case "invalid_response":
			return (
				withBudget(`Bridge status at ${diagnostics.statusUrl} returned an unreadable status payload.`, timeoutMs) +
				suffix
			);
		case "autostart_failed":
			return withBudget(`Could not start or reach the bridge at ${diagnostics.statusUrl}.`, timeoutMs) + suffix;
		case "unreachable":
			return withBudget(`Bridge status at ${diagnostics.statusUrl} is unreachable.`, timeoutMs) + suffix;
		default: {
			const exhaustive: never = diagnostics.reason;
			return exhaustive;
		}
	}
}

/**
 * Read `/status`, including the response body, under one abort deadline.
 * A stalled body stays inside `timeoutMs` instead of clearing the timer at the headers.
 */
export async function readBridgeStatus(
	statusUrl: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<BridgeStatusReadResult> {
	if (signal?.aborted || timeoutMs <= 0) {
		return { ok: false, reason: "timeout", detail: BRIDGE_STATUS_TIMEOUT_DETAIL };
	}
	const controller = new AbortController();
	const abortFromParent = (): void => controller.abort();
	signal?.addEventListener("abort", abortFromParent, { once: true });
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(statusUrl, { signal: controller.signal });
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			return {
				ok: false,
				reason: "http_error",
				detail: `HTTP ${response.status}.`,
				httpStatus: response.status,
			};
		}
		const body: unknown = await response.json();
		if (typeof body !== "object" || body === null) {
			return { ok: false, reason: "invalid_response", detail: "Status response was not a JSON object." };
		}
		return { ok: true, status: body as BridgeServerStatus };
	} catch (error) {
		if (controller.signal.aborted) {
			return { ok: false, reason: "timeout", detail: BRIDGE_STATUS_TIMEOUT_DETAIL };
		}
		if (error instanceof SyntaxError) {
			return { ok: false, reason: "invalid_response", detail: error.message };
		}
		return { ok: false, ...classifyBridgeConnectivityFailure(error) };
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abortFromParent);
	}
}
