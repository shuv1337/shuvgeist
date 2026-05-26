import { ElectronSessionStore } from "../../../src/bridge/electron/session-store.js";
import type { BridgeTarget } from "../../../src/bridge/target.js";

describe("electron session store", () => {
	it("creates stable session ids and projects public summaries", () => {
		const store = new ElectronSessionStore();
		const first = store.create({
			appId: "app-one",
			appRef: "app",
			pid: 111,
			port: 9333,
			browser: "Electron/1",
			launched: false,
		});
		const second = store.create({
			appId: "app-two",
			port: 9444,
			launched: true,
		});
		first.windows.push(
			{
				ref: "w1",
				targetId: "target-1",
				type: "page",
				title: "Main",
				url: "app://main",
				webSocketDebuggerUrl: "ws://page",
				isPrimary: true,
				attachedAt: "2026-01-01T00:00:00.000Z",
				lastSeenAt: "2026-01-01T00:00:00.000Z",
			},
			{
				ref: "w2",
				targetId: "target-2",
				type: "page",
				webSocketDebuggerUrl: "ws://closed",
				isPrimary: false,
				attachedAt: "2026-01-01T00:00:00.000Z",
				lastSeenAt: "2026-01-01T00:00:00.000Z",
				closed: true,
			},
		);

		expect(first.id).toBe("e1");
		expect(second.id).toBe("e2");
		expect(store.summaries()).toMatchObject([
			{
				id: "e1",
				appId: "app-one",
				appRef: "app",
				pid: 111,
				port: 9333,
				browser: "Electron/1",
				launched: false,
				windows: [{ ref: "w1", title: "Main", url: "app://main", isPrimary: true }],
			},
			{
				id: "e2",
				appId: "app-two",
				port: 9444,
				launched: true,
				windows: [],
			},
		]);
	});

	it("looks up, deletes, and resolves target sessions", () => {
		const store = new ElectronSessionStore();
		const first = store.create({ appId: "first", appRef: "alpha", port: 9333, launched: false });
		const second = store.create({ appId: "second", appRef: "beta", port: 9444, launched: false });

		expect(store.get(first.id)).toBe(first);
		expect(store.resolveTargetSession({ kind: "electron-window", sessionId: second.id } as BridgeTarget)).toBe(second);
		expect(store.resolveTargetSession({ kind: "electron-window", appRef: "alpha" } as BridgeTarget)).toBe(first);
		expect(store.resolveTargetSession({ kind: "electron-window" } as BridgeTarget)).toBe(first);
		expect(store.delete(first.id)).toBe(true);
		expect(store.get(first.id)).toBeUndefined();
		expect(store.resolveTargetSession({ kind: "electron-window" } as BridgeTarget)).toBe(second);
	});
});
