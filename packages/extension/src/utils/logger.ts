/**
 * Centralized logging system.
 * All logs go to console and optionally to a central store (sidepanel).
 */

export type LogLevel = "info" | "warn" | "error";
export type LogSource = "background" | "sidepanel" | "tool";

export interface LogEntry {
	time: number;
	source: LogSource;
	tag: string;
	level: LogLevel;
	msg: string;
	args: any[];
}

// Optional sender function to send logs to central store
let sender: ((entry: LogEntry) => void) | undefined;

/**
 * Configure where logs should be sent (e.g., to sidepanel via port).
 * If not set, logs only go to console.
 */
export function setLogSender(fn: (entry: LogEntry) => void): void {
	sender = fn;
}

/**
 * Create a logger for a specific component.
 *
 * @param source - Where the log originates from (background, sidepanel, tool)
 * @param tag - Component name (e.g., "SessionManager", "ChatPanel")
 */
export function createLogger(source: LogSource, tag: string) {
	const log = (level: LogLevel, msg: string, ...args: any[]) => {
		const entry: LogEntry = {
			time: Date.now(),
			source,
			tag,
			level,
			msg,
			args,
		};

		// Always log to console
		console[level](`[${source}:${tag}]`, msg, ...args);

		// Send to central store if configured
		sender?.(entry);
	};

	return {
		info: (msg: string, ...args: any[]) => log("info", msg, ...args),
		warn: (msg: string, ...args: any[]) => log("warn", msg, ...args),
		error: (msg: string, ...args: any[]) => log("error", msg, ...args),
	};
}
