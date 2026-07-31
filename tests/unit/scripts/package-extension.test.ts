import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import JSZip from "jszip";
import {
	extensionPackageFiles,
	makeExtensionArchive,
	packageExtension,
	validateExtensionPackage,
} from "../../../packages/extension/scripts/package-extension.mjs";

const reviewedManifest = {
	manifest_version: 3,
	minimum_chrome_version: "141",
	name: "Shuvgeist fixture",
	version: "2.3.4",
	permissions: [
		"storage",
		"unlimitedStorage",
		"activeTab",
		"scripting",
		"sidePanel",
		"userScripts",
		"webNavigation",
		"debugger",
		"cookies",
		"declarativeNetRequest",
		"offscreen",
		"alarms",
	],
	host_permissions: ["<all_urls>"],
};

describe("deterministic extension package", () => {
	let fixtureRoot: string | undefined;

	afterEach(() => {
		if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = undefined;
	});

	function createFixture(): string {
		fixtureRoot = mkdtempSync(join(tmpdir(), "shuvgeist-extension-package-"));
		const distDirectory = join(fixtureRoot, "dist-chrome");
		for (const relativePath of extensionPackageFiles) {
			const destination = join(distDirectory, relativePath);
			mkdirSync(dirname(destination), { recursive: true });
			const iconMatch = /^icon-(16|48|128)\.png$/.exec(relativePath);
			if (iconMatch) {
				copyFileSync(join(process.cwd(), "static", relativePath), destination);
			} else if (relativePath === "manifest.json") {
				writeFileSync(destination, JSON.stringify(reviewedManifest));
			} else {
				writeFileSync(destination, `fixture:${relativePath}\n`);
			}
		}
		return distDirectory;
	}

	it("produces byte-identical sorted archives with fixed dates and modes", async () => {
		const distDirectory = createFixture();
		const first = await makeExtensionArchive(distDirectory);
		for (const relativePath of extensionPackageFiles) {
			utimesSync(join(distDirectory, relativePath), new Date("2026-01-01"), new Date("2026-07-31"));
		}
		const second = await makeExtensionArchive(distDirectory);
		expect(second.equals(first)).toBe(true);

		const archive = await JSZip.loadAsync(first);
		expect(Object.keys(archive.files)).toEqual(extensionPackageFiles);
		for (const entry of Object.values(archive.files)) {
			expect(entry.date.toISOString()).toBe("2000-01-01T00:00:00.000Z");
			expect(entry.unixPermissions).toBe(0o100644);
		}
	});

	it("writes a matching SHA-256 sidecar", async () => {
		const distDirectory = createFixture();
		const outputPath = join(fixtureRoot ?? "", "shuvgeist.zip");
		const result = await packageExtension({ distDirectory, outputPath, repoRoot: fixtureRoot });
		const archive = readFileSync(outputPath);
		const expectedDigest = createHash("sha256").update(archive).digest("hex");

		expect(result.digest).toBe(expectedDigest);
		expect(readFileSync(result.digestPath, "utf8")).toBe(`${expectedDigest}  shuvgeist.zip\n`);
	});

	it("fails closed on source maps, unexpected files, and missing files", async () => {
		const distDirectory = createFixture();
		writeFileSync(join(distDirectory, "background.js.map"), "{}");
		await expect(validateExtensionPackage(distDirectory)).rejects.toThrow("must not contain source maps");

		rmSync(join(distDirectory, "background.js.map"));
		writeFileSync(join(distDirectory, "surprise.js"), "");
		await expect(validateExtensionPackage(distDirectory)).rejects.toThrow("unexpected: surprise.js");

		rmSync(join(distDirectory, "surprise.js"));
		rmSync(join(distDirectory, "background.js"));
		await expect(validateExtensionPackage(distDirectory)).rejects.toThrow("missing: background.js");
	});

	it("fails closed when reviewed manifest permissions drift", async () => {
		const distDirectory = createFixture();
		writeFileSync(
			join(distDirectory, "manifest.json"),
			JSON.stringify({ ...reviewedManifest, permissions: [...reviewedManifest.permissions, "downloads"] }),
		);
		await expect(validateExtensionPackage(distDirectory)).rejects.toThrow("permissions differ");

		writeFileSync(
			join(distDirectory, "manifest.json"),
			JSON.stringify({ ...reviewedManifest, host_permissions: ["https://example.com/*"] }),
		);
		await expect(validateExtensionPackage(distDirectory)).rejects.toThrow("host permissions differ");

		writeFileSync(
			join(distDirectory, "manifest.json"),
			JSON.stringify({ ...reviewedManifest, optional_permissions: ["downloads"] }),
		);
		await expect(validateExtensionPackage(distDirectory)).rejects.toThrow("unreviewed optional permissions");
	});
});
