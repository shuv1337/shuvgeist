class StorageMock {
	getItem() {
		return null;
	}
	setItem() {}
	removeItem() {}
	clear() {}
	key() {
		return null;
	}
	get length() {
		return 0;
	}
}

Object.defineProperty(globalThis, "localStorage", {
	value: new StorageMock(),
	configurable: true,
});

import { BridgeTab } from "../../../src/dialogs/BridgeTab.js";
import {
	BRIDGE_OTEL_STATE_KEY,
	BRIDGE_SETTINGS_KEY,
	BRIDGE_STATE_KEY,
} from "../../../src/bridge/internal-messages.js";

declare global {
	var chrome: typeof chrome;
}

function createStorageArea(initialState: Record<string, unknown> = {}) {
	const state = { ...initialState };
	return {
		async get(keys?: string | string[] | Record<string, unknown> | null) {
			if (!keys) return { ...state };
			if (typeof keys === "string") return { [keys]: state[keys] };
			if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, state[key]]));
			return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, state[key] ?? fallback]));
		},
		async set(next: Record<string, unknown>) {
			Object.assign(state, next);
		},
		_state: state,
	};
}

describe("BridgeTab", () => {
	let localArea: ReturnType<typeof createStorageArea>;
	let sessionArea: ReturnType<typeof createStorageArea>;
	let listeners: Array<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void>;

	beforeEach(() => {
		document.body.innerHTML = "";
		localArea = createStorageArea({
			[BRIDGE_SETTINGS_KEY]: {
				enabled: true,
				url: "ws://127.0.0.1:19285/ws",
				token: "",
				sensitiveAccessEnabled: false,
				observability: {
					enabled: false,
					ingestUrl: "http://localhost:3474",
					publicIngestKey: "",
				},
			},
		});
		sessionArea = createStorageArea({
			[BRIDGE_STATE_KEY]: { state: "disconnected", detail: "waiting" },
			[BRIDGE_OTEL_STATE_KEY]: { state: "disabled" },
		});
		listeners = [];
		globalThis.chrome = {
			storage: {
				local: localArea,
				session: sessionArea,
				onChanged: {
					addListener(listener: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) {
						listeners.push(listener);
					},
					removeListener(listener: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) {
						listeners = listeners.filter((entry) => entry !== listener);
					},
				},
			},
		} as unknown as typeof chrome;
	});

	it("renders local default mode and bridge state from chrome storage", async () => {
		const tab = new BridgeTab();
		document.body.appendChild(tab);
		await tab.updateComplete;
		await Promise.resolve();
		await tab.updateComplete;

		expect(tab.textContent).toContain("CLI Bridge");
		expect(tab.textContent).toContain("Disconnected");
		expect(tab.textContent).toContain("Maple OTEL tracing");
		expect(tab.textContent).toContain("Run any `shuvgeist` command or `shuvgeist serve` to start the local bridge.");
		expect(tab.textContent).not.toContain("Enter the remote bridge token");
		tab.remove();
	});

	it("writes blocked/unblocked bridge state back to local storage", async () => {
		const tab = new BridgeTab();
		document.body.appendChild(tab);
		await tab.updateComplete;
		await Promise.resolve();
		await tab.updateComplete;

		const blockToggle = tab.querySelector('input[type="checkbox"]') as HTMLInputElement;
		blockToggle.checked = true;
		blockToggle.dispatchEvent(new Event("change"));
		await Promise.resolve();

		expect(localArea._state[BRIDGE_SETTINGS_KEY]).toMatchObject({ enabled: false });
		tab.remove();
	});

	it("writes sensitive access toggle and advanced URL/token edits to local storage", async () => {
		const tab = new BridgeTab();
		document.body.appendChild(tab);
		await tab.updateComplete;
		await Promise.resolve();
		await tab.updateComplete;

		const checkboxes = tab.querySelectorAll('input[type="checkbox"]');
		const sensitiveToggle = checkboxes[1] as HTMLInputElement;
		sensitiveToggle.checked = true;
		sensitiveToggle.dispatchEvent(new Event("change"));
		await Promise.resolve();

		expect(localArea._state[BRIDGE_SETTINGS_KEY]).toMatchObject({ sensitiveAccessEnabled: true });

		const inputs = tab.querySelectorAll('input[type="text"], input[type="password"]');
		const ingestUrlInput = inputs[0] as HTMLInputElement;
		const ingestKeyInput = inputs[1] as HTMLInputElement;
		const urlInput = inputs[2] as HTMLInputElement;
		const tokenInput = inputs[3] as HTMLInputElement;
		ingestUrlInput.value = "http://localhost:3474";
		ingestUrlInput.dispatchEvent(new Event("input"));
		ingestUrlInput.dispatchEvent(new Event("blur"));
		ingestKeyInput.value = "maple_pk_test";
		ingestKeyInput.dispatchEvent(new Event("input"));
		ingestKeyInput.dispatchEvent(new Event("blur"));
		urlInput.value = "ws://bridge.example:19285/ws";
		urlInput.dispatchEvent(new Event("input"));
		urlInput.dispatchEvent(new Event("blur"));
		tokenInput.value = "manual-token";
		tokenInput.dispatchEvent(new Event("input"));
		tokenInput.dispatchEvent(new Event("blur"));
		await Promise.resolve();

		expect(localArea._state[BRIDGE_SETTINGS_KEY]).toMatchObject({
			url: "ws://bridge.example:19285/ws",
			token: "manual-token",
			observability: {
				enabled: false,
				ingestUrl: "http://localhost:3474",
				publicIngestKey: "maple_pk_test",
			},
		});
		tab.remove();
	});

	it("writes observability toggle and reacts to OTEL session-state updates", async () => {
		const tab = new BridgeTab();
		document.body.appendChild(tab);
		await tab.updateComplete;
		await Promise.resolve();
		await tab.updateComplete;

		const checkboxes = tab.querySelectorAll('input[type="checkbox"]');
		const observabilityToggle = checkboxes[2] as HTMLInputElement;
		observabilityToggle.checked = true;
		observabilityToggle.dispatchEvent(new Event("change"));
		await Promise.resolve();

		expect(localArea._state[BRIDGE_SETTINGS_KEY]).toMatchObject({
			observability: {
				enabled: true,
			},
		});

		(tab as unknown as { applyOtelState: (state: { state: "ok"; lastExportedAt: string }) => void }).applyOtelState({
			state: "ok",
			lastExportedAt: "2026-04-22T12:00:00.000Z",
		});
		expect(
			(tab as unknown as { observabilityStateLabel: () => string }).observabilityStateLabel(),
		).toBe("Exported 2026-04-22T12:00:00.000Z");
		tab.remove();
	});

	it("updates status display from BRIDGE_STATE_KEY storage changes", async () => {
		const tab = new BridgeTab();
		document.body.appendChild(tab);
		await tab.updateComplete;
		await Promise.resolve();
		await Promise.resolve();
		await tab.updateComplete;

		((tab as unknown as { storageChangeListener: typeof listeners[number] }).storageChangeListener)(
			{
				[BRIDGE_STATE_KEY]: {
					oldValue: { state: "disconnected", detail: "waiting" },
					newValue: { state: "connected", detail: undefined },
				},
			},
			"session",
		);
		await Promise.resolve();
		expect((tab as unknown as { bridgeState: string }).bridgeState).toBe("connected");
		await tab.requestUpdate();
		await tab.updateComplete;

		expect(tab.textContent).toContain("Connected");
		tab.remove();
	});

	it("shows remote/manual-token guidance when URL is non-loopback and token is empty", async () => {
		localArea = createStorageArea({
			[BRIDGE_SETTINGS_KEY]: {
				enabled: true,
				url: "ws://192.168.1.44:19285/ws",
				token: "",
				sensitiveAccessEnabled: false,
				observability: {
					enabled: false,
					ingestUrl: "http://localhost:3474",
					publicIngestKey: "",
				},
			},
		});
		globalThis.chrome.storage.local = localArea as unknown as chrome.storage.LocalStorageArea;

		const tab = new BridgeTab();
		document.body.appendChild(tab);
		await tab.updateComplete;
		await Promise.resolve();
		await tab.updateComplete;

		expect(tab.textContent).toContain("Enter the remote bridge token to connect to a LAN or remote bridge.");
		tab.remove();
	});
});
