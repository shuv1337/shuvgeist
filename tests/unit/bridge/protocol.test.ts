import {
	BridgeCapabilities,
	BridgeDefaults,
	ErrorCodes,
	getBridgeCapabilities,
	isWriteMethod,
} from "../../../src/bridge/protocol.js";

describe("bridge protocol", () => {
	it("returns eval capability only when debugger is enabled", () => {
		expect(getBridgeCapabilities(true)).toEqual(BridgeCapabilities);
		expect(getBridgeCapabilities(false)).not.toContain("eval");
		expect(getBridgeCapabilities(false)).toEqual(BridgeCapabilities.filter((cap) => cap !== "eval"));
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
	});
});
