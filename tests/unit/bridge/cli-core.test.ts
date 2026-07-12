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
import { getBridgeCommandMetadata } from "../../../src/bridge/command-catalog.js";

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
		expect(
			exitCodeForResponse({
				id: 1,
				result: { ok: false, kind: "text", message: "missing", attempts: 3 },
			}),
		).toBe(1);
		expect(
			exitCodeForResponse({
				id: 1,
				result: { ok: false, closedTabIds: [], skipped: [{ tabId: 9, reason: "missing" }] },
			}),
		).toBe(1);
		expect(
			exitCodeForResponse({
				id: 1,
				result: { ok: true, closedTabIds: [9] },
			}),
		).toBe(0);
		expect(
			exitCodeForResponse({
				id: 1,
				result: { ok: false, closedWindowIds: [], skipped: [{ windowId: 1, reason: "missing" }] },
			}),
		).toBe(1);
		expect(
			exitCodeForResponse({
				id: 1,
				result: { ok: true, closedWindowIds: [3], closedTabIds: [1, 2] },
			}),
		).toBe(0);
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
		expect(createCommandPlan("tabs", ["list"], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "navigate",
			params: { listTabs: true },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("tabs", ["close", "9", "10"], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "navigate",
			params: { closeTabs: [9, 10] },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("tabs", ["close", "9"], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "navigate",
			params: { closeTab: 9 },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("tabs", ["close"], { titleMatch: "x" }, readFileText)).toEqual({
			kind: "usage-error",
			message: expect.stringContaining("Filter close requires --dry-run"),
		});
		expect(createCommandPlan("tabs", ["close"], { titleMatch: "x", dryRun: true }, readFileText)).toEqual({
			kind: "one-shot",
			method: "navigate",
			params: {
				closeTabFilter: { titleIncludes: "x" },
				dryRun: true,
			},
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("tabs", ["close"], { titleMatch: "x", yes: true }, readFileText)).toEqual({
			kind: "one-shot",
			method: "navigate",
			params: {
				closeTabFilter: { titleIncludes: "x" },
			},
			defaultTimeoutMs: 60_000,
		});
		expect(
			createCommandPlan(
				"tabs",
				["close"],
				{
					urlMatch: "localhost",
					titlePattern: "end$",
					urlPattern: "https://",
					windowId: "7",
					includePinned: true,
					includeProtected: true,
					requireMatch: true,
					yes: true,
				},
				readFileText,
			),
		).toEqual({
			kind: "one-shot",
			method: "navigate",
			params: {
				closeTabFilter: {
					urlIncludes: "localhost",
					titlePattern: "end$",
					urlPattern: "https://",
					windowId: 7,
					includePinned: true,
					includeProtected: true,
				},
				requireMatch: true,
			},
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("tabs", ["close", "9"], { titleMatch: "x", yes: true }, readFileText)).toEqual({
			kind: "usage-error",
			message: expect.stringContaining("either tab IDs or filter flags"),
		});
		expect(createCommandPlan("windows", [], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "navigate",
			params: { listWindows: true },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("windows", ["close", "42"], { yes: true }, readFileText)).toEqual({
			kind: "one-shot",
			method: "navigate",
			params: { closeWindow: 42 },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("windows", ["close", "42"], {}, readFileText)).toEqual({
			kind: "usage-error",
			message: expect.stringContaining("Window close requires --dry-run"),
		});
		expect(createCommandPlan("windows", ["close", "42"], { dryRun: true }, readFileText)).toEqual({
			kind: "one-shot",
			method: "navigate",
			params: { closeWindow: 42, dryRun: true },
			defaultTimeoutMs: 60_000,
		});
		// Top-level `close` remains launch teardown, not tab close
		expect(createCommandPlan("close", ["9"], {}, readFileText)).toEqual({ kind: "close" });
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
		expect(createCommandPlan("ref", ["click", "checkout"], { timeout: "3s" }, readFileText)).toEqual({
			kind: "one-shot",
			method: "ref_click",
			params: { refId: "checkout", waitMs: 3000 },
			defaultTimeoutMs: 60_000,
		});
		expect(readFileText).toHaveBeenCalledWith("script.js");
	});

	it("uses catalog timeout metadata for one-shot bridge command plans", () => {
		const readFileText = vi.fn();
		const plans = [
			createCommandPlan("navigate", ["https://example.com"], {}, readFileText),
			createCommandPlan("eval", ["document.title"], {}, readFileText),
			createCommandPlan("select", ["Pick", "a", "button"], {}, readFileText),
			createCommandPlan("snapshot", [], {}, readFileText),
			createCommandPlan("electron", ["doctor"], {}, readFileText),
			createCommandPlan("electron", ["source", "extract", "/tmp/out"], { sourcePath: "/tmp/app" }, readFileText),
		];
		for (const plan of plans) {
			expect(plan.kind).toBe("one-shot");
			if (plan.kind !== "one-shot") continue;
			expect(getBridgeCommandMetadata(plan.method)?.defaultTimeout, plan.method).toBeDefined();
			if (plan.method === "select_element") {
				expect(plan.defaultTimeoutMs).toBeUndefined();
			} else {
				expect(plan.defaultTimeoutMs).toBeGreaterThan(0);
			}
		}
	});

	it("forwards target flags for repl and eval", () => {
		const readFileText = vi.fn(() => "return 1");

		expect(createCommandPlan("repl", ["return 1"], { tabId: "42", frameId: "7" }, readFileText)).toEqual({
			kind: "repl",
			params: { title: "CLI REPL", code: "return 1", tabId: 42, frameId: 7 },
			defaultTimeoutMs: 120_000,
			target: { kind: "chrome-tab", tabId: 42, frameId: 7 },
		});

		expect(createCommandPlan("eval", ["return 1"], { tabId: "42", frameId: "7" }, readFileText)).toEqual({
			kind: "one-shot",
			method: "eval",
			params: { code: "return 1", tabId: 42, frameId: 7 },
			defaultTimeoutMs: 120_000,
			target: { kind: "chrome-tab", tabId: 42, frameId: 7 },
		});

		expect(
			createCommandPlan(
				"assert",
				["role", "button"],
				{ tabId: "42", frameId: "7", name: "Continue", visible: true, timeout: "10s", interval: "250ms" },
				readFileText,
			),
		).toEqual({
			kind: "assert",
			params: {
				tabId: 42,
				frameId: 7,
				timeoutMs: 10_000,
				intervalMs: 250,
				visible: true,
				kind: "role",
				role: "button",
				name: "Continue",
			},
			defaultTimeoutMs: 15_000,
			target: { kind: "chrome-tab", tabId: 42, frameId: 7 },
		});
	});

	it("places --target on command plans instead of per-method params", () => {
		const readFileText = vi.fn();

		expect(createCommandPlan("screenshot", [], { target: "electron:vscode:w2" }, readFileText)).toEqual({
			kind: "screenshot",
			params: {},
			defaultTimeoutMs: 120_000,
			target: { kind: "electron-window", appRef: "vscode", windowRef: "w2" },
		});

		expect(createCommandPlan("tabs", [], { target: "bogus" }, readFileText)).toEqual({
			kind: "usage-error",
			message: "Invalid --target: target must start with chrome:, electron:, or electron-session:",
		});
	});

	it("maps electron namespace commands to bridge-local methods", () => {
		const readFileText = vi.fn();

		expect(createCommandPlan("electron", ["allow", "vscode"], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "electron_allow",
			params: { appRef: "vscode" },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("electron", ["launch", "vscode"], { inspectMain: true }, readFileText)).toEqual({
			kind: "one-shot",
			method: "electron_launch",
			params: { appRef: "vscode", inspectMain: true },
			defaultTimeoutMs: 120_000,
		});
		expect(
			createCommandPlan(
				"electron",
				["attach", "vscode"],
				{ port: "9333", pid: "123", inspectPort: "9444" },
				readFileText,
			),
		).toEqual({
				kind: "one-shot",
				method: "electron_attach",
				params: { appRef: "vscode", port: 9333, pid: 123, inspectPort: 9444 },
				defaultTimeoutMs: 60_000,
			});
		expect(createCommandPlan("electron", ["label", "e1", "w2", "chat", "pane"], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "electron_label",
			params: { sessionId: "e1", windowRef: "w2", label: "chat pane" },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("electron", ["main", "e1"], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "electron_main_info",
			params: { sessionId: "e1" },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("electron", ["ipc", "tap", "e1"], { channel: "workbench" }, readFileText)).toEqual({
			kind: "one-shot",
			method: "electron_ipc_tap_start",
			params: { sessionId: "e1", channel: "workbench" },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("electron", ["ipc", "untap", "e1"], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "electron_ipc_tap_stop",
			params: { sessionId: "e1" },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("electron", ["network-main", "start", "e1"], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "electron_main_network_start",
			params: { sessionId: "e1" },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("electron", ["network-main", "stop", "e1"], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "electron_main_network_stop",
			params: { sessionId: "e1" },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("electron", ["source", "layout"], { sourcePath: "/tmp/app" }, readFileText)).toEqual({
			kind: "one-shot",
			method: "electron_source_layout",
			params: { sourcePath: "/tmp/app" },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("electron", ["source", "list", "vscode"], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "electron_source_list",
			params: { appRef: "vscode" },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("electron", ["source", "read", "src/main.js"], { sourcePath: "/tmp/app" }, readFileText)).toEqual({
			kind: "one-shot",
			method: "electron_source_read",
			params: { sourcePath: "/tmp/app", filePath: "src/main.js" },
			defaultTimeoutMs: 60_000,
		});
		expect(
			createCommandPlan("electron", ["source", "extract", "/tmp/out", "vscode"], {}, readFileText),
		).toEqual({
			kind: "one-shot",
			method: "electron_source_extract",
			params: { appRef: "vscode", destinationPath: "/tmp/out" },
			defaultTimeoutMs: 120_000,
		});
		expect(createCommandPlan("electron", ["doctor", "vscode"], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "electron_doctor",
			params: { appRef: "vscode" },
			defaultTimeoutMs: 120_000,
		});
		expect(createCommandPlan("electron", ["auto-attach", "status", "vscode"], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "electron_auto_attach",
			params: { action: "status", appRef: "vscode" },
			defaultTimeoutMs: 60_000,
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
