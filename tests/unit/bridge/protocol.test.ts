import {
	BRIDGE_PROTOCOL_MIN_VERSION,
	BRIDGE_PROTOCOL_VERSION,
	BridgeCapabilities,
	BridgeDefaults,
	BridgeMethods,
	ErrorCodes,
	getBridgeCapabilities,
	isExtensionRelayedMethod,
	isBridgeProtocolCompatible,
	isServerLocalMethod,
	isTargetDispatchedMethod,
	isWriteMethod,
	type RecordFrameEventData,
	type RefClickParams,
	type ResolvedPageTarget,
	type BridgeEvent,
	type TypedBridgeRequest,
} from "@shuvgeist/protocol/protocol";
import { BridgeCommandCatalog, getBridgeCommandMetadata } from "@shuvgeist/protocol/command-catalog";

describe("bridge protocol", () => {
	it("correlates parameter optionality with the command schema", () => {
		type HasRequiredParams<T> = T extends { params: unknown } ? true : false;
		expectTypeOf<HasRequiredParams<TypedBridgeRequest<"eval">>>().toEqualTypeOf<true>();
		expectTypeOf<HasRequiredParams<TypedBridgeRequest<"status">>>().toEqualTypeOf<false>();
	});

	it("exposes target-aware page contracts and trusted ref input", () => {
		expectTypeOf<RefClickParams>().toMatchTypeOf<{ refId: string; native?: boolean; trusted?: boolean }>();
		expectTypeOf<ResolvedPageTarget>().toEqualTypeOf<
		| { kind: "chrome-tab"; tabId: number; frameId?: number }
		| { kind: "electron-window"; sessionId: string; windowRef: string; targetId: string; frameId?: number }
	>();
		expectTypeOf<RecordFrameEventData>().toMatchTypeOf<{
		target: ResolvedPageTarget;
		navigationGeneration: number;
		tabId?: number;
		frameId?: number;
	}>();
	});

	it("models dynamic capability updates as a canonical bridge event", () => {
		const event: BridgeEvent = {
			type: "event",
			event: "capabilities_update",
			data: { capabilities: ["status", "repl"] },
		};
		expect(event).toEqual({
			type: "event",
			event: "capabilities_update",
			data: { capabilities: ["status", "repl"] },
		});
	});

	it("returns sensitive capabilities only when sensitive access is enabled", () => {
		expect(getBridgeCapabilities(true)).toEqual(BridgeCapabilities);
		expect(getBridgeCapabilities(false)).not.toContain("eval");
		expect(getBridgeCapabilities(false)).not.toContain("cookies");
		expect(getBridgeCapabilities(false)).not.toContain("cookie_import");
		expect(getBridgeCapabilities(false)).not.toContain("cookie_import_apply");
		expect(getBridgeCapabilities(false)).not.toContain("network_get");
		expect(getBridgeCapabilities(false)).not.toContain("network_body");
		expect(getBridgeCapabilities(false)).not.toContain("network_curl");
		expect(getBridgeCapabilities(false)).not.toContain("record_start");
		expect(getBridgeCapabilities(false)).not.toContain("record_stop");
		expect(getBridgeCapabilities(false)).not.toContain("record_status");
		expect(getBridgeCapabilities(false)).toContain("page_assert");
		expect(getBridgeCapabilities(false)).toEqual(
			BridgeCapabilities.filter(
				(cap) =>
					cap !== "eval" &&
					cap !== "cookies" &&
					cap !== "cookie_import" &&
					cap !== "cookie_import_apply" &&
					cap !== "network_get" &&
					cap !== "network_body" &&
					cap !== "network_curl" &&
					cap !== "record_start" &&
					cap !== "record_stop" &&
					cap !== "record_status",
			),
		);
	});

	it("detects write methods", () => {
		expect(isWriteMethod("session_inject")).toBe(true);
		expect(isWriteMethod("session_new")).toBe(true);
		expect(isWriteMethod("session_set_model")).toBe(true);
		expect(isWriteMethod("status")).toBe(false);
		expect(isWriteMethod("navigate")).toBe(false);
	});

	it("derives protocol method and capability metadata from the command catalog", () => {
		expect(BridgeMethods).toEqual(BridgeCommandCatalog.map((entry) => entry.method));
		expect(BridgeCapabilities).toEqual(
			BridgeCommandCatalog.filter((entry) => entry.route === "extension").flatMap((entry) => entry.capabilities),
		);
		expect(BridgeCapabilities).not.toContain("electron_list");
		expect(BridgeCapabilities).not.toContain("cookie_import");
		expect(new Set(BridgeMethods).size).toBe(BridgeMethods.length);
		expect(new Set(BridgeCapabilities).size).toBe(BridgeCapabilities.length);
		expect(getBridgeCommandMetadata("navigate")).toMatchObject({
			method: "navigate",
			capabilities: ["navigate", "tabs"],
			route: "extension",
		});
		expect(getBridgeCommandMetadata("electron_doctor")).toMatchObject({
			method: "electron_doctor",
			capabilities: ["electron_doctor"],
			route: "server-local",
		});
	});

	it("derives bridge routing classifications from the command catalog", () => {
		expect(isServerLocalMethod("electron_list")).toBe(true);
		expect(isExtensionRelayedMethod("electron_list")).toBe(false);
		expect(isServerLocalMethod("navigate")).toBe(false);
		expect(isExtensionRelayedMethod("navigate")).toBe(true);
		expect(isTargetDispatchedMethod("navigate")).toBe(true);
		expect(isTargetDispatchedMethod("electron_windows")).toBe(false);
		expect(isTargetDispatchedMethod("session_history")).toBe(true);
		expect(isTargetDispatchedMethod("perf_trace_start", "electron-window")).toBe(false);
	});

	it("exposes stable defaults and error codes", () => {
		expect(BridgeDefaults.PORT).toBe(19285);
		expect(BridgeDefaults.STATUS_TIMEOUT_MS).toBeLessThan(BridgeDefaults.REQUEST_TIMEOUT_MS);
		expect(ErrorCodes.NO_EXTENSION_TARGET).toBeLessThan(0);
		expect(ErrorCodes.WRITE_LOCKED).toBeLessThan(0);
		expect(BridgeCapabilities).toContain("cookies");
	});

	it("negotiates overlapping protocol ranges", () => {
		expect(BRIDGE_PROTOCOL_VERSION).toBe(4);
		expect(BRIDGE_PROTOCOL_MIN_VERSION).toBe(4);
		expect(isBridgeProtocolCompatible(BRIDGE_PROTOCOL_VERSION, BRIDGE_PROTOCOL_MIN_VERSION)).toBe(true);
		expect(isBridgeProtocolCompatible(BRIDGE_PROTOCOL_MIN_VERSION, BRIDGE_PROTOCOL_MIN_VERSION)).toBe(true);
		expect(isBridgeProtocolCompatible(BRIDGE_PROTOCOL_MIN_VERSION - 1, BRIDGE_PROTOCOL_MIN_VERSION - 1)).toBe(false);
		expect(isBridgeProtocolCompatible(BRIDGE_PROTOCOL_VERSION + 2, BRIDGE_PROTOCOL_VERSION + 1)).toBe(false);
		expect(isBridgeProtocolCompatible(BRIDGE_PROTOCOL_VERSION, undefined)).toBe(false);
	});
});
