declare const __SHUVGEIST_VERSION__: string;
declare const __SHUVGEIST_BUILD_ID__: string;
declare const __SHUVGEIST_BUILD_KIND__: BuildKind;
declare const chrome:
	| {
			runtime?: {
				getManifest?: () => { version: string };
			};
	  }
	| undefined;

export type BuildKind = "development" | "release";

export interface BuildIdentity {
	id: string;
	kind: BuildKind;
}

export function getShuvgeistVersion(): string {
	if (typeof __SHUVGEIST_VERSION__ !== "undefined") {
		return __SHUVGEIST_VERSION__;
	}

	const extensionChrome = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome;
	if (extensionChrome?.runtime?.getManifest) {
		return extensionChrome.runtime.getManifest().version;
	}

	return "dev";
}

export function getInjectedBuildIdentity(): BuildIdentity | undefined {
	if (
		typeof __SHUVGEIST_BUILD_ID__ === "string" &&
		__SHUVGEIST_BUILD_ID__.length > 0 &&
		typeof __SHUVGEIST_BUILD_KIND__ === "string" &&
		(__SHUVGEIST_BUILD_KIND__ === "development" || __SHUVGEIST_BUILD_KIND__ === "release")
	) {
		return { id: __SHUVGEIST_BUILD_ID__, kind: __SHUVGEIST_BUILD_KIND__ };
	}
	return undefined;
}
