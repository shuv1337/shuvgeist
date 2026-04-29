import { createCommandPlan, parseTimeout, resolveBridgeUrl, resolveConfig } from "../../../src/bridge/cli-core.js";

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
		});
		expect(createCommandPlan("record", ["stop"], { tabId: "9" }, readFileText)).toEqual({
			kind: "record",
			action: "stop",
			params: { tabId: 9 },
			defaultTimeoutMs: 60_000,
		});
		expect(createCommandPlan("record", ["status"], { tabId: "9", json: true }, readFileText)).toEqual({
			kind: "record",
			action: "status",
			params: { tabId: 9 },
			defaultTimeoutMs: 60_000,
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
		expect(createCommandPlan("serve", [], {}, readFileText)).toEqual({ kind: "serve" });
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
		expect(createCommandPlan("select", [], {}, readFileText)).toEqual({
			kind: "usage-error",
			message: "Usage: shuvgeist select <message>",
		});
		expect(createCommandPlan("mystery", [], {}, readFileText)).toEqual({
			kind: "usage-error",
			message: "Unknown command: mystery",
		});
	});
});
