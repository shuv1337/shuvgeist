/**
 * Unit tests for the pure helpers exported by `packages/cli/src/launcher.ts`.
 *
 * The full `launchBrowser` flow spawns a real browser process and polls a
 * bridge HTTP endpoint, so it is exercised by integration / e2e tests rather
 * than here. The user-data-dir resolution rules, however, are pure and worth
 * locking in unit tests so the contract does not regress: by default we
 * isolate Shuvgeist into its own per-browser profile under `~/.shuvgeist`
 * (so the launched browser does not collide with a user's already-open
 * Chrome/Helium/Brave instance), and `useDefaultProfile` is the explicit
 * opt-out.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { launchBrowser, resolveUserDataDir } from "shuvgeist/launcher";
import type {
	DiscoveryDefaults,
	DiscoveryOverrides,
	NodeConfigOwner,
	ResolvedDiscoveryCandidates,
} from "@shuvgeist/server/node-config";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("resolveUserDataDir", () => {
	it("defaults to an isolated, per-browser, persistent Shuvgeist-managed directory", () => {
		expect(resolveUserDataDir({}, "chrome", "/home/example")).toBe(
			"/home/example/.shuvgeist/profile/chrome",
		);
		expect(resolveUserDataDir({}, "helium", "/home/example")).toBe(
			"/home/example/.shuvgeist/profile/helium",
		);
	});

	it("returns undefined when useDefaultProfile is set, so no --user-data-dir is passed", () => {
		expect(resolveUserDataDir({ useDefaultProfile: true }, "chrome", "/home/example")).toBeUndefined();
		// useDefaultProfile wins even if userDataDir is also set, because the
		// flag's documented intent is "share the user's real profile" and we
		// should not silently override that with a path the user happened to
		// also pass.
		expect(
			resolveUserDataDir(
				{ useDefaultProfile: true, userDataDir: "/tmp/ignored" },
				"chrome",
				"/home/example",
			),
		).toBeUndefined();
	});

	it("honors an explicit absolute userDataDir verbatim", () => {
		expect(resolveUserDataDir({ userDataDir: "/var/tmp/sg" }, "chrome", "/home/example")).toBe(
			"/var/tmp/sg",
		);
	});

	it("resolves a relative userDataDir to an absolute path", () => {
		const resolved = resolveUserDataDir(
			{ userDataDir: "relative/path" },
			"chrome",
			"/home/example",
		);
		// path.resolve makes the result absolute against the test process cwd.
		// We do not assert on the cwd portion — just that no relative prefix
		// leaks through, since Chromium rejects relative --user-data-dir args
		// silently on some platforms.
		expect(resolved?.startsWith("/")).toBe(true);
		expect(resolved?.endsWith("relative/path")).toBe(true);
	});
});

describe("launchBrowser discovery ownership", () => {
	it("threads one injected NodeConfigOwner through browser and extension discovery", async () => {
		const browserPath = "/virtual/google-chrome";
		const extensionPath = "/virtual/shuvgeist-extension";
		const resolveDiscoveryCandidates = vi.fn(
			(
				flags: DiscoveryOverrides = {},
				_defaults: DiscoveryDefaults = {},
			): ResolvedDiscoveryCandidates => ({
				browser: flags.browser ? [{ value: flags.browser, source: "flags" }] : [],
				extensionPath: flags.extensionPath ? [{ value: flags.extensionPath, source: "flags" }] : [],
			}),
		);
		const configOwner: Pick<NodeConfigOwner, "paths" | "resolveDiscoveryCandidates"> = {
			paths: { bridge: "/virtual/bridge.json", discovery: "/virtual/discovery.json" },
			resolveDiscoveryCandidates,
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(JSON.stringify({ extension: { connected: true } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		);

		const result = await launchBrowser(
			{ browser: browserPath, extensionPath },
			"http://127.0.0.1:9222/status",
			{
				discovery: {
					configOwner,
					existsSync: (path) =>
						path === browserPath || path === extensionPath || path === `${extensionPath}/manifest.json`,
					readFileSync: (path) => {
						if (path !== `${extensionPath}/manifest.json`) throw new Error(`Unexpected read: ${path}`);
						return JSON.stringify({ name: "Shuvgeist" });
					},
					readdirSync: () => [],
					resolvePath: (path) => path,
					which: () => null,
					developmentRoot: "/virtual/repo-without-build",
					homeDirectory: "/virtual/home",
				},
			},
		);

		expect(result).toMatchObject({
			pid: 0,
			browserPath,
			extensionPath,
			browserName: "chrome",
			alreadyRunning: true,
		});
		expect(resolveDiscoveryCandidates).toHaveBeenNthCalledWith(1, { browser: browserPath });
		expect(resolveDiscoveryCandidates).toHaveBeenNthCalledWith(2, { extensionPath });
	});
});
