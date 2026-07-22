import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(scriptsDir, "..");
const driverRoot = join(packageRoot, "packages/driver");
const extensionRoot = join(packageRoot, "packages/extension");
const driverGeneratedModulePath = join(driverRoot, "src/injected/driver-artifacts.generated.ts");
const extensionGeneratedModulePath = join(extensionRoot, "src/injected/extension-artifacts.generated.ts");
const pageRefActionRuntimePath = join(packageRoot, "static/page-ref-action-runtime.js");

const artifactGroups = [
	{
		owner: "driver",
		generatedModulePath: driverGeneratedModulePath,
		definitions: [
			{
				exportName: "SNAPSHOT_INJECTED_ARTIFACT",
				entryPoint: join(driverRoot, "src/injected/snapshot.ts"),
				globalName: "__SHUVGEIST_INJECTED_SNAPSHOT__",
			},
			{
				exportName: "PAGE_REF_ACTION_INJECTED_ARTIFACT",
				entryPoint: join(driverRoot, "src/injected/page-ref-action.ts"),
				globalName: "__SHUVGEIST_INJECTED_PAGE_REF_ACTION__",
			},
		],
	},
	{
		owner: "extension",
		generatedModulePath: extensionGeneratedModulePath,
		definitions: [
			{
				exportName: "BROWSERJS_WRAPPER_INJECTED_ARTIFACT",
				entryPoint: join(extensionRoot, "src/injected/browserjs-wrapper.ts"),
				globalName: "__SHUVGEIST_INJECTED_BROWSERJS__",
			},
			{
				exportName: "PAGE_EXECUTION_INJECTED_ARTIFACT",
				entryPoint: join(extensionRoot, "src/injected/page-execution.ts"),
				globalName: "__SHUVGEIST_INJECTED_PAGE_EXECUTION__",
			},
			{
				exportName: "REPL_OVERLAY_INJECTED_ARTIFACT",
				entryPoint: join(extensionRoot, "src/injected/repl-overlay.ts"),
				globalName: "__SHUVGEIST_INJECTED_REPL_OVERLAY__",
			},
			{
				exportName: "ELEMENT_PICKER_INJECTED_ARTIFACT",
				entryPoint: join(extensionRoot, "src/injected/element-picker.ts"),
				globalName: "__SHUVGEIST_INJECTED_ELEMENT_PICKER__",
			},
		],
	},
];

async function compileArtifact(definition) {
	const result = await build({
		absWorkingDir: packageRoot,
		entryPoints: [definition.entryPoint],
		bundle: true,
		write: false,
		metafile: true,
		format: "iife",
		globalName: definition.globalName,
		platform: "browser",
		target: ["chrome120"],
		legalComments: "none",
		minifySyntax: true,
		minifyWhitespace: true,
		minifyIdentifiers: false,
		charset: "utf8",
		loader: { ".ts": "ts" },
	});
	const output = result.outputFiles?.[0];
	if (!output) throw new Error(`No output generated for ${definition.entryPoint}`);
	const source = output.text.trim();
	const contentHash = createHash("sha256").update(source).digest("hex").slice(0, 16);
	const watchFiles = Object.keys(result.metafile?.inputs ?? {}).map((input) => resolve(packageRoot, input));
	return { ...definition, contentHash, source, watchFiles };
}

function serializeSourceLiteral(source) {
	const jsonContent = JSON.stringify(source).slice(1, -1);
	return `'${jsonContent.replaceAll('\\"', '"').replaceAll("'", "\\'")}'`;
}

function serializeGeneratedModule(owner, artifacts) {
	const contractsImport = owner === "driver" ? "./contracts.js" : "@shuvgeist/driver/injected-contracts";
	const lines = [
		`/* Generated ${owner} artifacts by scripts/injected-artifacts.mjs. Run npm run build to refresh. */`,
		`import { INJECTED_ARTIFACT_VERSION, type InjectedArtifactDescriptor } from ${JSON.stringify(contractsImport)};`,
		"",
	];
	for (const artifact of artifacts) {
		lines.push(
			`export const ${artifact.exportName} = {`,
			"\tversion: INJECTED_ARTIFACT_VERSION,",
			`\tglobalName: ${JSON.stringify(artifact.globalName)},`,
			`\tcontentHash: ${JSON.stringify(artifact.contentHash)},`,
			"\tsource:",
			`\t\t${serializeSourceLiteral(artifact.source)},`,
			"} as const satisfies InjectedArtifactDescriptor;",
			"",
		);
	}
	return lines.join("\n");
}

export async function generateInjectedArtifactsModules() {
	const groups = await Promise.all(
		artifactGroups.map(async (group) => {
			const artifacts = await Promise.all(group.definitions.map(compileArtifact));
			return {
				...group,
				artifacts,
				contents: serializeGeneratedModule(group.owner, artifacts),
				watchFiles: [...new Set(artifacts.flatMap((artifact) => artifact.watchFiles))],
			};
		}),
	);
	const driver = groups.find((group) => group.owner === "driver");
	const extension = groups.find((group) => group.owner === "extension");
	if (!driver || !extension) throw new Error("Injected artifact owner definitions are incomplete");
	const pageRefActionArtifact = driver.artifacts.find(
		(artifact) => artifact.exportName === "PAGE_REF_ACTION_INJECTED_ARTIFACT",
	);
	if (!pageRefActionArtifact) throw new Error("Page ref action artifact definition is missing");
	return {
		driver,
		extension,
		pageRefActionRuntimeContents: pageRefActionArtifact.source,
		watchFiles: [...new Set(groups.flatMap((group) => group.watchFiles))],
	};
}

function readCurrent(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function writeIfChanged(path, contents) {
	if (readCurrent(path) !== contents) writeFileSync(path, contents, "utf8");
}

export async function writeInjectedArtifactsModules() {
	const generated = await generateInjectedArtifactsModules();
	writeIfChanged(generated.driver.generatedModulePath, generated.driver.contents);
	writeIfChanged(generated.extension.generatedModulePath, generated.extension.contents);
	writeIfChanged(pageRefActionRuntimePath, generated.pageRefActionRuntimeContents);
	return generated;
}

function verifyCurrent(path, expected, label) {
	const current = readCurrent(path);
	if (current === undefined) {
		throw new Error(`${label} is missing at ${relative(packageRoot, path)}. Run npm run build.`);
	}
	if (current !== expected) {
		throw new Error(`${label} is stale at ${relative(packageRoot, path)}. Run npm run build.`);
	}
}

export async function verifyInjectedArtifactsModules() {
	const generated = await generateInjectedArtifactsModules();
	verifyCurrent(generated.driver.generatedModulePath, generated.driver.contents, "Driver injected artifact module");
	verifyCurrent(
		generated.extension.generatedModulePath,
		generated.extension.contents,
		"Extension injected artifact module",
	);
	verifyCurrent(pageRefActionRuntimePath, generated.pageRefActionRuntimeContents, "Page ref action fallback runtime");
	return generated;
}

export function createInjectedArtifactsPlugin() {
	return {
		name: "shuvgeist-injected-artifacts",
		setup(esbuildBuild) {
			esbuildBuild.onLoad(
				{ filter: /[\\/]src[\\/]injected[\\/](?:driver|extension)-artifacts\.generated\.ts$/ },
				async (args) => {
					const generated = await writeInjectedArtifactsModules();
					const module =
						resolve(args.path) === resolve(driverGeneratedModulePath) ? generated.driver : generated.extension;
					return {
						contents: module.contents,
						loader: "ts",
						watchFiles: module.watchFiles,
					};
				},
			);
		},
	};
}

export const injectedArtifactsGeneratedPaths = {
	driver: relative(packageRoot, driverGeneratedModulePath),
	extension: relative(packageRoot, extensionGeneratedModulePath),
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--check")) {
		const generated = await verifyInjectedArtifactsModules();
		console.log(`Injected artifacts are current (${generated.watchFiles.length} source files watched).`);
	} else if (process.argv.length === 2) {
		await writeInjectedArtifactsModules();
	} else {
		throw new Error("Usage: node scripts/injected-artifacts.mjs [--check]");
	}
}
