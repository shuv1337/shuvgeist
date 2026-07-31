import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";

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

function collectFiles(root, relativePath) {
	const absolutePath = join(root, relativePath);
	const stats = statSync(absolutePath);
	if (stats.isFile()) return [relativePath];
	if (!stats.isDirectory())
		throw new Error(`Build identity input is not a regular file or directory: ${relativePath}`);

	return readdirSync(absolutePath)
		.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
		.flatMap((entry) => collectFiles(root, posix.join(relativePath, entry)));
}

export function computeSourceBuildDigest(repositoryRoot, inputs = BUILD_IDENTITY_INPUTS) {
	const root = resolve(repositoryRoot);
	const files = inputs.flatMap((input) => collectFiles(root, input)).sort();
	const hash = createHash("sha256");
	for (const relativePath of files) {
		const absolutePath = join(root, relativePath);
		const normalizedPath = relative(root, absolutePath).split("\\").join("/");
		const data = readFileSync(absolutePath);
		hash.update(`${normalizedPath.length}:${normalizedPath}:${data.length}:`);
		hash.update(data);
		hash.update("\n");
	}
	return hash.digest("hex");
}

export function computeBuildIdentity(repositoryRoot, kind = "development") {
	if (kind !== "development" && kind !== "release") {
		throw new Error(`Unsupported Shuvgeist build kind: ${kind}`);
	}
	const digest = computeSourceBuildDigest(repositoryRoot);
	return { id: `${kind}-${digest.slice(0, 24)}`, kind };
}
