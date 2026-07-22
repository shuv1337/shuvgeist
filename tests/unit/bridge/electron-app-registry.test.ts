import {
	KNOWN_ELECTRON_APPS,
	listElectronRegistryEntries,
	resolveElectronApp,
} from "@shuvgeist/server/electron/app-registry";

describe("electron app registry", () => {
	it("resolves known app aliases to canonical ids", () => {
		expect(resolveElectronApp("vscode")?.id).toBe("com.microsoft.VSCode");
		expect(resolveElectronApp("code")?.id).toBe("com.microsoft.VSCode");
		expect(resolveElectronApp("shuvscode")?.id).toBe("dev.shuv.shuvscode");
		expect(resolveElectronApp("shuvcode")).toBeUndefined();
		expect(resolveElectronApp("codex")?.id).toBe("codex-desktop");
		expect(resolveElectronApp("codex-desktop")?.id).toBe("codex-desktop");
		expect(resolveElectronApp("Codex")?.id).toBe("codex-desktop");
		expect(resolveElectronApp("legcord")?.id).toBe("dev.legcord.Legcord");
		expect(resolveElectronApp("signal")?.id).toBe("org.signal.Signal");
		expect(resolveElectronApp("signal-desktop")?.id).toBe("org.signal.Signal");
		expect(resolveElectronApp("obsidian")?.id).toBe("md.obsidian.Obsidian");
		expect(resolveElectronApp("missing-app")).toBeUndefined();
	});

	it("includes the verified Codex Desktop Linux wrapper and runtime paths", () => {
		const codex = KNOWN_ELECTRON_APPS.find((app) => app.id === "codex-desktop");

		expect(codex).toMatchObject({
			aliases: ["codex"],
			displayName: "Codex Desktop",
			singleInstance: "strict",
			mainInspectSupported: false,
		});
		expect(codex?.paths.linux).toEqual(
			expect.arrayContaining([
				"/usr/bin/codex-desktop",
				"/opt/codex-desktop/codex-desktop-electron",
			]),
		);
	});

	it("lists known apps with allowlist state", () => {
		const entries = listElectronRegistryEntries(new Set(["com.microsoft.VSCode", "dev.shuv.shuvscode"]));
		expect(entries.find((entry) => entry.id === "com.microsoft.VSCode")).toMatchObject({
			allowed: true,
			displayName: "Visual Studio Code",
		});
		expect(entries.find((entry) => entry.id === "dev.shuv.shuvscode")).toMatchObject({
			allowed: true,
			displayName: "shuvscode",
		});
		expect(entries.find((entry) => entry.id === "codex-desktop")).toMatchObject({
			allowed: false,
			displayName: "Codex Desktop",
			aliases: ["codex"],
		});
		expect(entries.find((entry) => entry.id === "com.tinyspeck.slackmacgap")).toMatchObject({
			allowed: false,
			displayName: "Slack",
		});
		expect(entries.find((entry) => entry.id === "dev.legcord.Legcord")).toMatchObject({
			allowed: false,
			displayName: "Legcord",
		});
		expect(entries.find((entry) => entry.id === "org.signal.Signal")).toMatchObject({
			allowed: false,
			displayName: "Signal",
		});
		expect(entries.find((entry) => entry.id === "md.obsidian.Obsidian")).toMatchObject({
			allowed: false,
			displayName: "Obsidian",
		});
	});
});
