export type BridgeCommandRoute = "extension" | "server-local";

export interface BridgeCommandMetadata {
	method: string;
	capabilities: readonly string[];
	route: BridgeCommandRoute;
	sensitive?: boolean;
	write?: boolean;
}

export const BridgeCommandCatalog = [
	{ method: "status", capabilities: ["status"], route: "extension" },
	{ method: "navigate", capabilities: ["navigate", "tabs"], route: "extension" },
	{ method: "repl", capabilities: ["repl"], route: "extension" },
	{ method: "screenshot", capabilities: ["screenshot"], route: "extension" },
	{ method: "eval", capabilities: ["eval"], route: "extension", sensitive: true },
	{ method: "cookies", capabilities: ["cookies"], route: "extension", sensitive: true },
	{ method: "select_element", capabilities: ["select_element"], route: "extension" },
	{ method: "workflow_run", capabilities: ["workflow_run"], route: "extension" },
	{ method: "workflow_validate", capabilities: ["workflow_validate"], route: "extension" },
	{ method: "page_snapshot", capabilities: ["page_snapshot"], route: "extension" },
	{ method: "page_assert", capabilities: ["page_assert"], route: "extension" },
	{ method: "locate_by_role", capabilities: ["locate_by_role"], route: "extension" },
	{ method: "locate_by_text", capabilities: ["locate_by_text"], route: "extension" },
	{ method: "locate_by_label", capabilities: ["locate_by_label"], route: "extension" },
	{ method: "ref_click", capabilities: ["ref_click"], route: "extension" },
	{ method: "ref_fill", capabilities: ["ref_fill"], route: "extension" },
	{ method: "frame_list", capabilities: ["frame_list"], route: "extension" },
	{ method: "frame_tree", capabilities: ["frame_tree"], route: "extension" },
	{ method: "network_start", capabilities: ["network_start"], route: "extension" },
	{ method: "network_stop", capabilities: ["network_stop"], route: "extension" },
	{ method: "network_list", capabilities: ["network_list"], route: "extension" },
	{ method: "network_clear", capabilities: ["network_clear"], route: "extension" },
	{ method: "network_stats", capabilities: ["network_stats"], route: "extension" },
	{ method: "network_get", capabilities: ["network_get"], route: "extension", sensitive: true },
	{ method: "network_body", capabilities: ["network_body"], route: "extension", sensitive: true },
	{ method: "network_curl", capabilities: ["network_curl"], route: "extension", sensitive: true },
	{ method: "device_emulate", capabilities: ["device_emulate"], route: "extension" },
	{ method: "device_reset", capabilities: ["device_reset"], route: "extension" },
	{ method: "perf_metrics", capabilities: ["perf_metrics"], route: "extension" },
	{ method: "perf_trace_start", capabilities: ["perf_trace_start"], route: "extension" },
	{ method: "perf_trace_stop", capabilities: ["perf_trace_stop"], route: "extension" },
	{ method: "record_start", capabilities: ["record_start"], route: "extension", sensitive: true },
	{ method: "record_stop", capabilities: ["record_stop"], route: "extension", sensitive: true },
	{ method: "record_status", capabilities: ["record_status"], route: "extension", sensitive: true },
	{ method: "session_history", capabilities: ["session_history"], route: "extension" },
	{ method: "session_inject", capabilities: ["session_inject"], route: "extension", write: true },
	{ method: "session_new", capabilities: ["session_new"], route: "extension", write: true },
	{ method: "session_set_model", capabilities: ["session_set_model"], route: "extension", write: true },
	{ method: "session_artifacts", capabilities: ["session_artifacts"], route: "extension" },
	{ method: "electron_list", capabilities: ["electron_list"], route: "server-local" },
	{ method: "electron_allow", capabilities: ["electron_allow"], route: "server-local" },
	{ method: "electron_launch", capabilities: ["electron_launch"], route: "server-local" },
	{ method: "electron_attach", capabilities: ["electron_attach"], route: "server-local" },
	{ method: "electron_detach", capabilities: ["electron_detach"], route: "server-local" },
	{ method: "electron_windows", capabilities: ["electron_windows"], route: "server-local" },
	{ method: "electron_label", capabilities: ["electron_label"], route: "server-local" },
	{ method: "electron_main_info", capabilities: ["electron_main_info"], route: "server-local" },
	{ method: "electron_ipc_tap_start", capabilities: ["electron_ipc_tap_start"], route: "server-local" },
	{ method: "electron_ipc_tap_stop", capabilities: ["electron_ipc_tap_stop"], route: "server-local" },
	{ method: "electron_main_network_start", capabilities: ["electron_main_network_start"], route: "server-local" },
	{ method: "electron_main_network_stop", capabilities: ["electron_main_network_stop"], route: "server-local" },
	{ method: "electron_source_layout", capabilities: ["electron_source_layout"], route: "server-local" },
	{ method: "electron_source_list", capabilities: ["electron_source_list"], route: "server-local" },
	{ method: "electron_source_read", capabilities: ["electron_source_read"], route: "server-local" },
	{ method: "electron_source_extract", capabilities: ["electron_source_extract"], route: "server-local" },
	{ method: "electron_doctor", capabilities: ["electron_doctor"], route: "server-local" },
	{ method: "electron_auto_attach", capabilities: ["electron_auto_attach"], route: "server-local" },
	{ method: "skills_snapshot_status", capabilities: ["skills_snapshot_status"], route: "server-local" },
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

export function isCatalogTargetDispatchedMethod(method: string): boolean {
	return !method.startsWith("session_");
}
