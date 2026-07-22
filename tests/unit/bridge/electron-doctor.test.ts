import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runElectronDoctor } from "@shuvgeist/server/electron/doctor";
import { SKILL_SNAPSHOT_VERSION } from "@shuvgeist/protocol/skill-snapshot";

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

	it("fails closed with the exact malformed bridge config path", async () => {
		const path = join(tempRoot, "bridge.json");
		writeFileSync(path, '{ "token": ');

		await expect(runElectronDoctor()).rejects.toMatchObject({ code: "INVALID_JSON", path });
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

	it("discovers a requested app CDP port outside the configured launch range", async () => {
		writeFileSync(
			join(tempRoot, "bridge.json"),
			JSON.stringify({ token: "secret", electron: { allowlist: ["codex-desktop"], portRange: [9330, 9330] } }),
		);
		const requestedUrls: string[] = [];
		globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.includes(":9228/")) {
				return {
					ok: true,
					json: async () => ({
						Browser: "Chrome/148.0.7778.97",
						webSocketDebuggerUrl: "ws://127.0.0.1:9228/devtools/browser/codex",
					}),
				};
			}
			return { ok: false, json: async () => ({}) };
		}) as typeof fetch;

		const result = await runElectronDoctor({
			appRef: "codex",
			listProcesses: async () => [
				{
					pid: 202,
					command: "/opt/codex-desktop/codex-desktop-electron --remote-debugging-port=9228",
					args: [
						"/opt/codex-desktop/codex-desktop-electron",
						"--remote-debugging-port=9228",
					],
					executablePath: "/opt/codex-desktop/codex-desktop-electron",
				},
			],
			listeningPidsForPort: async () => [202],
		});

		expect(requestedUrls).toEqual(["http://127.0.0.1:9228/json/version"]);
		expect(result.runningCdpApps).toEqual([
			{
				port: 9228,
				browser: "Chrome/148.0.7778.97",
				webSocketDebuggerUrl: "ws://127.0.0.1:9228/devtools/browser/codex",
			},
		]);
		expect(result.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "running_cdp", status: "pass" }),
				expect.objectContaining({ id: "chromium_version", status: "pass" }),
			]),
		);
	});

	it("does not confuse code with codex or trust a port owned by another PID", async () => {
		writeFileSync(
			join(tempRoot, "bridge.json"),
			JSON.stringify({ token: "secret", electron: { allowlist: ["codex-desktop"], portRange: [9330, 9330] } }),
		);
		const fetchMock = vi.fn(async () => ({
			ok: true,
			json: async () => ({ Browser: "unrelated" }),
		}));
		globalThis.fetch = fetchMock as typeof fetch;

		const result = await runElectronDoctor({
			appRef: "codex",
			listProcesses: async () => [
				{
					pid: 101,
					command: "/usr/bin/code --remote-debugging-port=9228 --label=codex",
					args: ["/usr/bin/code", "--remote-debugging-port=9228", "--label=codex"],
					executablePath: "/usr/bin/code",
				},
				{
					pid: 202,
					command: "/opt/codex-desktop/codex-desktop-electron --remote-debugging-port=9228",
					args: [
						"/opt/codex-desktop/codex-desktop-electron",
						"--remote-debugging-port=9228",
					],
					executablePath: "/opt/codex-desktop/codex-desktop-electron",
				},
			],
			listeningPidsForPort: async () => [101],
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.runningCdpApps).toEqual([]);
		expect(result.checks).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "running_cdp", status: "warn" })]),
		);
	});

	it("reports unavailable listener ownership instead of treating it as no owner", async () => {
		writeFileSync(
			join(tempRoot, "bridge.json"),
			JSON.stringify({ token: "secret", electron: { allowlist: ["codex-desktop"] } }),
		);
		const fetchMock = vi.fn();
		globalThis.fetch = fetchMock as typeof fetch;

		const result = await runElectronDoctor({
			appRef: "codex",
			listProcesses: async () => [
				{
					pid: 202,
					command: "/opt/codex-desktop/codex-desktop-electron --remote-debugging-port=9228",
					args: ["/opt/codex-desktop/codex-desktop-electron", "--remote-debugging-port=9228"],
					executablePath: "/opt/codex-desktop/codex-desktop-electron",
				},
			],
			listeningPidsForPort: async () => undefined,
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "port_ownership", status: "warn" }),
				expect.objectContaining({
					id: "running_cdp",
					status: "warn",
					detail: expect.stringContaining("could not be verified"),
				}),
			]),
		);
	});

	it("checks the requested app instead of accepting another allowlisted app", async () => {
		writeFileSync(
			join(tempRoot, "bridge.json"),
			JSON.stringify({ token: "secret", electron: { allowlist: ["com.microsoft.VSCode"] } }),
		);

		const result = await runElectronDoctor({
			appRef: "codex",
			listProcesses: async () => [],
			listeningPidsForPort: async () => [],
		});

		expect(result.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "allowlist",
					status: "warn",
					detail: "Codex Desktop is not allowlisted",
				}),
			]),
		);
	});
});
