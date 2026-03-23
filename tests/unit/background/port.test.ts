import { createChromeRuntimePortMock } from "../../helpers/chrome-mock.js";

const runtimeConnect = vi.fn();

declare global {
	var chrome: {
		runtime: {
			connect: typeof runtimeConnect;
		};
	};
}

globalThis.chrome = {
	runtime: {
		connect: runtimeConnect,
	},
};

const portModule = await import("../../../src/utils/port.js");

describe("port module", () => {
	beforeEach(() => {
		portModule.resetPortStateForTests();
		runtimeConnect.mockReset();
	});

	it("requires initialization before connecting", () => {
		expect(() => portModule.connect()).toThrow("windowId not initialized");
	});

	it("connects lazily and sends typed messages", async () => {
		const mock = createChromeRuntimePortMock();
		runtimeConnect.mockReturnValue(mock.port);
		portModule.initialize(33);

		const responsePromise = portModule.sendMessage({ type: "acquireLock", sessionId: "session-1", windowId: 33 });
		expect(runtimeConnect).toHaveBeenCalledWith({ name: "sidepanel:33" });
		expect(mock.port.postMessage).toHaveBeenCalledWith({ type: "acquireLock", sessionId: "session-1", windowId: 33 });

		mock.emitMessage({ type: "lockResult", sessionId: "session-1", success: true });
		await expect(responsePromise).resolves.toEqual({ type: "lockResult", sessionId: "session-1", success: true });
		expect(portModule.isConnected()).toBe(true);
	});

	it("retries once when the first send fails", async () => {
		const first = createChromeRuntimePortMock();
		first.port.postMessage.mockImplementationOnce(() => {
			throw new Error("disconnected");
		});
		const second = createChromeRuntimePortMock();
		runtimeConnect.mockReturnValueOnce(first.port).mockReturnValueOnce(second.port);

		portModule.initialize(44);
		const responsePromise = portModule.sendMessage({ type: "getLockedSessions" });
		second.emitMessage({ type: "lockedSessions", locks: { abc: 44 } });
		await expect(responsePromise).resolves.toEqual({ type: "lockedSessions", locks: { abc: 44 } });
		expect(runtimeConnect).toHaveBeenCalledTimes(2);
	});

	it("times out when no response arrives", async () => {
		vi.useFakeTimers();
		const mock = createChromeRuntimePortMock();
		runtimeConnect.mockReturnValue(mock.port);
		portModule.initialize(55);

		const responsePromise = portModule.sendMessage({ type: "getLockedSessions" }, 10).catch((error) => error);
		await vi.advanceTimersByTimeAsync(25);
		const error = await responsePromise;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("Failed to send message after 2 attempts");
		vi.useRealTimers();
	});
});
