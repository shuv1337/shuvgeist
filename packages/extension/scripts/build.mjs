import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";
import { createInjectedArtifactsPlugin } from "../../../scripts/injected-artifacts.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const extensionRoot = join(__dirname, "..");
const repoRoot = join(extensionRoot, "../..");
const isWatch = process.argv.includes("--watch");
const staticDir = join(repoRoot, "static");
const includeInjectedArtifactTestSurface = process.env.SHUVGEIST_BUILD_TEST_SURFACES === "1";

// Chrome only
const targetBrowser = "chrome";
const outDir = join(repoRoot, "dist-chrome");

const entryPoints = {
	sidepanel: join(extensionRoot, "src/sidepanel.ts"),
	debug: join(extensionRoot, "src/debug.ts"),
	icons: join(extensionRoot, "src/icons.ts"),
	background: join(extensionRoot, "src/background.ts"),
	offscreen: join(extensionRoot, "src/offscreen.ts"),
	...(includeInjectedArtifactTestSurface
		? {
				"driver-injected-artifacts": join(repoRoot, "tests/e2e/fixtures/driver-injected-artifact-surface.ts"),
				"extension-injected-artifacts": join(repoRoot, "tests/e2e/fixtures/extension-injected-artifact-surface.ts"),
			}
		: {}),
};

const overlayRuntimeEntry = join(extensionRoot, "src/tts/overlay-runtime.ts");
const sharedBuildOptions = {
	absWorkingDir: repoRoot,
	target: ["chrome120"],
	platform: "browser",
	sourcemap: isWatch ? "inline" : true,
	loader: {
		".ts": "ts",
		".tsx": "tsx",
	},
	define: {
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? (isWatch ? "development" : "production")),
		"process.env.TARGET_BROWSER": JSON.stringify(targetBrowser),
		global: "globalThis",
	},
	inject: [join(extensionRoot, "scripts/process-shim.js"), join(extensionRoot, "scripts/dom-shim.js")],
	// Force all mini-lit and lit imports to resolve to shuvgeist's node_modules
	alias: {
		process: join(extensionRoot, "scripts/process-shim.js"),
		"@mariozechner/mini-lit": join(repoRoot, "node_modules/@mariozechner/mini-lit"),
		lit: join(repoRoot, "node_modules/lit"),
		"lit/decorators.js": join(repoRoot, "node_modules/lit/decorators.js"),
		"lit/directives/class-map.js": join(repoRoot, "node_modules/lit/directives/class-map.js"),
		"lit/directives/unsafe-html.js": join(repoRoot, "node_modules/lit/directives/unsafe-html.js"),
	},
	plugins: [createInjectedArtifactsPlugin()],
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const buildOptions = {
	...sharedBuildOptions,
	entryPoints,
	bundle: true,
	outdir: outDir,
	format: "esm",
	entryNames: "[name]",
};

const overlayRuntimeBuildOptions = {
	...sharedBuildOptions,
	entryPoints: [overlayRuntimeEntry],
	bundle: true,
	outfile: join(outDir, "tts-overlay-runtime.js"),
	format: "iife",
};

// Get all files from static directory
const getStaticFiles = () => {
	return readdirSync(staticDir).map((file) => join("static", file));
};

const copyStatic = () => {
	// Use browser-specific manifest
	const manifestSource = join(repoRoot, `static/manifest.${targetBrowser}.json`);
	const manifestDest = join(outDir, "manifest.json");
	copyFileSync(manifestSource, manifestDest);

	// Copy all files from static/ directory (except manifest files)
	const staticFiles = getStaticFiles();
	for (const relative of staticFiles) {
		const filename = relative.replace("static/", "");
		// Skip manifest files - we already copied the correct one above
		if (filename.startsWith("manifest.")) continue;

		const source = join(repoRoot, relative);
		const destination = join(outDir, filename);
		copyFileSync(source, destination);
	}

	// Copy PDF.js worker from node_modules (check both local and monorepo root)
	let pdfWorkerSource = join(extensionRoot, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	if (!existsSync(pdfWorkerSource)) {
		pdfWorkerSource = join(repoRoot, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
	}
	const pdfWorkerDestDir = join(outDir, "pdfjs-dist/build");
	mkdirSync(pdfWorkerDestDir, { recursive: true });
	const pdfWorkerDest = join(pdfWorkerDestDir, "pdf.worker.min.mjs");
	copyFileSync(pdfWorkerSource, pdfWorkerDest);

	console.log(`Built for ${targetBrowser} in ${outDir}`);
};

const run = async () => {
	if (isWatch) {
		const ctx = await context(buildOptions);
		const overlayCtx = await context(overlayRuntimeBuildOptions);
		await Promise.all([ctx.watch(), overlayCtx.watch()]);
		copyStatic();

		// Watch the entire static directory
		watch(staticDir, { recursive: true }, (eventType) => {
			if (eventType === "change") {
				console.log(`\nStatic files changed, copying...`);
				copyStatic();
			}
		});

		// Watch the manifest file for the target browser
		const manifestSource = join(repoRoot, `static/manifest.${targetBrowser}.json`);
		watch(manifestSource, (eventType) => {
			if (eventType === "change") {
				console.log(`\nManifest changed, copying...`);
				copyStatic();
			}
		});

		process.stdout.write("Watching for changes...\n");
	} else {
		await build(buildOptions);
		await build(overlayRuntimeBuildOptions);
		copyStatic();
	}
};

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
