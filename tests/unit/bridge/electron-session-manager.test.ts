import {
	ElectronSessionManager,
	electronSessionTestHooks,
} from "../../../src/bridge/electron/session-manager.js";

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

	it("filters captured snapshots by query while preserving ancestors", async () => {
		const close = vi.fn();
		const send = vi.fn(async () => ({
			result: {
				value: {
					success: true,
					result: {
						url: "app://settings",
						title: "Settings",
						generatedAt: 10,
						totalCandidates: 3,
						truncated: false,
						entries: [
							{
								snapshotId: "panel",
								frameId: 0,
								tagName: "section",
								role: "region",
								name: "Account",
								attributes: {},
								selectorCandidates: ["section"],
								ordinalPath: [0],
								boundingBox: { x: 0, y: 0, width: 400, height: 200 },
								interactive: false,
							},
							{
								snapshotId: "save",
								frameId: 0,
								tagName: "button",
								role: "button",
								name: "Save billing settings",
								text: "Save",
								attributes: {},
								selectorCandidates: ["#save"],
								ordinalPath: [0, 0],
								boundingBox: { x: 10, y: 20, width: 100, height: 32 },
								interactive: true,
							},
							{
								snapshotId: "cancel",
								frameId: 0,
								tagName: "button",
								role: "button",
								name: "Cancel",
								text: "Cancel",
								attributes: {},
								selectorCandidates: ["#cancel"],
								ordinalPath: [1],
								boundingBox: { x: 10, y: 60, width: 100, height: 32 },
								interactive: true,
							},
						],
					},
				},
			},
		}));
		const manager = new ElectronSessionManager();
		vi.spyOn(manager as unknown as { connectToPage: () => Promise<unknown> }, "connectToPage").mockResolvedValue({
			send,
			close,
		});

		const snapshot = await (
			manager as unknown as {
				captureSnapshot: (
					resolved: {
						session: { id: string };
						window: { ref: string };
					},
					options: { query?: string; maxEntries?: number },
				) => Promise<{ query?: string; entries: Array<{ snapshotId: string; tabId: number; frameId: number }> }>;
			}
		).captureSnapshot({ session: { id: "s1" }, window: { ref: "w1" } }, { query: "billing", maxEntries: 1 });

		expect(snapshot.query).toBe("billing");
		expect(snapshot.entries.map((entry) => entry.snapshotId)).toEqual(["panel", "save"]);
		expect(snapshot.entries.every((entry) => entry.tabId === -1 && entry.frameId === 0)).toBe(true);
		expect(close).toHaveBeenCalledOnce();
	});
});
