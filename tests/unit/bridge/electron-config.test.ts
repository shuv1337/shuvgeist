import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	allowElectronApp,
	DEFAULT_ELECTRON_PORT_RANGE,
	normalizeElectronConfig,
} from "@shuvgeist/server/electron/config";
import { createNodeConfigOwner, NodeConfigError } from "@shuvgeist/server/node-config";

function ownerFor(path: string) {
	return createNodeConfigOwner({ env: { SHUVGEIST_BRIDGE_CONFIG: path } });
}

describe("electron bridge config", () => {
	it("normalizes defaults without touching extension-owned settings", () => {
		expect(normalizeElectronConfig({}).portRange).toEqual(DEFAULT_ELECTRON_PORT_RANGE);
		expect(normalizeElectronConfig({ electron: { allowlist: ["a", "a", ""] } }).allowlist).toEqual(["a"]);
	});

	it("persists allowlisted app ids in bridge config", () => {
		const dir = mkdtempSync(join(tmpdir(), "shuvgeist-electron-config-"));
		const path = join(dir, "bridge.json");
		const owner = ownerFor(path);
		try {
			allowElectronApp("com.microsoft.VSCode", owner);
			allowElectronApp("com.microsoft.VSCode", owner);
			expect(owner.readBridgeConfig().electron?.allowlist).toEqual(["com.microsoft.VSCode"]);
			expect(JSON.parse(readFileSync(path, "utf-8"))).toMatchObject({
				electron: { allowlist: ["com.microsoft.VSCode"] },
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("preserves unknown fields and fails closed on malformed config", () => {
		const dir = mkdtempSync(join(tmpdir(), "shuvgeist-electron-config-"));
		const path = join(dir, "bridge.json");
		const owner = ownerFor(path);
		try {
			writeFileSync(
				path,
				JSON.stringify({
					futureTopLevel: { keep: true },
					electron: { futureElectron: { keep: true }, allowlist: ["existing"] },
				}),
			);
			allowElectronApp("com.microsoft.VSCode", owner);
			expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
				futureTopLevel: { keep: true },
				electron: {
					futureElectron: { keep: true },
					allowlist: ["existing", "com.microsoft.VSCode"],
				},
			});

			writeFileSync(path, '{ "electron": ');
			expect(() => owner.readBridgeConfig()).toThrowError(
				expect.objectContaining<NodeConfigError>({ code: "INVALID_JSON", path }),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
