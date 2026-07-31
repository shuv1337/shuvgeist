const { fsMock, buildMock, computeBuildIdentityMock } = vi.hoisted(() => ({
	fsMock: {
		chmodSync: vi.fn(),
		mkdirSync: vi.fn(),
		readFileSync: vi.fn(() => JSON.stringify({ version: "1.0.8" })),
		rmSync: vi.fn(),
	},
	buildMock: vi.fn().mockResolvedValue(undefined),
	computeBuildIdentityMock: vi.fn(() => ({
		id: "development-0123456789abcdef01234567",
		kind: "development",
	})),
}));

vi.mock("node:fs", () => fsMock);
vi.mock("esbuild", () => ({
	build: buildMock,
}));
vi.mock("../../../scripts/build-identity.mjs", () => ({
	computeBuildIdentity: computeBuildIdentityMock,
}));

describe("build-cli script", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.unstubAllEnvs();
		fsMock.chmodSync.mockClear();
		fsMock.mkdirSync.mockClear();
		fsMock.readFileSync.mockClear();
		fsMock.rmSync.mockClear();
		buildMock.mockClear();
		computeBuildIdentityMock.mockClear();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("omits the E2E artifact surface and marks the production CLI executable", async () => {
		vi.stubEnv("SHUVGEIST_BUILD_TEST_SURFACES", "");
		await import("../../../packages/cli/scripts/build-cli.mjs");

		expect(fsMock.readFileSync).toHaveBeenCalledWith(expect.stringContaining("static/manifest.chrome.json"), "utf-8");
		expect(buildMock).toHaveBeenCalledTimes(1);
		expect(buildMock).toHaveBeenCalledWith(
			expect.objectContaining({
				define: expect.objectContaining({
					__SHUVGEIST_BUILD_ID__: JSON.stringify("development-0123456789abcdef01234567"),
					__SHUVGEIST_BUILD_KIND__: JSON.stringify("development"),
				}),
				entryPoints: {
					"direct-cdp-runtime": expect.stringContaining("packages/cli/src/headless/direct-cdp-runtime.ts"),
					shuvgeist: expect.stringContaining("packages/cli/src/cli.ts"),
				},
			}),
		);
		expect(fsMock.chmodSync).toHaveBeenCalledWith(expect.stringContaining("dist-cli/shuvgeist.mjs"), 0o755);
	});

	it("includes the E2E-only artifact surface when explicitly enabled", async () => {
		vi.stubEnv("SHUVGEIST_BUILD_TEST_SURFACES", "1");
		await import("../../../packages/cli/scripts/build-cli.mjs");

		expect(buildMock).toHaveBeenCalledWith(
			expect.objectContaining({
				entryPoints: expect.objectContaining({
					"direct-cdp-runtime": expect.stringContaining(
						"packages/cli/src/headless/direct-cdp-runtime.ts",
					),
					shuvgeist: expect.stringContaining("packages/cli/src/cli.ts"),
					"driver-injected-artifacts": expect.stringContaining(
						"tests/e2e/fixtures/driver-injected-artifact-surface.ts",
					),
				}),
			}),
		);
	});
});
