import {
	existsSync as nodeExistsSync,
	mkdirSync as nodeMkdirSync,
	readFileSync as nodeReadFileSync,
	renameSync as nodeRenameSync,
	unlinkSync as nodeUnlinkSync,
	writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { homedir as nodeHomeDirectory } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { BridgeDefaults } from "@shuvgeist/protocol/protocol";

export type ConfigValueSource = "flags" | "environment" | "file" | "defaults";
export type BridgeUrlLocality = "loopback" | "remote";

export type ElectronCapability = "eval" | "cookies" | "main_inspect" | "ipc_tap" | "main_network_tap" | "cdp_input";

export interface ElectronCapabilitiesConfig {
	[key: string]: unknown;
	eval?: boolean;
	cookies?: boolean;
	main_inspect?: boolean;
	ipc_tap?: boolean;
	main_network_tap?: boolean;
	cdp_input?: boolean;
}

export interface ElectronNodeConfig {
	[key: string]: unknown;
	allowlist?: string[];
	portRange?: [number, number];
	defaultFlags?: Record<string, string[]>;
	capabilities?: Record<string, ElectronCapabilitiesConfig>;
}

export interface NodeOtelConfig {
	[key: string]: unknown;
	enabled?: boolean;
	ingestUrl?: string;
	privateIngestKey?: string;
}

export interface BridgeServeNodeConfig {
	[key: string]: unknown;
	host?: string;
	port?: number;
}

export interface BridgeNodeConfig {
	[key: string]: unknown;
	url?: string;
	token?: string;
	serve?: BridgeServeNodeConfig;
	electron?: ElectronNodeConfig;
	otel?: NodeOtelConfig;
}

export interface DiscoveryNodeConfig {
	[key: string]: unknown;
	extensionPath?: string;
	browser?: string;
}

export interface BridgeNodeConfigPatch {
	[key: string]: unknown;
	url?: string;
	token?: string;
	serve?: Partial<BridgeServeNodeConfig>;
	electron?: Partial<ElectronNodeConfig>;
	otel?: Partial<NodeOtelConfig>;
}

export interface DiscoveryNodeConfigPatch {
	[key: string]: unknown;
	extensionPath?: string;
	browser?: string;
}

export interface NodeConfigEnvironment {
	[key: string]: string | undefined;
	SHUVGEIST_BRIDGE_CONFIG?: string;
	SHUVGEIST_CONFIG?: string;
	SHUVGEIST_DISCOVERY_CONFIG?: string;
	SHUVGEIST_BRIDGE_URL?: string;
	SHUVGEIST_BRIDGE_HOST?: string;
	SHUVGEIST_BRIDGE_PORT?: string;
	SHUVGEIST_BRIDGE_TOKEN?: string;
	SHUVGEIST_EXTENSION_PATH?: string;
	SHUVGEIST_BROWSER?: string;
	SHUVGEIST_OTEL_ENABLED?: string;
	SHUVGEIST_OTEL_INGEST_URL?: string;
	SHUVGEIST_OTEL_PRIVATE_INGEST_KEY?: string;
}

export interface BridgeConnectionOverrides {
	url?: string;
	host?: string;
	port?: string | number;
	token?: string;
}

export interface BridgeConnectionDefaults {
	url?: string;
	host: string;
	port: number;
	token: string;
}

export interface BridgeServeOverrides {
	host?: string;
	port?: string | number;
	token?: string;
}

export interface BridgeServeDefaults {
	host: string;
	port: number;
	token: string;
}

export interface ResolvedBridgeServeBinding {
	host: string;
	port: number;
	token: string;
	configPath: string;
	sources: {
		host: ConfigValueSource;
		port: ConfigValueSource;
		token: ConfigValueSource;
	};
}

export interface ResolvedBridgeConnection {
	url: string;
	token: string;
	host: string;
	port: number;
	locality: BridgeUrlLocality;
	canAutoStart: boolean;
	configPath: string;
	sources: {
		url: ConfigValueSource;
		token: ConfigValueSource;
	};
}

export interface NodeOtelDefaults {
	enabled: boolean;
	ingestUrl: string;
	privateIngestKey: string;
}

export interface ResolvedNodeOtelConfig {
	enabled: boolean;
	ingestUrl: string;
	privateIngestKey: string;
	configPath: string;
	sources: {
		enabled: ConfigValueSource;
		ingestUrl: ConfigValueSource;
		privateIngestKey: ConfigValueSource;
	};
}

export interface DiscoveryOverrides {
	extensionPath?: string;
	browser?: string;
}

export interface DiscoveryDefaults {
	extensionPath?: string;
	browser?: string;
}

export interface ResolvedDiscoveryPreferences {
	extensionPath?: string;
	browser?: string;
	sources: {
		extensionPath?: ConfigValueSource;
		browser?: ConfigValueSource;
	};
}

export interface DiscoveryCandidate {
	value: string;
	source: ConfigValueSource;
}

export interface ResolvedDiscoveryCandidates {
	extensionPath: DiscoveryCandidate[];
	browser: DiscoveryCandidate[];
}

export interface NodeConfigPaths {
	bridge: string;
	discovery: string;
}

export interface NodeConfigFileSystem {
	existsSync(path: string): boolean;
	readFileSync(path: string): string;
	mkdirSync(path: string): void;
	writeFileSync(path: string, contents: string): void;
	renameSync(from: string, to: string): void;
	unlinkSync(path: string): void;
}

export interface NodeConfigDependencies {
	fs?: NodeConfigFileSystem;
	env?: NodeConfigEnvironment;
	homeDirectory?: string;
	currentWorkingDirectory?: string;
	processId?: number;
	now?: () => number;
	random?: () => number;
}

export interface ResolveBridgeConnectionOptions {
	flags?: BridgeConnectionOverrides;
	env?: NodeConfigEnvironment;
	file?: BridgeNodeConfig;
	defaults?: Partial<BridgeConnectionDefaults>;
	configPath?: string;
}

export interface ResolveBridgeServeBindingOptions {
	flags?: BridgeServeOverrides;
	env?: NodeConfigEnvironment;
	file?: BridgeNodeConfig;
	defaults?: Partial<BridgeServeDefaults>;
	configPath?: string;
}

export interface ResolveNodeOtelConfigOptions {
	env?: NodeConfigEnvironment;
	file?: BridgeNodeConfig;
	defaults?: Partial<NodeOtelDefaults>;
	configPath?: string;
}

export interface ResolveDiscoveryPreferencesOptions {
	flags?: DiscoveryOverrides;
	env?: NodeConfigEnvironment;
	file?: DiscoveryNodeConfig;
	defaults?: DiscoveryDefaults;
	configPath?: string;
}

export interface NodeConfigOwner {
	readonly paths: NodeConfigPaths;
	readBridgeConfig(): BridgeNodeConfig;
	readDiscoveryConfig(): DiscoveryNodeConfig;
	writeBridgeConfig(config: BridgeNodeConfig): void;
	writeDiscoveryConfig(config: DiscoveryNodeConfig): void;
	updateBridgeConfig(patch: BridgeNodeConfigPatch): BridgeNodeConfig;
	updateDiscoveryConfig(patch: DiscoveryNodeConfigPatch): DiscoveryNodeConfig;
	resolveBridgeConnection(
		flags?: BridgeConnectionOverrides,
		defaults?: Partial<BridgeConnectionDefaults>,
	): ResolvedBridgeConnection;
	resolveBridgeServeBinding(
		flags?: BridgeServeOverrides,
		defaults?: Partial<BridgeServeDefaults>,
	): ResolvedBridgeServeBinding;
	resolveOtelConfig(defaults?: Partial<NodeOtelDefaults>): ResolvedNodeOtelConfig;
	resolveDiscoveryCandidates(flags?: DiscoveryOverrides, defaults?: DiscoveryDefaults): ResolvedDiscoveryCandidates;
	resolveDiscoveryPreferences(flags?: DiscoveryOverrides, defaults?: DiscoveryDefaults): ResolvedDiscoveryPreferences;
}

export type NodeConfigErrorCode =
	| "READ_FAILED"
	| "INVALID_JSON"
	| "INVALID_SCHEMA"
	| "INVALID_OVERRIDE"
	| "ATOMIC_WRITE_FAILED"
	| "AUTOSTART_UNSAFE"
	| "AUTOSTART_FAILED";

export class NodeConfigError extends Error {
	readonly code: NodeConfigErrorCode;
	readonly path: string;

	constructor(code: NodeConfigErrorCode, path: string, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "NodeConfigError";
		this.code = code;
		this.path = path;
	}
}

export const DEFAULT_BRIDGE_CONNECTION: BridgeConnectionDefaults = {
	host: "127.0.0.1",
	port: BridgeDefaults.PORT,
	token: "",
};

export const DEFAULT_BRIDGE_SERVE_BINDING: BridgeServeDefaults = {
	host: BridgeDefaults.HOST,
	port: BridgeDefaults.PORT,
	token: "",
};

export const DEFAULT_NODE_OTEL_CONFIG: NodeOtelDefaults = {
	enabled: false,
	ingestUrl: "http://localhost:3474",
	privateIngestKey: "",
};

const ELECTRON_CAPABILITIES: readonly ElectronCapability[] = [
	"eval",
	"cookies",
	"main_inspect",
	"ipc_tap",
	"main_network_tap",
	"cdp_input",
];

const DEFAULT_FILE_SYSTEM: NodeConfigFileSystem = {
	existsSync: nodeExistsSync,
	readFileSync: (path) => nodeReadFileSync(path, "utf8"),
	mkdirSync: (path) => {
		nodeMkdirSync(path, { recursive: true, mode: 0o700 });
	},
	writeFileSync: (path, contents) => {
		nodeWriteFileSync(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
	},
	renameSync: nodeRenameSync,
	unlinkSync: nodeUnlinkSync,
};

interface SchemaContext {
	kind: "bridge" | "discovery";
	path: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function valueKind(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number" && !Number.isFinite(value)) return "non-finite number";
	return typeof value;
}

function schemaError(context: SchemaContext, field: string, expectation: string, value: unknown): never {
	const location = field ? `field '${field}'` : "the root value";
	throw new NodeConfigError(
		"INVALID_SCHEMA",
		context.path,
		`Invalid ${context.kind} config at ${context.path}: ${location} must be ${expectation}; received ${valueKind(value)}. Fix the field or remove it before retrying.`,
	);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(
	value: unknown,
	context: SchemaContext,
	field = "",
	ancestors: ReadonlySet<object> = new Set(),
): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) schemaError(context, field, "a finite JSON number", value);
		return;
	}
	if (typeof value !== "object") schemaError(context, field, "valid JSON data", value);
	if (ancestors.has(value)) schemaError(context, field, "acyclic JSON data", value);

	const nextAncestors = new Set(ancestors);
	nextAncestors.add(value);
	if (Array.isArray(value)) {
		value.forEach((entry, index) => {
			assertJsonValue(entry, context, `${field}[${index}]`, nextAncestors);
		});
		return;
	}
	if (!isPlainObject(value)) schemaError(context, field, "a plain JSON object", value);
	for (const [key, entry] of Object.entries(value)) {
		assertJsonValue(entry, context, field ? `${field}.${key}` : key, nextAncestors);
	}
}

function assertObject(value: unknown, context: SchemaContext, field: string): asserts value is Record<string, unknown> {
	if (!isPlainObject(value)) schemaError(context, field, "an object", value);
}

function assertString(
	value: unknown,
	context: SchemaContext,
	field: string,
	options: { allowEmpty?: boolean } = {},
): asserts value is string {
	if (typeof value !== "string") schemaError(context, field, "a string", value);
	if (!options.allowEmpty && value.trim().length === 0) {
		schemaError(context, field, "a non-empty string", value);
	}
}

function assertBoolean(value: unknown, context: SchemaContext, field: string): asserts value is boolean {
	if (typeof value !== "boolean") schemaError(context, field, "a boolean", value);
}

function parseUrl(value: string, context: SchemaContext, field: string, protocols: readonly string[]): URL {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		schemaError(context, field, `an absolute ${protocols.join(" or ")} URL`, value);
	}
	if (!protocols.includes(parsed.protocol) || !parsed.hostname) {
		schemaError(context, field, `an absolute ${protocols.join(" or ")} URL`, value);
	}
	if (parsed.username || parsed.password) {
		schemaError(context, field, "a URL without embedded credentials", value);
	}
	return parsed;
}

function isValidHost(value: string): boolean {
	const host = value.trim();
	if (!host || /[\s/?#]/u.test(host)) return false;
	const authorityHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
	try {
		const parsed = new URL(`ws://${authorityHost}:1/ws`);
		return Boolean(parsed.hostname) && !parsed.username && !parsed.password;
	} catch {
		return false;
	}
}

function validateServeConfig(value: unknown, context: SchemaContext): void {
	assertObject(value, context, "serve");
	if ("host" in value) {
		assertString(value.host, context, "serve.host");
		if (!isValidHost(value.host)) schemaError(context, "serve.host", "a hostname or IP address", value.host);
	}
	if ("port" in value) {
		if (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535) {
			schemaError(context, "serve.port", "an integer port between 1 and 65535", value.port);
		}
	}
}

function validateElectronConfig(value: unknown, context: SchemaContext): void {
	assertObject(value, context, "electron");
	if ("allowlist" in value) {
		const allowlist = value.allowlist;
		if (!Array.isArray(allowlist))
			schemaError(context, "electron.allowlist", "an array of non-empty strings", allowlist);
		for (let index = 0; index < allowlist.length; index++) {
			assertString(allowlist[index], context, `electron.allowlist[${index}]`);
		}
	}
	if ("portRange" in value) {
		const range = value.portRange;
		if (!Array.isArray(range) || range.length !== 2) {
			schemaError(context, "electron.portRange", "a two-item [start, end] port tuple", range);
		}
		const [start, end] = range;
		if (
			!Number.isInteger(start) ||
			!Number.isInteger(end) ||
			(start as number) < 1 ||
			(end as number) > 65_535 ||
			(end as number) < (start as number)
		) {
			schemaError(context, "electron.portRange", "an ascending port tuple between 1 and 65535", range);
		}
	}
	if ("defaultFlags" in value) {
		assertObject(value.defaultFlags, context, "electron.defaultFlags");
		for (const [appId, flags] of Object.entries(value.defaultFlags)) {
			if (!appId) schemaError(context, "electron.defaultFlags", "non-empty application keys", appId);
			if (!Array.isArray(flags)) {
				schemaError(context, `electron.defaultFlags.${appId}`, "an array of strings", flags);
			}
			flags.forEach((flag, index) => {
				assertString(flag, context, `electron.defaultFlags.${appId}[${index}]`);
			});
		}
	}
	if ("capabilities" in value) {
		assertObject(value.capabilities, context, "electron.capabilities");
		for (const [appId, capabilities] of Object.entries(value.capabilities)) {
			if (!appId) schemaError(context, "electron.capabilities", "non-empty application keys", appId);
			assertObject(capabilities, context, `electron.capabilities.${appId}`);
			for (const capability of ELECTRON_CAPABILITIES) {
				if (capability in capabilities) {
					assertBoolean(capabilities[capability], context, `electron.capabilities.${appId}.${capability}`);
				}
			}
		}
	}
}

function validateOtelConfig(value: unknown, context: SchemaContext): void {
	assertObject(value, context, "otel");
	if ("enabled" in value) assertBoolean(value.enabled, context, "otel.enabled");
	if ("ingestUrl" in value) {
		assertString(value.ingestUrl, context, "otel.ingestUrl");
		parseUrl(value.ingestUrl, context, "otel.ingestUrl", ["http:", "https:"]);
	}
	if ("privateIngestKey" in value) {
		assertString(value.privateIngestKey, context, "otel.privateIngestKey", { allowEmpty: true });
	}
}

export function parseBridgeNodeConfig(value: unknown, path = "<bridge config>"): BridgeNodeConfig {
	const context: SchemaContext = { kind: "bridge", path };
	assertJsonValue(value, context);
	assertObject(value, context, "");
	if ("url" in value) {
		assertString(value.url, context, "url");
		parseUrl(value.url, context, "url", ["ws:", "wss:"]);
	}
	if ("token" in value) assertString(value.token, context, "token", { allowEmpty: true });
	if ("serve" in value) validateServeConfig(value.serve, context);
	if ("electron" in value) validateElectronConfig(value.electron, context);
	if ("otel" in value) validateOtelConfig(value.otel, context);
	return value as BridgeNodeConfig;
}

export function parseDiscoveryNodeConfig(value: unknown, path = "<discovery config>"): DiscoveryNodeConfig {
	const context: SchemaContext = { kind: "discovery", path };
	assertJsonValue(value, context);
	assertObject(value, context, "");
	if ("extensionPath" in value) assertString(value.extensionPath, context, "extensionPath");
	if ("browser" in value) assertString(value.browser, context, "browser");
	return value as DiscoveryNodeConfig;
}

function parseJson(contents: string, context: SchemaContext): unknown {
	try {
		return JSON.parse(contents) as unknown;
	} catch (error) {
		throw new NodeConfigError(
			"INVALID_JSON",
			context.path,
			`Invalid JSON in ${context.kind} config at ${context.path}: ${errorMessage(error)}. Fix or remove the file before retrying; malformed configuration is not ignored.`,
			error,
		);
	}
}

function readConfigFile<T>(
	path: string,
	kind: SchemaContext["kind"],
	fs: NodeConfigFileSystem,
	parse: (value: unknown, path: string) => T,
): T {
	if (!fs.existsSync(path)) return parse({}, path);
	let contents: string;
	try {
		contents = fs.readFileSync(path);
	} catch (error) {
		throw new NodeConfigError(
			"READ_FAILED",
			path,
			`Failed to read ${kind} config at ${path}: ${errorMessage(error)}. Check that the file exists and is readable.`,
			error,
		);
	}
	return parse(parseJson(contents, { kind, path }), path);
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		const previous = merged[key];
		merged[key] = isPlainObject(previous) && isPlainObject(value) ? deepMerge(previous, value) : value;
	}
	return merged;
}

function atomicWriteJson(
	path: string,
	value: Record<string, unknown>,
	fs: NodeConfigFileSystem,
	tempSuffix: string,
): void {
	const directory = dirname(path);
	const temporaryPath = join(directory, `.${basename(path)}.${tempSuffix}.tmp`);
	let temporaryExistedBefore = false;
	let writeAttempted = false;
	let temporaryCreated = false;
	try {
		fs.mkdirSync(directory);
		temporaryExistedBefore = fs.existsSync(temporaryPath);
		writeAttempted = true;
		fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
		temporaryCreated = true;
		fs.renameSync(temporaryPath, path);
	} catch (error) {
		try {
			if (
				writeAttempted &&
				!temporaryExistedBefore &&
				(temporaryCreated || errorCode(error) !== "EEXIST") &&
				fs.existsSync(temporaryPath)
			) {
				fs.unlinkSync(temporaryPath);
			}
		} catch {
			// Preserve the original atomic-write error.
		}
		throw new NodeConfigError(
			"ATOMIC_WRITE_FAILED",
			path,
			`Failed to atomically write config at ${path}: ${errorMessage(error)}. The existing config was left unchanged.`,
			error,
		);
	}
}

function nonEmpty(value: string | undefined): string | undefined {
	return value !== undefined && value.trim().length > 0 ? value : undefined;
}

function requireNonEmptyOverride(value: string, label: string, configPath: string): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new NodeConfigError(
			"INVALID_OVERRIDE",
			configPath,
			`Invalid ${label}: expected a non-empty string; received an empty value.`,
		);
	}
	return normalized;
}

function parsePort(value: string | number, label: string, configPath: string): number {
	const parsed =
		typeof value === "number" ? value : /^\d+$/u.test(value.trim()) ? Number.parseInt(value.trim(), 10) : Number.NaN;
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
		throw new NodeConfigError(
			"INVALID_OVERRIDE",
			configPath,
			`Invalid ${label}: expected an integer port between 1 and 65535; received ${JSON.stringify(value)}.`,
		);
	}
	return parsed;
}

function parseConnectionUrl(value: string, label: string, configPath: string): URL {
	const context: SchemaContext = { kind: "bridge", path: configPath };
	try {
		return parseUrl(value, context, label, ["ws:", "wss:"]);
	} catch (error) {
		if (error instanceof NodeConfigError) {
			throw new NodeConfigError("INVALID_OVERRIDE", configPath, error.message, error);
		}
		throw error;
	}
}

/** Convert a WebSocket connection endpoint to the bridge HTTP health endpoint. */
export function bridgeStatusUrl(connectionUrl: string): string {
	const url = new URL(connectionUrl);
	if (url.protocol !== "ws:" && url.protocol !== "wss:") {
		throw new TypeError(`Bridge status URL requires a ws:// or wss:// connection URL; received ${connectionUrl}.`);
	}
	url.protocol = url.protocol === "wss:" ? "https:" : "http:";
	url.pathname = "/status";
	url.search = "";
	url.hash = "";
	return url.toString();
}

function normalizeHost(value: string, label: string, configPath: string): string {
	const host = value.trim();
	if (!isValidHost(host)) {
		throw new NodeConfigError(
			"INVALID_OVERRIDE",
			configPath,
			`Invalid ${label}: expected a hostname or IP address without a scheme, path, or port.`,
		);
	}
	return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function setUrlHost(url: URL, host: string): void {
	url.hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function applyUrlLayer(
	current: URL,
	currentCanAutoStart: boolean,
	layer: { url?: string; host?: string; port?: string | number },
	source: ConfigValueSource,
	configPath: string,
): { url: URL; source: ConfigValueSource; canAutoStart: boolean } {
	const explicitUrl =
		layer.url === undefined ? undefined : requireNonEmptyOverride(layer.url, `${source} bridge URL`, configPath);
	const explicitHost =
		layer.host === undefined ? undefined : requireNonEmptyOverride(layer.host, `${source} bridge host`, configPath);
	const explicitPort = layer.port;
	// Validate every provided value even when a full URL wins within this layer;
	// malformed environment or flag state must never be silently masked.
	const normalizedExplicitHost =
		explicitHost === undefined ? undefined : normalizeHost(explicitHost, `${source} bridge host`, configPath);
	if (explicitPort !== undefined) parsePort(explicitPort, `${source} bridge port`, configPath);
	if (explicitUrl !== undefined) {
		return {
			url: parseConnectionUrl(explicitUrl, `${source} bridge URL`, configPath),
			source,
			canAutoStart: isBridgeUrlSafeForAutoStart(explicitUrl),
		};
	}
	if (!explicitHost && explicitPort === undefined) {
		return { url: current, source: "defaults", canAutoStart: currentCanAutoStart };
	}

	const next = new URL(current);
	if (normalizedExplicitHost) setUrlHost(next, normalizedExplicitHost);
	if (explicitPort !== undefined) next.port = String(parsePort(explicitPort, `${source} bridge port`, configPath));
	const authorityHost = normalizedExplicitHost?.includes(":") ? `[${normalizedExplicitHost}]` : normalizedExplicitHost;
	const canAutoStart = normalizedExplicitHost
		? isBridgeUrlSafeForAutoStart(
				`${current.protocol}//${authorityHost}:${effectivePort(next)}${next.pathname}${next.search}${next.hash}`,
			)
		: currentCanAutoStart;
	return { url: next, source, canAutoStart };
}

function effectivePort(url: URL): number {
	if (url.port) return Number.parseInt(url.port, 10);
	return url.protocol === "wss:" ? 443 : 80;
}

function normalizedHostname(url: URL): string {
	return url.hostname
		.replace(/^\[|\]$/gu, "")
		.replace(/\.$/u, "")
		.toLowerCase();
}

export function classifyBridgeUrl(value: string): BridgeUrlLocality {
	const url = parseConnectionUrl(value, "bridge URL", "<bridge URL>");
	const hostname = normalizedHostname(url);
	if (hostname === "localhost" || hostname === "::1") return "loopback";
	const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
	if (ipv4 && Number.parseInt(ipv4[1], 10) === 127) return "loopback";
	return "remote";
}

function literalBridgeHostname(value: string): string | undefined {
	const match = value.trim().match(/^ws:\/\/(\[[^\]]+\]|[^:/?#]+)(?::\d+)?(?:[/?#]|$)/iu);
	if (!match) return undefined;
	const authorityHost = match[1].toLowerCase();
	if (authorityHost.startsWith("[") && authorityHost.endsWith("]")) {
		return authorityHost.slice(1, -1);
	}
	return authorityHost === "localhost." ? "localhost" : authorityHost;
}

/**
 * Automatic startup is intentionally narrower than generic loopback locality.
 * TLS endpoints require externally managed certificates, and aliases such as
 * other 127/8 addresses must never be turned into implicit listeners.
 */
export function isBridgeUrlSafeForAutoStart(value: string): boolean {
	const url = parseConnectionUrl(value, "bridge URL", "<bridge URL>");
	if (url.protocol !== "ws:") return false;
	if (url.pathname !== "/ws" || url.search || url.hash || value.includes("?") || value.includes("#")) return false;
	const literalHostname = literalBridgeHostname(value);
	if (literalHostname !== "localhost" && literalHostname !== "127.0.0.1" && literalHostname !== "::1") {
		return false;
	}
	return normalizedHostname(url) === literalHostname;
}

function pickString(values: readonly [string | undefined, ConfigValueSource][]): {
	value: string;
	source: ConfigValueSource;
} {
	for (const [candidate, source] of values) {
		const value = nonEmpty(candidate);
		if (value !== undefined) return { value, source };
	}
	return { value: "", source: "defaults" };
}

function resolveBridgeToken(
	flagsToken: string | undefined,
	environmentToken: string | undefined,
	fileToken: string | undefined,
	defaultToken: string,
	configPath: string,
): { value: string; source: ConfigValueSource } {
	if (flagsToken !== undefined) {
		return {
			value: requireNonEmptyOverride(flagsToken, "flag bridge token", configPath),
			source: "flags",
		};
	}
	if (environmentToken !== undefined) {
		return {
			value: requireNonEmptyOverride(environmentToken, "SHUVGEIST_BRIDGE_TOKEN", configPath),
			source: "environment",
		};
	}
	return pickString([
		[fileToken, "file"],
		[defaultToken, "defaults"],
	]);
}

export function resolveBridgeConnection(options: ResolveBridgeConnectionOptions = {}): ResolvedBridgeConnection {
	const flags = options.flags ?? {};
	const env = options.env ?? {};
	const configPath = options.configPath ?? "<bridge config>";
	const file = parseBridgeNodeConfig(options.file ?? {}, configPath);
	const providedDefaults = options.defaults ?? {};
	const defaults: BridgeConnectionDefaults = {
		...(providedDefaults.url === undefined ? {} : { url: providedDefaults.url }),
		host: providedDefaults.host ?? DEFAULT_BRIDGE_CONNECTION.host,
		port: providedDefaults.port ?? DEFAULT_BRIDGE_CONNECTION.port,
		token: providedDefaults.token ?? DEFAULT_BRIDGE_CONNECTION.token,
	};

	const defaultPort = parsePort(defaults.port, "default bridge port", configPath);
	const defaultHost = normalizeHost(defaults.host, "default bridge host", configPath);
	const defaultUrlValue =
		defaults.url !== undefined
			? requireNonEmptyOverride(defaults.url, "default bridge URL", configPath)
			: `ws://${defaultHost.includes(":") ? `[${defaultHost}]` : defaultHost}:${defaultPort}/ws`;
	let resolvedUrl = parseConnectionUrl(defaultUrlValue, "default bridge URL", configPath);
	let canAutoStart = isBridgeUrlSafeForAutoStart(defaultUrlValue);
	let urlSource: ConfigValueSource = "defaults";

	if (file.url !== undefined) {
		resolvedUrl = parseConnectionUrl(file.url, "file bridge URL", configPath);
		canAutoStart = isBridgeUrlSafeForAutoStart(file.url);
		urlSource = "file";
	}

	const environmentLayer = applyUrlLayer(
		resolvedUrl,
		canAutoStart,
		{
			url: env.SHUVGEIST_BRIDGE_URL,
			host: env.SHUVGEIST_BRIDGE_HOST,
			port: env.SHUVGEIST_BRIDGE_PORT,
		},
		"environment",
		configPath,
	);
	if (environmentLayer.source !== "defaults") {
		resolvedUrl = environmentLayer.url;
		canAutoStart = environmentLayer.canAutoStart;
		urlSource = environmentLayer.source;
	}

	const flagLayer = applyUrlLayer(resolvedUrl, canAutoStart, flags, "flags", configPath);
	if (flagLayer.source !== "defaults") {
		resolvedUrl = flagLayer.url;
		canAutoStart = flagLayer.canAutoStart;
		urlSource = flagLayer.source;
	}

	const token = resolveBridgeToken(flags.token, env.SHUVGEIST_BRIDGE_TOKEN, file.token, defaults.token, configPath);
	const url = resolvedUrl.toString();
	const locality = classifyBridgeUrl(url);
	return {
		url,
		token: token.value,
		host: normalizedHostname(resolvedUrl),
		port: effectivePort(resolvedUrl),
		locality,
		canAutoStart,
		configPath,
		sources: { url: urlSource, token: token.source },
	};
}

export function resolveBridgeServeBinding(options: ResolveBridgeServeBindingOptions = {}): ResolvedBridgeServeBinding {
	const flags = options.flags ?? {};
	const env = options.env ?? {};
	const configPath = options.configPath ?? "<bridge config>";
	const file = parseBridgeNodeConfig(options.file ?? {}, configPath);
	const providedDefaults = options.defaults ?? {};
	const defaults: BridgeServeDefaults = {
		host: providedDefaults.host ?? DEFAULT_BRIDGE_SERVE_BINDING.host,
		port: providedDefaults.port ?? DEFAULT_BRIDGE_SERVE_BINDING.port,
		token: providedDefaults.token ?? DEFAULT_BRIDGE_SERVE_BINDING.token,
	};

	let host = normalizeHost(defaults.host, "default serve host", configPath);
	let hostSource: ConfigValueSource = "defaults";
	if (file.serve?.host !== undefined) {
		host = normalizeHost(file.serve.host, "file serve host", configPath);
		hostSource = "file";
	}
	if (env.SHUVGEIST_BRIDGE_HOST !== undefined) {
		host = normalizeHost(
			requireNonEmptyOverride(env.SHUVGEIST_BRIDGE_HOST, "environment serve host", configPath),
			"environment serve host",
			configPath,
		);
		hostSource = "environment";
	}
	if (flags.host !== undefined) {
		host = normalizeHost(
			requireNonEmptyOverride(flags.host, "flag serve host", configPath),
			"flag serve host",
			configPath,
		);
		hostSource = "flags";
	}

	let port = parsePort(defaults.port, "default serve port", configPath);
	let portSource: ConfigValueSource = "defaults";
	if (file.serve?.port !== undefined) {
		port = parsePort(file.serve.port, "file serve port", configPath);
		portSource = "file";
	}
	if (env.SHUVGEIST_BRIDGE_PORT !== undefined) {
		port = parsePort(env.SHUVGEIST_BRIDGE_PORT, "environment serve port", configPath);
		portSource = "environment";
	}
	if (flags.port !== undefined) {
		port = parsePort(flags.port, "flag serve port", configPath);
		portSource = "flags";
	}

	const token = resolveBridgeToken(flags.token, env.SHUVGEIST_BRIDGE_TOKEN, file.token, defaults.token, configPath);
	return {
		host,
		port,
		token: token.value,
		configPath,
		sources: { host: hostSource, port: portSource, token: token.source },
	};
}

function parseBooleanOverride(value: string, label: string, configPath: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	throw new NodeConfigError(
		"INVALID_OVERRIDE",
		configPath,
		`Invalid ${label}: expected one of 1, true, yes, on, 0, false, no, or off; received ${JSON.stringify(value)}.`,
	);
}

function validateOtelIngestUrl(value: string, label: string, configPath: string): string {
	const normalized = requireNonEmptyOverride(value, label, configPath);
	try {
		parseUrl(normalized, { kind: "bridge", path: configPath }, label, ["http:", "https:"]);
		return normalized;
	} catch (error) {
		if (error instanceof NodeConfigError) {
			throw new NodeConfigError("INVALID_OVERRIDE", configPath, error.message, error);
		}
		throw error;
	}
}

export function resolveNodeOtelConfig(options: ResolveNodeOtelConfigOptions = {}): ResolvedNodeOtelConfig {
	const env = options.env ?? {};
	const configPath = options.configPath ?? "<bridge config>";
	const file = parseBridgeNodeConfig(options.file ?? {}, configPath);
	const providedDefaults = options.defaults ?? {};
	const defaults: NodeOtelDefaults = {
		enabled: providedDefaults.enabled ?? DEFAULT_NODE_OTEL_CONFIG.enabled,
		ingestUrl: providedDefaults.ingestUrl ?? DEFAULT_NODE_OTEL_CONFIG.ingestUrl,
		privateIngestKey: providedDefaults.privateIngestKey ?? DEFAULT_NODE_OTEL_CONFIG.privateIngestKey,
	};
	if (typeof defaults.enabled !== "boolean") {
		throw new NodeConfigError(
			"INVALID_OVERRIDE",
			configPath,
			"Invalid default OTEL enabled value: expected a boolean.",
		);
	}
	if (typeof defaults.privateIngestKey !== "string") {
		throw new NodeConfigError(
			"INVALID_OVERRIDE",
			configPath,
			"Invalid default OTEL private ingest key: expected a string.",
		);
	}

	let enabled = defaults.enabled;
	let enabledSource: ConfigValueSource = "defaults";
	if (file.otel?.enabled !== undefined) {
		enabled = file.otel.enabled;
		enabledSource = "file";
	}
	if (env.SHUVGEIST_OTEL_ENABLED !== undefined) {
		enabled = parseBooleanOverride(env.SHUVGEIST_OTEL_ENABLED, "SHUVGEIST_OTEL_ENABLED", configPath);
		enabledSource = "environment";
	}

	let ingestUrl = validateOtelIngestUrl(defaults.ingestUrl, "default OTEL ingest URL", configPath);
	let ingestUrlSource: ConfigValueSource = "defaults";
	if (file.otel?.ingestUrl !== undefined) {
		ingestUrl = file.otel.ingestUrl;
		ingestUrlSource = "file";
	}
	if (env.SHUVGEIST_OTEL_INGEST_URL !== undefined) {
		ingestUrl = validateOtelIngestUrl(env.SHUVGEIST_OTEL_INGEST_URL, "SHUVGEIST_OTEL_INGEST_URL", configPath);
		ingestUrlSource = "environment";
	}

	let privateIngestKey = defaults.privateIngestKey;
	let privateIngestKeySource: ConfigValueSource = "defaults";
	if (file.otel?.privateIngestKey !== undefined) {
		privateIngestKey = file.otel.privateIngestKey;
		privateIngestKeySource = "file";
	}
	if (env.SHUVGEIST_OTEL_PRIVATE_INGEST_KEY !== undefined) {
		privateIngestKey = env.SHUVGEIST_OTEL_PRIVATE_INGEST_KEY;
		privateIngestKeySource = "environment";
	}

	return {
		enabled,
		ingestUrl,
		privateIngestKey,
		configPath,
		sources: {
			enabled: enabledSource,
			ingestUrl: ingestUrlSource,
			privateIngestKey: privateIngestKeySource,
		},
	};
}

function collectDiscoveryCandidates(
	values: readonly [string | undefined, ConfigValueSource, string][],
	configPath: string,
): DiscoveryCandidate[] {
	const candidates: DiscoveryCandidate[] = [];
	const seen = new Set<string>();
	for (const [candidate, source, label] of values) {
		if (candidate === undefined) continue;
		const value = requireNonEmptyOverride(candidate, label, configPath);
		if (seen.has(value)) continue;
		seen.add(value);
		candidates.push({ value, source });
	}
	return candidates;
}

export function resolveDiscoveryCandidates(
	options: ResolveDiscoveryPreferencesOptions = {},
): ResolvedDiscoveryCandidates {
	const flags = options.flags ?? {};
	const env = options.env ?? {};
	const configPath = options.configPath ?? "<discovery config>";
	const file = parseDiscoveryNodeConfig(options.file ?? {}, configPath);
	const defaults = options.defaults ?? {};
	return {
		extensionPath: collectDiscoveryCandidates(
			[
				[flags.extensionPath, "flags", "flag extension path"],
				[env.SHUVGEIST_EXTENSION_PATH, "environment", "SHUVGEIST_EXTENSION_PATH"],
				[file.extensionPath, "file", "file extension path"],
				[defaults.extensionPath, "defaults", "default extension path"],
			],
			configPath,
		),
		browser: collectDiscoveryCandidates(
			[
				[flags.browser, "flags", "flag browser"],
				[env.SHUVGEIST_BROWSER, "environment", "SHUVGEIST_BROWSER"],
				[file.browser, "file", "file browser"],
				[defaults.browser, "defaults", "default browser"],
			],
			configPath,
		),
	};
}

export function resolveDiscoveryPreferences(
	options: ResolveDiscoveryPreferencesOptions = {},
): ResolvedDiscoveryPreferences {
	const candidates = resolveDiscoveryCandidates(options);
	const extensionPath = candidates.extensionPath[0];
	const browser = candidates.browser[0];
	return {
		...(extensionPath ? { extensionPath: extensionPath.value } : {}),
		...(browser ? { browser: browser.value } : {}),
		sources: {
			...(extensionPath ? { extensionPath: extensionPath.source } : {}),
			...(browser ? { browser: browser.source } : {}),
		},
	};
}

export function createNodeConfigOwner(dependencies: NodeConfigDependencies = {}): NodeConfigOwner {
	const fs = dependencies.fs ?? DEFAULT_FILE_SYSTEM;
	const env = dependencies.env ?? process.env;
	const homeDirectory = dependencies.homeDirectory ?? nodeHomeDirectory();
	const currentWorkingDirectory = dependencies.currentWorkingDirectory ?? process.cwd();
	const defaultDirectory = join(homeDirectory, ".shuvgeist");
	const resolveCustomPath = (value: string, label: string) => {
		const configuredPath = requireNonEmptyOverride(value, label, "<environment>");
		return isAbsolute(configuredPath) ? configuredPath : resolve(currentWorkingDirectory, configuredPath);
	};
	const bridgePath =
		env.SHUVGEIST_BRIDGE_CONFIG === undefined
			? join(defaultDirectory, "bridge.json")
			: resolveCustomPath(env.SHUVGEIST_BRIDGE_CONFIG, "SHUVGEIST_BRIDGE_CONFIG");
	const discoveryPathOverride = env.SHUVGEIST_CONFIG ?? env.SHUVGEIST_DISCOVERY_CONFIG;
	const discoveryPathLabel = env.SHUVGEIST_CONFIG === undefined ? "SHUVGEIST_DISCOVERY_CONFIG" : "SHUVGEIST_CONFIG";
	const discoveryPath =
		discoveryPathOverride === undefined
			? join(defaultDirectory, "config.json")
			: resolveCustomPath(discoveryPathOverride, discoveryPathLabel);
	const paths: NodeConfigPaths = Object.freeze({
		bridge: bridgePath,
		discovery: discoveryPath,
	});
	const processId = dependencies.processId ?? process.pid;
	const now = dependencies.now ?? Date.now;
	const random = dependencies.random ?? Math.random;
	let writeSequence = 0;
	const nextTempSuffix = () => {
		writeSequence++;
		const randomPart = Math.floor(Math.abs(random()) * 0x1_0000_0000)
			.toString(16)
			.padStart(8, "0");
		return `${processId}.${now()}.${writeSequence}.${randomPart}`;
	};

	const readBridgeConfig = () => readConfigFile(paths.bridge, "bridge", fs, parseBridgeNodeConfig);
	const readDiscoveryConfig = () => readConfigFile(paths.discovery, "discovery", fs, parseDiscoveryNodeConfig);
	const writeBridgeConfig = (config: BridgeNodeConfig) => {
		const parsed = parseBridgeNodeConfig(config, paths.bridge);
		atomicWriteJson(paths.bridge, parsed, fs, nextTempSuffix());
	};
	const writeDiscoveryConfig = (config: DiscoveryNodeConfig) => {
		const parsed = parseDiscoveryNodeConfig(config, paths.discovery);
		atomicWriteJson(paths.discovery, parsed, fs, nextTempSuffix());
	};

	return {
		paths,
		readBridgeConfig,
		readDiscoveryConfig,
		writeBridgeConfig,
		writeDiscoveryConfig,
		updateBridgeConfig(patch) {
			const context: SchemaContext = { kind: "bridge", path: paths.bridge };
			assertJsonValue(patch, context);
			const next = parseBridgeNodeConfig(deepMerge(readBridgeConfig(), patch), paths.bridge);
			atomicWriteJson(paths.bridge, next, fs, nextTempSuffix());
			return next;
		},
		updateDiscoveryConfig(patch) {
			const context: SchemaContext = { kind: "discovery", path: paths.discovery };
			assertJsonValue(patch, context);
			const next = parseDiscoveryNodeConfig(deepMerge(readDiscoveryConfig(), patch), paths.discovery);
			atomicWriteJson(paths.discovery, next, fs, nextTempSuffix());
			return next;
		},
		resolveBridgeConnection(flags = {}, defaults = {}) {
			return resolveBridgeConnection({ flags, env, file: readBridgeConfig(), defaults, configPath: paths.bridge });
		},
		resolveBridgeServeBinding(flags = {}, defaults = {}) {
			return resolveBridgeServeBinding({ flags, env, file: readBridgeConfig(), defaults, configPath: paths.bridge });
		},
		resolveOtelConfig(defaults = {}) {
			return resolveNodeOtelConfig({ env, file: readBridgeConfig(), defaults, configPath: paths.bridge });
		},
		resolveDiscoveryCandidates(flags = {}, defaults = {}) {
			return resolveDiscoveryCandidates({
				flags,
				env,
				file: readDiscoveryConfig(),
				defaults,
				configPath: paths.discovery,
			});
		},
		resolveDiscoveryPreferences(flags = {}, defaults = {}) {
			return resolveDiscoveryPreferences({
				flags,
				env,
				file: readDiscoveryConfig(),
				defaults,
				configPath: paths.discovery,
			});
		},
	};
}
