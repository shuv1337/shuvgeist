import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeSourceBuildDigest } from "@shuvgeist/server/build-identity";
import { computeSourceBuildDigest as computeScriptBuildDigest } from "../../../scripts/build-identity.mjs";

describe("exact build identity", () => {
	it("matches the build script and ignores files outside the bounded input set", () => {
		const root = mkdtempSync(join(tmpdir(), "shuvgeist-build-identity-"));
		const inputs = ["package-lock.json", "packages/cli/src"];
		const sourceDirectory = join(root, "packages/cli/src");
		mkdirSync(sourceDirectory, { recursive: true });
		writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
		writeFileSync(join(sourceDirectory, "cli.ts"), "export const value = 1;\n");
		try {
			const initial = computeSourceBuildDigest(root, undefined, inputs);
			expect(computeScriptBuildDigest(root, inputs)).toBe(initial);

			writeFileSync(join(root, "unrelated.txt"), "not part of the runtime build\n");
			expect(computeSourceBuildDigest(root, undefined, inputs)).toBe(initial);

			writeFileSync(join(sourceDirectory, "cli.ts"), "export const value = 2;\n");
			const sourceChanged = computeSourceBuildDigest(root, undefined, inputs);
			expect(sourceChanged).not.toBe(initial);
			expect(computeScriptBuildDigest(root, inputs)).toBe(sourceChanged);

			writeFileSync(join(root, "package-lock.json"), '{"lockfileVersion":3,"changed":true}\n');
			expect(computeSourceBuildDigest(root, undefined, inputs)).not.toBe(sourceChanged);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
