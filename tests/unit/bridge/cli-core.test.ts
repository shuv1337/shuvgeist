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
			code: "return 1",
			defaultTimeoutMs: 120_000,
		});
		expect(readFileText).toHaveBeenCalledWith("script.js");
	});
});
