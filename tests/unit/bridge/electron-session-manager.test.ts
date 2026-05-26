import { electronSessionTestHooks } from "../../../src/bridge/electron/session-manager.js";

describe("electron session manager", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("parses remote debugging ports from process command lines", () => {
		expect(electronSessionTestHooks.parseRemoteDebuggingPort("code --remote-debugging-port=9333 --new-window")).toBe(
			9333,
		);
		expect(electronSessionTestHooks.parseRemoteDebuggingPort("code --remote-debugging-port 9334")).toBe(9334);
		expect(electronSessionTestHooks.parseRemoteDebuggingPort("code --disable-gpu")).toBeUndefined();
	});

	it("uses a Chromium /json/version websocket for inspector endpoints", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					Browser: "Chrome/142",
					webSocketDebuggerUrl: "ws://127.0.0.1:9331/devtools/browser/main",
				}),
				{ status: 200 },
			),
		);

		await expect(electronSessionTestHooks.resolveInspectorEndpoint(9331, 10)).resolves.toEqual({
			Browser: "Chrome/142",
			webSocketDebuggerUrl: "ws://127.0.0.1:9331/devtools/browser/main",
		});
	});

	it("falls back to /json/list for Node inspector endpoints", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ Browser: "node.js/v22.22.1", "Protocol-Version": "1.1" }), {
					status: 200,
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify([
						{
							id: "node-target",
							type: "node",
							title: "electron/js2c/browser_init",
							webSocketDebuggerUrl: "ws://127.0.0.1:9331/node-target",
						},
					]),
					{ status: 200 },
				),
			);

		await expect(electronSessionTestHooks.resolveInspectorEndpoint(9331, 10)).resolves.toEqual({
			Browser: "node.js/v22.22.1",
			webSocketDebuggerUrl: "ws://127.0.0.1:9331/node-target",
		});
	});

	it("keeps a wrapper-launched session when CDP is still alive after child exit", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ Browser: "Chrome/142" }), { status: 200 }),
		);

		await expect(electronSessionTestHooks.shouldDeleteSessionAfterChildExit(9330, 0)).resolves.toBe(false);
	});

	it("deletes a launched session when CDP is gone after child exit", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

		await expect(electronSessionTestHooks.shouldDeleteSessionAfterChildExit(9330, 0)).resolves.toBe(true);
	});
});
