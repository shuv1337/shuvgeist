import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeTelemetry, formatTraceparent, parseTraceparent } from "../../../src/bridge/telemetry.js";

describe("bridge telemetry", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("parses and formats W3C traceparent headers", () => {
		const context = parseTraceparent(
			"00-11111111111111111111111111111111-2222222222222222-01",
			"maple=test",
		);
		expect(context).toEqual({
			traceId: "11111111111111111111111111111111",
			spanId: "2222222222222222",
			traceFlags: "01",
			tracestate: "maple=test",
		});
		expect(formatTraceparent(context!)).toBe("00-11111111111111111111111111111111-2222222222222222-01");
	});

	it("exports spans to Maple with bearer auth", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			text: async () => "",
		}));
		globalThis.fetch = fetchMock as typeof fetch;

		const telemetry = new BridgeTelemetry({
			serviceName: "shuvgeist-cli",
			enabled: true,
			ingestUrl: "http://localhost:3474",
			ingestKey: "maple_sk_test",
		});
		const span = telemetry.startSpan("bridge.cli.status", {
			kind: "client",
			attributes: {
				"bridge.method": "status",
			},
		});
		span.end("ok");
		await telemetry.flush();

		expect(fetchMock).toHaveBeenCalledWith("http://localhost:3474/v1/traces", {
			method: "POST",
			headers: {
				authorization: "Bearer maple_sk_test",
				"content-type": "application/json",
			},
			body: expect.any(String),
		});
		expect(telemetry.getExportState().state).toBe("ok");
	});

	it("stays no-op when tracing is disabled", async () => {
		const fetchMock = vi.fn();
		globalThis.fetch = fetchMock as typeof fetch;

		const telemetry = new BridgeTelemetry({
			serviceName: "shuvgeist-cli",
			enabled: false,
			ingestUrl: "http://localhost:3474",
			ingestKey: "maple_sk_test",
		});
		telemetry.startSpan("bridge.cli.navigate").end("ok");
		await telemetry.flush();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(telemetry.getExportState().state).toBe("disabled");
	});

	it("surfaces exporter failures without throwing", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("connect ECONNREFUSED");
		});
		globalThis.fetch = fetchMock as typeof fetch;

		const telemetry = new BridgeTelemetry({
			serviceName: "shuvgeist-cli",
			enabled: true,
			ingestUrl: "http://localhost:3474",
			ingestKey: "maple_sk_test",
		});
		telemetry.startSpan("bridge.cli.eval").end("error");

		await expect(telemetry.flush()).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(telemetry.getExportState()).toMatchObject({
			state: "error",
			lastError: expect.stringContaining("connect ECONNREFUSED"),
		});
	});
});
