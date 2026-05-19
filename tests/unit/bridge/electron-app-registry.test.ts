import { listElectronRegistryEntries, resolveElectronApp } from "../../../src/bridge/electron/app-registry.js";

describe("electron app registry", () => {
	it("resolves known app aliases to canonical ids", () => {
		expect(resolveElectronApp("vscode")?.id).toBe("com.microsoft.VSCode");
		expect(resolveElectronApp("code")?.id).toBe("com.microsoft.VSCode");
		expect(resolveElectronApp("missing-app")).toBeUndefined();
	});

	it("lists known apps with allowlist state", () => {
		const entries = listElectronRegistryEntries(new Set(["com.microsoft.VSCode"]));
		expect(entries.find((entry) => entry.id === "com.microsoft.VSCode")).toMatchObject({
			allowed: true,
			displayName: "Visual Studio Code",
		});
		expect(entries.find((entry) => entry.id === "com.tinyspeck.slackmacgap")).toMatchObject({
			allowed: false,
			displayName: "Slack",
		});
	});
});
