import type { BridgeMethod, BridgeResponse, CliConfigFile } from "./protocol.js";
import { BridgeDefaults, ErrorCodes } from "./protocol.js";

export interface CliFlags {
	url?: string;
	host?: string;
	port?: string;
	token?: string;
	json?: boolean;
	timeout?: string;
	out?: string;
	maxWidth?: string;
	writeFiles?: string;
	last?: string;
	role?: string;
	follow?: boolean;
	file?: string;
	newTab?: boolean;
}

export interface CliEnvironment {
	SHUVGEIST_BRIDGE_URL?: string;
	SHUVGEIST_BRIDGE_HOST?: string;
	SHUVGEIST_BRIDGE_PORT?: string;
	SHUVGEIST_BRIDGE_TOKEN?: string;
}

export type ResolveConfigResult = { ok: true; url: string; token: string } | { ok: false; message: string };

export type CliCommandPlan =
	| { kind: "status" }
	| { kind: "serve" }
	| { kind: "one-shot"; method: BridgeMethod; params: Record<string, unknown>; defaultTimeoutMs?: number }
	| { kind: "repl"; code: string; defaultTimeoutMs: number }
	| { kind: "screenshot"; params: Record<string, unknown>; defaultTimeoutMs: number }
	| { kind: "session"; follow: boolean; params: Record<string, unknown>; defaultTimeoutMs: number }
	| { kind: "inject"; text: string; role: "user" | "assistant" }
	| { kind: "usage-error"; message: string };

export function resolveBridgeUrl(
	flags: Pick<CliFlags, "url" | "host" | "port">,
	env: CliEnvironment,
	file: CliConfigFile,
): string {
	let url = flags.url || env.SHUVGEIST_BRIDGE_URL || file.url || "";
	if (!url) {
		const host = flags.host || env.SHUVGEIST_BRIDGE_HOST || "127.0.0.1";
		const port = flags.port || env.SHUVGEIST_BRIDGE_PORT || String(BridgeDefaults.PORT);
		url = `ws://${host}:${port}/ws`;
	}
	return url;
}

export function resolveConfig(
	flags: Pick<CliFlags, "url" | "host" | "port" | "token">,
	env: CliEnvironment,
	file: CliConfigFile,
	configPath: string,
): ResolveConfigResult {
	const token = flags.token || env.SHUVGEIST_BRIDGE_TOKEN || file.token || "";
	if (!token) {
		return {
			ok: false,
			message: [
				"bridge token is required.",
				"",
				"Set it via:",
				"  --token <token>",
				"  SHUVGEIST_BRIDGE_TOKEN env var",
				`  ${configPath}`,
			].join("\n"),
		};
	}
	return { ok: true, url: resolveBridgeUrl(flags, env, file), token };
}

export function bridgeStatusUrl(wsUrl: string): string {
	const url = new URL(wsUrl);
	url.protocol = url.protocol === "wss:" ? "https:" : "http:";
	url.pathname = "/status";
	url.search = "";
	url.hash = "";
	return url.toString();
}

export function generateRequestId(now = Date.now(), random = Math.random()): number {
	return Number(
		`${now.toString().slice(-10)}${Math.floor(random * 1000)
			.toString()
			.padStart(3, "0")}`,
	);
}

export function parseTimeout(value: string | undefined, fallbackMs?: number): number | undefined {
	if (!value) return fallbackMs;
	if (value === "0" || value === "none") return undefined;
	const trimmed = value.trim().toLowerCase();
	if (trimmed.endsWith("ms")) return Number.parseInt(trimmed.slice(0, -2), 10);
	if (trimmed.endsWith("s")) return Number.parseInt(trimmed.slice(0, -1), 10) * 1000;
	if (trimmed.endsWith("m")) return Number.parseInt(trimmed.slice(0, -1), 10) * 60_000;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) ? parsed : fallbackMs;
}

export function isNetworkOrConfigError(err: unknown): boolean {
	const code = typeof err === "object" && err && "code" in err ? String((err as { code?: string }).code) : "";
	const message = err instanceof Error ? err.message : String(err || "");
	const networkCodes = new Set([
		"ECONNREFUSED",
		"ECONNRESET",
		"EHOSTUNREACH",
		"ENOTFOUND",
		"ETIMEDOUT",
		"EAI_AGAIN",
		"ERR_INVALID_URL",
	]);
	if (networkCodes.has(code)) return true;
	return (
		message.includes("ECONNREFUSED") ||
		message.includes("ECONNRESET") ||
		message.includes("EHOSTUNREACH") ||
		message.includes("ENOTFOUND") ||
		message.includes("ETIMEDOUT") ||
		message.includes("EAI_AGAIN") ||
		message.includes("timeout") ||
		message.includes("Registration failed") ||
		message.includes("Connection closed before response") ||
		message.includes("Invalid URL")
	);
}

export function exitCodeForResponse(response: BridgeResponse): number {
	if (!response.error) return 0;
	if (response.error.code === ErrorCodes.NO_EXTENSION_TARGET) return 2;
	if (
		response.error.code === ErrorCodes.AUTH_FAILED ||
		response.error.code === ErrorCodes.INVALID_METHOD ||
		response.error.code === ErrorCodes.REGISTRATION_REQUIRED
	) {
		return 3;
	}
	return 1;
}

export function createCommandPlan(
	command: string,
	positionals: string[],
	flags: CliFlags,
	readFileText: (path: string) => string,
): CliCommandPlan {
	switch (command) {
		case "serve":
			return { kind: "serve" };
		case "status":
			return { kind: "status" };
		case "navigate": {
			const url = positionals[0];
			if (!url) return { kind: "usage-error", message: "Usage: shuvgeist navigate <url> [--new-tab]" };
			return {
				kind: "one-shot",
				method: "navigate",
				params: flags.newTab ? { url, newTab: true } : { url },
				defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
			};
		}
		case "tabs":
			return {
				kind: "one-shot",
				method: "navigate",
				params: { listTabs: true },
				defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
			};
		case "switch": {
			const tabId = positionals[0];
			if (!tabId) return { kind: "usage-error", message: "Usage: shuvgeist switch <tabId>" };
			return {
				kind: "one-shot",
				method: "navigate",
				params: { switchToTab: Number.parseInt(tabId, 10) },
				defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
			};
		}
		case "repl": {
			let code = positionals.join(" ");
			if (flags.file) code = readFileText(flags.file);
			if (!code) {
				return { kind: "usage-error", message: "Usage: shuvgeist repl <code> or shuvgeist repl -f <file.js>" };
			}
			return { kind: "repl", code, defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS };
		}
		case "screenshot": {
			const params: Record<string, unknown> = {};
			if (flags.maxWidth) params.maxWidth = Number.parseInt(flags.maxWidth, 10);
			return { kind: "screenshot", params, defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS };
		}
		case "eval": {
			const code = positionals.join(" ");
			if (!code) return { kind: "usage-error", message: "Usage: shuvgeist eval <code>" };
			return {
				kind: "one-shot",
				method: "eval",
				params: { code },
				defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS,
			};
		}
		case "select": {
			const message = positionals.join(" ");
			if (!message) return { kind: "usage-error", message: "Usage: shuvgeist select <message>" };
			return {
				kind: "one-shot",
				method: "select_element",
				params: { message },
				defaultTimeoutMs: undefined,
			};
		}
		case "session": {
			const params: Record<string, unknown> = {};
			if (flags.last) params.last = Number.parseInt(flags.last, 10);
			return {
				kind: "session",
				follow: Boolean(flags.follow),
				params,
				defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
			};
		}
		case "inject": {
			const text = positionals.join(" ");
			if (!text) return { kind: "usage-error", message: "Usage: shuvgeist inject <text> [--role user|assistant]" };
			return { kind: "inject", text, role: flags.role === "assistant" ? "assistant" : "user" };
		}
		case "new-session": {
			const model = positionals[0];
			return {
				kind: "one-shot",
				method: "session_new",
				params: model ? { model } : {},
				defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
			};
		}
		case "set-model": {
			const model = positionals[0];
			if (!model) return { kind: "usage-error", message: "Usage: shuvgeist set-model <provider/model-id>" };
			return {
				kind: "one-shot",
				method: "session_set_model",
				params: { model },
				defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
			};
		}
		case "artifacts":
			return {
				kind: "one-shot",
				method: "session_artifacts",
				params: {},
				defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
			};
		default:
			return { kind: "usage-error", message: `Unknown command: ${command}` };
	}
}
