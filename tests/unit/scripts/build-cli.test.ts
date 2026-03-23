const { fsMock, buildMock } = vi.hoisted(() => ({
	fsMock: {
		chmodSync: vi.fn(),
		mkdirSync: vi.fn(),
		readFileSync: vi.fn(() => JSON.stringify({ version: "1.0.8" })),
		rmSync: vi.fn(),
	},
	buildMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => fsMock);
vi.mock("esbuild", () => ({
	build: buildMock,
}));

describe("build-cli script", () => {
	beforeEach(() => {
		fsMock.chmodSync.mockClear();
		fsMock.mkdirSync.mockClear();
		fsMock.readFileSync.mockClear();
		fsMock.rmSync.mockClear();
		buildMock.mockClear();
	});

	it("marks the built CLI entrypoint executable", async () => {
		await import("../../../scripts/build-cli.mjs");

		expect(fsMock.readFileSync).toHaveBeenCalledWith(expect.stringContaining("static/manifest.chrome.json"), "utf-8");
		expect(buildMock).toHaveBeenCalledTimes(1);
		expect(fsMock.chmodSync).toHaveBeenCalledWith(expect.stringContaining("dist-cli/shuvgeist.mjs"), 0o755);
	});
});
