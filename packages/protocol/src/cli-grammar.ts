export type CliFlagKind = "boolean" | "string" | "string-list";

export interface CliFlagDefinitionShape {
	readonly names: readonly [string, ...string[]];
	readonly key: string;
	readonly kind: CliFlagKind;
}

/** Runtime-neutral spelling and value grammar for every supported CLI flag. */
export const CliFlagDefinitions = [
	{ names: ["--json"], key: "json", kind: "boolean" },
	{ names: ["--new-tab"], key: "newTab", kind: "boolean" },
	{ names: ["--dry-run"], key: "dryRun", kind: "boolean" },
	{ names: ["--yes"], key: "yes", kind: "boolean" },
	{ names: ["--include-pinned"], key: "includePinned", kind: "boolean" },
	{ names: ["--include-protected"], key: "includeProtected", kind: "boolean" },
	{ names: ["--require-match"], key: "requireMatch", kind: "boolean" },
	{ names: ["--follow"], key: "follow", kind: "boolean" },
	{ names: ["--include-hidden"], key: "includeHidden", kind: "boolean" },
	{ names: ["--include-sensitive"], key: "includeSensitive", kind: "boolean" },
	{ names: ["--no-viewport-json"], key: "noViewportJson", kind: "boolean" },
	{ names: ["--exact"], key: "exact", kind: "boolean" },
	{ names: ["--visible"], key: "visible", kind: "boolean" },
	{ names: ["--enabled"], key: "enabled", kind: "boolean" },
	{ names: ["--native"], key: "native", kind: "boolean" },
	{ names: ["--trusted", "--cdp-input"], key: "trusted", kind: "boolean" },
	{ names: ["--mobile"], key: "mobile", kind: "boolean" },
	{ names: ["--touch"], key: "touch", kind: "boolean" },
	{ names: ["--inspect-main"], key: "inspectMain", kind: "boolean" },
	{ names: ["--use-default-profile"], key: "useDefaultProfile", kind: "boolean" },
	{ names: ["--headless"], key: "headless", kind: "boolean" },
	{ names: ["--foreground"], key: "foreground", kind: "boolean" },
	{ names: ["--url"], key: "url", kind: "string" },
	{ names: ["--host"], key: "host", kind: "string" },
	{ names: ["--port"], key: "port", kind: "string" },
	{ names: ["--token"], key: "token", kind: "string" },
	{ names: ["--timeout"], key: "timeout", kind: "string" },
	{ names: ["--interval"], key: "interval", kind: "string" },
	{ names: ["--out"], key: "out", kind: "string" },
	{ names: ["--max-width"], key: "maxWidth", kind: "string" },
	{ names: ["--max-height"], key: "maxHeight", kind: "string" },
	{ names: ["--write-files"], key: "writeFiles", kind: "string" },
	{ names: ["--last"], key: "last", kind: "string" },
	{ names: ["--role"], key: "role", kind: "string" },
	{ names: ["--inline"], key: "inline", kind: "string" },
	{ names: ["--arg"], key: "arg", kind: "string-list" },
	{ names: ["--tab-id"], key: "tabId", kind: "string" },
	{ names: ["--frame-id"], key: "frameId", kind: "string" },
	{ names: ["--target"], key: "target", kind: "string" },
	{ names: ["--pid"], key: "pid", kind: "string" },
	{ names: ["--inspect-port"], key: "inspectPort", kind: "string" },
	{ names: ["--channel"], key: "channel", kind: "string" },
	{ names: ["--source-path"], key: "sourcePath", kind: "string" },
	{ names: ["--extract-to"], key: "extractTo", kind: "string" },
	{ names: ["--max-entries"], key: "maxEntries", kind: "string" },
	{ names: ["--limit"], key: "limit", kind: "string" },
	{ names: ["--min-score"], key: "minScore", kind: "string" },
	{ names: ["--name"], key: "name", kind: "string" },
	{ names: ["--value"], key: "value", kind: "string" },
	{ names: ["--world"], key: "world", kind: "string" },
	{ names: ["--count"], key: "count", kind: "string" },
	{ names: ["--min-count"], key: "minCount", kind: "string" },
	{ names: ["--max-count"], key: "maxCount", kind: "string" },
	{ names: ["--url-pattern"], key: "urlPattern", kind: "string" },
	{ names: ["--title-match"], key: "titleMatch", kind: "string" },
	{ names: ["--url-match"], key: "urlMatch", kind: "string" },
	{ names: ["--title-pattern"], key: "titlePattern", kind: "string" },
	{ names: ["--window-id"], key: "windowId", kind: "string" },
	{ names: ["--search"], key: "search", kind: "string" },
	{ names: ["--preset"], key: "preset", kind: "string" },
	{ names: ["--width"], key: "width", kind: "string" },
	{ names: ["--height"], key: "height", kind: "string" },
	{ names: ["--dpr"], key: "dpr", kind: "string" },
	{ names: ["--user-agent"], key: "userAgent", kind: "string" },
	{ names: ["--auto-stop"], key: "autoStop", kind: "string" },
	{ names: ["--max-duration"], key: "maxDuration", kind: "string" },
	{ names: ["--fps"], key: "fps", kind: "string" },
	{ names: ["--quality"], key: "quality", kind: "string" },
	{ names: ["--video-bitrate"], key: "videoBitrate", kind: "string" },
	{ names: ["--mime-type"], key: "mimeType", kind: "string" },
	{ names: ["--browser"], key: "browser", kind: "string" },
	{ names: ["--extension-path"], key: "extensionPath", kind: "string" },
	{ names: ["--profile"], key: "profile", kind: "string" },
	{ names: ["--user-data-dir"], key: "userDataDir", kind: "string" },
	{ names: ["--file", "-f"], key: "file", kind: "string" },
] as const satisfies readonly CliFlagDefinitionShape[];

export type CliFlagDefinition = (typeof CliFlagDefinitions)[number];
export type CliFlagKey = CliFlagDefinition["key"];
type CliFlagDefinitionFor<K extends CliFlagKey> = Extract<CliFlagDefinition, { key: K }>;
type CliFlagValueFor<K extends CliFlagKey> = CliFlagDefinitionFor<K>["kind"] extends "boolean"
	? boolean
	: CliFlagDefinitionFor<K>["kind"] extends "string-list"
		? string[]
		: string;

export type CliFlags = {
	[K in CliFlagKey]?: CliFlagValueFor<K>;
};

export type CliValueParser = "string" | "integer" | "number" | "boolean" | "duration" | "json";

export interface CliFlagBinding {
	flag: CliFlagKey;
	/** Named codec input. Defaults to the flag key. */
	input?: string;
	/** Direct bridge-param path for generic materialization. */
	param?: string;
	parse?: CliValueParser;
}

export interface CliPositionalBinding {
	name: string;
	source: "index" | "rest";
	index: number;
	/** Named codec input. Defaults to the positional name. */
	input?: string;
	/** Direct bridge-param path for generic materialization. */
	param?: string;
	parse?: CliValueParser;
	required?: boolean;
	join?: "space" | "array";
}

export interface CliBinding {
	family: string;
	/** Subcommand tokens consumed before positional binding. */
	select: readonly string[];
	aliases?: readonly (readonly string[])[];
	/** Use this binding when the family is invoked without subcommands. */
	default?: boolean;
	usage: string;
	flags: readonly CliFlagBinding[];
	positionals: readonly CliPositionalBinding[];
	constants?: Readonly<Record<string, string | number | boolean | null>>;
	/** Runtime-neutral identifier for parameter construction and legacy validation. */
	codec: string;
	/** Runtime-neutral identifier for non-generic CLI execution/output behavior. */
	runner?: string;
}

export type CliNoExposureReason =
	| "shadowed-by-local-command"
	| "extension-internal"
	| "server-internal"
	| "not-user-facing";

export type CliExposure =
	| { kind: "none"; reason: CliNoExposureReason }
	| { kind: "bridge"; bindings: readonly CliBinding[] };

export function defineCliBinding<const Binding extends CliBinding>(binding: Binding): Binding {
	return binding;
}

export function bridgeCli<const Bindings extends readonly CliBinding[]>(
	...bindings: Bindings
): { kind: "bridge"; bindings: Bindings } {
	return { kind: "bridge", bindings };
}

export function noCli<const Reason extends CliNoExposureReason>(reason: Reason): { kind: "none"; reason: Reason } {
	return { kind: "none", reason };
}

export function cliFlag<const Flag extends CliFlagKey>(flag: Flag): { flag: Flag };
export function cliFlag<const Flag extends CliFlagKey, const Options extends Omit<CliFlagBinding, "flag">>(
	flag: Flag,
	options: Options,
): { flag: Flag } & Options;
export function cliFlag(flag: CliFlagKey, options: Omit<CliFlagBinding, "flag"> = {}): CliFlagBinding {
	return { flag, ...options };
}

export function cliPositional<const Name extends string, const Options extends Omit<CliPositionalBinding, "name">>(
	name: Name,
	options: Options,
): { name: Name } & Options {
	return { name, ...options };
}

export const GlobalCliFlagKeys = [
	"json",
	"url",
	"host",
	"port",
	"token",
	"timeout",
] as const satisfies readonly CliFlagKey[];

/** CLI-local commands that never correspond to a bridge protocol method. */
export const LocalCliCommandDefinitions = [
	{
		family: "status",
		usage: "Usage: shuvgeist status",
		flags: [],
		positionals: [],
		codec: "local-status",
	},
	{
		family: "serve",
		usage: "Usage: shuvgeist serve [--host host] [--port port] [--token token]",
		flags: [cliFlag("host"), cliFlag("port"), cliFlag("token")],
		positionals: [],
		codec: "local-serve",
	},
	{
		family: "launch",
		usage: "Usage: shuvgeist launch [url] [browser options]",
		flags: [
			cliFlag("browser"),
			cliFlag("extensionPath"),
			cliFlag("profile"),
			cliFlag("userDataDir"),
			cliFlag("useDefaultProfile"),
			cliFlag("url"),
			cliFlag("headless"),
			cliFlag("foreground"),
		],
		positionals: [cliPositional("url", { source: "index", index: 0 })],
		codec: "local-launch",
	},
	{
		family: "close",
		usage: "Usage: shuvgeist close",
		flags: [],
		positionals: [],
		codec: "local-close",
	},
] as const;

/** Commands handled before the bridge argv tokenizer and planner run. */
export const PreParserCliCommandDefinitions = [
	{
		family: "help",
		tokens: ["<no-arguments>", "--help", "-h"],
		usage: "shuvgeist [--help|-h]",
		reason: "top-level usage output",
	},
	{
		family: "version",
		tokens: ["--version", "-v"],
		usage: "shuvgeist [--version|-v]",
		reason: "version output",
	},
	{
		family: "skill",
		tokens: ["skill"],
		usage: "shuvgeist skill <install|path> [--force] [--json]",
		reason: "local skill installation and path lookup",
	},
] as const;
