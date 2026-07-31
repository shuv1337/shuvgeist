import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";
import type { BuildIdentity, BuildKind } from "@shuvgeist/protocol/version";

export const BUILD_IDENTITY_INPUTS = Object.freeze([
	"package.json",
	"package-lock.json",
	"scripts/build-identity.mjs",
	"scripts/injected-artifacts.mjs",
	"static",
	"packages/protocol/package.json",
	"packages/protocol/src",
	"packages/driver/package.json",
	"packages/driver/src",
	"packages/extension/package.json",
	"packages/extension/scripts",
	"packages/extension/src",
	"packages/server/package.json",
	"packages/server/src",
	"packages/cli/package.json",
	"packages/cli/scripts",
	"packages/cli/src",
]);

export interface BuildIdentityFileSystem {
	readFileSync(path: string): Buffer;
	readdirSync(path: string): string[];
	statSync(path: string): { isDirectory(): boolean; isFile(): boolean };
}

const defaultFileSystem: BuildIdentityFileSystem = {
	readFileSync: (path) => readFileSync(path),
	readdirSync: (path) => readdirSync(path),
	statSync: (path) => statSync(path),
};

function collectFiles(root: string, relativePath: string, fileSystem: BuildIdentityFileSystem): string[] {
	const absolutePath = join(root, relativePath);
	const stats = fileSystem.statSync(absolutePath);
	if (stats.isFile()) return [relativePath];
	if (!stats.isDirectory())
		throw new Error(`Build identity input is not a regular file or directory: ${relativePath}`);

	return fileSystem
		.readdirSync(absolutePath)
		.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
		.flatMap((entry) => collectFiles(root, posix.join(relativePath, entry), fileSystem));
}

export function computeSourceBuildDigest(
	repositoryRoot: string,
	fileSystem: BuildIdentityFileSystem = defaultFileSystem,
	inputs: readonly string[] = BUILD_IDENTITY_INPUTS,
): string {
	const root = resolve(repositoryRoot);
	const files = inputs.flatMap((input) => collectFiles(root, input, fileSystem)).sort();
	const hash = createHash("sha256");
	for (const relativePath of files) {
		const absolutePath = join(root, relativePath);
		const normalizedPath = relative(root, absolutePath).split("\\").join("/");
		const data = fileSystem.readFileSync(absolutePath);
		hash.update(`${normalizedPath.length}:${normalizedPath}:${data.length}:`);
		hash.update(data);
		hash.update("\n");
	}
	return hash.digest("hex");
}

export function computeSourceBuildIdentity(repositoryRoot: string, kind: BuildKind): BuildIdentity {
	const digest = computeSourceBuildDigest(repositoryRoot);
	return { id: `${kind}-${digest.slice(0, 24)}`, kind };
}
