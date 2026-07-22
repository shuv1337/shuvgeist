import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageCliPackage } from "../../../packages/cli/scripts/package-cli.mjs";

function packageFiles(directory: string, prefix = ""): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
		return entry.isDirectory() ? packageFiles(join(directory, entry.name), relativePath) : [relativePath];
	});
}

describe("CLI release package", () => {
	let fixtureRoot: string | undefined;

	afterEach(() => {
		if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = undefined;
	});

	function createFixture(): string {
		fixtureRoot = mkdtempSync(join(tmpdir(), "shuvgeist-cli-package-"));
		mkdirSync(join(fixtureRoot, "dist-cli"), { recursive: true });
		mkdirSync(join(fixtureRoot, "packages/cli"), { recursive: true });
		mkdirSync(join(fixtureRoot, "static"), { recursive: true });
		mkdirSync(join(fixtureRoot, "skills/shuvgeist"), { recursive: true });
		writeFileSync(
			join(fixtureRoot, "package.json"),
			JSON.stringify({ name: "@shuvgeist/root", version: "2.3.4", private: true }),
		);
		writeFileSync(
			join(fixtureRoot, "packages/cli/package.json"),
			JSON.stringify({
				name: "shuvgeist",
				version: "2.3.4",
				description: "fixture",
				dependencies: {
					"@shuvgeist/driver": "2.3.4",
					"@shuvgeist/protocol": "2.3.4",
					"@shuvgeist/server": "2.3.4",
				},
			}),
		);
		writeFileSync(join(fixtureRoot, "static/manifest.chrome.json"), JSON.stringify({ version: "2.3.4" }));
		writeFileSync(join(fixtureRoot, "dist-cli/shuvgeist.mjs"), "#!/usr/bin/env node\n");
		writeFileSync(join(fixtureRoot, "dist-cli/direct-cdp-runtime.mjs"), "export const shipped = true;\n");
		writeFileSync(join(fixtureRoot, "dist-cli/direct-cdp-runtime.mjs.map"), "not shipped");
		writeFileSync(join(fixtureRoot, "skills/shuvgeist/SKILL.md"), "# Shuvgeist\n");
		writeFileSync(join(fixtureRoot, "README.md"), "# Fixture\n");
		writeFileSync(join(fixtureRoot, "LICENSE"), "AGPL-3.0-only\n");
		return fixtureRoot;
	}

	it("stages a dependency-free install package with the direct-CDP export", () => {
		const packageRoot = createFixture();
		const outputDir = join(packageRoot, "release-package");
		const result = stageCliPackage({ packageRoot, outputDir });

		expect(result.manifest).toMatchObject({
			name: "shuvgeist",
			version: "2.3.4",
			bin: { shuvgeist: "dist-cli/shuvgeist.mjs" },
			exports: { "./direct-cdp-runtime": "./dist-cli/direct-cdp-runtime.mjs" },
			engines: { node: ">=22" },
		});
		expect(result.manifest).not.toHaveProperty("dependencies");
		expect(result.manifest).not.toHaveProperty("private");
		expect(readFileSync(join(outputDir, "dist-cli/direct-cdp-runtime.mjs"), "utf8")).toContain(
			"shipped",
		);
		expect(existsSync(join(outputDir, "dist-cli/direct-cdp-runtime.mjs.map"))).toBe(false);
		expect(existsSync(join(outputDir, "skills/shuvgeist/SKILL.md"))).toBe(true);
		expect(packageFiles(outputDir).sort()).toEqual([
			"LICENSE",
			"README.md",
			"dist-cli/direct-cdp-runtime.mjs",
			"dist-cli/shuvgeist.mjs",
			"package.json",
			"skills/shuvgeist/SKILL.md",
		]);
	});

	it("fails closed when the direct-CDP production entry is absent", () => {
		const packageRoot = createFixture();
		rmSync(join(packageRoot, "dist-cli/direct-cdp-runtime.mjs"));

		expect(() => stageCliPackage({ packageRoot })).toThrow(/direct-cdp-runtime\.mjs/);
	});

	it("fails direct source-workspace packing in favor of canonical staging", () => {
		const cliManifest = JSON.parse(readFileSync("packages/cli/package.json", "utf8"));
		expect(cliManifest.scripts?.prepack).toBe("node ./scripts/guard-direct-pack.mjs");

		const result = spawnSync(process.execPath, ["packages/cli/scripts/guard-direct-pack.mjs"], {
			cwd: process.cwd(),
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("npm run package:cli");
	});
});
