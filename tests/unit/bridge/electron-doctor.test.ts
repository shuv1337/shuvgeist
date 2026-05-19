import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runElectronDoctor } from "../../../src/bridge/electron/doctor.js";
import { SKILL_SNAPSHOT_VERSION } from "../../../src/bridge/skill-snapshot.js";

describe("electron doctor", () => {
	let tempRoot: string;
	let originalFetch: typeof fetch;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "shuvgeist-doctor-"));
		originalFetch = globalThis.fetch;
		vi.stubEnv("SHUVGEIST_BRIDGE_CONFIG", join(tempRoot, "bridge.json"));
		vi.stubEnv("SHUVGEIST_SKILL_SNAPSHOT", join(tempRoot, "skills.snapshot.json"));
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.unstubAllEnvs();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("reports broken fixtures with actionable fixes", async () => {
		globalThis.fetch = vi.fn(() => Promise.reject(new Error("closed"))) as typeof fetch;

		const result = await runElectronDoctor();

		expect(result.ok).toBe(false);
		expect(result.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "token_file", status: "fail" }),
				expect.objectContaining({ id: "allowlist", status: "warn" }),
				expect.objectContaining({ id: "skill_snapshot", status: "warn" }),
				expect.objectContaining({ id: "running_cdp", status: "warn" }),
			]),
		);
		expect(result.fixes.length).toBeGreaterThan(0);
		expect(result.text).toContain("Electron doctor");
	});

	it("reports healthy token, snapshot, allowlist, and CDP fixtures", async () => {
		writeFileSync(
			join(tempRoot, "bridge.json"),
			JSON.stringify({ token: "secret", electron: { allowlist: ["com.microsoft.VSCode"], portRange: [9330, 9330] } }),
		);
		writeFileSync(
			join(tempRoot, "skills.snapshot.json"),
			JSON.stringify({
				version: SKILL_SNAPSHOT_VERSION,
				generatedAt: new Date().toISOString(),
				skills: [],
			}),
		);
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ Browser: "Electron/30.0.0", webSocketDebuggerUrl: "ws://127.0.0.1:9330/devtools" }),
		})) as typeof fetch;

		const result = await runElectronDoctor();

		expect(result.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "token_file", status: "pass" }),
				expect.objectContaining({ id: "token_value", status: "pass" }),
				expect.objectContaining({ id: "allowlist", status: "pass" }),
				expect.objectContaining({ id: "skill_snapshot", status: "pass" }),
				expect.objectContaining({ id: "running_cdp", status: "pass" }),
				expect.objectContaining({ id: "chromium_version", status: "pass" }),
			]),
		);
		expect(result.runningCdpApps).toEqual([
			{ port: 9330, browser: "Electron/30.0.0", webSocketDebuggerUrl: "ws://127.0.0.1:9330/devtools" },
		]);
	});
});
