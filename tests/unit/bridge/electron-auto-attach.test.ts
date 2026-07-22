import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@shuvgeist/server/electron/app-registry", () => ({
	resolveElectronApp: (appRef: string) =>
		appRef === "fixture"
			? {
					id: "com.example.Fixture",
					aliases: ["fixture"],
					displayName: "Fixture",
					paths: {},
					defaultArgs: [],
					singleInstance: "unknown",
					mainInspectSupported: true,
				}
			: undefined,
	resolveExecutable: () => "/opt/fixture/fixture",
}));

describe("electron auto attach", () => {
	let tempRoot: string;
	let originalPlatform: PropertyDescriptor | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "shuvgeist-auto-attach-"));
		vi.stubEnv("HOME", tempRoot);
		originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "linux" });
	});

	afterEach(() => {
		if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
		vi.unstubAllEnvs();
		rmSync(tempRoot, { recursive: true, force: true });
		vi.resetModules();
	});

	it("installs, reports, and uninstalls a reversible Linux shim idempotently", async () => {
		const { manageElectronAutoAttach } = await import("@shuvgeist/server/electron/auto-attach");

		const installed = await manageElectronAutoAttach("install", "fixture");
		expect(installed.installed).toBe(true);
		expect(installed.path).toBe(join(tempRoot, ".local", "bin", "shuvgeist-electron-com-example-Fixture"));
		expect(await lstat(installed.path ?? "")).toMatchObject({ isSymbolicLink: expect.any(Function) });
		expect(await readFile(`${installed.path}.shuvgeist-electron-shim`, "utf-8")).toContain(
			"--remote-debugging-port",
		);

		await expect(manageElectronAutoAttach("install", "fixture")).resolves.toMatchObject({ installed: true });
		await expect(manageElectronAutoAttach("status", "fixture")).resolves.toMatchObject({ installed: true });
		await expect(manageElectronAutoAttach("uninstall", "fixture")).resolves.toMatchObject({ installed: false });
		expect(existsSync(installed.path ?? "")).toBe(false);
	});
});
