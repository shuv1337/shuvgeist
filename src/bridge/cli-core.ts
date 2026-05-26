import type { LaunchOptions } from "./launcher.js";
import type { BridgeMethod, BridgeResponse, CliConfigFile } from "./protocol.js";
import { BridgeDefaults, ErrorCodes } from "./protocol.js";
import { type BridgeTarget, parseTargetSpec } from "./target.js";

export interface CliFlags {
	url?: string;
	host?: string;
	port?: string;
	token?: string;
	json?: boolean;
	timeout?: string;
	interval?: string;
	out?: string;
	maxWidth?: string;
	maxHeight?: string;
	writeFiles?: string;
	last?: string;
	role?: string;
	follow?: boolean;
	file?: string;
	newTab?: boolean;
	inline?: string;
	arg?: string[];
	dryRun?: boolean;
	tabId?: string;
	frameId?: string;
	target?: string;
	pid?: string;
	inspectMain?: boolean;
	inspectPort?: string;
	channel?: string;
	sourcePath?: string;
	extractTo?: string;
	maxEntries?: string;
	includeHidden?: boolean;
	limit?: string;
	minScore?: string;
	name?: string;
	value?: string;
	world?: string;
	exact?: boolean;
	visible?: boolean;
	enabled?: boolean;
	native?: boolean;
	count?: string;
	minCount?: string;
	maxCount?: string;
	urlPattern?: string;
	search?: string;
	includeSensitive?: boolean;
	preset?: string;
	width?: string;
	height?: string;
	dpr?: string;
	mobile?: boolean;
	touch?: boolean;
	userAgent?: string;
	autoStop?: string;
	maxDuration?: string;
	videoBitrate?: string;
	mimeType?: string;
	fps?: string;
	quality?: string;
	browser?: string;
	extensionPath?: string;
	profile?: string;
	userDataDir?: string;
	useDefaultProfile?: boolean;
	headless?: boolean;
	foreground?: boolean;
	noViewportJson?: boolean;
}

export interface CliEnvironment {
	SHUVGEIST_BRIDGE_URL?: string;
	SHUVGEIST_BRIDGE_HOST?: string;
	SHUVGEIST_BRIDGE_PORT?: string;
	SHUVGEIST_BRIDGE_TOKEN?: string;
	SHUVGEIST_OTEL_ENABLED?: string;
	SHUVGEIST_OTEL_INGEST_URL?: string;
	SHUVGEIST_OTEL_PRIVATE_INGEST_KEY?: string;
}

export type ResolveConfigResult = { ok: true; url: string; token: string } | { ok: false; message: string };

export type CliCommandPlan =
	| { kind: "status" }
	| { kind: "serve" }
	| {
			kind: "one-shot";
			method: BridgeMethod;
			params: Record<string, unknown>;
			defaultTimeoutMs?: number;
			target?: BridgeTarget;
	  }
	| { kind: "repl"; params: Record<string, unknown>; defaultTimeoutMs: number; target?: BridgeTarget }
	| { kind: "assert"; params: Record<string, unknown>; defaultTimeoutMs: number; target?: BridgeTarget }
	| { kind: "screenshot"; params: Record<string, unknown>; defaultTimeoutMs: number; target?: BridgeTarget }
	| { kind: "cookies"; defaultTimeoutMs: number; target?: BridgeTarget }
	| {
			kind: "workflow";
			action: "run" | "validate";
			workflow: unknown;
			args: Record<string, unknown>;
			defaultTimeoutMs: number;
			dryRun?: boolean;
	  }
	| { kind: "session"; follow: boolean; params: Record<string, unknown>; defaultTimeoutMs: number }
	| {
			kind: "record";
			action: "start" | "stop" | "status";
			params: Record<string, unknown>;
			defaultTimeoutMs: number | undefined;
			target?: BridgeTarget;
	  }
	| { kind: "inject"; text: string; role: "user" | "assistant" }
	| { kind: "launch"; options: LaunchOptions }
	| { kind: "close" }
	| { kind: "usage-error"; message: string };

function parseNumberFlag(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePositiveIntegerFlag(
	name: string,
	value: string | undefined,
): { ok: true; value?: number } | { ok: false; message: string } {
	if (!value) return { ok: true };
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return { ok: false, message: `${name} must be a positive integer` };
	}
	return { ok: true, value: parsed };
}

function applyTargetFlags(flags: CliFlags, params: Record<string, unknown>): void {
	const tabId = parseNumberFlag(flags.tabId);
	const frameId = parseNumberFlag(flags.frameId);
	if (typeof tabId === "number") params.tabId = tabId;
	if (typeof frameId === "number") params.frameId = frameId;
}

function targetFromFlags(flags: CliFlags): { ok: true; target?: BridgeTarget } | { ok: false; message: string } {
	if (flags.target) {
		try {
			return { ok: true, target: parseTargetSpec(flags.target) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, message: `Invalid --target: ${message}` };
		}
	}
	const tabId = parseNumberFlag(flags.tabId);
	const frameId = parseNumberFlag(flags.frameId);
	if (typeof tabId === "number" || typeof frameId === "number") {
		return {
			ok: true,
			target: {
				kind: "chrome-tab",
				...(typeof tabId === "number" ? { tabId } : {}),
				...(typeof frameId === "number" ? { frameId } : {}),
			},
		};
	}
	return { ok: true };
}

function parseWorkflowArgs(values: string[] | undefined): Record<string, unknown> {
	const parsed: Record<string, unknown> = {};
	for (const value of values ?? []) {
		const separator = value.indexOf("=");
		if (separator <= 0) continue;
		const key = value.slice(0, separator).trim();
		const raw = value.slice(separator + 1);
		if (!key) continue;
		try {
			parsed[key] = JSON.parse(raw);
		} catch {
			parsed[key] = raw;
		}
	}
	return parsed;
}

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
	if (!response.error) {
		return isAssertionResult(response.result) && response.result.ok === false ? 1 : 0;
	}
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

function isAssertionResult(value: unknown): value is { ok: boolean; kind: string; attempts: number } {
	return (
		typeof value === "object" &&
		value !== null &&
		"ok" in value &&
		"kind" in value &&
		"attempts" in value &&
		typeof (value as { ok?: unknown }).ok === "boolean" &&
		typeof (value as { kind?: unknown }).kind === "string"
	);
}

export function createCommandPlan(
	command: string,
	positionals: string[],
	flags: CliFlags,
	readFileText: (path: string) => string,
): CliCommandPlan {
	const parsedTarget = targetFromFlags(flags);
	if (!parsedTarget.ok) return { kind: "usage-error", message: parsedTarget.message };
	const target = parsedTarget.target;
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
				target,
			};
		}
		case "tabs":
			return {
				kind: "one-shot",
				method: "navigate",
				params: { listTabs: true },
				defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
				target,
			};
		case "switch": {
			const tabId = positionals[0];
			if (!tabId) return { kind: "usage-error", message: "Usage: shuvgeist switch <tabId>" };
			return {
				kind: "one-shot",
				method: "navigate",
				params: { switchToTab: Number.parseInt(tabId, 10) },
				defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
				target,
			};
		}
		case "repl": {
			let code = positionals.join(" ");
			if (flags.file) code = readFileText(flags.file);
			if (!code) {
				return { kind: "usage-error", message: "Usage: shuvgeist repl <code> or shuvgeist repl -f <file.js>" };
			}
			const params: Record<string, unknown> = { title: "CLI REPL", code };
			applyTargetFlags(flags, params);
			return { kind: "repl", params, defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS, target };
		}
		case "screenshot": {
			const params: Record<string, unknown> = {};
			if (flags.maxWidth) params.maxWidth = Number.parseInt(flags.maxWidth, 10);
			return { kind: "screenshot", params, defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS, target };
		}
		case "eval": {
			const code = positionals.join(" ");
			if (!code) return { kind: "usage-error", message: "Usage: shuvgeist eval <code>" };
			const params: Record<string, unknown> = { code };
			applyTargetFlags(flags, params);
			return {
				kind: "one-shot",
				method: "eval",
				params,
				defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS,
				target,
			};
		}
		case "assert": {
			const mode = positionals[0];
			const query = positionals.slice(1).join(" ");
			const params: Record<string, unknown> = {};
			applyTargetFlags(flags, params);
			const assertionTimeoutMs = parseTimeout(flags.timeout, 5_000) ?? 5_000;
			params.timeoutMs = assertionTimeoutMs;
			if (flags.interval) params.intervalMs = parseTimeout(flags.interval, 100);
			if (flags.exact) params.exact = true;
			if (flags.visible) params.visible = true;
			if (flags.enabled) params.enabled = true;
			if (flags.count) params.count = Number.parseInt(flags.count, 10);
			if (flags.minCount) params.minCount = Number.parseInt(flags.minCount, 10);
			if (flags.maxCount) params.maxCount = Number.parseInt(flags.maxCount, 10);
			if (flags.world === "main") params.world = "main";
			if (flags.urlPattern) params.urlPattern = flags.urlPattern;
			if (mode === "expr" || mode === "expression") {
				if (!query) return { kind: "usage-error", message: "Usage: shuvgeist assert expr <expression>" };
				params.kind = "expression";
				params.expression = query;
			} else if (mode === "text") {
				if (!query) return { kind: "usage-error", message: "Usage: shuvgeist assert text <text>" };
				params.kind = "text";
				params.text = query;
			} else if (mode === "selector") {
				if (!query) return { kind: "usage-error", message: "Usage: shuvgeist assert selector <selector>" };
				params.kind = "selector";
				params.selector = query;
			} else if (mode === "role") {
				if (!query) return { kind: "usage-error", message: "Usage: shuvgeist assert role <role> [--name name]" };
				params.kind = "role";
				params.role = query;
				if (flags.name) params.name = flags.name;
			} else if (mode === "label") {
				if (!query) return { kind: "usage-error", message: "Usage: shuvgeist assert label <label>" };
				params.kind = "label";
				params.label = query;
			} else if (mode === "url") {
				const expected = query || flags.urlPattern;
				if (!expected)
					return { kind: "usage-error", message: "Usage: shuvgeist assert url <url> [--url-pattern regex]" };
				params.kind = "url";
				if (query) params.url = query;
			} else {
				return {
					kind: "usage-error",
					message: "Usage: shuvgeist assert <expr|text|selector|role|label|url> <query>",
				};
			}
			return {
				kind: "assert",
				params,
				defaultTimeoutMs: assertionTimeoutMs + 5_000,
				target,
			};
		}
		case "cookies":
			return {
				kind: "cookies",
				defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS,
				target,
			};
		case "select": {
			const message = positionals.join(" ");
			if (!message) return { kind: "usage-error", message: "Usage: shuvgeist select <message>" };
			return {
				kind: "one-shot",
				method: "select_element",
				params: { message },
				defaultTimeoutMs: undefined,
				target,
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
		case "workflow": {
			const action = positionals[0];
			if (action !== "run" && action !== "validate") {
				return {
					kind: "usage-error",
					message:
						"Usage: shuvgeist workflow <run|validate> (--file file.json | --inline '{...}') [--arg key=value]",
				};
			}
			let source = flags.inline;
			if (!source && flags.file) {
				source = readFileText(flags.file);
			}
			if (!source) {
				return { kind: "usage-error", message: "Workflow source required via --file or --inline" };
			}
			let workflow: unknown;
			try {
				workflow = JSON.parse(source);
			} catch (error) {
				return {
					kind: "usage-error",
					message: `Workflow JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			return {
				kind: "workflow",
				action,
				workflow,
				args: parseWorkflowArgs(flags.arg),
				dryRun: Boolean(flags.dryRun),
				defaultTimeoutMs: BridgeDefaults.WORKFLOW_TIMEOUT_MS,
			};
		}
		case "snapshot": {
			const params: Record<string, unknown> = {};
			applyTargetFlags(flags, params);
			if (flags.maxEntries) params.maxEntries = Number.parseInt(flags.maxEntries, 10);
			if (flags.includeHidden) params.includeHidden = true;
			return {
				kind: "one-shot",
				method: "page_snapshot",
				params,
				defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS,
				target,
			};
		}
		case "locate": {
			const mode = positionals[0];
			const query = positionals.slice(1).join(" ");
			if (!mode || !query) {
				return {
					kind: "usage-error",
					message: "Usage: shuvgeist locate <role|text|label> <query> [--tab-id N] [--frame-id N]",
				};
			}
			const params: Record<string, unknown> = {};
			applyTargetFlags(flags, params);
			if (flags.limit) params.limit = Number.parseInt(flags.limit, 10);
			if (flags.minScore) params.minScore = Number.parseFloat(flags.minScore);
			if (mode === "role") {
				params.role = query;
				if (flags.name) params.name = flags.name;
				return {
					kind: "one-shot",
					method: "locate_by_role",
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					target,
				};
			}
			if (mode === "text") {
				params.text = query;
				return {
					kind: "one-shot",
					method: "locate_by_text",
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					target,
				};
			}
			if (mode === "label") {
				params.label = query;
				return {
					kind: "one-shot",
					method: "locate_by_label",
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					target,
				};
			}
			return { kind: "usage-error", message: "Usage: shuvgeist locate <role|text|label> <query>" };
		}
		case "ref": {
			const action = positionals[0];
			const refId = positionals[1];
			if (!action || !refId) {
				return { kind: "usage-error", message: "Usage: shuvgeist ref <click|fill> <refId> [--value text]" };
			}
			const params: Record<string, unknown> = { refId };
			applyTargetFlags(flags, params);
			if (flags.native) params.native = true;
			if (action === "click") {
				const waitMs = parseTimeout(flags.timeout);
				if (typeof waitMs === "number") params.waitMs = waitMs;
				return {
					kind: "one-shot",
					method: "ref_click",
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					target,
				};
			}
			if (action === "fill") {
				if (typeof flags.value !== "string") {
					return { kind: "usage-error", message: "Usage: shuvgeist ref fill <refId> --value <text>" };
				}
				params.value = flags.value;
				return {
					kind: "one-shot",
					method: "ref_fill",
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					target,
				};
			}
			return { kind: "usage-error", message: "Usage: shuvgeist ref <click|fill> <refId>" };
		}
		case "frame": {
			const action = positionals[0];
			const params: Record<string, unknown> = {};
			if (flags.tabId) params.tabId = Number.parseInt(flags.tabId, 10);
			if (action === "list") {
				return {
					kind: "one-shot",
					method: "frame_list",
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					target,
				};
			}
			if (action === "tree") {
				return {
					kind: "one-shot",
					method: "frame_tree",
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					target,
				};
			}
			return { kind: "usage-error", message: "Usage: shuvgeist frame <list|tree> [--tab-id N]" };
		}
		case "network": {
			const action = positionals[0];
			const params: Record<string, unknown> = {};
			if (flags.tabId) params.tabId = Number.parseInt(flags.tabId, 10);
			if (flags.limit) params.limit = Number.parseInt(flags.limit, 10);
			if (flags.search) params.search = flags.search;
			const requestId = positionals[1];
			switch (action) {
				case "start":
					return {
						kind: "one-shot",
						method: "network_start",
						params,
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
						target,
					};
				case "stop":
					return {
						kind: "one-shot",
						method: "network_stop",
						params,
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
						target,
					};
				case "list":
					return {
						kind: "one-shot",
						method: "network_list",
						params,
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
						target,
					};
				case "clear":
					return {
						kind: "one-shot",
						method: "network_clear",
						params,
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
						target,
					};
				case "stats":
					return {
						kind: "one-shot",
						method: "network_stats",
						params,
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
						target,
					};
				case "get":
					if (!requestId) return { kind: "usage-error", message: "Usage: shuvgeist network get <requestId>" };
					return {
						kind: "one-shot",
						method: "network_get",
						params: { ...params, requestId },
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
						target,
					};
				case "body":
					if (!requestId) return { kind: "usage-error", message: "Usage: shuvgeist network body <requestId>" };
					return {
						kind: "one-shot",
						method: "network_body",
						params: { ...params, requestId },
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
						target,
					};
				case "curl":
					if (!requestId)
						return {
							kind: "usage-error",
							message: "Usage: shuvgeist network curl <requestId> [--include-sensitive]",
						};
					if (flags.includeSensitive) params.includeSensitive = true;
					return {
						kind: "one-shot",
						method: "network_curl",
						params: { ...params, requestId },
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
						target,
					};
				default:
					return {
						kind: "usage-error",
						message: "Usage: shuvgeist network <start|stop|list|get|body|curl|clear|stats>",
					};
			}
		}
		case "device": {
			const action = positionals[0];
			const params: Record<string, unknown> = {};
			if (flags.tabId) params.tabId = Number.parseInt(flags.tabId, 10);
			if (action === "reset") {
				return {
					kind: "one-shot",
					method: "device_reset",
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					target,
				};
			}
			if (action !== "emulate") {
				return { kind: "usage-error", message: "Usage: shuvgeist device <emulate|reset> ..." };
			}
			if (flags.preset) params.preset = flags.preset;
			const width = parseNumberFlag(flags.width);
			const height = parseNumberFlag(flags.height);
			const dpr = parseNumberFlag(flags.dpr);
			if (typeof width === "number" && typeof height === "number") {
				params.viewport = {
					width,
					height,
					deviceScaleFactor: dpr,
					mobile: Boolean(flags.mobile),
				};
			}
			if (flags.touch) params.touch = true;
			if (flags.userAgent) params.userAgent = flags.userAgent;
			return {
				kind: "one-shot",
				method: "device_emulate",
				params,
				defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
				target,
			};
		}
		case "record": {
			const action = positionals[0];
			const params: Record<string, unknown> = {};
			applyTargetFlags(flags, params);
			if (action === "start") {
				if (!flags.out) {
					return {
						kind: "usage-error",
						message: "Usage: shuvgeist record start --out file.webm [--max-duration 30s]",
					};
				}
				const maxDurationMs = parseTimeout(flags.maxDuration, BridgeDefaults.RECORD_DEFAULT_MAX_DURATION_MS);
				if (typeof maxDurationMs !== "number") {
					return { kind: "usage-error", message: "--max-duration must be greater than 0" };
				}
				if (maxDurationMs > BridgeDefaults.RECORD_HARD_MAX_DURATION_MS) {
					return {
						kind: "usage-error",
						message: `--max-duration exceeds hard limit of ${BridgeDefaults.RECORD_HARD_MAX_DURATION_MS}ms`,
					};
				}
				params.maxDurationMs = maxDurationMs;
				if (flags.videoBitrate) {
					const videoBitsPerSecond = Number.parseInt(flags.videoBitrate, 10);
					if (!Number.isFinite(videoBitsPerSecond) || videoBitsPerSecond <= 0) {
						return { kind: "usage-error", message: "--video-bitrate must be a positive integer" };
					}
					params.videoBitsPerSecond = videoBitsPerSecond;
				}
				const fps = parsePositiveIntegerFlag("--fps", flags.fps);
				if (!fps.ok) return { kind: "usage-error", message: fps.message };
				if (typeof fps.value === "number") {
					if (fps.value < BridgeDefaults.RECORD_MIN_FPS || fps.value > BridgeDefaults.RECORD_MAX_FPS) {
						return {
							kind: "usage-error",
							message: `--fps must be between ${BridgeDefaults.RECORD_MIN_FPS} and ${BridgeDefaults.RECORD_MAX_FPS}`,
						};
					}
					params.fps = fps.value;
				}
				const quality = parsePositiveIntegerFlag("--quality", flags.quality);
				if (!quality.ok) return { kind: "usage-error", message: quality.message };
				if (typeof quality.value === "number") {
					if (quality.value < 1 || quality.value > 100) {
						return { kind: "usage-error", message: "--quality must be between 1 and 100" };
					}
					params.quality = quality.value;
				}
				const maxWidth = parsePositiveIntegerFlag("--max-width", flags.maxWidth);
				if (!maxWidth.ok) return { kind: "usage-error", message: maxWidth.message };
				if (typeof maxWidth.value === "number") params.maxWidth = maxWidth.value;
				const maxHeight = parsePositiveIntegerFlag("--max-height", flags.maxHeight);
				if (!maxHeight.ok) return { kind: "usage-error", message: maxHeight.message };
				if (typeof maxHeight.value === "number") params.maxHeight = maxHeight.value;
				if (flags.mimeType) {
					const allowed = new Set(["video/webm", "video/webm;codecs=vp8", "video/webm;codecs=vp9"]);
					if (!allowed.has(flags.mimeType.toLowerCase())) {
						return {
							kind: "usage-error",
							message: "--mime-type must be video/webm, video/webm;codecs=vp8, or video/webm;codecs=vp9",
						};
					}
					params.mimeType = flags.mimeType;
				}
				return {
					kind: "record",
					action,
					params,
					defaultTimeoutMs: undefined,
					target,
				};
			}
			if (action === "stop") {
				return {
					kind: "record",
					action,
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					target,
				};
			}
			if (action === "status") {
				return {
					kind: "record",
					action,
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					target,
				};
			}
			return { kind: "usage-error", message: "Usage: shuvgeist record <start|stop|status> ..." };
		}
		case "perf": {
			const action = positionals[0];
			const params: Record<string, unknown> = {};
			if (flags.tabId) params.tabId = Number.parseInt(flags.tabId, 10);
			if (action === "metrics") {
				return {
					kind: "one-shot",
					method: "perf_metrics",
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					target,
				};
			}
			if (action === "trace-start") {
				if (flags.autoStop) params.autoStopMs = Number.parseInt(flags.autoStop, 10);
				return {
					kind: "one-shot",
					method: "perf_trace_start",
					params,
					defaultTimeoutMs: BridgeDefaults.TRACE_TIMEOUT_MS,
					target,
				};
			}
			if (action === "trace-stop") {
				return {
					kind: "one-shot",
					method: "perf_trace_stop",
					params,
					defaultTimeoutMs: BridgeDefaults.TRACE_TIMEOUT_MS,
					target,
				};
			}
			return { kind: "usage-error", message: "Usage: shuvgeist perf <metrics|trace-start|trace-stop>" };
		}
		case "electron": {
			const action = positionals[0] ?? "list";
			if (action === "list") {
				return {
					kind: "one-shot",
					method: "electron_list",
					params: {},
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
				};
			}
			if (action === "allow") {
				const appRef = positionals[1];
				if (!appRef) return { kind: "usage-error", message: "Usage: shuvgeist electron allow <app-id-or-alias>" };
				return {
					kind: "one-shot",
					method: "electron_allow",
					params: { appRef },
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
				};
			}
			if (action === "launch") {
				const appRef = positionals[1];
				if (!appRef) return { kind: "usage-error", message: "Usage: shuvgeist electron launch <app-id-or-alias>" };
				return {
					kind: "one-shot",
					method: "electron_launch",
					params: { appRef, ...(flags.inspectMain ? { inspectMain: true } : {}) },
					defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS,
				};
			}
			if (action === "attach") {
				const appRef = positionals[1];
				const params: Record<string, unknown> = {};
				if (appRef) params.appRef = appRef;
				if (flags.port) params.port = Number.parseInt(flags.port, 10);
				if (flags.pid) params.pid = Number.parseInt(flags.pid, 10);
				if (flags.inspectPort) params.inspectPort = Number.parseInt(flags.inspectPort, 10);
				return {
					kind: "one-shot",
					method: "electron_attach",
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
				};
			}
			if (action === "detach") {
				const sessionId = positionals[1];
				return {
					kind: "one-shot",
					method: "electron_detach",
					params: sessionId ? { sessionId } : {},
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
				};
			}
			if (action === "windows") {
				const appRef = positionals[1];
				return {
					kind: "one-shot",
					method: "electron_windows",
					params: appRef ? { appRef } : {},
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
				};
			}
			if (action === "label") {
				const sessionId = positionals[1];
				const windowRef = positionals[2];
				const label = positionals.slice(3).join(" ");
				if (!sessionId || !windowRef || !label) {
					return {
						kind: "usage-error",
						message: "Usage: shuvgeist electron label <session-id> <window-ref> <label>",
					};
				}
				return {
					kind: "one-shot",
					method: "electron_label",
					params: { sessionId, windowRef, label },
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
				};
			}
			if (action === "main") {
				const sessionId = positionals[1];
				if (!sessionId) return { kind: "usage-error", message: "Usage: shuvgeist electron main <session-id>" };
				return {
					kind: "one-shot",
					method: "electron_main_info",
					params: { sessionId },
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
				};
			}
			if (action === "ipc") {
				const ipcAction = positionals[1];
				const sessionId = positionals[2];
				if (ipcAction === "tap") {
					if (!sessionId) {
						return {
							kind: "usage-error",
							message: "Usage: shuvgeist electron ipc tap <session-id> [--channel <filter>]",
						};
					}
					return {
						kind: "one-shot",
						method: "electron_ipc_tap_start",
						params: { sessionId, ...(flags.channel ? { channel: flags.channel } : {}) },
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					};
				}
				if (ipcAction === "untap" || ipcAction === "stop") {
					if (!sessionId)
						return { kind: "usage-error", message: "Usage: shuvgeist electron ipc untap <session-id>" };
					return {
						kind: "one-shot",
						method: "electron_ipc_tap_stop",
						params: { sessionId },
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					};
				}
				return { kind: "usage-error", message: "Usage: shuvgeist electron ipc <tap|untap> <session-id>" };
			}
			if (action === "network-main") {
				const networkAction = positionals[1];
				const sessionId = positionals[2];
				if (networkAction === "start") {
					if (!sessionId)
						return { kind: "usage-error", message: "Usage: shuvgeist electron network-main start <session-id>" };
					return {
						kind: "one-shot",
						method: "electron_main_network_start",
						params: { sessionId },
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					};
				}
				if (networkAction === "stop") {
					if (!sessionId)
						return { kind: "usage-error", message: "Usage: shuvgeist electron network-main stop <session-id>" };
					return {
						kind: "one-shot",
						method: "electron_main_network_stop",
						params: { sessionId },
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					};
				}
				return { kind: "usage-error", message: "Usage: shuvgeist electron network-main <start|stop> <session-id>" };
			}
			if (action === "source") {
				const sourceAction = positionals[1];
				const sourceParams: Record<string, unknown> = {};
				if (flags.sourcePath) sourceParams.sourcePath = flags.sourcePath;
				if (positionals[2] && sourceAction !== "read" && sourceAction !== "extract")
					sourceParams.appRef = positionals[2];
				if (sourceAction === "layout") {
					return {
						kind: "one-shot",
						method: "electron_source_layout",
						params: sourceParams,
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					};
				}
				if (sourceAction === "list") {
					return {
						kind: "one-shot",
						method: "electron_source_list",
						params: sourceParams,
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					};
				}
				if (sourceAction === "read") {
					const filePath = positionals[2];
					if (!flags.sourcePath && positionals[3]) sourceParams.appRef = positionals[3];
					if (!filePath) {
						return {
							kind: "usage-error",
							message: "Usage: shuvgeist electron source read <file> --source-path <path>",
						};
					}
					return {
						kind: "one-shot",
						method: "electron_source_read",
						params: { ...sourceParams, filePath },
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					};
				}
				if (sourceAction === "extract") {
					const destinationPath = flags.extractTo ?? positionals[2];
					if (!flags.sourcePath && positionals[3]) sourceParams.appRef = positionals[3];
					if (!destinationPath) {
						return {
							kind: "usage-error",
							message: "Usage: shuvgeist electron source extract <destination> --source-path <path>",
						};
					}
					return {
						kind: "one-shot",
						method: "electron_source_extract",
						params: { ...sourceParams, destinationPath },
						defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS,
					};
				}
				return {
					kind: "usage-error",
					message: "Usage: shuvgeist electron source <layout|list|read|extract> ...",
				};
			}
			if (action === "doctor") {
				const appRef = positionals[1];
				return {
					kind: "one-shot",
					method: "electron_doctor",
					params: appRef ? { appRef } : {},
					defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS,
				};
			}
			if (action === "auto-attach") {
				const autoAttachAction = positionals[1];
				const appRef = positionals[2];
				if (!autoAttachAction || !appRef) {
					return {
						kind: "usage-error",
						message: "Usage: shuvgeist electron auto-attach <status|install|uninstall> <app>",
					};
				}
				return {
					kind: "one-shot",
					method: "electron_auto_attach",
					params: { action: autoAttachAction, appRef },
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
				};
			}
			return {
				kind: "usage-error",
				message:
					"Usage: shuvgeist electron <list|allow|launch|attach|detach|windows|label|main|source|doctor|auto-attach> ...",
			};
		}
		case "launch":
			return {
				kind: "launch",
				options: {
					browser: flags.browser,
					extensionPath: flags.extensionPath,
					profile: flags.profile,
					userDataDir: flags.userDataDir,
					useDefaultProfile: flags.useDefaultProfile,
					// Accept the URL to open either as --url (as documented in the
					// help text) or as a positional. When --url is used on the launch
					// command it is the URL to open in the launched browser, NOT the
					// bridge WebSocket URL — cmdLaunch strips flags.url before
					// resolving the bridge URL to avoid the collision.
					url: flags.url || positionals[0],
					headless: flags.headless,
					foreground: flags.foreground,
				},
			};
		case "close":
			return { kind: "close" };
		default:
			return { kind: "usage-error", message: `Unknown command: ${command}` };
	}
}
