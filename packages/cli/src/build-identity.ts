import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildIdentity } from "@shuvgeist/protocol/version";
import { getInjectedBuildIdentity } from "@shuvgeist/protocol/version";
import { computeSourceBuildIdentity } from "@shuvgeist/server/build-identity";

declare const __SHUVGEIST_DEV_ROOT__: string;

export function resolveDevelopmentRoot(): string | undefined {
	return typeof __SHUVGEIST_DEV_ROOT__ === "string" && __SHUVGEIST_DEV_ROOT__.length > 0
		? __SHUVGEIST_DEV_ROOT__
		: resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function resolveCliBuildIdentity(developmentRoot = resolveDevelopmentRoot()): BuildIdentity {
	const injected = getInjectedBuildIdentity();
	if (injected) return injected;
	if (!developmentRoot) {
		throw new Error("Cannot compute the Shuvgeist development build identity without a source root");
	}
	return computeSourceBuildIdentity(developmentRoot, "development");
}
