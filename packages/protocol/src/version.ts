declare const __SHUVGEIST_VERSION__: string;
declare const chrome:
	| {
			runtime?: {
				getManifest?: () => { version: string };
			};
	  }
	| undefined;

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
