import { ElectronSessionStore } from "@shuvgeist/server/electron/session-store";
import type { BridgeTarget } from "@shuvgeist/protocol/target";

describe("electron session store", () => {
	it("creates stable session ids and projects public summaries", () => {
		const store = new ElectronSessionStore();
		const first = store.create({
			...endpointIdentity("ws://127.0.0.1:9333/devtools/browser/one", 111),
			appId: "app-one",
			appRef: "app",
			pid: 111,
			port: 9333,
			browser: "Electron/1",
			launched: false,
		});
		const second = store.create({
			...endpointIdentity("ws://127.0.0.1:9444/devtools/browser/two", 222),
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
		const first = store.create({
			...endpointIdentity("ws://127.0.0.1:9333/devtools/browser/one", 111),
			appId: "first",
			appRef: "alpha",
			port: 9333,
			launched: false,
		});
		const second = store.create({
			...endpointIdentity("ws://127.0.0.1:9444/devtools/browser/two", 222),
			appId: "second",
			appRef: "beta",
			port: 9444,
			launched: false,
		});

		expect(store.get(first.id)).toBe(first);
		expect(store.resolveTargetSession({ kind: "electron-window", sessionId: second.id } as BridgeTarget)).toBe(second);
		expect(store.resolveTargetSession({ kind: "electron-window", appRef: "alpha" } as BridgeTarget)).toBe(first);
		expect(store.resolveTargetSession({ kind: "electron-window" } as BridgeTarget)).toBe(first);
		expect(store.delete(first.id)).toBe(true);
		expect(store.get(first.id)).toBeUndefined();
		expect(store.resolveTargetSession({ kind: "electron-window" } as BridgeTarget)).toBe(second);
	});

	it("rejects a session selector when any supplied app identity disagrees", () => {
		const store = new ElectronSessionStore();
		const vscode = store.create({
			...endpointIdentity("ws://127.0.0.1:9333/devtools/browser/vscode", 111),
			appId: "com.microsoft.VSCode",
			appRef: "vscode",
			port: 9333,
			launched: false,
		});
		store.create({
			...endpointIdentity("ws://127.0.0.1:9444/devtools/browser/slack", 222),
			appId: "com.tinyspeck.slackmacgap",
			appRef: "slack",
			port: 9444,
			launched: false,
		});

		expect(
			store.resolveTargetSession({
				kind: "electron-window",
				sessionId: vscode.id,
				appRef: "slack",
			}),
		).toBeUndefined();
		expect(
			store.resolveTargetSession({
				kind: "electron-window",
				sessionId: vscode.id,
				appRef: "code",
			}),
		).toBe(vscode);
	});

	it("finds an exact debugger endpoint and same-port stale conflicts", () => {
		const store = new ElectronSessionStore();
		const current = store.create({
			...endpointIdentity("ws://127.0.0.1:9333/devtools/browser/current", 111),
			appId: "first",
			port: 9333,
			launched: false,
		});
		const stale = store.create({
			...endpointIdentity("ws://127.0.0.1:9333/devtools/browser/stale", 111),
			appId: "first",
			port: 9333,
			launched: false,
		});
		store.create({
			...endpointIdentity("ws://127.0.0.1:9444/devtools/browser/other", 222),
			appId: "second",
			port: 9444,
			launched: false,
		});

		expect(store.findByEndpointKey(current.endpointKey)).toBe(current);
		expect(store.findEndpointConflicts(current.endpointKey, 9333)).toEqual([stale]);
	});

	it("keeps explicit create semantics for separately launched processes", () => {
		const store = new ElectronSessionStore();
		const first = store.create({
			...endpointIdentity("ws://127.0.0.1:9333/devtools/browser/launch", 101),
			appId: "first",
			pid: 101,
			port: 9333,
			launched: true,
		});
		const second = store.create({
			...endpointIdentity("ws://127.0.0.1:9333/devtools/browser/launch", 101),
			appId: "first",
			pid: 202,
			port: 9333,
			launched: true,
		});

		expect(second.id).not.toBe(first.id);
		expect(store.list()).toEqual([first, second]);
	});
});

function endpointIdentity(browserEndpointKey: string, pid: number) {
	return {
		endpointKey: `${browserEndpointKey}|owner=${pid}`,
		browserEndpointKey,
		owner: {
			pid,
			generation: `generation-${pid}`,
			executablePath: `/app/${pid}`,
			familyKey: `app:${pid}@generation-${pid}:/app/${pid}`,
		},
	};
}
