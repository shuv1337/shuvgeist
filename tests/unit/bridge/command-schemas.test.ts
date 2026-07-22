import { BridgeMethods, validateBridgeCommandParams, validateBridgeCommandResult } from "@shuvgeist/protocol/protocol";
import { BridgeCommandSchemas } from "@shuvgeist/protocol/command-schemas";

describe("bridge command schemas", () => {
	it("provides parameter and result schemas for every bridge method", () => {
		expect(Object.keys(BridgeCommandSchemas)).toEqual(BridgeMethods);
		for (const method of BridgeMethods) {
			expect(BridgeCommandSchemas[method].params, method).toBeDefined();
			expect(BridgeCommandSchemas[method].result, method).toBeDefined();
		}
	});

	it("validates required, optional, and unknown command parameters", () => {
		expect(validateBridgeCommandParams("status", undefined)).toEqual({ ok: true, value: {} });
		expect(validateBridgeCommandParams("eval", { code: "document.title", tabId: 7 })).toMatchObject({ ok: true });
		expect(validateBridgeCommandParams("eval", { tabId: 7 })).toMatchObject({
			ok: false,
			errors: expect.arrayContaining([expect.objectContaining({ path: "/code" })]),
		});
		expect(validateBridgeCommandParams("electron_attach", { appRef: "vscode", port: 9333 })).toMatchObject({
			ok: true,
		});
		expect(validateBridgeCommandParams("electron_attach", { appRef: "vscode", mystery: true })).toMatchObject({
			ok: false,
		});
		expect(validateBridgeCommandParams("electron_attach", {})).toMatchObject({ ok: false });
		expect(validateBridgeCommandParams("record_start", { fps: 31 })).toMatchObject({ ok: false });
		expect(validateBridgeCommandParams("page_assert", { kind: "text" })).toMatchObject({ ok: false });
		expect(validateBridgeCommandParams("page_assert", { kind: "text", text: "Ready" })).toMatchObject({ ok: true });
		expect(validateBridgeCommandParams("electron_windows", { appRef: "vscode" })).toMatchObject({ ok: false });
		expect(validateBridgeCommandParams("ref_click", { refId: "submit", trusted: true })).toMatchObject({ ok: true });
		expect(validateBridgeCommandParams("ref_fill", { refId: "email", value: "x", trusted: true })).toMatchObject({
			ok: true,
		});
		expect(
			validateBridgeCommandParams("ref_click", { refId: "submit", native: true, trusted: true }),
		).toMatchObject({
			ok: false,
			errors: [expect.objectContaining({ path: "/trusted", message: expect.stringContaining("mutually exclusive") })],
		});
	});

	it("validates concrete result contracts", () => {
		expect(
			validateBridgeCommandResult("status", {
				ok: true,
				ready: true,
				activeTab: { tabId: 7, title: "Example", url: "https://example.com" },
			}),
		).toMatchObject({ ok: true });
		expect(validateBridgeCommandResult("status", { ok: true })).toMatchObject({ ok: false });
		expect(validateBridgeCommandResult("navigate", { implementationSpecific: true })).toMatchObject({ ok: false });
		expect(validateBridgeCommandResult("navigate", { finalUrl: "https://example.com" })).toMatchObject({ ok: true });
		expect(validateBridgeCommandResult("network_stats", { tabId: 1, active: false })).toMatchObject({ ok: false });
		expect(
			validateBridgeCommandResult("eval", {
				output: "nested",
				result: { values: [1, true, null, { label: "ok" }] },
			}),
		).toMatchObject({ ok: true });
	});

	it("validates target-aware structured ref results without selector or point leakage", () => {
		const success = {
			ok: true,
			refId: "submit",
			target: { kind: "chrome-tab", tabId: 7, frameId: 0 },
			navigationGeneration: 4,
			tabId: 7,
			frameId: 0,
			action: "click",
			mode: "cdp-trusted",
			match: { score: 0.98, reasons: ["role"], tagName: "button", role: "button", name: "Submit" },
			execution: { kind: "click", methods: ["Input.dispatchMouseEvent"] },
		};
		expect(validateBridgeCommandResult("ref_click", success)).toMatchObject({ ok: true });
		expect(validateBridgeCommandResult("ref_click", { ...success, native: true })).toMatchObject({ ok: true });
		expect(validateBridgeCommandResult("ref_click", { ...success, selector: "button:first" })).toMatchObject({
			ok: false,
		});
		expect(validateBridgeCommandResult("ref_click", { ...success, point: { x: 12, y: 34 } })).toMatchObject({
			ok: false,
		});

		expect(
			validateBridgeCommandResult("ref_fill", {
				ok: false,
				refId: "email",
				target: { kind: "electron-window", sessionId: "e1", windowRef: "w1", targetId: "page-1" },
				navigationGeneration: 8,
				action: "fill",
				mode: "dom",
				reason: "ambiguous_match",
				message: "Multiple candidates matched",
				candidates: [
					{ score: 0.9, reasons: ["label"], stableElementId: "email", tagName: "input", name: "Email" },
				],
			}),
		).toMatchObject({ ok: true });
	});

	it("requires resolved targets for page, network, and recording results", () => {
		const chromeScope = {
			target: { kind: "chrome-tab", tabId: 2 },
			navigationGeneration: 3,
			tabId: 2,
		};
		const electronScope = {
			target: { kind: "electron-window", sessionId: "e1", windowRef: "main", targetId: "target-9" },
			navigationGeneration: 5,
		};
		expect(
			validateBridgeCommandResult("network_stats", {
				...electronScope,
				active: true,
				requestCount: 1,
				storedBodyBytes: 12,
				evictedRequests: 0,
			}),
		).toMatchObject({ ok: true });
		expect(
			validateBridgeCommandResult("page_assert", {
				...electronScope,
				ok: true,
				kind: "role",
				message: "matched",
				attempts: 1,
				durationMs: 4,
				timeoutMs: 1000,
			}),
		).toMatchObject({ ok: true });
		expect(
			validateBridgeCommandResult("perf_metrics", {
				...electronScope,
				metrics: [{ name: "Documents", value: 1 }],
			}),
		).toMatchObject({ ok: true });
		expect(
			validateBridgeCommandResult("network_list", { ...chromeScope, requests: [] }),
		).toMatchObject({ ok: true });
		expect(validateBridgeCommandResult("network_list", [])).toMatchObject({ ok: false });
		expect(
			validateBridgeCommandResult("network_body", {
				...electronScope,
				requestId: "r1",
				responseBody: "ok",
				requestBodyTruncated: false,
				responseBodyTruncated: false,
			}),
		).toMatchObject({ ok: true });
		expect(
			validateBridgeCommandResult("record_stop", {
				...electronScope,
				ok: true,
				recordingId: "rec-1",
				startedAt: "2026-07-21T00:00:00.000Z",
				endedAt: "2026-07-21T00:00:01.000Z",
				durationMs: 1000,
				mimeType: "video/webm",
				sourceBytes: 4096,
				encodedSizeBytes: 1024,
				sizeBytes: 1024,
				frameCount: 12,
				outcome: "stopped_target_closed",
			}),
		).toMatchObject({ ok: true });
		expect(
			validateBridgeCommandResult("record_start", {
				...electronScope,
				tabId: -1,
				ok: true,
				recordingId: "rec-1",
				startedAt: "2026-07-21T00:00:00.000Z",
				mimeType: "video/webm",
				maxDurationMs: 1000,
			}),
		).toMatchObject({ ok: false });
	});
});
