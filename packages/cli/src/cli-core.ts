import {
	type CliBinding,
	type CliFlagBinding,
	type CliFlagDefinition,
	CliFlagDefinitions,
	type CliFlagKey,
	type CliFlags,
	type CliPositionalBinding,
	GlobalCliFlagKeys,
	LocalCliCommandDefinitions,
} from "@shuvgeist/protocol/cli-grammar";
import {
	BridgeCliBindings,
	type BridgeCommandTimeout,
	type CatalogBridgeMethod,
	type CatalogCliCodec,
	type CatalogCliCommand,
	type CatalogCliRunner,
	getBridgeCommandMetadata,
	getCatalogCliCommands,
} from "@shuvgeist/protocol/command-catalog";
import { formatBridgeCommandValidationErrors, validateBridgeCommandParams } from "@shuvgeist/protocol/command-schemas";
import {
	type BridgeNodeConfig,
	type NodeConfigEnvironment,
	NodeConfigError,
	resolveBridgeConnection,
} from "@shuvgeist/server/node-config";
import type { LaunchOptions } from "./launcher.js";

export { bridgeStatusUrl } from "@shuvgeist/server/node-config";

import type { BridgeMethod, BridgeResponse } from "@shuvgeist/protocol/protocol";
import { BridgeDefaults, ErrorCodes } from "@shuvgeist/protocol/protocol";
import { type BridgeTarget, parseTargetSpec } from "@shuvgeist/protocol/target";

export type { CliFlags } from "@shuvgeist/protocol/cli-grammar";
export { CliFlagDefinitions } from "@shuvgeist/protocol/cli-grammar";

export interface ParsedCliArguments {
	flags: CliFlags;
	positionals: string[];
}

const CliFlagDefinitionByName = new Map<string, CliFlagDefinition>();
for (const definition of CliFlagDefinitions) {
	for (const name of definition.names) {
		if (CliFlagDefinitionByName.has(name)) {
			throw new Error(`Duplicate CLI flag definition: ${name}`);
		}
		CliFlagDefinitionByName.set(name, definition);
	}
}

/** Parse bridge-command argv while preserving legacy unknown/missing-value handling. */
export function parseCliArguments(args: readonly string[]): ParsedCliArguments {
	const parsedFlags: Record<string, boolean | string | string[]> = {};
	const positionals: string[] = [];

	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		const definition = CliFlagDefinitionByName.get(argument);
		if (!definition) {
			positionals.push(argument);
			continue;
		}

		if (definition.kind === "boolean") {
			parsedFlags[definition.key] = true;
			continue;
		}

		const value = args[index + 1];
		if (value === undefined) {
			// Historically a value-taking option with no following token flowed
			// through as a positional; retain that observable usage-error behavior.
			positionals.push(argument);
			continue;
		}
		index++;
		if (definition.kind === "string-list") {
			const current = parsedFlags[definition.key];
			parsedFlags[definition.key] = Array.isArray(current) ? [...current, value] : [value];
		} else {
			parsedFlags[definition.key] = value;
		}
	}

	return { flags: parsedFlags as CliFlags, positionals };
}

export type CliEnvironment = NodeConfigEnvironment;

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

function timeoutForCatalogKind(kind: BridgeCommandTimeout | undefined): number | undefined {
	switch (kind) {
		case "request":
			return BridgeDefaults.REQUEST_TIMEOUT_MS;
		case "slow":
			return BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS;
		case "workflow":
			return BridgeDefaults.WORKFLOW_TIMEOUT_MS;
		case "trace":
			return BridgeDefaults.TRACE_TIMEOUT_MS;
		case "none":
			return undefined;
		default:
			return BridgeDefaults.REQUEST_TIMEOUT_MS;
	}
}

function catalogDefaultTimeoutMs(method: BridgeMethod): number | undefined {
	return timeoutForCatalogKind(getBridgeCommandMetadata(method)?.defaultTimeout);
}

function createOneShotPlan(
	method: BridgeMethod,
	params: Record<string, unknown>,
	target?: BridgeTarget,
): CliCommandPlan {
	return {
		kind: "one-shot",
		method,
		params,
		defaultTimeoutMs: catalogDefaultTimeoutMs(method),
		target,
	};
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

function targetFromFlags(flags: CliFlags): { ok: true; target?: BridgeTarget } | { ok: false; message: string } {
	if (flags.target) {
		try {
			const target = parseTargetSpec(flags.target);
			if (target.kind === "electron-window" && (flags.tabId !== undefined || flags.windowId !== undefined)) {
				return {
					ok: false,
					message: "Electron --target cannot be combined with Chrome selectors --tab-id or --window-id.",
				};
			}
			return { ok: true, target };
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
	file: BridgeNodeConfig,
): string {
	return resolveBridgeConnection({ flags, env, file }).url;
}

export function resolveConfig(
	flags: Pick<CliFlags, "url" | "host" | "port" | "token">,
	env: CliEnvironment,
	file: BridgeNodeConfig,
	configPath: string,
): ResolveConfigResult {
	const resolved = resolveBridgeConnection({ flags, env, file, configPath });
	if (!resolved.token) {
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
	return { ok: true, url: resolved.url, token: resolved.token };
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

/** Add CLI-side ffmpeg output size without conflating it with raw captured-frame bytes. */
export function withEncodedRecordingSize<T extends object>(
	summary: T,
	encodedSizeBytes: number,
): T & { encodedSizeBytes: number; sizeBytes: number } {
	if (!Number.isSafeInteger(encodedSizeBytes) || encodedSizeBytes < 0) {
		throw new Error("Encoded recording size must be a non-negative safe integer");
	}
	return { ...summary, encodedSizeBytes, sizeBytes: encodedSizeBytes };
}

export function isNetworkOrConfigError(err: unknown): boolean {
	if (err instanceof NodeConfigError) return true;
	const code = typeof err === "object" && err && "code" in err ? String((err as { code?: string }).code) : "";
	const message = err instanceof Error ? err.message : String(err || "");
	const networkCodes = new Set([
		"ECONNREFUSED",
		"ECONNRESET",
		"EHOSTUNREACH",
		"ENOTFOUND",
		"ETIMEDOUT",
		"EAI_AGAIN",
		"EAUTH",
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
		if (isAssertionResult(response.result) && response.result.ok === false) return 1;
		if (isNavigateCloseResult(response.result) && response.result.ok === false) return 1;
		if (isRefActionResult(response.result) && response.result.ok === false) return 1;
		return 0;
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

function isRefActionResult(value: unknown): value is { ok: boolean; refId: string; action: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"ok" in value &&
		"refId" in value &&
		"action" in value &&
		typeof (value as { ok?: unknown }).ok === "boolean" &&
		typeof (value as { refId?: unknown }).refId === "string" &&
		typeof (value as { action?: unknown }).action === "string"
	);
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

/** Navigate close/window-close results set ok:false on partial/explicit failures. */
function isNavigateCloseResult(value: unknown): value is { ok: boolean; closedTabIds?: number[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		"ok" in value &&
		typeof (value as { ok?: unknown }).ok === "boolean" &&
		("closedTabIds" in value || "closedWindowIds" in value)
	);
}

type LocalCliCommandDefinition = (typeof LocalCliCommandDefinitions)[number];
type LocalCliPlannerCommand = LocalCliCommandDefinition["family"];
type LocalCliCodec = LocalCliCommandDefinition["codec"];

export const LocalCliPlannerCommands = LocalCliCommandDefinitions.map(
	(definition) => definition.family,
) as LocalCliPlannerCommand[];

export type CliPlannerCommand = CatalogCliCommand | LocalCliPlannerCommand;

interface CliCommandPlannerContext {
	positionals: string[];
	flags: CliFlags;
	readFileText: (path: string) => string;
	target?: BridgeTarget;
}

type CliCommandPlanner = (context: CliCommandPlannerContext) => CliCommandPlan;

interface ResolvedBridgeCliBinding {
	method: CatalogBridgeMethod;
	binding: CliBinding;
	positionals: string[];
}

type ResolveBridgeCliBindingResult = { ok: true; value: ResolvedBridgeCliBinding } | { ok: false; message: string };

interface CliCodecOutput {
	params: Record<string, unknown>;
	target?: BridgeTarget;
}

type CliCodecResult = { ok: true; value: CliCodecOutput } | { ok: false; message: string };

interface CliCodecContext extends CliCommandPlannerContext, ResolvedBridgeCliBinding {}

interface CliRunnerContext extends CliCodecContext {
	params: Record<string, unknown>;
	resolvedTarget?: BridgeTarget;
}

interface CliRunnerDefinition {
	validateParams: boolean;
	createPlan: (context: CliRunnerContext) => CliCommandPlan;
}

function matchesCliPath(positionals: readonly string[], path: readonly string[]): boolean {
	return path.every((token, index) => positionals[index] === token);
}

function bindingPaths(binding: CliBinding): readonly (readonly string[])[] {
	return [binding.select, ...(binding.aliases ?? [])];
}

function resolveBridgeCliBinding(command: string, positionals: string[]): ResolveBridgeCliBindingResult {
	const familyBindings = BridgeCliBindings.filter(({ binding }) => binding.family === command);
	if (familyBindings.length === 0) {
		return { ok: false, message: `Unknown command: ${command}` };
	}

	let best: ResolvedBridgeCliBinding | undefined;
	let bestConsumed = -1;
	for (const entry of familyBindings) {
		const binding = entry.binding as CliBinding;
		if (positionals.length === 0 && binding.default && bestConsumed < 0) {
			best = { method: entry.method, binding, positionals: [] };
			bestConsumed = 0;
		}
		for (const path of bindingPaths(binding)) {
			if (path.length === 0 || matchesCliPath(positionals, path)) {
				if (path.length <= bestConsumed) continue;
				best = {
					method: entry.method,
					binding,
					positionals: positionals.slice(path.length),
				};
				bestConsumed = path.length;
			}
		}
	}

	if (best) return { ok: true, value: best };
	const usages = Array.from(new Set(familyBindings.map(({ binding }) => binding.usage)));
	return { ok: false, message: usages.join("\n") };
}

function isMissingCliValue(value: unknown): boolean {
	return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

function parseCliBindingValue(value: unknown, parser: CliFlagBinding["parse"]): unknown {
	if (Array.isArray(value)) return value.map((item) => parseCliBindingValue(item, parser));
	if (!parser || parser === "string") return value;
	if (parser === "boolean") return Boolean(value);
	if (typeof value !== "string") return value;
	if (parser === "integer") return Number.parseInt(value, 10);
	if (parser === "number") return Number.parseFloat(value);
	if (parser === "duration") return parseTimeout(value);
	return JSON.parse(value);
}

function positionalBindingValue(binding: CliPositionalBinding, positionals: readonly string[]): unknown {
	if (binding.source === "index") return positionals[binding.index];
	const values = positionals.slice(binding.index);
	return binding.join === "array" ? values : values.join(" ");
}

function materializeGenericParams(context: CliCodecContext): CliCodecResult {
	const params: Record<string, unknown> = { ...(context.binding.constants ?? {}) };
	try {
		for (const flagBinding of context.binding.flags) {
			const value = context.flags[flagBinding.flag];
			if (value === undefined || !flagBinding.param) continue;
			const parsed = parseCliBindingValue(value, flagBinding.parse);
			if (parsed !== undefined) params[flagBinding.param] = parsed;
		}
		for (const positionalBinding of context.binding.positionals) {
			const value = positionalBindingValue(positionalBinding, context.positionals);
			if (isMissingCliValue(value)) {
				if (positionalBinding.required) {
					return { ok: false, message: context.binding.usage };
				}
				continue;
			}
			if (!positionalBinding.param) continue;
			const parsed = parseCliBindingValue(value, positionalBinding.parse);
			if (parsed !== undefined) params[positionalBinding.param] = parsed;
		}
	} catch (error) {
		return {
			ok: false,
			message: `${context.binding.usage}\n${error instanceof Error ? error.message : String(error)}`,
		};
	}
	return { ok: true, value: { params } };
}

function createTabsCloseParams(context: CliCodecContext): CliCodecResult {
	const ids = context.positionals.filter((value) => /^\d+$/.test(value)).map((value) => Number.parseInt(value, 10));
	const unexpected = context.positionals.filter((value) => !/^\d+$/.test(value));
	if (unexpected.length > 0) {
		return {
			ok: false,
			message: `Unexpected argument(s): ${unexpected.join(" ")}. Usage: shuvgeist tabs close <tabId...> | --title-match … [--yes|--dry-run]`,
		};
	}

	const { flags } = context;
	const hasFilter = Boolean(
		flags.titleMatch || flags.urlMatch || flags.titlePattern || flags.urlPattern || flags.windowId,
	);
	if (ids.length === 0 && !hasFilter) {
		return {
			ok: false,
			message:
				"Usage: shuvgeist tabs close <tabId...> | --title-match <s> | --url-match <s> | --title-pattern <re> | --url-pattern <re> | --window-id <n> [--yes] [--dry-run]",
		};
	}
	if (ids.length > 0 && hasFilter) {
		return { ok: false, message: "tabs close: pass either tab IDs or filter flags, not both" };
	}
	if (hasFilter && !flags.yes && !flags.dryRun) {
		return {
			ok: false,
			message:
				"Filter close requires --dry-run (preview matches) or --yes (apply). Example: shuvgeist tabs close --title-match shuvplan --dry-run --json",
		};
	}

	const params: Record<string, unknown> = {};
	if (flags.dryRun) params.dryRun = true;
	if (flags.requireMatch) params.requireMatch = true;
	if (ids.length === 1) {
		params.closeTab = ids[0];
	} else if (ids.length > 1) {
		params.closeTabs = ids;
	} else {
		const filter: Record<string, unknown> = {};
		if (flags.titleMatch) filter.titleIncludes = flags.titleMatch;
		if (flags.urlMatch) filter.urlIncludes = flags.urlMatch;
		if (flags.titlePattern) filter.titlePattern = flags.titlePattern;
		if (flags.urlPattern) filter.urlPattern = flags.urlPattern;
		if (flags.windowId) {
			const windowId = Number.parseInt(flags.windowId, 10);
			if (!Number.isFinite(windowId)) return { ok: false, message: "--window-id must be a number" };
			filter.windowId = windowId;
		}
		if (flags.includePinned) filter.includePinned = true;
		if (flags.includeProtected) filter.includeProtected = true;
		params.closeTabFilter = filter;
	}
	return { ok: true, value: { params } };
}

function createWindowsCloseParams(context: CliCodecContext): CliCodecResult {
	const windowIdRaw = context.positionals[0];
	if (!windowIdRaw || !/^\d+$/.test(windowIdRaw)) {
		return { ok: false, message: context.binding.usage };
	}
	if (!context.flags.yes && !context.flags.dryRun) {
		return {
			ok: false,
			message:
				"Window close requires --dry-run (preview) or --yes (apply). Example: shuvgeist windows close <id> --yes --json",
		};
	}
	return {
		ok: true,
		value: {
			params: {
				closeWindow: Number.parseInt(windowIdRaw, 10),
				...(context.flags.dryRun ? { dryRun: true } : {}),
				...(context.flags.requireMatch ? { requireMatch: true } : {}),
			},
		},
	};
}

function createReplParams(context: CliCodecContext): CliCodecResult {
	const materialized = materializeGenericParams(context);
	if (!materialized.ok) return materialized;
	let code = context.positionals.join(" ");
	if (context.flags.file) code = context.readFileText(context.flags.file);
	if (!code) return { ok: false, message: context.binding.usage };
	return {
		ok: true,
		value: { params: { ...materialized.value.params, title: "CLI REPL", code } },
	};
}

function createWorkflowParams(context: CliCodecContext): CliCodecResult {
	let source = context.flags.inline;
	if (!source && context.flags.file) source = context.readFileText(context.flags.file);
	if (!source) return { ok: false, message: "Workflow source required via --file or --inline" };
	try {
		return {
			ok: true,
			value: {
				params: {
					workflow: JSON.parse(source),
					args: parseWorkflowArgs(context.flags.arg),
					...(context.method === "workflow_run" && context.flags.dryRun ? { dryRun: true } : {}),
				},
			},
		};
	} catch (error) {
		return {
			ok: false,
			message: `Workflow JSON parse error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function createAssertionParams(context: CliCodecContext): CliCodecResult {
	const materialized = materializeGenericParams(context);
	if (!materialized.ok) return materialized;
	const timeoutMs = parseTimeout(context.flags.timeout, 5_000) ?? 5_000;
	const params: Record<string, unknown> = { ...materialized.value.params, timeoutMs };
	if (params.kind === "url" && !params.url && !params.urlPattern) {
		return { ok: false, message: context.binding.usage };
	}
	return { ok: true, value: { params } };
}

function createRefActionParams(context: CliCodecContext): CliCodecResult {
	if (context.flags.native && context.flags.trusted) {
		return {
			ok: false,
			message: "Ref input modes are mutually exclusive: use only one of --native or --trusted/--cdp-input.",
		};
	}
	if (context.flags.native && context.target?.kind === "electron-window") {
		return {
			ok: false,
			message:
				"Electron does not support --native OS-level input. Use DOM refs or enable cdp_input and pass --trusted/--cdp-input.",
		};
	}
	return materializeGenericParams(context);
}

function createRefFillParams(context: CliCodecContext): CliCodecResult {
	if (typeof context.flags.value !== "string") return { ok: false, message: context.binding.usage };
	return createRefActionParams(context);
}

function createDeviceEmulateParams(context: CliCodecContext): CliCodecResult {
	const materialized = materializeGenericParams(context);
	if (!materialized.ok) return materialized;
	const width = parseNumberFlag(context.flags.width);
	const height = parseNumberFlag(context.flags.height);
	const dpr = context.flags.dpr ? Number.parseFloat(context.flags.dpr) : undefined;
	const params = { ...materialized.value.params };
	if (typeof width === "number" && typeof height === "number") {
		params.viewport = {
			width,
			height,
			deviceScaleFactor: dpr,
			mobile: Boolean(context.flags.mobile),
		};
	}
	return { ok: true, value: { params } };
}

function createRecordStartParams(context: CliCodecContext): CliCodecResult {
	const materialized = materializeGenericParams(context);
	if (!materialized.ok) return materialized;
	if (!context.flags.out) {
		return {
			ok: false,
			message: "Usage: shuvgeist record start --out file.webm [--max-duration 30s]",
		};
	}
	const params = { ...materialized.value.params };
	const maxDurationMs = parseTimeout(context.flags.maxDuration, BridgeDefaults.RECORD_DEFAULT_MAX_DURATION_MS);
	if (typeof maxDurationMs !== "number" || maxDurationMs <= 0) {
		return { ok: false, message: "--max-duration must be greater than 0" };
	}
	if (maxDurationMs > BridgeDefaults.RECORD_HARD_MAX_DURATION_MS) {
		return {
			ok: false,
			message: `--max-duration exceeds hard limit of ${BridgeDefaults.RECORD_HARD_MAX_DURATION_MS}ms`,
		};
	}
	params.maxDurationMs = maxDurationMs;
	if (context.flags.videoBitrate) {
		const videoBitsPerSecond = Number.parseInt(context.flags.videoBitrate, 10);
		if (!Number.isFinite(videoBitsPerSecond) || videoBitsPerSecond <= 0) {
			return { ok: false, message: "--video-bitrate must be a positive integer" };
		}
		params.videoBitsPerSecond = videoBitsPerSecond;
	}
	const fps = parsePositiveIntegerFlag("--fps", context.flags.fps);
	if (!fps.ok) return { ok: false, message: fps.message };
	if (typeof fps.value === "number") {
		if (fps.value < BridgeDefaults.RECORD_MIN_FPS || fps.value > BridgeDefaults.RECORD_MAX_FPS) {
			return {
				ok: false,
				message: `--fps must be between ${BridgeDefaults.RECORD_MIN_FPS} and ${BridgeDefaults.RECORD_MAX_FPS}`,
			};
		}
		params.fps = fps.value;
	}
	const quality = parsePositiveIntegerFlag("--quality", context.flags.quality);
	if (!quality.ok) return { ok: false, message: quality.message };
	if (typeof quality.value === "number") {
		if (quality.value < 1 || quality.value > 100) {
			return { ok: false, message: "--quality must be between 1 and 100" };
		}
		params.quality = quality.value;
	}
	for (const [name, value, param] of [
		["--max-width", context.flags.maxWidth, "maxWidth"],
		["--max-height", context.flags.maxHeight, "maxHeight"],
	] as const) {
		const parsed = parsePositiveIntegerFlag(name, value);
		if (!parsed.ok) return { ok: false, message: parsed.message };
		if (typeof parsed.value === "number") params[param] = parsed.value;
	}
	if (context.flags.mimeType) {
		const allowed = new Set(["video/webm", "video/webm;codecs=vp8", "video/webm;codecs=vp9"]);
		if (!allowed.has(context.flags.mimeType.toLowerCase())) {
			return {
				ok: false,
				message: "--mime-type must be video/webm, video/webm;codecs=vp8, or video/webm;codecs=vp9",
			};
		}
		params.mimeType = context.flags.mimeType;
	}
	return { ok: true, value: { params } };
}

function createElectronWindowsParams(context: CliCodecContext): CliCodecResult {
	const appRef = context.positionals[0];
	return {
		ok: true,
		value: {
			params: {},
			...(appRef ? { target: { kind: "electron-window" as const, appRef } } : {}),
		},
	};
}

function createElectronSourceExtractParams(context: CliCodecContext): CliCodecResult {
	const materialized = materializeGenericParams(context);
	if (!materialized.ok) return materialized;
	const destinationPath = context.flags.extractTo ?? context.positionals[0];
	if (!destinationPath) return { ok: false, message: context.binding.usage };
	return {
		ok: true,
		value: { params: { ...materialized.value.params, destinationPath } },
	};
}

const CliCodecRegistry = {
	generic: materializeGenericParams,
	"tabs-close": createTabsCloseParams,
	"windows-close": createWindowsCloseParams,
	repl: createReplParams,
	workflow: createWorkflowParams,
	assert: createAssertionParams,
	"ref-action": createRefActionParams,
	"ref-fill": createRefFillParams,
	"device-emulate": createDeviceEmulateParams,
	"record-start": createRecordStartParams,
	"electron-windows": createElectronWindowsParams,
	"electron-source-extract": createElectronSourceExtractParams,
} satisfies Record<CatalogCliCodec, (context: CliCodecContext) => CliCodecResult>;

const CliRunnerRegistry = {
	repl: {
		validateParams: true,
		createPlan: ({ params, resolvedTarget }) => ({
			kind: "repl",
			params,
			defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS,
			target: resolvedTarget,
		}),
	},
	screenshot: {
		validateParams: true,
		createPlan: ({ params, resolvedTarget }) => ({
			kind: "screenshot",
			params,
			defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS,
			target: resolvedTarget,
		}),
	},
	cookies: {
		validateParams: true,
		createPlan: ({ resolvedTarget }) => ({
			kind: "cookies",
			defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS,
			target: resolvedTarget,
		}),
	},
	workflow: {
		validateParams: true,
		createPlan: ({ method, params }) => ({
			kind: "workflow",
			action: method === "workflow_run" ? "run" : "validate",
			workflow: params.workflow,
			args: (params.args as Record<string, unknown> | undefined) ?? {},
			dryRun: params.dryRun === true,
			defaultTimeoutMs: BridgeDefaults.WORKFLOW_TIMEOUT_MS,
		}),
	},
	assert: {
		validateParams: true,
		createPlan: ({ params, resolvedTarget }) => {
			const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 5_000;
			return {
				kind: "assert",
				params,
				defaultTimeoutMs: timeoutMs + 5_000,
				target: resolvedTarget,
			};
		},
	},
	session: {
		validateParams: true,
		createPlan: ({ params, flags }) => ({
			kind: "session",
			follow: Boolean(flags.follow),
			params,
			defaultTimeoutMs: BridgeDefaults.REQUEST_TIMEOUT_MS,
		}),
	},
	record: {
		validateParams: true,
		createPlan: ({ method, params, resolvedTarget }) => ({
			kind: "record",
			action: method === "record_start" ? "start" : method === "record_stop" ? "stop" : "status",
			params,
			defaultTimeoutMs: catalogDefaultTimeoutMs(method),
			target: resolvedTarget,
		}),
	},
	inject: {
		// The execution path obtains expectedSessionId and constructs wire params later.
		validateParams: false,
		createPlan: ({ positionals, flags }) => ({
			kind: "inject",
			text: positionals.join(" "),
			role: flags.role === "assistant" ? "assistant" : "user",
		}),
	},
} satisfies Record<CatalogCliRunner, CliRunnerDefinition>;

function bindingAcceptsTarget(binding: CliBinding): boolean {
	return binding.flags.some(({ flag }) => flag === "target");
}

function validatePlannedParams(
	method: CatalogBridgeMethod,
	params: Record<string, unknown>,
): { ok: true; params: Record<string, unknown> } | { ok: false; message: string } {
	const validation = validateBridgeCommandParams(method, params);
	if (!validation.ok) {
		return {
			ok: false,
			message: `Invalid parameters for '${method}': ${formatBridgeCommandValidationErrors(validation.errors)}`,
		};
	}
	return { ok: true, params: validation.value as Record<string, unknown> };
}

function createBridgeCommandPlan(command: string, context: CliCommandPlannerContext): CliCommandPlan {
	const resolved = resolveBridgeCliBinding(command, context.positionals);
	if (!resolved.ok) return { kind: "usage-error", message: resolved.message };
	const codecContext: CliCodecContext = { ...context, ...resolved.value };
	const codec = CliCodecRegistry[resolved.value.binding.codec as CatalogCliCodec];
	const encoded = codec(codecContext);
	if (!encoded.ok) return { kind: "usage-error", message: encoded.message };
	const resolvedTarget =
		encoded.value.target ?? (bindingAcceptsTarget(resolved.value.binding) ? context.target : undefined);
	const runnerId = resolved.value.binding.runner as CatalogCliRunner | undefined;
	const runner = runnerId ? CliRunnerRegistry[runnerId] : undefined;
	let params = encoded.value.params;
	if (!runner || runner.validateParams) {
		const validated = validatePlannedParams(resolved.value.method, params);
		if (!validated.ok) return { kind: "usage-error", message: validated.message };
		params = validated.params;
	}
	if (runner) {
		return runner.createPlan({ ...codecContext, params, resolvedTarget });
	}
	return createOneShotPlan(resolved.value.method, params, resolvedTarget);
}

const LocalCliCodecRegistry = {
	"local-status": () => ({ kind: "status" as const }),
	"local-serve": () => ({ kind: "serve" as const }),
	"local-launch": ({ positionals, flags }: CliCommandPlannerContext) => ({
		kind: "launch" as const,
		options: {
			browser: flags.browser,
			extensionPath: flags.extensionPath,
			profile: flags.profile,
			userDataDir: flags.userDataDir,
			useDefaultProfile: flags.useDefaultProfile,
			url: flags.url || positionals[0],
			headless: flags.headless,
			foreground: flags.foreground,
		},
	}),
	"local-close": () => ({ kind: "close" as const }),
} satisfies Record<LocalCliCodec, CliCommandPlanner>;

const bridgeFamilyPlanners = Object.fromEntries(
	getCatalogCliCommands().map((command) => [
		command,
		(context: CliCommandPlannerContext) => createBridgeCommandPlan(command, context),
	]),
);
const localFamilyPlanners = Object.fromEntries(
	LocalCliCommandDefinitions.map((definition) => [definition.family, LocalCliCodecRegistry[definition.codec]]),
);

/** Derived planner registry: bridge family selection lives only in command definitions. */
export const CliCommandPlanners = {
	...bridgeFamilyPlanners,
	...localFamilyPlanners,
} as Record<CliPlannerCommand, CliCommandPlanner>;

export interface CliPlannerCoverage {
	missingCatalogCommands: string[];
	unexpectedCommands: string[];
	duplicateBindings: string[];
	duplicateDefaults: string[];
	overlappingPositionals: string[];
	missingCodecs: string[];
	unexpectedCodecs: string[];
	missingRunners: string[];
	unexpectedRunners: string[];
	missingLocalCodecs: string[];
	unexpectedLocalCodecs: string[];
	unreferencedFlagDefinitions: string[];
}

function duplicateCliBindings(): string[] {
	const seenPaths = new Set<string>();
	const duplicates: string[] = [];
	for (const { binding } of BridgeCliBindings) {
		const neutralBinding = binding as CliBinding;
		for (const path of bindingPaths(neutralBinding)) {
			const key = `${neutralBinding.family}/${path.join("/") || "<root>"}`;
			if (seenPaths.has(key)) duplicates.push(key);
			seenPaths.add(key);
		}
	}
	return duplicates.sort();
}

function duplicateDefaultFamilies(): string[] {
	const counts = new Map<string, number>();
	for (const { binding } of BridgeCliBindings) {
		const neutralBinding = binding as CliBinding;
		if (neutralBinding.default) {
			counts.set(neutralBinding.family, (counts.get(neutralBinding.family) ?? 0) + 1);
		}
	}
	return [...counts]
		.filter(([, count]) => count > 1)
		.map(([family]) => family)
		.sort();
}

function overlappingCliPositionals(): string[] {
	const overlaps: string[] = [];
	for (const { binding } of BridgeCliBindings) {
		const positions = binding.positionals as readonly CliPositionalBinding[];
		const fixed = positions.filter((entry) => entry.source === "index").map((entry) => entry.index);
		const rest = positions.filter((entry) => entry.source === "rest").map((entry) => entry.index);
		const duplicateFixed = fixed.filter((index, itemIndex) => fixed.indexOf(index) !== itemIndex);
		const hasOverlap =
			duplicateFixed.length > 0 || rest.length > 1 || rest.some((start) => fixed.some((index) => index >= start));
		if (hasOverlap) overlaps.push(`${binding.family}/${binding.select.join("/") || "<root>"}`);
	}
	return overlaps.sort();
}

function registryDifference(expected: Iterable<string>, actual: Iterable<string>): [string[], string[]] {
	const expectedSet = new Set(expected);
	const actualSet = new Set(actual);
	return [
		[...expectedSet].filter((value) => !actualSet.has(value)).sort(),
		[...actualSet].filter((value) => !expectedSet.has(value)).sort(),
	];
}

/** Runtime companion to compile-time codec/runner registry exhaustiveness. */
export function getCliPlannerCoverage(): CliPlannerCoverage {
	const catalogCommands = new Set(getCatalogCliCommands());
	const localCommands = new Set<string>(LocalCliPlannerCommands);
	const plannerCommands = Object.keys(CliCommandPlanners);
	const referencedCodecs = BridgeCliBindings.map(({ binding }) => binding.codec);
	const referencedRunners = BridgeCliBindings.flatMap(({ binding }) => {
		const runner = (binding as CliBinding).runner;
		return runner ? [runner] : [];
	});
	const referencedLocalCodecs = LocalCliCommandDefinitions.map(({ codec }) => codec);
	const [missingCodecs, unexpectedCodecs] = registryDifference(referencedCodecs, Object.keys(CliCodecRegistry));
	const [missingRunners, unexpectedRunners] = registryDifference(referencedRunners, Object.keys(CliRunnerRegistry));
	const [missingLocalCodecs, unexpectedLocalCodecs] = registryDifference(
		referencedLocalCodecs,
		Object.keys(LocalCliCodecRegistry),
	);
	const referencedFlags = new Set<CliFlagKey>(GlobalCliFlagKeys);
	for (const { binding } of BridgeCliBindings) {
		for (const { flag } of binding.flags) referencedFlags.add(flag);
	}
	for (const definition of LocalCliCommandDefinitions) {
		for (const { flag } of definition.flags) referencedFlags.add(flag);
	}
	return {
		missingCatalogCommands: [...catalogCommands].filter((command) => !plannerCommands.includes(command)).sort(),
		unexpectedCommands: plannerCommands
			.filter((command) => !catalogCommands.has(command) && !localCommands.has(command))
			.sort(),
		duplicateBindings: duplicateCliBindings(),
		duplicateDefaults: duplicateDefaultFamilies(),
		overlappingPositionals: overlappingCliPositionals(),
		missingCodecs,
		unexpectedCodecs,
		missingRunners,
		unexpectedRunners,
		missingLocalCodecs,
		unexpectedLocalCodecs,
		unreferencedFlagDefinitions: CliFlagDefinitions.map(({ key }) => key)
			.filter((key) => !referencedFlags.has(key))
			.sort(),
	};
}

function isCliPlannerCommand(command: string): command is CliPlannerCommand {
	return Object.hasOwn(CliCommandPlanners, command);
}

export function createCommandPlan(
	command: string,
	positionals: string[],
	flags: CliFlags,
	readFileText: (path: string) => string,
): CliCommandPlan {
	const parsedTarget = targetFromFlags(flags);
	if (!parsedTarget.ok) return { kind: "usage-error", message: parsedTarget.message };
	if (!isCliPlannerCommand(command)) {
		return { kind: "usage-error", message: `Unknown command: ${command}` };
	}
	return CliCommandPlanners[command]({
		positionals,
		flags,
		readFileText,
		target: parsedTarget.target,
	});
}
