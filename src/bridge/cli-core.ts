import type { LaunchOptions } from "./launcher.js";
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
	inline?: string;
	arg?: string[];
	dryRun?: boolean;
	tabId?: string;
	frameId?: string;
	maxEntries?: string;
	includeHidden?: boolean;
	limit?: string;
	minScore?: string;
	name?: string;
	value?: string;
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
	browser?: string;
	extensionPath?: string;
	profile?: string;
	userDataDir?: string;
	useDefaultProfile?: boolean;
	headless?: boolean;
	foreground?: boolean;
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
	| { kind: "one-shot"; method: BridgeMethod; params: Record<string, unknown>; defaultTimeoutMs?: number }
	| { kind: "repl"; code: string; defaultTimeoutMs: number }
	| { kind: "screenshot"; params: Record<string, unknown>; defaultTimeoutMs: number }
	| { kind: "cookies"; defaultTimeoutMs: number }
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

function applyTargetFlags(flags: CliFlags, params: Record<string, unknown>): void {
	const tabId = parseNumberFlag(flags.tabId);
	const frameId = parseNumberFlag(flags.frameId);
	if (typeof tabId === "number") params.tabId = tabId;
	if (typeof frameId === "number") params.frameId = frameId;
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
			const params: Record<string, unknown> = { code };
			applyTargetFlags(flags, params);
			return {
				kind: "one-shot",
				method: "eval",
				params,
				defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS,
			};
		}
		case "cookies":
			return {
				kind: "cookies",
				defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS,
			};
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
				};
			}
			if (mode === "text") {
				params.text = query;
				return {
					kind: "one-shot",
					method: "locate_by_text",
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
				};
			}
			if (mode === "label") {
				params.label = query;
				return {
					kind: "one-shot",
					method: "locate_by_label",
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
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
			if (action === "click") {
				return {
					kind: "one-shot",
					method: "ref_click",
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
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
				};
			}
			if (action === "tree") {
				return {
					kind: "one-shot",
					method: "frame_tree",
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
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
					};
				case "stop":
					return {
						kind: "one-shot",
						method: "network_stop",
						params,
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					};
				case "list":
					return {
						kind: "one-shot",
						method: "network_list",
						params,
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					};
				case "clear":
					return {
						kind: "one-shot",
						method: "network_clear",
						params,
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					};
				case "stats":
					return {
						kind: "one-shot",
						method: "network_stats",
						params,
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					};
				case "get":
					if (!requestId) return { kind: "usage-error", message: "Usage: shuvgeist network get <requestId>" };
					return {
						kind: "one-shot",
						method: "network_get",
						params: { ...params, requestId },
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
					};
				case "body":
					if (!requestId) return { kind: "usage-error", message: "Usage: shuvgeist network body <requestId>" };
					return {
						kind: "one-shot",
						method: "network_body",
						params: { ...params, requestId },
						defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
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
				if (flags.mimeType) params.mimeType = flags.mimeType;
				return {
					kind: "record",
					action,
					params,
					defaultTimeoutMs: undefined,
				};
			}
			if (action === "stop") {
				return {
					kind: "record",
					action,
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
				};
			}
			if (action === "status") {
				return {
					kind: "record",
					action,
					params,
					defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
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
				};
			}
			if (action === "trace-start") {
				if (flags.autoStop) params.autoStopMs = Number.parseInt(flags.autoStop, 10);
				return {
					kind: "one-shot",
					method: "perf_trace_start",
					params,
					defaultTimeoutMs: BridgeDefaults.TRACE_TIMEOUT_MS,
				};
			}
			if (action === "trace-stop") {
				return {
					kind: "one-shot",
					method: "perf_trace_stop",
					params,
					defaultTimeoutMs: BridgeDefaults.TRACE_TIMEOUT_MS,
				};
			}
			return { kind: "usage-error", message: "Usage: shuvgeist perf <metrics|trace-start|trace-stop>" };
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
