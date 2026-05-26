import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BridgeCommandCatalog,
	getCatalogCliCommands,
	isCatalogServerLocalMethod,
	isCatalogTargetDispatchedMethod,
} from "../../../src/bridge/command-catalog.js";
import { BridgeMethods } from "../../../src/bridge/protocol.js";

describe("bridge command catalog", () => {
	it("covers every bridge method with one execution route", () => {
		expect(BridgeCommandCatalog.map((entry) => entry.method)).toEqual(BridgeMethods);
		for (const method of BridgeMethods) {
			const entry = BridgeCommandCatalog.find((candidate) => candidate.method === method);
			expect(entry, method).toBeDefined();
			expect(entry?.route === "extension" || entry?.route === "server-local").toBe(true);
			expect(isCatalogServerLocalMethod(method)).toBe(entry?.route === "server-local");
			expect(isCatalogTargetDispatchedMethod(method)).toBe(!method.startsWith("session_"));
		}
	});

	it("keeps catalog CLI commands represented in help output", () => {
		const cliSource = readFileSync(join(process.cwd(), "src/bridge/cli.ts"), "utf-8");
		for (const command of getCatalogCliCommands()) {
			expect(cliSource, command).toContain("shuvgeist " + command);
		}
	});

	it("records planning timeout metadata for all bridge methods", () => {
		for (const entry of BridgeCommandCatalog) {
			expect(entry.defaultTimeout, entry.method).toBeDefined();
		}
	});
});
