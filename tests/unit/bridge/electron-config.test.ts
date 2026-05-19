import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	allowElectronApp,
	DEFAULT_ELECTRON_PORT_RANGE,
	normalizeElectronConfig,
	readBridgeConfig,
} from "../../../src/bridge/electron/config.js";

describe("electron bridge config", () => {
	it("normalizes defaults without touching extension-owned settings", () => {
		expect(normalizeElectronConfig({}).portRange).toEqual(DEFAULT_ELECTRON_PORT_RANGE);
		expect(normalizeElectronConfig({ electron: { allowlist: ["a", "a", ""] } }).allowlist).toEqual(["a"]);
	});

	it("persists allowlisted app ids in bridge config", () => {
		const dir = mkdtempSync(join(tmpdir(), "shuvgeist-electron-config-"));
		const path = join(dir, "bridge.json");
		try {
			allowElectronApp("com.microsoft.VSCode", path);
			allowElectronApp("com.microsoft.VSCode", path);
			expect(readBridgeConfig(path).electron?.allowlist).toEqual(["com.microsoft.VSCode"]);
			expect(JSON.parse(readFileSync(path, "utf-8"))).toMatchObject({
				electron: { allowlist: ["com.microsoft.VSCode"] },
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
