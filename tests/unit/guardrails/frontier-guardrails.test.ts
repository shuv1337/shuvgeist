import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BridgeCommandCatalog } from "@shuvgeist/protocol/command-catalog";

const EXPECTED_BRIDGE_SURFACE = [
	{ method: "status", route: "extension", capabilities: ["status"], cliCommands: [], sensitive: false, write: false },
	{
		method: "navigate",
		route: "extension",
		capabilities: ["navigate", "tabs"],
		cliCommands: ["navigate", "tabs", "switch", "windows"],
		sensitive: false,
		write: false,
	},
	{
		method: "repl",
		route: "extension",
		capabilities: ["repl"],
		cliCommands: ["repl"],
		sensitive: false,
		write: false,
	},
	{
		method: "screenshot",
		route: "extension",
		capabilities: ["screenshot"],
		cliCommands: ["screenshot"],
		sensitive: false,
		write: false,
	},
	{ method: "eval", route: "extension", capabilities: ["eval"], cliCommands: ["eval"], sensitive: true, write: false },
	{
		method: "cookies",
		route: "extension",
		capabilities: ["cookies"],
		cliCommands: ["cookies"],
		sensitive: true,
		write: false,
	},
	{
		method: "cookie_import",
		route: "server-local",
		capabilities: ["cookie_import"],
		cliCommands: [],
		sensitive: true,
		write: false,
	},
	{
		method: "cookie_import_apply",
		route: "extension",
		capabilities: ["cookie_import_apply"],
		cliCommands: [],
		sensitive: true,
		write: false,
	},
	{
		method: "select_element",
		route: "extension",
		capabilities: ["select_element"],
		cliCommands: ["select"],
		sensitive: false,
		write: false,
	},
	{
		method: "workflow_run",
		route: "extension",
		capabilities: ["workflow_run"],
		cliCommands: ["workflow"],
		sensitive: false,
		write: false,
	},
	{
		method: "workflow_validate",
		route: "extension",
		capabilities: ["workflow_validate"],
		cliCommands: ["workflow"],
		sensitive: false,
		write: false,
	},
	{
		method: "page_snapshot",
		route: "extension",
		capabilities: ["page_snapshot"],
		cliCommands: ["snapshot"],
		sensitive: false,
		write: false,
	},
	{
		method: "snapshot_store",
		route: "server-local",
		capabilities: ["snapshot_store"],
		cliCommands: [],
		sensitive: false,
		write: false,
	},
	{
		method: "snapshot_read",
		route: "server-local",
		capabilities: ["snapshot_read"],
		cliCommands: [],
		sensitive: false,
		write: false,
	},
	{
		method: "page_assert",
		route: "extension",
		capabilities: ["page_assert"],
		cliCommands: ["assert"],
		sensitive: false,
		write: false,
	},
	{
		method: "locate_by_role",
		route: "extension",
		capabilities: ["locate_by_role"],
		cliCommands: ["locate"],
		sensitive: false,
		write: false,
	},
	{
		method: "locate_by_text",
		route: "extension",
		capabilities: ["locate_by_text"],
		cliCommands: ["locate"],
		sensitive: false,
		write: false,
	},
	{
		method: "locate_by_label",
		route: "extension",
		capabilities: ["locate_by_label"],
		cliCommands: ["locate"],
		sensitive: false,
		write: false,
	},
	{
		method: "ref_click",
		route: "extension",
		capabilities: ["ref_click"],
		cliCommands: ["ref"],
		sensitive: false,
		write: false,
	},
	{
		method: "ref_fill",
		route: "extension",
		capabilities: ["ref_fill"],
		cliCommands: ["ref"],
		sensitive: false,
		write: false,
	},
	{
		method: "frame_list",
		route: "extension",
		capabilities: ["frame_list"],
		cliCommands: ["frame"],
		sensitive: false,
		write: false,
	},
	{
		method: "frame_tree",
		route: "extension",
		capabilities: ["frame_tree"],
		cliCommands: ["frame"],
		sensitive: false,
		write: false,
	},
	{
		method: "network_start",
		route: "extension",
		capabilities: ["network_start"],
		cliCommands: ["network"],
		sensitive: false,
		write: false,
	},
	{
		method: "network_stop",
		route: "extension",
		capabilities: ["network_stop"],
		cliCommands: ["network"],
		sensitive: false,
		write: false,
	},
	{
		method: "network_list",
		route: "extension",
		capabilities: ["network_list"],
		cliCommands: ["network"],
		sensitive: false,
		write: false,
	},
	{
		method: "network_clear",
		route: "extension",
		capabilities: ["network_clear"],
		cliCommands: ["network"],
		sensitive: false,
		write: false,
	},
	{
		method: "network_stats",
		route: "extension",
		capabilities: ["network_stats"],
		cliCommands: ["network"],
		sensitive: false,
		write: false,
	},
	{
		method: "network_get",
		route: "extension",
		capabilities: ["network_get"],
		cliCommands: ["network"],
		sensitive: true,
		write: false,
	},
	{
		method: "network_body",
		route: "extension",
		capabilities: ["network_body"],
		cliCommands: ["network"],
		sensitive: true,
		write: false,
	},
	{
		method: "network_curl",
		route: "extension",
		capabilities: ["network_curl"],
		cliCommands: ["network"],
		sensitive: true,
		write: false,
	},
	{
		method: "device_emulate",
		route: "extension",
		capabilities: ["device_emulate"],
		cliCommands: ["device"],
		sensitive: false,
		write: false,
	},
	{
		method: "device_reset",
		route: "extension",
		capabilities: ["device_reset"],
		cliCommands: ["device"],
		sensitive: false,
		write: false,
	},
	{
		method: "perf_metrics",
		route: "extension",
		capabilities: ["perf_metrics"],
		cliCommands: ["perf"],
		sensitive: false,
		write: false,
	},
	{
		method: "perf_trace_start",
		route: "extension",
		capabilities: ["perf_trace_start"],
		cliCommands: ["perf"],
		sensitive: false,
		write: false,
	},
	{
		method: "perf_trace_stop",
		route: "extension",
		capabilities: ["perf_trace_stop"],
		cliCommands: ["perf"],
		sensitive: false,
		write: false,
	},
	{
		method: "record_start",
		route: "extension",
		capabilities: ["record_start"],
		cliCommands: ["record"],
		sensitive: true,
		write: false,
	},
	{
		method: "record_stop",
		route: "extension",
		capabilities: ["record_stop"],
		cliCommands: ["record"],
		sensitive: true,
		write: false,
	},
	{
		method: "record_status",
		route: "extension",
		capabilities: ["record_status"],
		cliCommands: ["record"],
		sensitive: true,
		write: false,
	},
	{
		method: "session_history",
		route: "extension",
		capabilities: ["session_history"],
		cliCommands: ["session"],
		sensitive: false,
		write: false,
	},
	{
		method: "session_inject",
		route: "extension",
		capabilities: ["session_inject"],
		cliCommands: ["inject"],
		sensitive: false,
		write: true,
	},
	{
		method: "session_new",
		route: "extension",
		capabilities: ["session_new"],
		cliCommands: ["new-session"],
		sensitive: false,
		write: true,
	},
	{
		method: "session_set_model",
		route: "extension",
		capabilities: ["session_set_model"],
		cliCommands: ["set-model"],
		sensitive: false,
		write: true,
	},
	{
		method: "session_artifacts",
		route: "extension",
		capabilities: ["session_artifacts"],
		cliCommands: ["artifacts"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_list",
		route: "server-local",
		capabilities: ["electron_list"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_allow",
		route: "server-local",
		capabilities: ["electron_allow"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_launch",
		route: "server-local",
		capabilities: ["electron_launch"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_attach",
		route: "server-local",
		capabilities: ["electron_attach"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_detach",
		route: "server-local",
		capabilities: ["electron_detach"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_windows",
		route: "server-local",
		capabilities: ["electron_windows"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_label",
		route: "server-local",
		capabilities: ["electron_label"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_main_info",
		route: "server-local",
		capabilities: ["electron_main_info"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_ipc_tap_start",
		route: "server-local",
		capabilities: ["electron_ipc_tap_start"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_ipc_tap_stop",
		route: "server-local",
		capabilities: ["electron_ipc_tap_stop"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_main_network_start",
		route: "server-local",
		capabilities: ["electron_main_network_start"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_main_network_stop",
		route: "server-local",
		capabilities: ["electron_main_network_stop"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_source_layout",
		route: "server-local",
		capabilities: ["electron_source_layout"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_source_list",
		route: "server-local",
		capabilities: ["electron_source_list"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_source_read",
		route: "server-local",
		capabilities: ["electron_source_read"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_source_extract",
		route: "server-local",
		capabilities: ["electron_source_extract"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_doctor",
		route: "server-local",
		capabilities: ["electron_doctor"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "electron_auto_attach",
		route: "server-local",
		capabilities: ["electron_auto_attach"],
		cliCommands: ["electron"],
		sensitive: false,
		write: false,
	},
	{
		method: "skills_snapshot_status",
		route: "server-local",
		capabilities: ["skills_snapshot_status"],
		cliCommands: [],
		sensitive: false,
		write: false,
	},
] as const;

const PRODUCT_COPY_PATHS = [
	"README.md",
	"docs",
	"site/src/frontend",
	"packages/extension/src/dialogs",
	"packages/extension/src/tutorials.ts",
	"packages/extension/src/sidepanel.ts",
];

const RUNTIME_PACKAGE_MANIFESTS = [
	"package.json",
	"packages/protocol/package.json",
	"packages/driver/package.json",
	"packages/extension/package.json",
	"packages/server/package.json",
	"packages/cli/package.json",
];

const FORBIDDEN_CLAIM_PATTERNS = [
	/\bundetectable\b/iu,
	/\bbypass(?:es|ing)?\s+(?:all\s+)?(?:bot\s+)?detection\b/iu,
	/\bbot\s+detection\s+bypass\b/iu,
];

const FORBIDDEN_MANDATORY_EGRESS_DEPENDENCIES = [
	"@sentry/browser",
	"@sentry/node",
	"@vercel/analytics",
	"posthog-js",
	"segment",
	"mixpanel-browser",
	"amplitude-js",
	"firebase",
	"@firebase/app",
];

function readRepoFile(path: string): string {
	return readFileSync(join(process.cwd(), path), "utf-8");
}

function listFiles(path: string): string[] {
	const fullPath = join(process.cwd(), path);
	const stat = statSync(fullPath);
	if (stat.isFile()) return [path];
	return readdirSync(fullPath).flatMap((entry) => {
		const child = join(path, entry);
		const childStat = statSync(join(process.cwd(), child));
		if (childStat.isDirectory()) return listFiles(child);
		return /\.(html|md|ts|tsx)$/u.test(child) ? [child] : [];
	});
}

describe("frontier guardrails", () => {
	it("keeps the bridge protocol surface additive", () => {
		const byMethod = new Map(
			BridgeCommandCatalog.map((entry) => [
				entry.method,
				{
					method: entry.method,
					route: entry.route,
					capabilities: [...entry.capabilities],
					cliCommands: [...(entry.cliCommands ?? [])],
					sensitive: !!entry.sensitive,
					write: !!entry.write,
				},
			]),
		);

		for (const expected of EXPECTED_BRIDGE_SURFACE) {
			expect(byMethod.get(expected.method), expected.method).toEqual(expected);
		}
	});

	it("keeps AGPL licensing visible in source and product copy", () => {
		expect(readRepoFile("LICENSE")).toMatch(/GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/iu);
		expect(readRepoFile("README.md")).toContain("AGPL-3.0");
		expect(readRepoFile("site/src/frontend/index.html")).toContain("AGPL-3.0");
	});

	it("does not add mandatory analytics or telemetry dependencies", () => {
		const runtimeDeps = RUNTIME_PACKAGE_MANIFESTS.flatMap((manifestPath) => {
			const packageJson = JSON.parse(readRepoFile(manifestPath)) as {
				dependencies?: Record<string, string>;
			};
			return Object.keys(packageJson.dependencies ?? {});
		});
		expect(runtimeDeps).not.toEqual(expect.arrayContaining(FORBIDDEN_MANDATORY_EGRESS_DEPENDENCIES));
	});

	it("does not introduce detection-evasion claims in product copy", () => {
		const offenders: string[] = [];
		for (const path of PRODUCT_COPY_PATHS.flatMap(listFiles)) {
			const text = readRepoFile(path);
			for (const pattern of FORBIDDEN_CLAIM_PATTERNS) {
				if (pattern.test(text)) offenders.push(relative(process.cwd(), join(process.cwd(), path)));
			}
		}
		expect(offenders).toEqual([]);
	});
});
