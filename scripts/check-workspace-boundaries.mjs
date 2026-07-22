import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chromeManifestPath = join(repositoryRoot, "static/manifest.chrome.json");
const chromeManifestSource = JSON.parse(readFileSync(chromeManifestPath, "utf8"));
const releaseVersion = chromeManifestSource.version;
const expectedWorkspacePatterns = ["packages/*", "proxy", "site"];

const workspaceDefinitions = [
	{
		path: "packages/protocol",
		name: "@shuvgeist/protocol",
		private: true,
		requireSourceExports: true,
		requiredInternalDependencies: [],
		allowedInternalDependencies: [],
	},
	{
		path: "packages/driver",
		name: "@shuvgeist/driver",
		private: true,
		requireSourceExports: true,
		requiredInternalDependencies: ["@shuvgeist/protocol"],
		allowedInternalDependencies: ["@shuvgeist/protocol"],
	},
	{
		path: "packages/extension",
		name: "@shuvgeist/extension",
		private: true,
		requireSourceExports: true,
		requiredInternalDependencies: ["@shuvgeist/protocol", "@shuvgeist/driver"],
		allowedInternalDependencies: ["@shuvgeist/protocol", "@shuvgeist/driver"],
	},
	{
		path: "packages/server",
		name: "@shuvgeist/server",
		private: true,
		requireSourceExports: true,
		requiredInternalDependencies: ["@shuvgeist/protocol", "@shuvgeist/driver"],
		allowedInternalDependencies: ["@shuvgeist/protocol", "@shuvgeist/driver"],
	},
	{
		path: "packages/cli",
		name: "shuvgeist",
		private: false,
		requireSourceExports: true,
		requiredInternalDependencies: ["@shuvgeist/protocol", "@shuvgeist/driver", "@shuvgeist/server"],
		allowedInternalDependencies: ["@shuvgeist/protocol", "@shuvgeist/driver", "@shuvgeist/server"],
	},
	{
		path: "proxy",
		name: "shuvgeist-cors-proxy",
		versionParity: false,
		requiredInternalDependencies: [],
		allowedInternalDependencies: [],
	},
	{
		path: "site",
		name: "shuvgeist-site",
		versionParity: false,
		requiredInternalDependencies: [],
		allowedInternalDependencies: [],
	},
];

const internalNames = new Set(workspaceDefinitions.map((workspace) => workspace.name));
const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const sourceExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const ignoredDirectories = new Set(["coverage", "dist", "dist-cli", "dist-chrome", "node_modules", "test-results"]);
const errors = [];

function fail(message) {
	errors.push(message);
}

function readJson(relativePath) {
	const absolutePath = join(repositoryRoot, relativePath);
	if (!existsSync(absolutePath)) {
		fail(`${relativePath} is missing`);
		return undefined;
	}
	try {
		return JSON.parse(readFileSync(absolutePath, "utf8"));
	} catch (error) {
		fail(`${relativePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function sameMembers(actual, expected) {
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		actual.every((value) => typeof value === "string") &&
		[...actual].sort().every((value, index) => value === [...expected].sort()[index])
	);
}

function allInternalDependencies(manifest) {
	const result = new Map();
	for (const section of dependencySections) {
		const dependencies = manifest?.[section];
		if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) continue;
		for (const [name, version] of Object.entries(dependencies)) {
			if (internalNames.has(name)) result.set(name, { section, version });
		}
	}
	return result;
}

function exportTargets(value) {
	if (typeof value === "string") return [value];
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	return Object.values(value).flatMap(exportTargets);
}

function checkManifest(definition, manifest) {
	if (!manifest) return;
	const manifestPath = `${definition.path}/package.json`;
	if (manifest.name !== definition.name) {
		fail(`${manifestPath} must declare name ${definition.name}`);
	}
	if (definition.versionParity !== false && manifest.version !== releaseVersion) {
		fail(`${manifestPath} version must equal ${releaseVersion}`);
	}
	if (manifest.type !== "module") fail(`${manifestPath} must declare type: module`);
	if (definition.private === true && manifest.private !== true) {
		fail(`${manifestPath} must be private`);
	}
	if (definition.private === false && manifest.private === true) {
		fail(`${manifestPath} must remain publishable (private must not be true)`);
	}
	if (definition.requireSourceExports) {
		const targets = exportTargets(manifest.exports);
		if (targets.length === 0) {
			fail(`${manifestPath} must declare source exports`);
		}
		for (const target of targets) {
			if (!target.startsWith("./src/")) {
				fail(`${manifestPath} export ${target} must target package-local source under ./src/`);
			} else if (!target.includes("*") && !existsSync(join(repositoryRoot, definition.path, target))) {
				fail(`${manifestPath} export ${target} does not exist`);
			}
		}
		if (!existsSync(join(repositoryRoot, definition.path, "tsconfig.json"))) {
			fail(`${definition.path}/tsconfig.json is missing`);
		}
	}

	const internalDependencies = allInternalDependencies(manifest);
	for (const requiredName of definition.requiredInternalDependencies) {
		const declared = internalDependencies.get(requiredName);
		if (!declared) {
			fail(`${manifestPath} must depend on ${requiredName}`);
			continue;
		}
		if (declared.section !== "dependencies") {
			fail(`${manifestPath} must declare ${requiredName} in dependencies, not ${declared.section}`);
		}
	}
	for (const [name, declaration] of internalDependencies) {
		if (!definition.allowedInternalDependencies.includes(name)) {
			fail(`${manifestPath} has forbidden internal edge ${definition.name} -> ${name}`);
		}
		if (declaration.version !== releaseVersion) {
			fail(`${manifestPath} must pin ${name} to exact ${releaseVersion}; found ${String(declaration.version)}`);
		}
	}
}

function walkSourceFiles(directory) {
	if (!existsSync(directory)) return [];
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...walkSourceFiles(path));
		else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(path);
	}
	return files;
}

function importSpecifiers(source) {
	const specifiers = new Set();
	const patterns = [
		/\bfrom\s*["']([^"']+)["']/gu,
		/\bimport\s*["']([^"']+)["']/gu,
		/\bimport\s*\(\s*["']([^"']+)["']/gu,
		/\brequire\s*\(\s*["']([^"']+)["']/gu,
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			if (match[1]) specifiers.add(match[1]);
		}
	}
	return specifiers;
}

function escapesDirectory(path, directory) {
	const pathFromDirectory = relative(directory, path);
	return (
		pathFromDirectory === ".." ||
		pathFromDirectory.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
		isAbsolute(pathFromDirectory)
	);
}

function matchingExportKey(exportsDeclaration, exportKey) {
	if (typeof exportsDeclaration === "string") return exportKey === ".";
	if (!exportsDeclaration || typeof exportsDeclaration !== "object" || Array.isArray(exportsDeclaration)) return false;
	if (Object.hasOwn(exportsDeclaration, exportKey)) return true;
	return Object.keys(exportsDeclaration).some((key) => {
		if (!key.includes("*")) return false;
		const [prefix, suffix] = key.split("*");
		return exportKey.startsWith(prefix ?? "") && exportKey.endsWith(suffix ?? "");
	});
}

function internalImportTarget(specifier) {
	const definition = workspaceDefinitions.find(
		(workspace) => specifier === workspace.name || specifier.startsWith(`${workspace.name}/`),
	);
	if (definition) return definition;
	return specifier.startsWith("@shuvgeist/") ? "unknown" : undefined;
}

function checkSourceImports(definition, manifest, manifestsByPath) {
	const workspaceRoot = join(repositoryRoot, definition.path);
	for (const file of walkSourceFiles(join(workspaceRoot, "src"))) {
		const source = readFileSync(file, "utf8");
		for (const specifier of importSpecifiers(source)) {
			if (specifier.startsWith(".")) {
				const target = resolve(dirname(file), specifier);
				if (escapesDirectory(target, workspaceRoot)) {
					fail(`${relative(repositoryRoot, file)} imports across a package boundary with ${specifier}`);
				}
				continue;
			}

			const targetDefinition = internalImportTarget(specifier);
			if (!targetDefinition) continue;
			if (targetDefinition === "unknown") {
				fail(`${relative(repositoryRoot, file)} imports unknown internal package ${specifier}`);
				continue;
			}
			if (!definition.allowedInternalDependencies.includes(targetDefinition.name)) {
				fail(
					`${relative(repositoryRoot, file)} imports forbidden internal edge ${definition.name} -> ${targetDefinition.name}`,
				);
				continue;
			}
			const declaration = allInternalDependencies(manifest).get(targetDefinition.name);
			if (!declaration) {
				fail(`${relative(repositoryRoot, file)} imports undeclared internal dependency ${targetDefinition.name}`);
				continue;
			}
			const targetManifest = manifestsByPath.get(targetDefinition.path);
			const suffix = specifier.slice(targetDefinition.name.length);
			const exportKey = suffix ? `.${suffix}` : ".";
			if (!matchingExportKey(targetManifest?.exports, exportKey)) {
				fail(`${relative(repositoryRoot, file)} imports unexported internal subpath ${specifier}`);
			}
		}
	}
}

const rootManifest = readJson("package.json");
if (rootManifest) {
	if (rootManifest.name !== "@shuvgeist/root") fail("package.json must declare name @shuvgeist/root");
	if (rootManifest.version !== releaseVersion) fail(`package.json version must equal ${releaseVersion}`);
	if (rootManifest.private !== true) fail("package.json must remain private");
	if (!sameMembers(rootManifest.workspaces, expectedWorkspacePatterns)) {
		fail(`package.json workspaces must be exactly: ${expectedWorkspacePatterns.join(", ")}`);
	}
	for (const publishField of ["bin", "exports", "files", "main", "publishConfig"]) {
		if (rootManifest[publishField] !== undefined) fail(`private root package.json must not declare ${publishField}`);
	}
}

if (existsSync(join(repositoryRoot, "src")) && statSync(join(repositoryRoot, "src")).isDirectory()) {
	fail("root src/ must not exist after the workspace migration");
}

const manifestsByPath = new Map();
for (const definition of workspaceDefinitions) {
	const manifest = readJson(`${definition.path}/package.json`);
	manifestsByPath.set(definition.path, manifest);
}
for (const definition of workspaceDefinitions) {
	const manifest = manifestsByPath.get(definition.path);
	checkManifest(definition, manifest);
	checkSourceImports(definition, manifest, manifestsByPath);
}

const cliManifest = manifestsByPath.get("packages/cli");
if (cliManifest?.scripts?.prepack !== "node ./scripts/guard-direct-pack.mjs") {
	fail("packages/cli/package.json must fail direct source-workspace packing in favor of npm run package:cli");
}
if (!existsSync(join(repositoryRoot, "packages/cli/scripts/guard-direct-pack.mjs"))) {
	fail("packages/cli/scripts/guard-direct-pack.mjs is missing");
}

const chromeManifest = readJson("static/manifest.chrome.json");
if (chromeManifest?.version !== releaseVersion) {
	fail(`static/manifest.chrome.json version must equal ${releaseVersion}`);
}

const rootLock = readJson("package-lock.json");
if (rootLock) {
	const rootLockPackage = rootLock.packages?.[""];
	if (rootLockPackage?.name !== "@shuvgeist/root" || rootLockPackage?.version !== releaseVersion) {
		fail("package-lock.json root package identity/version is stale");
	}
	for (const definition of workspaceDefinitions) {
		const lockedWorkspace = rootLock.packages?.[definition.path];
		const workspaceVersion = manifestsByPath.get(definition.path)?.version;
		if (lockedWorkspace?.name !== definition.name || lockedWorkspace?.version !== workspaceVersion) {
			fail(`package-lock.json is missing current workspace metadata for ${definition.path}`);
		}
	}
}

for (const nestedLockPath of ["proxy/package-lock.json", "site/package-lock.json"]) {
	const nestedLock = readJson(nestedLockPath);
	const definition = workspaceDefinitions.find(
		(workspace) => `${workspace.path}/package-lock.json` === nestedLockPath,
	);
	const workspaceVersion = definition ? manifestsByPath.get(definition.path)?.version : undefined;
	if (
		nestedLock?.version !== workspaceVersion ||
		nestedLock?.packages?.[""]?.version !== workspaceVersion ||
		(definition && nestedLock?.name !== definition.name)
	) {
		fail(`${nestedLockPath} package identity/version must match its workspace manifest`);
	}
}

for (const relativePath of [
	"package.json",
	"package-lock.json",
	...workspaceDefinitions.flatMap((workspace) => [
		`${workspace.path}/package.json`,
		...(workspace.path === "proxy" || workspace.path === "site" ? [`${workspace.path}/package-lock.json`] : []),
	]),
]) {
	const absolutePath = join(repositoryRoot, relativePath);
	if (existsSync(absolutePath) && readFileSync(absolutePath, "utf8").includes("workspace:")) {
		fail(`${relativePath} must not use the workspace: protocol`);
	}
}

if (errors.length > 0) {
	console.error("Workspace boundary check failed:");
	for (const error of errors) console.error(`- ${error}`);
	process.exitCode = 1;
} else {
	console.log(
		`Workspace boundaries valid: ${workspaceDefinitions.length} workspaces, core release ${releaseVersion}, exact internal DAG, no root src, no cross-package source imports.`,
	);
}
