import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BridgeCommandCatalog,
	BridgeCommandDefinitions,
	BridgeCliBindings,
	ElectronTargetBridgeMethods,
	getCatalogCliCommands,
	getBridgeCommandTargetSupport,
	isCatalogServerLocalMethod,
	isCatalogTargetDispatchedMethod,
} from "@shuvgeist/protocol/command-catalog";
import { ElectronTargetCommandHandlers } from "@shuvgeist/server/electron/target-handler-registry";
import { BridgeMethods } from "@shuvgeist/protocol/protocol";

describe("bridge command catalog", () => {
	it("covers every bridge method with one execution route", () => {
		expect(BridgeCommandCatalog.map((entry) => entry.method)).toEqual(BridgeMethods);
		for (const method of BridgeMethods) {
			const entry = BridgeCommandCatalog.find((candidate) => candidate.method === method);
			expect(entry, method).toBeDefined();
			expect(entry?.route === "extension" || entry?.route === "server-local").toBe(true);
			expect(isCatalogServerLocalMethod(method)).toBe(entry?.route === "server-local");
			expect(isCatalogTargetDispatchedMethod(method, "chrome-tab")).toBe(entry?.route === "extension");
			expect(isCatalogTargetDispatchedMethod(method, "electron-window")).toBe(
				ElectronTargetBridgeMethods.includes(method as (typeof ElectronTargetBridgeMethods)[number]),
			);
			expect(BridgeCommandDefinitions[method].params).toBeDefined();
			expect(BridgeCommandDefinitions[method].result).toBeDefined();
			expect(BridgeCommandDefinitions[method].targetSupport).toEqual(getBridgeCommandTargetSupport(method));
		}
	});

	it("does not advertise unimplemented Electron target commands", () => {
		expect(ElectronTargetBridgeMethods).toEqual(Object.keys(ElectronTargetCommandHandlers));
		for (const method of ElectronTargetBridgeMethods) {
			expect(typeof ElectronTargetCommandHandlers[method], method).toBe("function");
		}
		expect(getBridgeCommandTargetSupport("perf_metrics")).toEqual({ chromeTab: true, electronWindow: true });
		expect(getBridgeCommandTargetSupport("perf_trace_start")).toEqual({ chromeTab: true, electronWindow: false });
		expect(getBridgeCommandTargetSupport("perf_trace_stop")).toEqual({ chromeTab: true, electronWindow: false });
		expect(getBridgeCommandTargetSupport("electron_list")).toEqual({ chromeTab: false, electronWindow: false });
	});

	it("keeps catalog CLI commands represented in help output", () => {
		const cliSource = readFileSync(join(process.cwd(), "packages/cli/src/cli.ts"), "utf-8");
		for (const command of getCatalogCliCommands()) {
			expect(cliSource, command).toContain("shuvgeist " + command);
		}
	});

	it("derives trusted ref input from the catalog without replacing legacy native input", () => {
		for (const method of ["ref_click", "ref_fill"] as const) {
			const binding = BridgeCliBindings.find((entry) => entry.method === method)?.binding;
			expect(binding?.flags.map(({ flag }) => flag)).toEqual(expect.arrayContaining(["native", "trusted"]));
		}
		const cliSource = readFileSync(join(process.cwd(), "packages/cli/src/cli.ts"), "utf-8");
		expect(cliSource).toContain("--trusted");
		expect(cliSource).toContain("--cdp-input");
		expect(cliSource).toContain("Electron --native is intentionally unsupported");
	});

	it("requires every method to make an explicit CLI exposure decision", () => {
		const hidden = BridgeCommandCatalog.filter((entry) => entry.cli.kind === "none").map((entry) => [
			entry.method,
			entry.cli.kind === "none" ? entry.cli.reason : undefined,
		]);
		expect(hidden).toEqual([
			["status", "shadowed-by-local-command"],
			["cookie_import", "server-internal"],
			["cookie_import_apply", "extension-internal"],
			["snapshot_store", "server-internal"],
			["snapshot_read", "server-internal"],
			["skills_snapshot_status", "server-internal"],
		]);
		for (const entry of BridgeCommandCatalog) {
			if (entry.cli.kind === "bridge") expect(entry.cli.bindings.length, entry.method).toBeGreaterThan(0);
		}
		expect(new Set(BridgeCliBindings.map(({ method }) => method))).toEqual(
			new Set(BridgeCommandCatalog.filter((entry) => entry.cli.kind === "bridge").map((entry) => entry.method)),
		);
	});

	it("records planning timeout metadata for all bridge methods", () => {
		for (const entry of BridgeCommandCatalog) {
			expect(entry.defaultTimeout, entry.method).toBeDefined();
		}
	});
});
