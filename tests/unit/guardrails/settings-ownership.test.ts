import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const sourceRoots = ["protocol", "driver", "extension", "server", "cli"].map((packageName) =>
	join(root, "packages", packageName, "src"),
);

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.isFile() && path.endsWith(".ts") ? [path] : [];
	});
}

function matchingFiles(pattern: RegExp, excluded: ReadonlySet<string> = new Set()): string[] {
	return sourceRoots
		.flatMap(sourceFiles)
		.filter((path) => !excluded.has(relative(root, path)))
		.filter((path) => pattern.test(readFileSync(path, "utf8")))
		.map((path) => relative(root, path));
}

describe("settings ownership guardrails", () => {
	it("keeps generic IndexedDB settings access behind the typed owner", () => {
		expect(
			matchingFiles(
				/\.settings\.(?:get|set|delete)\(/u,
				new Set(["packages/extension/src/storage/persistent-settings.ts"]),
			),
		).toEqual([]);
	});

	it("keeps chrome session writes in the runtime-state adapter and background composition root", () => {
		expect(matchingFiles(/chrome\.storage\.session\.set/u)).toEqual([]);
		expect(
			matchingFiles(
				/writeBridgeRuntimeStates?\(/u,
				new Set(["packages/extension/src/background.ts", "packages/extension/src/bridge/runtime-state.ts"]),
			),
		).toEqual([]);
	});

	it("keeps loose developer storage keys behind their typed owner", () => {
		expect(
			matchingFiles(
				/["'](?:debuggerMode|showJsonMode)["']/u,
				new Set([
					"packages/extension/src/agent/offscreen-developer-settings.ts",
					"packages/extension/src/storage/developer-settings.ts",
				]),
			),
		).toEqual([]);
	});

	it("keeps the physical bridge settings key behind its typed owner", () => {
		expect(
			matchingFiles(
				/\bBRIDGE_SETTINGS_KEY\b|["']bridge_settings["']/u,
				new Set([
					"packages/extension/src/bridge/internal-messages.ts",
					"packages/extension/src/bridge/settings.ts",
				]),
			),
		).toEqual([]);
	});

	it("keeps Node bridge and telemetry environment resolution behind the Node config owner", () => {
		expect(
			matchingFiles(
				/process\.env\.SHUVGEIST_(?:BRIDGE_(?:CONFIG|URL|HOST|PORT|TOKEN)|OTEL_(?:ENABLED|INGEST_URL|PRIVATE_INGEST_KEY))/u,
				new Set(["packages/server/src/node-config.ts"]),
			),
		).toEqual([]);
	});

	it("keeps Node config schema and discovery-file parsing out of protocol and feature modules", () => {
		expect(matchingFiles(/\bCliConfigFile\b/u)).toEqual([]);
		expect(matchingFiles(/\breadShuvgeistConfig\b/u)).toEqual([]);
		expect(
			matchingFiles(
				/export function (?:readBridgeConfig|writeBridgeConfig)\b/u,
				new Set(["packages/server/src/node-config.ts"]),
			),
		).toEqual([]);
		expect(
			matchingFiles(
				/(?:readFileSync|writeFileSync)\([^\n]*(?:bridge\.json|config\.json)/u,
				new Set(["packages/server/src/node-config.ts"]),
			),
		).toEqual([]);
	});
});
