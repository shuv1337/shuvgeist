import { electronSessionTestHooks } from "../../../src/bridge/electron/session-manager.js";

describe("electron session manager", () => {
	it("parses remote debugging ports from process command lines", () => {
		expect(electronSessionTestHooks.parseRemoteDebuggingPort("code --remote-debugging-port=9333 --new-window")).toBe(
			9333,
		);
		expect(electronSessionTestHooks.parseRemoteDebuggingPort("code --remote-debugging-port 9334")).toBe(9334);
		expect(electronSessionTestHooks.parseRemoteDebuggingPort("code --disable-gpu")).toBeUndefined();
	});
});
