import { ErrorCodes } from "@shuvgeist/protocol/protocol";
import {
	getBridgeTargetSupport,
	missingExtensionTargetError,
	resolveBridgeExecution,
	unsupportedTargetError,
} from "@shuvgeist/server/target-execution";

describe("bridge target execution", () => {
	it("routes server-local methods before target dispatch", () => {
		expect(resolveBridgeExecution("electron_list", { kind: "chrome-tab" })).toMatchObject({
			adapter: "server-local",
			support: { serverLocal: true, chromeExtension: false, electronWindow: false, requiresExtension: false },
		});
	});

	it("routes Chrome and Electron target-capable methods to the correct adapter", () => {
		expect(resolveBridgeExecution("navigate", { kind: "chrome-tab", tabId: 7 })).toMatchObject({
			adapter: "chrome-extension",
			target: { kind: "chrome-tab", tabId: 7 },
		});
		expect(resolveBridgeExecution("screenshot", { kind: "electron-window", sessionId: "e1", windowRef: "w1" })).toMatchObject({
			adapter: "electron-target",
			target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
		});
	});

	it("marks shared browser and Electron commands as Electron-window capable", () => {
		for (const method of [
			"eval",
			"screenshot",
			"page_snapshot",
			"locate_by_role",
			"locate_by_text",
			"locate_by_label",
			"ref_click",
			"ref_fill",
			"record_start",
			"record_stop",
			"record_status",
		] as const) {
			expect(getBridgeTargetSupport(method), method).toMatchObject({
				chromeExtension: true,
				electronWindow: true,
				requiresExtension: true,
			});
		}
	});

	it("normalizes unsupported target and missing extension errors", () => {
		const target = { kind: "electron-window" as const, sessionId: "e1", windowRef: "w1" };
		expect(getBridgeTargetSupport("session_history")).toMatchObject({
			serverLocal: false,
			chromeExtension: true,
			electronWindow: false,
			requiresExtension: true,
		});
		expect(resolveBridgeExecution("session_history", target)).toMatchObject({
			adapter: "unsupported-target",
			error: {
				code: ErrorCodes.INVALID_TARGET,
				message: "Method 'session_history' cannot be routed to target 'e1'",
			},
		});
		expect(unsupportedTargetError("session_history", target)).toEqual({
			code: ErrorCodes.INVALID_TARGET,
			message: "Method 'session_history' cannot be routed to target 'e1'",
		});
		expect(missingExtensionTargetError()).toEqual({
			code: ErrorCodes.NO_EXTENSION_TARGET,
			message: "No active extension target connected",
		});
	});

	it("rejects catalog commands without an Electron adapter before dispatch", () => {
		const target = { kind: "electron-window" as const, sessionId: "e1", windowRef: "w1" };
		expect(getBridgeTargetSupport("perf_trace_start")).toMatchObject({
			chromeExtension: true,
			electronWindow: false,
		});
		expect(resolveBridgeExecution("perf_trace_start", target)).toMatchObject({
			adapter: "unsupported-target",
			error: { code: ErrorCodes.INVALID_TARGET },
		});
	});
});
