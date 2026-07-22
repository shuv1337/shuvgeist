import { stripVTControlCharacters } from "node:util";
import type { BridgeServerStatus } from "@shuvgeist/protocol/protocol";

export interface BridgeStatusTextOptions {
	cliVersion: string;
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
		`Bridge: ${options.statusUrl}`,
		`Bridge version: ${status.serverVersion ?? "unknown"}`,
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
