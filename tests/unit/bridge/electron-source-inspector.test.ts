import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractElectronSource,
	electronSourceInspectorTestHooks,
	inspectElectronSourceLayout,
	listElectronSource,
	readElectronSourceFile,
} from "@shuvgeist/server/electron/source-inspector";

function pickleString(value: string): Buffer {
	const data = Buffer.from(value, "utf-8");
	const payloadSize = 4 + data.length;
	const paddedSize = Math.ceil(payloadSize / 4) * 4;
	const buffer = Buffer.alloc(4 + paddedSize);
	buffer.writeUInt32LE(payloadSize, 0);
	buffer.writeUInt32LE(data.length, 4);
	data.copy(buffer, 8);
	return buffer;
}

function writeFixtureAsar(path: string): void {
	const appJs = Buffer.from("console.log('asar');\n", "utf-8");
	const unpackedConfig = Buffer.from('{"unpacked":true}', "utf-8");
	const headerJson = JSON.stringify({
		files: {
			"app.js": { size: appJs.length, offset: "0" },
			"config.json": { size: unpackedConfig.length, offset: "0", unpacked: true },
			"linked.js": { link: "app.js" },
		},
	});
	const headerPickle = pickleString(headerJson);
	const sizePickle = Buffer.alloc(8);
	sizePickle.writeUInt32LE(4, 0);
	sizePickle.writeUInt32LE(headerPickle.length, 4);
	writeFileSync(path, Buffer.concat([sizePickle, headerPickle, appJs]));
}

describe("electron source inspector", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "shuvgeist-source-"));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("detects, lists, reads, and extracts unpacked app layouts", async () => {
		const appRoot = join(tempRoot, "resources", "app");
		await mkdir(join(appRoot, "src"), { recursive: true });
		await writeFile(join(appRoot, "package.json"), '{"name":"fixture"}\n');
		await writeFile(join(appRoot, "src", "main.js"), "console.log('unpacked');\n");
		symlinkSync("src/main.js", join(appRoot, "main-link.js"));

		await expect(inspectElectronSourceLayout({ sourcePath: tempRoot })).resolves.toMatchObject({
			kind: "unpacked",
			appPath: appRoot,
		});
		await expect(listElectronSource({ sourcePath: tempRoot })).resolves.toMatchObject({
			entries: expect.arrayContaining([
				{ path: "package.json", type: "file", size: 19 },
				{ path: "src", type: "directory" },
				{ path: "src/main.js", type: "file", size: 25 },
				{ path: "main-link.js", type: "symlink", link: "src/main.js" },
			]),
		});
		await expect(readElectronSourceFile({ sourcePath: tempRoot, filePath: "src/main.js" })).resolves.toMatchObject({
			path: "src/main.js",
			text: "console.log('unpacked');\n",
		});

		const outRoot = join(tempRoot, "out-unpacked");
		await extractElectronSource({ sourcePath: tempRoot, destinationPath: outRoot });
		await expect(readFile(join(outRoot, "src", "main.js"), "utf-8")).resolves.toBe("console.log('unpacked');\n");
	});

	it("detects, lists, reads, and extracts asar layouts with unpacked and symlink entries", async () => {
		const resourcesRoot = join(tempRoot, "resources");
		await mkdir(join(resourcesRoot, "app.asar.unpacked"), { recursive: true });
		const asarPath = join(resourcesRoot, "app.asar");
		writeFixtureAsar(asarPath);
		await writeFile(join(resourcesRoot, "app.asar.unpacked", "config.json"), '{"unpacked":true}');

		await expect(inspectElectronSourceLayout({ sourcePath: tempRoot })).resolves.toMatchObject({
			kind: "asar",
			asarPath,
			unpackedPath: `${asarPath}.unpacked`,
		});
		await expect(listElectronSource({ sourcePath: tempRoot })).resolves.toMatchObject({
			entries: expect.arrayContaining([
				expect.objectContaining({ path: "app.js", type: "file", size: 21 }),
				expect.objectContaining({ path: "config.json", type: "file", unpacked: true }),
				expect.objectContaining({ path: "linked.js", type: "symlink", link: "app.js" }),
			]),
		});
		await expect(readElectronSourceFile({ sourcePath: tempRoot, filePath: "app.js" })).resolves.toMatchObject({
			path: "app.js",
			text: "console.log('asar');\n",
		});
		await expect(readElectronSourceFile({ sourcePath: tempRoot, filePath: "config.json" })).resolves.toMatchObject({
			text: '{"unpacked":true}',
		});

		const outRoot = join(tempRoot, "out-asar");
		await extractElectronSource({ sourcePath: tempRoot, destinationPath: outRoot });
		await expect(readFile(join(outRoot, "app.js"), "utf-8")).resolves.toBe("console.log('asar');\n");
		await expect(readFile(join(outRoot, "config.json"), "utf-8")).resolves.toBe('{"unpacked":true}');
		await expect(lstat(join(outRoot, "linked.js"))).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
		expect((await lstat(join(outRoot, "linked.js"))).isSymbolicLink()).toBe(true);
	});

	it("returns a teaching error for unsupported layouts", async () => {
		await expect(listElectronSource({ sourcePath: tempRoot })).rejects.toThrow(
			"Unsupported or encrypted Electron source layout",
		);
	});

	it("infers packaged roots from shell launcher wrappers", async () => {
		const wrapper = join(tempRoot, "bin", "fixture");
		await mkdir(join(tempRoot, "bin"), { recursive: true });
		await writeFile(wrapper, '#!/usr/bin/env bash\nexec /opt/fixture/bin/fixture "$@"\n');

		await expect(electronSourceInspectorTestHooks.inferExecutableSourceRoots(wrapper)).resolves.toEqual(
			expect.arrayContaining(["/opt/fixture/bin", "/opt/fixture"]),
		);
	});
});
