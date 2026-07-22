import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const defaultPackageRoot = join(scriptsDir, "..", "..", "..");

export function createCliPackageManifest(cliPackage, version) {
	if (cliPackage.version !== version) {
		throw new Error(
			`CLI package version mismatch: packages/cli/package.json=${cliPackage.version ?? "missing"}, manifest=${version}`,
		);
	}
	return {
		name: cliPackage.name,
		version,
		description: cliPackage.description,
		type: "module",
		bin: { shuvgeist: "dist-cli/shuvgeist.mjs" },
		exports: {
			".": "./dist-cli/shuvgeist.mjs",
			"./direct-cdp-runtime": "./dist-cli/direct-cdp-runtime.mjs",
		},
		engines: { node: ">=22" },
		license: "AGPL-3.0-only",
		files: ["dist-cli", "skills/shuvgeist", "README.md", "LICENSE"],
	};
}

export function stageCliPackage(options = {}) {
	const packageRoot = options.packageRoot ?? defaultPackageRoot;
	const outputDir = options.outputDir ?? join(packageRoot, "dist-cli-package");
	const cliOutputDir = join(packageRoot, "dist-cli");
	const requiredCliFiles = ["shuvgeist.mjs", "direct-cdp-runtime.mjs"];
	for (const filename of requiredCliFiles) {
		const source = join(cliOutputDir, filename);
		if (!existsSync(source)) {
			throw new Error(`CLI package input is missing: ${source}. Run npm run build:cli first.`);
		}
	}

	const rootPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	const cliPackage = JSON.parse(readFileSync(join(packageRoot, "packages/cli/package.json"), "utf8"));
	const manifest = JSON.parse(readFileSync(join(packageRoot, "static/manifest.chrome.json"), "utf8"));
	if (rootPackage.version !== manifest.version) {
		throw new Error(
			`Release version mismatch: package.json=${rootPackage.version ?? "missing"}, manifest=${manifest.version}`,
		);
	}
	const packageManifest = createCliPackageManifest(cliPackage, manifest.version);

	rmSync(outputDir, { recursive: true, force: true });
	mkdirSync(join(outputDir, "dist-cli"), { recursive: true });
	for (const filename of requiredCliFiles) {
		cpSync(join(cliOutputDir, filename), join(outputDir, "dist-cli", filename));
	}
	cpSync(join(packageRoot, "skills/shuvgeist"), join(outputDir, "skills/shuvgeist"), { recursive: true });
	cpSync(join(packageRoot, "README.md"), join(outputDir, "README.md"));
	cpSync(join(packageRoot, "LICENSE"), join(outputDir, "LICENSE"));
	writeFileSync(join(outputDir, "package.json"), `${JSON.stringify(packageManifest, null, "\t")}\n`);
	return { outputDir, manifest: packageManifest };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
	const result = stageCliPackage();
	console.log(`CLI package staged at ${result.outputDir}`);
}
