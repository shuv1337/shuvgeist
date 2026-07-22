/**
 * Structured logging for bridge server, CLI, and extension client.
 *
 * All bridge components share a consistent JSON-line log format so that
 * connection lifecycle, command routing, and errors are easy to correlate
 * across hosts in a multi-machine LAN deployment.
 *
 * Stable fields (always use these names when applicable):
 *   connectionId  — unique id for the WebSocket connection
 *   role          — "cli" | "extension" | "server"
 *   remoteAddress — peer IP:port string
 *   windowId      — Chrome window id of the extension target
 *   requestId     — numeric id correlating a request/response pair
 *   method        — bridge command name
 *   durationMs    — wall-clock ms for a forwarded command
 *   outcome       — "success" | "error" | "timeout" | "aborted" | "rejected"
 */

export interface LogFields {
	connectionId?: string;
	role?: "cli" | "extension" | "server";
	remoteAddress?: string;
	windowId?: number;
	requestId?: number;
	method?: string;
	durationMs?: number;
	outcome?: "success" | "error" | "timeout" | "aborted" | "rejected";
	error?: string;
	[key: string]: unknown;
}

export type LogLevel = "info" | "warn" | "error" | "debug";

/**
 * Emit a single structured JSON log line.
 *
 * Works identically in Node and browser environments (uses console.*).
 */
export function bridgeLog(level: LogLevel, message: string, fields?: LogFields): void {
	const entry: Record<string, unknown> = {
		ts: new Date().toISOString(),
		level,
		msg: message,
	};

	if (fields) {
		for (const [key, value] of Object.entries(fields)) {
			if (value !== undefined) {
				entry[key] = value;
			}
		}
	}

	const line = JSON.stringify(entry);

	switch (level) {
		case "error":
			console.error(line);
			break;
		case "warn":
			console.warn(line);
			break;
		case "debug":
			console.debug(line);
			break;
		default:
			console.log(line);
	}
}

let idCounter = 0;

/** Generate a short unique connection id (not cryptographically secure). */
export function generateConnectionId(): string {
	return `conn_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}
