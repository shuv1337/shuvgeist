import { createCommandPlan, parseTimeout, resolveBridgeUrl, resolveConfig } from "shuvgeist/cli-core";

describe("cli-core coverage cases", () => {
	it("prefers env host/port when url is not set", () => {
		expect(
			resolveBridgeUrl({}, { SHUVGEIST_BRIDGE_HOST: "10.0.0.5", SHUVGEIST_BRIDGE_PORT: "4444" }, {}),
		).toBe("ws://10.0.0.5:4444/ws");
	});

	it("prefers file token when flag and env are absent", () => {
		expect(resolveConfig({}, {}, { token: "file-token" }, "~/.shuvgeist/bridge.json")).toEqual({
			ok: true,
			url: "ws://127.0.0.1:19285/ws",
			token: "file-token",
		});
	});

	it("handles numeric timeouts and invalid values", () => {
		expect(parseTimeout("0")).toBeUndefined();
		expect(parseTimeout("2500")).toBe(2500);
		expect(parseTimeout("nope", 123)).toBe(123);
	});

	it("parses record command plans", () => {
		const readFileText = vi.fn();
		expect(
			createCommandPlan(
				"record",
				["start"],
				{
					out: "/tmp/repro.webm",
					tabId: "9",
					maxDuration: "5s",
					videoBitrate: "2500000",
					mimeType: "video/webm;codecs=vp9",
				},
				readFileText,
			),
		).toEqual({
			kind: "record",
			action: "start",
			params: {
				tabId: 9,
				maxDurationMs: 5000,
			videoBitsPerSecond: 2500000,
			mimeType: "video/webm;codecs=vp9",
		},
		defaultTimeoutMs: undefined,
		target: { kind: "chrome-tab", tabId: 9 },
	});
		expect(createCommandPlan("record", ["stop"], { tabId: "9" }, readFileText)).toEqual({
			kind: "record",
			action: "stop",
			params: { tabId: 9 },
			defaultTimeoutMs: 60_000,
			target: { kind: "chrome-tab", tabId: 9 },
		});
		expect(createCommandPlan("record", ["status"], { tabId: "9", json: true }, readFileText)).toEqual({
			kind: "record",
			action: "status",
			params: { tabId: 9 },
			defaultTimeoutMs: 60_000,
			target: { kind: "chrome-tab", tabId: 9 },
		});
		expect(createCommandPlan("record", ["start"], {}, readFileText)).toEqual({
			kind: "usage-error",
			message: "Usage: shuvgeist record start --out file.webm [--max-duration 30s]",
		});
		expect(createCommandPlan("record", ["start"], { out: "x.webm", maxDuration: "3m" }, readFileText)).toEqual({
			kind: "usage-error",
			message: "--max-duration exceeds hard limit of 120000ms",
		});
	});

	it("covers remaining command plan branches", () => {
		const readFileText = vi.fn((path: string) => `code from ${path}`);
		expect(createCommandPlan("status", [], {}, readFileText)).toEqual({ kind: "status" });
		expect(createCommandPlan("doctor", [], {}, readFileText)).toEqual({ kind: "doctor" });
		expect(createCommandPlan("serve", [], {}, readFileText)).toEqual({ kind: "serve" });
		expect(
			createCommandPlan(
				"snapshot",
				["store"],
				{ maxEntries: "25", includeHidden: true, query: "billing" },
				readFileText,
			),
		).toEqual({
			kind: "one-shot",
			method: "snapshot_store",
			params: { maxEntries: 25, includeHidden: true, query: "billing" },
			defaultTimeoutMs: 120_000,
		});
		expect(
			createCommandPlan(
				"snapshot",
				["diff", "baseline-record"],
				{ maxEntries: "25", query: "billing" },
				readFileText,
			),
		).toEqual({
			kind: "one-shot",
			method: "snapshot_diff",
			params: { baselineId: "baseline-record", maxEntries: 25, query: "billing" },
			defaultTimeoutMs: 120_000,
		});
		expect(createCommandPlan("screenshot", [], { maxWidth: "640" }, readFileText)).toEqual({
			kind: "screenshot",
			params: { maxWidth: 640 },
			defaultTimeoutMs: 120_000,
		});
		expect(createCommandPlan("new-session", ["anthropic/claude-opus-4-6"], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "session_new",
			params: { model: "anthropic/claude-opus-4-6" },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("artifacts", [], {}, readFileText)).toEqual({
			kind: "one-shot",
			method: "session_artifacts",
			params: {},
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("cookies", [], {}, readFileText)).toEqual({
			kind: "cookies",
			defaultTimeoutMs: 120_000,
		});
		expect(createCommandPlan("assert", ["url"], { urlPattern: "^https://example" }, readFileText)).toEqual({
			kind: "assert",
			params: {
				timeoutMs: 5000,
				urlPattern: "^https://example",
				kind: "url",
			},
			defaultTimeoutMs: 10_000,
		});
		expect(createCommandPlan("assert", ["selector", "#ready"], { count: "1", enabled: true }, readFileText)).toEqual({
			kind: "assert",
			params: {
				timeoutMs: 5000,
				enabled: true,
				count: 1,
				kind: "selector",
				selector: "#ready",
			},
			defaultTimeoutMs: 10_000,
		});
		expect(createCommandPlan("ref", ["click", "login-input"], { native: true, tabId: "42" }, readFileText)).toEqual({
			kind: "one-shot",
			method: "ref_click",
			params: { refId: "login-input", tabId: 42, native: true },
			defaultTimeoutMs: 60_000,
			target: { kind: "chrome-tab", tabId: 42 },
		});
		expect(createCommandPlan("ref", ["fill", "login-input"], { native: true, value: "alice" }, readFileText)).toEqual({
			kind: "one-shot",
			method: "ref_fill",
			params: { refId: "login-input", native: true, value: "alice" },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("select", [], {}, readFileText)).toEqual({
			kind: "usage-error",
			message: "Usage: shuvgeist select <message>",
		});
		expect(
			createCommandPlan(
				"handoff",
				["task-1", "session-1"],
				{ kind: "manual", message: "Complete sign-in", timeout: "2m", tabId: "42" },
				readFileText,
			),
		).toEqual({
			kind: "one-shot",
			method: "handoff_start",
			params: {
				taskId: "task-1",
				sessionId: "session-1",
				kind: "manual",
				message: "Complete sign-in",
				timeoutMs: 120_000,
				tabId: 42,
			},
			defaultTimeoutMs: undefined,
			target: { kind: "chrome-tab", tabId: 42 },
		});
		expect(createCommandPlan("journal", [], { last: "25" }, readFileText)).toEqual({
			kind: "one-shot",
			method: "journal_list",
			params: { last: 25 },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("mystery", [], {}, readFileText)).toEqual({
			kind: "usage-error",
			message: "Unknown command: mystery",
		});
	});
});
