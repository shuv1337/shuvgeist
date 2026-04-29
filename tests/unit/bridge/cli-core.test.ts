import {
	bridgeStatusUrl,
	createCommandPlan,
	exitCodeForResponse,
	generateRequestId,
	isNetworkOrConfigError,
	parseTimeout,
	resolveBridgeUrl,
	resolveConfig,
} from "../../../src/bridge/cli-core.js";

describe("cli-core", () => {
	it("resolves bridge url by flag, env, and config precedence", () => {
		expect(resolveBridgeUrl({ url: "ws://flag/ws" }, {}, {})).toBe("ws://flag/ws");
		expect(resolveBridgeUrl({}, { SHUVGEIST_BRIDGE_URL: "ws://env/ws" }, {})).toBe("ws://env/ws");
		expect(resolveBridgeUrl({}, {}, { url: "ws://file/ws" })).toBe("ws://file/ws");
		expect(resolveBridgeUrl({}, {}, {})).toBe("ws://127.0.0.1:19285/ws");
		expect(resolveBridgeUrl({ host: "10.0.0.2", port: "9999" }, {}, {})).toBe("ws://10.0.0.2:9999/ws");
	});

	it("resolves token by precedence and returns a structured error when missing", () => {
		expect(resolveConfig({ token: "flag" }, {}, {}, "~/.shuvgeist/bridge.json")).toEqual({
			ok: true,
			url: "ws://127.0.0.1:19285/ws",
			token: "flag",
		});
		expect(
			resolveConfig({}, { SHUVGEIST_BRIDGE_TOKEN: "env" }, { token: "file" }, "~/.shuvgeist/bridge.json"),
		).toEqual({
			ok: true,
			url: "ws://127.0.0.1:19285/ws",
			token: "env",
		});
		const missing = resolveConfig({}, {}, {}, "~/.shuvgeist/bridge.json");
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.message).toContain("bridge token is required");
			expect(missing.message).toContain("~/.shuvgeist/bridge.json");
		}
	});

	it("parses status urls and timeouts", () => {
		expect(bridgeStatusUrl("ws://127.0.0.1:19285/ws")).toBe("http://127.0.0.1:19285/status");
		expect(bridgeStatusUrl("wss://bridge.example/ws?x=1")).toBe("https://bridge.example/status");
		expect(parseTimeout(undefined, 1234)).toBe(1234);
		expect(parseTimeout("1500ms")).toBe(1500);
		expect(parseTimeout("30s")).toBe(30_000);
		expect(parseTimeout("2m")).toBe(120_000);
		expect(parseTimeout("none", 100)).toBeUndefined();
	});

	it("detects network/config errors and maps exit codes", () => {
		expect(isNetworkOrConfigError(Object.assign(new Error("boom"), { code: "ECONNREFUSED" }))).toBe(true);
		expect(isNetworkOrConfigError(new Error("Registration failed: no token"))).toBe(true);
		expect(isNetworkOrConfigError(new Error("logic failure"))).toBe(false);

		expect(exitCodeForResponse({ id: 1, result: { ok: true } })).toBe(0);
		expect(exitCodeForResponse({ id: 1, error: { code: -32000, message: "No extension" } })).toBe(2);
		expect(exitCodeForResponse({ id: 1, error: { code: -32001, message: "Auth" } })).toBe(3);
		expect(exitCodeForResponse({ id: 1, error: { code: -32003, message: "Exec" } })).toBe(1);
	});

	it("creates stable request ids", () => {
		expect(generateRequestId(1_700_000_000_123, 0.456)).toBe(123456);
	});

	it("maps commands to the actual bridge protocol", () => {
		const readFileText = vi.fn(() => "return 1");

		expect(createCommandPlan("tabs", [], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "navigate",
			params: { listTabs: true },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("switch", ["17"], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "navigate",
			params: { switchToTab: 17 },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("navigate", ["https://example.com"], { newTab: true }, readFileText)).toEqual({
			kind: "one-shot",
			method: "navigate",
			params: { url: "https://example.com", newTab: true },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("session", [], { follow: true, last: "5" }, readFileText)).toEqual({
			kind: "session",
			follow: true,
			params: { last: 5 },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("inject", ["hello"], { role: "assistant" }, readFileText)).toEqual({
			kind: "inject",
			text: "hello",
			role: "assistant",
		});
		expect(createCommandPlan("repl", [], { file: "script.js" }, readFileText)).toEqual({
			kind: "repl",
			params: { title: "CLI REPL", code: "return 1" },
			defaultTimeoutMs: 120_000,
		});
		expect(createCommandPlan("cookies", [], {}, readFileText)).toEqual({
			kind: "cookies",
			defaultTimeoutMs: 120_000,
		});
		expect(readFileText).toHaveBeenCalledWith("script.js");
	});

	it("forwards target flags for repl and eval", () => {
		const readFileText = vi.fn(() => "return 1");

		expect(createCommandPlan("repl", ["return 1"], { tabId: "42", frameId: "7" }, readFileText)).toEqual({
			kind: "repl",
			params: { title: "CLI REPL", code: "return 1", tabId: 42, frameId: 7 },
			defaultTimeoutMs: 120_000,
		});

		expect(createCommandPlan("eval", ["return 1"], { tabId: "42", frameId: "7" }, readFileText)).toEqual({
			kind: "one-shot",
			method: "eval",
			params: { code: "return 1", tabId: 42, frameId: 7 },
			defaultTimeoutMs: 120_000,
		});
	});

	it("reads the launch URL from --url or a positional, never confusing it with the bridge URL", () => {
		const readFileText = vi.fn();

		// --url form (as documented in the CLI help text)
		expect(
			createCommandPlan(
				"launch",
				[],
				{ headless: true, url: "https://example.com" },
				readFileText,
			),
		).toEqual({
			kind: "launch",
			options: {
				browser: undefined,
				extensionPath: undefined,
				profile: undefined,
				userDataDir: undefined,
				useDefaultProfile: undefined,
				url: "https://example.com",
				headless: true,
				foreground: undefined,
			},
		});

		// Positional form
		expect(
			createCommandPlan("launch", ["https://example.com"], { headless: true }, readFileText),
		).toEqual({
			kind: "launch",
			options: {
				browser: undefined,
				extensionPath: undefined,
				profile: undefined,
				userDataDir: undefined,
				useDefaultProfile: undefined,
				url: "https://example.com",
				headless: true,
				foreground: undefined,
			},
		});

		// --url wins when both are present (matches the documented flag form).
		expect(
			createCommandPlan(
				"launch",
				["https://positional.example"],
				{ url: "https://flag.example" },
				readFileText,
			),
		).toMatchObject({
			kind: "launch",
			options: { url: "https://flag.example" },
		});
	});

	it("forwards --user-data-dir and --use-default-profile to LaunchOptions", () => {
		const readFileText = vi.fn();

		// --user-data-dir is forwarded verbatim; the launcher resolves it.
		expect(
			createCommandPlan("launch", [], { userDataDir: "/tmp/shuvgeist-test" }, readFileText),
		).toMatchObject({
			kind: "launch",
			options: { userDataDir: "/tmp/shuvgeist-test", useDefaultProfile: undefined },
		});

		// --use-default-profile is a boolean opt-out and is forwarded verbatim.
		expect(createCommandPlan("launch", [], { useDefaultProfile: true }, readFileText)).toMatchObject({
			kind: "launch",
			options: { userDataDir: undefined, useDefaultProfile: true },
		});

		// Default invocation leaves both undefined so the launcher applies its
		// isolated-profile default.
		expect(createCommandPlan("launch", [], {}, readFileText)).toMatchObject({
			kind: "launch",
			options: { userDataDir: undefined, useDefaultProfile: undefined },
		});
	});
});
