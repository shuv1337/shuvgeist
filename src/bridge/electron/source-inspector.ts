import { constants as fsConstants } from "node:fs";
import { access, copyFile, mkdir, readdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveElectronApp, resolveExecutable } from "./app-registry.js";

export type ElectronSourceLayoutKind = "asar" | "unpacked" | "unsupported";

export interface ElectronSourceLayout {
	kind: ElectronSourceLayoutKind;
	root: string;
	appPath?: string;
	asarPath?: string;
	unpackedPath?: string;
	message?: string;
}

export interface ElectronSourceEntry {
	path: string;
	type: "file" | "directory" | "symlink";
	size?: number;
	unpacked?: boolean;
	link?: string;
}

interface AsarNode {
	files?: Record<string, AsarNode>;
	size?: number;
	offset?: string;
	unpacked?: boolean;
	link?: string;
}

interface AsarHeader {
	files: Record<string, AsarNode>;
}

interface ParsedAsar {
	path: string;
	header: AsarHeader;
	contentOffset: number;
	unpackedPath: string;
}

export interface ElectronSourceRef {
	sourcePath?: string;
	appRef?: string;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function assertRelativePath(path: string): string {
	const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
	if (!normalized || normalized === "." || normalized.includes("..")) {
		throw new Error("Source file path must be relative and cannot contain '..'");
	}
	return normalized;
}

async function resolveSourceRoot(ref: ElectronSourceRef): Promise<string> {
	if (ref.sourcePath) return resolve(ref.sourcePath);
	if (ref.appRef) {
		const app = resolveElectronApp(ref.appRef);
		if (!app)
			throw new Error(`Unknown Electron app '${ref.appRef}'. Run 'shuvgeist electron list' to see known apps.`);
		const executable = resolveExecutable(app);
		if (!executable) throw new Error(`Electron app '${ref.appRef}' is not installed on this host.`);
		return dirname(executable);
	}
	throw new Error("Usage: shuvgeist electron source <layout|list|read|extract> --source-path <path>");
}

export async function inspectElectronSourceLayout(ref: ElectronSourceRef): Promise<ElectronSourceLayout> {
	const root = await resolveSourceRoot(ref);
	const rootStat = await stat(root).catch(() => undefined);
	if (!rootStat) {
		return { kind: "unsupported", root, message: `Source root does not exist: ${root}` };
	}
	const candidates = rootStat.isFile() ? [root] : [join(root, "resources", "app.asar"), join(root, "app.asar")];
	for (const asarPath of candidates) {
		if (asarPath.endsWith(".asar") && (await pathExists(asarPath))) {
			const unpackedPath = `${asarPath}.unpacked`;
			return {
				kind: "asar",
				root,
				asarPath,
				unpackedPath: (await pathExists(unpackedPath)) ? unpackedPath : undefined,
			};
		}
	}
	const unpackedCandidates = rootStat.isDirectory() ? [join(root, "resources", "app"), join(root, "app"), root] : [];
	for (const appPath of unpackedCandidates) {
		if ((await pathExists(join(appPath, "package.json"))) || (await pathExists(join(appPath, "src")))) {
			return { kind: "unpacked", root, appPath };
		}
	}
	return {
		kind: "unsupported",
		root,
		message: "Unsupported or encrypted Electron source layout. Expected resources/app.asar or resources/app.",
	};
}

function readPickleString(buffer: Buffer): string {
	const payloadSize = buffer.readUInt32LE(0);
	if (payloadSize + 4 > buffer.length) throw new Error("ASAR header pickle is truncated.");
	const stringSize = buffer.readUInt32LE(4);
	const stringStart = 8;
	const stringEnd = stringStart + stringSize;
	if (stringEnd > buffer.length) throw new Error("ASAR header string is truncated.");
	return buffer.subarray(stringStart, stringEnd).toString("utf-8").replace(/\0+$/, "");
}

async function readAsar(path: string): Promise<ParsedAsar> {
	const file = await readFile(path);
	if (file.length < 16) throw new Error("ASAR archive is too small to contain a header.");
	const sizePickleSize = file.readUInt32LE(0);
	const headerSize = file.readUInt32LE(4);
	const headerStart = 4 + sizePickleSize;
	const headerEnd = headerStart + headerSize;
	if (sizePickleSize < 4 || headerEnd > file.length) throw new Error("ASAR archive header is invalid.");
	const headerJson = readPickleString(file.subarray(headerStart, headerEnd));
	const header = JSON.parse(headerJson) as AsarHeader;
	if (!header.files || typeof header.files !== "object") throw new Error("ASAR archive header is missing files.");
	return { path, header, contentOffset: headerEnd, unpackedPath: `${path}.unpacked` };
}

function walkAsarNodes(files: Record<string, AsarNode>, prefix = ""): ElectronSourceEntry[] {
	const entries: ElectronSourceEntry[] = [];
	for (const [name, node] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
		const entryPath = prefix ? `${prefix}/${name}` : name;
		if (node.files) {
			entries.push({ path: entryPath, type: "directory", unpacked: node.unpacked });
			entries.push(...walkAsarNodes(node.files, entryPath));
		} else if (node.link) {
			entries.push({ path: entryPath, type: "symlink", link: node.link, unpacked: node.unpacked });
		} else {
			entries.push({ path: entryPath, type: "file", size: node.size ?? 0, unpacked: node.unpacked });
		}
	}
	return entries;
}

function findAsarNode(header: AsarHeader, relativePath: string): AsarNode | undefined {
	let node: AsarNode | undefined;
	let files: Record<string, AsarNode> | undefined = header.files;
	for (const part of relativePath.split("/")) {
		node = files?.[part];
		files = node?.files;
	}
	return node;
}

async function listDirectory(root: string, prefix = ""): Promise<ElectronSourceEntry[]> {
	const current = prefix ? join(root, prefix) : root;
	const children = await readdir(current, { withFileTypes: true });
	const entries: ElectronSourceEntry[] = [];
	for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
		const entryPath = prefix ? `${prefix}/${child.name}` : child.name;
		const absolute = join(root, entryPath);
		if (child.isDirectory()) {
			entries.push({ path: entryPath, type: "directory" });
			entries.push(...(await listDirectory(root, entryPath)));
		} else if (child.isSymbolicLink()) {
			entries.push({ path: entryPath, type: "symlink", link: await readlink(absolute) });
		} else if (child.isFile()) {
			const info = await stat(absolute);
			entries.push({ path: entryPath, type: "file", size: info.size });
		}
	}
	return entries;
}

async function readAsarFile(parsed: ParsedAsar, relativePath: string): Promise<Buffer> {
	const node = findAsarNode(parsed.header, relativePath);
	if (!node || node.files || node.link) throw new Error(`ASAR source file not found: ${relativePath}`);
	if (node.unpacked) return readFile(join(parsed.unpackedPath, relativePath));
	const offset = Number.parseInt(node.offset ?? "", 10);
	if (!Number.isFinite(offset)) throw new Error(`ASAR source file has no readable offset: ${relativePath}`);
	const archive = await readFile(parsed.path);
	return archive.subarray(parsed.contentOffset + offset, parsed.contentOffset + offset + (node.size ?? 0));
}

export async function listElectronSource(
	ref: ElectronSourceRef,
): Promise<{ layout: ElectronSourceLayout; entries: ElectronSourceEntry[] }> {
	const layout = await inspectElectronSourceLayout(ref);
	if (layout.kind === "unsupported") throw new Error(layout.message ?? "Unsupported Electron source layout.");
	if (layout.kind === "unpacked") return { layout, entries: await listDirectory(layout.appPath ?? layout.root) };
	const parsed = await readAsar(layout.asarPath ?? "");
	return { layout, entries: walkAsarNodes(parsed.header.files) };
}

export async function readElectronSourceFile(
	ref: ElectronSourceRef & { filePath: string },
): Promise<{ layout: ElectronSourceLayout; path: string; text: string }> {
	const filePath = assertRelativePath(ref.filePath);
	const layout = await inspectElectronSourceLayout(ref);
	if (layout.kind === "unsupported") throw new Error(layout.message ?? "Unsupported Electron source layout.");
	const data =
		layout.kind === "unpacked"
			? await readFile(join(layout.appPath ?? layout.root, filePath))
			: await readAsarFile(await readAsar(layout.asarPath ?? ""), filePath);
	return { layout, path: filePath, text: data.toString("utf-8") };
}

async function writeAsarNode(
	parsed: ParsedAsar,
	node: AsarNode,
	relativePath: string,
	destinationRoot: string,
): Promise<void> {
	const destination = join(destinationRoot, relativePath);
	if (node.files) {
		await mkdir(destination, { recursive: true });
		for (const [name, child] of Object.entries(node.files)) {
			await writeAsarNode(parsed, child, relativePath ? `${relativePath}/${name}` : name, destinationRoot);
		}
		return;
	}
	await mkdir(dirname(destination), { recursive: true });
	if (node.link) {
		await symlink(node.link, destination);
		return;
	}
	if (node.unpacked) {
		await copyFile(join(parsed.unpackedPath, relativePath), destination);
		return;
	}
	await writeFile(destination, await readAsarFile(parsed, relativePath));
}

async function copyUnpackedSource(sourceRoot: string, destinationRoot: string): Promise<void> {
	await mkdir(destinationRoot, { recursive: true });
	for (const entry of await listDirectory(sourceRoot)) {
		const source = join(sourceRoot, entry.path);
		const destination = join(destinationRoot, entry.path);
		if (entry.type === "directory") {
			await mkdir(destination, { recursive: true });
		} else if (entry.type === "symlink") {
			await mkdir(dirname(destination), { recursive: true });
			await symlink(await readlink(source), destination);
		} else {
			await mkdir(dirname(destination), { recursive: true });
			await copyFile(source, destination);
		}
	}
}

export async function extractElectronSource(
	ref: ElectronSourceRef & { destinationPath: string },
): Promise<{ layout: ElectronSourceLayout; destinationPath: string; entries: ElectronSourceEntry[] }> {
	const destinationPath = resolve(ref.destinationPath);
	const layout = await inspectElectronSourceLayout(ref);
	if (layout.kind === "unsupported") throw new Error(layout.message ?? "Unsupported Electron source layout.");
	if (layout.kind === "unpacked") {
		const sourceRoot = layout.appPath ?? layout.root;
		await copyUnpackedSource(sourceRoot, destinationPath);
		return { layout, destinationPath, entries: await listDirectory(destinationPath) };
	}
	const parsed = await readAsar(layout.asarPath ?? "");
	await mkdir(destinationPath, { recursive: true });
	for (const [name, node] of Object.entries(parsed.header.files)) {
		await writeAsarNode(parsed, node, name, destinationPath);
	}
	return { layout, destinationPath, entries: await listDirectory(destinationPath) };
}
