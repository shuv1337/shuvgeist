import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import JSZip from "jszip";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = join(scriptDirectory, "../../..");
const fixedArchiveDate = new Date("2000-01-01T00:00:00.000Z");

export const extensionPackageFiles = Object.freeze([
	"app.css",
	"background.js",
	"cors-rules.json",
	"debug.html",
	"debug.js",
	"icon-128.png",
	"icon-16.png",
	"icon-48.png",
	"icons.html",
	"icons.js",
	"manifest.json",
	"offscreen.html",
	"offscreen.js",
	"page-ref-action-runtime.js",
	"pdfjs-dist/build/pdf.worker.min.mjs",
	"sandbox.html",
	"sandbox.js",
	"sidepanel.html",
	"sidepanel.js",
	"theme-loader.js",
	"tts-overlay-runtime.js",
]);

const reviewedPermissions = Object.freeze([
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
	"tabCapture",
	"alarms",
]);
const reviewedHostPermissions = Object.freeze(["<all_urls>"]);

function arraysEqual(actual, expected) {
	return (
		Array.isArray(actual) &&
		actual.length === expected.length &&
		actual.every((value, index) => value === expected[index])
	);
}

function isChromeExtensionVersion(version) {
	if (typeof version !== "string") return false;
	const components = version.split(".");
	return (
		components.length >= 1 &&
		components.length <= 4 &&
		components.every((component) => {
			if (!/^\d+$/.test(component) || (component.length > 1 && component.startsWith("0"))) return false;
			const value = Number(component);
			return Number.isInteger(value) && value >= 0 && value <= 65_535;
		})
	);
}

async function listFiles(directory, prefix = "") {
	const files = [];
	const entries = await readdir(join(directory, prefix), { withFileTypes: true });
	entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	for (const entry of entries) {
		const relativePath = posix.join(prefix, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(directory, relativePath)));
		} else if (entry.isFile()) {
			files.push(relativePath);
		} else {
			throw new Error(`Extension package contains an unsupported entry: ${relativePath}`);
		}
	}
	return files;
}

async function readManifest(distDirectory) {
	const parsed = JSON.parse(await readFile(join(distDirectory, "manifest.json"), "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Extension manifest must be an object");
	}
	return parsed;
}

async function validateIcon(distDirectory, size) {
	const png = await readFile(join(distDirectory, `icon-${size}.png`));
	if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.toString("ascii", 1, 4) !== "PNG") {
		throw new Error(`Extension icon ${size} is not a PNG`);
	}
	if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
		throw new Error(`Extension icon ${size} has incorrect dimensions`);
	}
}

export async function validateExtensionPackage(distDirectory) {
	const files = await listFiles(distDirectory);
	if (files.some((file) => file.endsWith(".map"))) {
		throw new Error("Extension package must not contain source maps");
	}
	if (!arraysEqual(files, extensionPackageFiles)) {
		const unexpected = files.filter((file) => !extensionPackageFiles.includes(file));
		const missing = extensionPackageFiles.filter((file) => !files.includes(file));
		throw new Error(
			`Extension package file allowlist mismatch; unexpected: ${unexpected.join(", ") || "(none)"}; missing: ${
				missing.join(", ") || "(none)"
			}`,
		);
	}

	const manifest = await readManifest(distDirectory);
	if (manifest.manifest_version !== 3 || manifest.minimum_chrome_version !== "141") {
		throw new Error("Extension manifest must target Manifest V3 and Chrome 141 or later");
	}
	if (!isChromeExtensionVersion(manifest.version)) {
		throw new Error("Extension manifest has an invalid Chrome version");
	}
	if (!arraysEqual(manifest.permissions, reviewedPermissions)) {
		throw new Error("Extension manifest permissions differ from the reviewed allowlist");
	}
	if (!arraysEqual(manifest.host_permissions, reviewedHostPermissions)) {
		throw new Error("Extension manifest host permissions differ from the reviewed allowlist");
	}
	if (Reflect.has(manifest, "optional_permissions") || Reflect.has(manifest, "optional_host_permissions")) {
		throw new Error("Extension manifest must not declare unreviewed optional permissions");
	}

	await Promise.all([16, 48, 128].map((size) => validateIcon(distDirectory, size)));
	return { files, version: manifest.version };
}

export async function makeExtensionArchive(distDirectory) {
	const { files } = await validateExtensionPackage(distDirectory);
	const archive = new JSZip();
	for (const relativePath of files) {
		archive.file(relativePath, await readFile(join(distDirectory, relativePath)), {
			binary: true,
			createFolders: false,
			date: fixedArchiveDate,
			unixPermissions: 0o100644,
		});
	}
	return archive.generateAsync({
		type: "nodebuffer",
		platform: "UNIX",
		compression: "DEFLATE",
		compressionOptions: { level: 9 },
		streamFiles: true,
	});
}

export async function packageExtension(options = {}) {
	const repoRoot = options.repoRoot ?? defaultRepoRoot;
	const distDirectory = options.distDirectory ?? join(repoRoot, "dist-chrome");
	const outputPath = options.outputPath ?? join(repoRoot, "shuvgeist.zip");
	const archive = await makeExtensionArchive(distDirectory);
	const digest = createHash("sha256").update(archive).digest("hex");
	const digestPath = `${outputPath}.sha256`;
	await writeFile(outputPath, archive);
	await writeFile(digestPath, `${digest}  ${relative(dirname(outputPath), outputPath)}\n`, "utf8");
	return { outputPath, digestPath, digest, sizeBytes: archive.length };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const result = await packageExtension();
	process.stdout.write(
		`${relative(defaultRepoRoot, result.outputPath)} sha256:${result.digest} (${result.sizeBytes} bytes)\n`,
	);
}
