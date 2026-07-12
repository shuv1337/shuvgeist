export type BridgeCommandRoute = "extension" | "server-local";
export type BridgeCommandTimeout = "request" | "slow" | "workflow" | "trace" | "none";
export type BridgeCommandTargetKind = "chrome-tab" | "electron-window";

export interface BridgeCommandMetadata {
	method: string;
	capabilities: readonly string[];
	route: BridgeCommandRoute;
	cliCommands?: readonly string[];
	defaultTimeout?: BridgeCommandTimeout;
	sensitive?: boolean;
	write?: boolean;
}

export const BridgeCommandCatalog = [
	{
		method: "status",
		capabilities: ["status"],
		route: "extension",
		cliCommands: ["status"],
		defaultTimeout: "request",
	},
	{
		method: "navigate",
		capabilities: ["navigate", "tabs"],
		route: "extension",
		// tabs close / windows list|close also map to navigate
		cliCommands: ["navigate", "tabs", "switch", "windows"],
		defaultTimeout: "request",
	},
	{ method: "repl", capabilities: ["repl"], route: "extension", cliCommands: ["repl"], defaultTimeout: "slow" },
	{
		method: "screenshot",
		capabilities: ["screenshot"],
		route: "extension",
		cliCommands: ["screenshot"],
		defaultTimeout: "slow",
	},
	{
		method: "eval",
		capabilities: ["eval"],
		route: "extension",
		cliCommands: ["eval"],
		defaultTimeout: "slow",
		sensitive: true,
	},
	{
		method: "cookies",
		capabilities: ["cookies"],
		route: "extension",
		cliCommands: ["cookies"],
		defaultTimeout: "slow",
		sensitive: true,
	},
	{
		method: "cookie_import",
		capabilities: ["cookie_import"],
		route: "server-local",
		defaultTimeout: "slow",
		sensitive: true,
	},
	{
		method: "cookie_import_apply",
		capabilities: ["cookie_import_apply"],
		route: "extension",
		defaultTimeout: "slow",
		sensitive: true,
	},
	{
		method: "select_element",
		capabilities: ["select_element"],
		route: "extension",
		cliCommands: ["select"],
		defaultTimeout: "none",
	},
	{
		method: "workflow_run",
		capabilities: ["workflow_run"],
		route: "extension",
		cliCommands: ["workflow"],
		defaultTimeout: "workflow",
	},
	{
		method: "workflow_validate",
		capabilities: ["workflow_validate"],
		route: "extension",
		cliCommands: ["workflow"],
		defaultTimeout: "workflow",
	},
	{
		method: "page_snapshot",
		capabilities: ["page_snapshot"],
		route: "extension",
		cliCommands: ["snapshot"],
		defaultTimeout: "slow",
	},
	{
		method: "snapshot_store",
		capabilities: ["snapshot_store"],
		route: "server-local",
		defaultTimeout: "slow",
	},
	{
		method: "snapshot_read",
		capabilities: ["snapshot_read"],
		route: "server-local",
		defaultTimeout: "request",
	},
	{
		method: "page_assert",
		capabilities: ["page_assert"],
		route: "extension",
		cliCommands: ["assert"],
		defaultTimeout: "request",
	},
	{
		method: "locate_by_role",
		capabilities: ["locate_by_role"],
		route: "extension",
		cliCommands: ["locate"],
		defaultTimeout: "request",
	},
	{
		method: "locate_by_text",
		capabilities: ["locate_by_text"],
		route: "extension",
		cliCommands: ["locate"],
		defaultTimeout: "request",
	},
	{
		method: "locate_by_label",
		capabilities: ["locate_by_label"],
		route: "extension",
		cliCommands: ["locate"],
		defaultTimeout: "request",
	},
	{
		method: "ref_click",
		capabilities: ["ref_click"],
		route: "extension",
		cliCommands: ["ref"],
		defaultTimeout: "request",
	},
	{
		method: "ref_fill",
		capabilities: ["ref_fill"],
		route: "extension",
		cliCommands: ["ref"],
		defaultTimeout: "request",
	},
	{
		method: "frame_list",
		capabilities: ["frame_list"],
		route: "extension",
		cliCommands: ["frame"],
		defaultTimeout: "request",
	},
	{
		method: "frame_tree",
		capabilities: ["frame_tree"],
		route: "extension",
		cliCommands: ["frame"],
		defaultTimeout: "request",
	},
	{
		method: "network_start",
		capabilities: ["network_start"],
		route: "extension",
		cliCommands: ["network"],
		defaultTimeout: "request",
	},
	{
		method: "network_stop",
		capabilities: ["network_stop"],
		route: "extension",
		cliCommands: ["network"],
		defaultTimeout: "request",
	},
	{
		method: "network_list",
		capabilities: ["network_list"],
		route: "extension",
		cliCommands: ["network"],
		defaultTimeout: "request",
	},
	{
		method: "network_clear",
		capabilities: ["network_clear"],
		route: "extension",
		cliCommands: ["network"],
		defaultTimeout: "request",
	},
	{
		method: "network_stats",
		capabilities: ["network_stats"],
		route: "extension",
		cliCommands: ["network"],
		defaultTimeout: "request",
	},
	{
		method: "network_get",
		capabilities: ["network_get"],
		route: "extension",
		cliCommands: ["network"],
		defaultTimeout: "request",
		sensitive: true,
	},
	{
		method: "network_body",
		capabilities: ["network_body"],
		route: "extension",
		cliCommands: ["network"],
		defaultTimeout: "request",
		sensitive: true,
	},
	{
		method: "network_curl",
		capabilities: ["network_curl"],
		route: "extension",
		cliCommands: ["network"],
		defaultTimeout: "request",
		sensitive: true,
	},
	{
		method: "device_emulate",
		capabilities: ["device_emulate"],
		route: "extension",
		cliCommands: ["device"],
		defaultTimeout: "request",
	},
	{
		method: "device_reset",
		capabilities: ["device_reset"],
		route: "extension",
		cliCommands: ["device"],
		defaultTimeout: "request",
	},
	{
		method: "perf_metrics",
		capabilities: ["perf_metrics"],
		route: "extension",
		cliCommands: ["perf"],
		defaultTimeout: "request",
	},
	{
		method: "perf_trace_start",
		capabilities: ["perf_trace_start"],
		route: "extension",
		cliCommands: ["perf"],
		defaultTimeout: "trace",
	},
	{
		method: "perf_trace_stop",
		capabilities: ["perf_trace_stop"],
		route: "extension",
		cliCommands: ["perf"],
		defaultTimeout: "trace",
	},
	{
		method: "record_start",
		capabilities: ["record_start"],
		route: "extension",
		cliCommands: ["record"],
		defaultTimeout: "none",
		sensitive: true,
	},
	{
		method: "record_stop",
		capabilities: ["record_stop"],
		route: "extension",
		cliCommands: ["record"],
		defaultTimeout: "request",
		sensitive: true,
	},
	{
		method: "record_status",
		capabilities: ["record_status"],
		route: "extension",
		cliCommands: ["record"],
		defaultTimeout: "request",
		sensitive: true,
	},
	{
		method: "session_history",
		capabilities: ["session_history"],
		route: "extension",
		cliCommands: ["session"],
		defaultTimeout: "request",
	},
	{
		method: "session_inject",
		capabilities: ["session_inject"],
		route: "extension",
		cliCommands: ["inject"],
		defaultTimeout: "request",
		write: true,
	},
	{
		method: "session_new",
		capabilities: ["session_new"],
		route: "extension",
		cliCommands: ["new-session"],
		defaultTimeout: "request",
		write: true,
	},
	{
		method: "session_set_model",
		capabilities: ["session_set_model"],
		route: "extension",
		cliCommands: ["set-model"],
		defaultTimeout: "request",
		write: true,
	},
	{
		method: "session_artifacts",
		capabilities: ["session_artifacts"],
		route: "extension",
		cliCommands: ["artifacts"],
		defaultTimeout: "request",
	},
	{
		method: "electron_list",
		capabilities: ["electron_list"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
	{
		method: "electron_allow",
		capabilities: ["electron_allow"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
	{
		method: "electron_launch",
		capabilities: ["electron_launch"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "slow",
	},
	{
		method: "electron_attach",
		capabilities: ["electron_attach"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
	{
		method: "electron_detach",
		capabilities: ["electron_detach"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
	{
		method: "electron_windows",
		capabilities: ["electron_windows"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
	{
		method: "electron_label",
		capabilities: ["electron_label"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
	{
		method: "electron_main_info",
		capabilities: ["electron_main_info"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
	{
		method: "electron_ipc_tap_start",
		capabilities: ["electron_ipc_tap_start"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
	{
		method: "electron_ipc_tap_stop",
		capabilities: ["electron_ipc_tap_stop"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
	{
		method: "electron_main_network_start",
		capabilities: ["electron_main_network_start"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
	{
		method: "electron_main_network_stop",
		capabilities: ["electron_main_network_stop"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
	{
		method: "electron_source_layout",
		capabilities: ["electron_source_layout"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
	{
		method: "electron_source_list",
		capabilities: ["electron_source_list"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
	{
		method: "electron_source_read",
		capabilities: ["electron_source_read"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
	{
		method: "electron_source_extract",
		capabilities: ["electron_source_extract"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "slow",
	},
	{
		method: "electron_doctor",
		capabilities: ["electron_doctor"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "slow",
	},
	{
		method: "electron_auto_attach",
		capabilities: ["electron_auto_attach"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
	{
		method: "skills_snapshot_status",
		capabilities: ["skills_snapshot_status"],
		route: "server-local",
		cliCommands: ["electron"],
		defaultTimeout: "request",
	},
] as const satisfies readonly BridgeCommandMetadata[];

export type CatalogBridgeMethod = (typeof BridgeCommandCatalog)[number]["method"];
export type CatalogBridgeCapability = (typeof BridgeCommandCatalog)[number]["capabilities"][number];

export const CatalogBridgeMethods = BridgeCommandCatalog.map((entry) => entry.method) as CatalogBridgeMethod[];
export const CatalogBridgeCapabilities = BridgeCommandCatalog.flatMap(
	(entry) => entry.capabilities,
) as CatalogBridgeCapability[];

const BridgeCommandMetadataList: readonly BridgeCommandMetadata[] = BridgeCommandCatalog;
const BridgeCommandMetadataByMethod = new Map<string, BridgeCommandMetadata>(
	BridgeCommandMetadataList.map((entry) => [entry.method, entry]),
);

export function getBridgeCommandMetadata(method: string): BridgeCommandMetadata | undefined {
	return BridgeCommandMetadataByMethod.get(method);
}

export function isSensitiveBridgeCapability(capability: string): boolean {
	return BridgeCommandMetadataList.some((entry) => entry.sensitive && entry.capabilities.includes(capability));
}

export function isCatalogWriteMethod(method: string): boolean {
	return Boolean(getBridgeCommandMetadata(method)?.write);
}

export function isCatalogServerLocalMethod(method: string): boolean {
	return getBridgeCommandMetadata(method)?.route === "server-local";
}

export function isCatalogTargetDispatchedMethod(
	method: string,
	targetKind: BridgeCommandTargetKind = "chrome-tab",
): boolean {
	if (targetKind === "electron-window" && isCatalogServerLocalMethod(method)) return false;
	return !method.startsWith("session_");
}

export function getCatalogCliCommands(): string[] {
	return Array.from(new Set(BridgeCommandMetadataList.flatMap((entry) => entry.cliCommands ?? []))).sort();
}
