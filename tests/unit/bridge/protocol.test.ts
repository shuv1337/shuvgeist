import {
	BridgeCapabilities,
	BridgeDefaults,
	ErrorCodes,
	getBridgeCapabilities,
	isWriteMethod,
} from "../../../src/bridge/protocol.js";

describe("bridge protocol", () => {
	it("returns eval/cookies capabilities only when sensitive access is enabled", () => {
		expect(getBridgeCapabilities(true)).toEqual(BridgeCapabilities);
		expect(getBridgeCapabilities(false)).not.toContain("eval");
		expect(getBridgeCapabilities(false)).not.toContain("cookies");
		expect(getBridgeCapabilities(false)).not.toContain("network_get");
		expect(getBridgeCapabilities(false)).not.toContain("network_body");
		expect(getBridgeCapabilities(false)).not.toContain("network_curl");
		expect(getBridgeCapabilities(false)).not.toContain("record_start");
		expect(getBridgeCapabilities(false)).not.toContain("record_stop");
		expect(getBridgeCapabilities(false)).not.toContain("record_status");
		expect(getBridgeCapabilities(false)).toEqual(
			BridgeCapabilities.filter(
				(cap) =>
					cap !== "eval" &&
					cap !== "cookies" &&
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

	it("exposes stable defaults and error codes", () => {
		expect(BridgeDefaults.PORT).toBe(19285);
		expect(BridgeDefaults.STATUS_TIMEOUT_MS).toBeLessThan(BridgeDefaults.REQUEST_TIMEOUT_MS);
		expect(ErrorCodes.NO_EXTENSION_TARGET).toBeLessThan(0);
		expect(ErrorCodes.WRITE_LOCKED).toBeLessThan(0);
		expect(BridgeCapabilities).toContain("cookies");
	});
});
