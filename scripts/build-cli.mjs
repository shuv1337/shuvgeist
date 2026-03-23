/**
 * Build the CLI bridge tools (server + CLI client) for Node 22.
 *
 * Bundles `ws` into the output so it does not need to be a runtime dependency.
 * Output goes to dist-cli/ with a hashbang for direct execution.
 */
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");
const outDir = join(packageRoot, "dist-cli");
const manifest = JSON.parse(readFileSync(join(packageRoot, "static/manifest.chrome.json"), "utf-8"));
const version = manifest.version;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
	absWorkingDir: packageRoot,
	entryPoints: {
		shuvgeist: join(packageRoot, "src/bridge/cli.ts"),
	},
	bundle: true,
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	format: "esm",
	target: ["node22"],
	platform: "node",
	sourcemap: true,
	entryNames: "[name]",
	banner: {
		js: [
			"#!/usr/bin/env node",
			// ws uses CJS require() for Node builtins — provide a require function in ESM context
			'import { createRequire as __createRequire } from "node:module";',
			"const require = __createRequire(import.meta.url);",
		].join("\n"),
	},
	loader: {
		".ts": "ts",
	},
	define: {
		"process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
		__SHUVGEIST_VERSION__: JSON.stringify(version),
	},
	// Bundle ws but keep Node builtins external (they're available at runtime)
	external: [
		"node:*",
		"events",
		"http",
		"https",
		"net",
		"tls",
		"stream",
		"url",
		"util",
		"crypto",
		"zlib",
		"buffer",
		"os",
		"fs",
		"path",
		"child_process",
	],
});

chmodSync(join(outDir, "shuvgeist.mjs"), 0o755);

console.log(`CLI built to ${outDir}/shuvgeist.mjs`);
