import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const testBuild = process.argv.includes("--test");
const chromeOnly = process.argv.includes("--chrome-only");
const supportedArguments = new Set(["--test", "--chrome-only"]);
const unknownArguments = process.argv.slice(2).filter((argument) => !supportedArguments.has(argument));

if (unknownArguments.length > 0 || (testBuild && chromeOnly)) {
	throw new Error("Usage: node scripts/check-injected-artifact-test-surface.mjs [--test | --chrome-only]");
}

const driverSurfaceGlobal = "__SHUVGEIST_DRIVER_INJECTED_ARTIFACT_SURFACE__";
const extensionSurfaceGlobal = "__SHUVGEIST_EXTENSION_INJECTED_ARTIFACT_SURFACE__";
const targets = [
	{
		name: "Chrome",
		outputDirectory: join(packageRoot, "dist-chrome"),
		expectedTestEntries: [
			{
				path: join(packageRoot, "dist-chrome/driver-injected-artifacts.js"),
				marker: driverSurfaceGlobal,
			},
			{
				path: join(packageRoot, "dist-chrome/extension-injected-artifacts.js"),
				marker: extensionSurfaceGlobal,
			},
		],
		disallowedTestEntries: [],
	},
	...(chromeOnly
		? []
		: [
				{
					name: "CLI",
					outputDirectory: join(packageRoot, "dist-cli"),
					expectedTestEntries: [
						{
							path: join(packageRoot, "dist-cli/driver-injected-artifacts.mjs"),
							marker: driverSurfaceGlobal,
						},
					],
					disallowedTestEntries: [
						{
							path: join(packageRoot, "dist-cli/extension-injected-artifacts.mjs"),
							marker: extensionSurfaceGlobal,
						},
					],
				},
			]),
];

function listJavaScriptOutputs(directory) {
	const outputs = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			outputs.push(...listJavaScriptOutputs(path));
			continue;
		}
		if ([".js", ".mjs", ".cjs", ".map"].includes(extname(entry.name))) outputs.push(path);
	}
	return outputs;
}

for (const target of targets) {
	if (!existsSync(target.outputDirectory)) {
		throw new Error(`${target.name} output is missing: ${target.outputDirectory}`);
	}
	const outputs = listJavaScriptOutputs(target.outputDirectory);

	if (testBuild) {
		for (const entry of target.expectedTestEntries) {
			if (!existsSync(entry.path)) {
				throw new Error(`${target.name} E2E artifact surface is missing: ${entry.path}`);
			}
			if (!readFileSync(entry.path, "utf8").includes(entry.marker)) {
				throw new Error(`${target.name} E2E artifact surface does not expose ${entry.marker}`);
			}
		}
		for (const entry of target.disallowedTestEntries) {
			if (existsSync(entry.path)) {
				throw new Error(`${target.name} test output contains the extension-only entry: ${entry.path}`);
			}
			const leakingOutput = outputs.find((path) => readFileSync(path, "utf8").includes(entry.marker));
			if (leakingOutput) {
				throw new Error(`${target.name} test output exposes extension-only ${entry.marker}: ${leakingOutput}`);
			}
		}
		continue;
	}

	for (const entry of [...target.expectedTestEntries, ...target.disallowedTestEntries]) {
		if (existsSync(entry.path)) {
			throw new Error(`${target.name} production output contains the E2E-only entry: ${entry.path}`);
		}
		const leakingOutput = outputs.find((path) => readFileSync(path, "utf8").includes(entry.marker));
		if (leakingOutput) {
			throw new Error(`${target.name} production output exposes ${entry.marker}: ${leakingOutput}`);
		}
	}
}

console.log(
	testBuild
		? "Verified split driver/extension E2E artifact surfaces and CLI owner isolation"
		: `Verified no injected-artifact test surface in ${chromeOnly ? "Chrome" : "Chrome or CLI"} production output`,
);
