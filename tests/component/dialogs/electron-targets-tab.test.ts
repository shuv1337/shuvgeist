import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_SETTINGS_KEY } from "@shuvgeist/extension/bridge/internal-messages";
import { ElectronTargetsTab } from "@shuvgeist/extension/dialogs/ElectronTargetsTab";

function createStorageArea(initialState: Record<string, unknown> = {}) {
	const state = { ...initialState };
	return {
		async get(keys?: string | string[]) {
			if (!keys) return { ...state };
			const requested = Array.isArray(keys) ? keys : [keys];
			return Object.fromEntries(requested.map((key) => [key, state[key]]));
		},
		set: vi.fn(async (next: Record<string, unknown>) => {
			Object.assign(state, next);
		}),
	};
}

describe("ElectronTargetsTab", () => {
	let sessionArea: ReturnType<typeof createStorageArea>;

	beforeEach(() => {
		document.body.innerHTML = "";
		sessionArea = createStorageArea();
		globalThis.chrome = {
			storage: {
				local: createStorageArea({
					[BRIDGE_SETTINGS_KEY]: {
						enabled: true,
						url: "ws://127.0.0.1:19285/ws",
						token: "token",
						sensitiveAccessEnabled: false,
						observability: { enabled: false, ingestUrl: "http://localhost:3474", publicIngestKey: "" },
					},
				}),
				session: sessionArea,
				onChanged: {
					addListener: vi.fn(),
					removeListener: vi.fn(),
				},
			},
		} as unknown as typeof chrome;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps refresh failures component-local and never writes transient session state", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
		const tab = new ElectronTargetsTab();
		document.body.appendChild(tab);
		await tab.updateComplete;
		await Promise.resolve();

		await (tab as unknown as { refreshFromBridge(): Promise<void> }).refreshFromBridge();
		await tab.updateComplete;

		expect(tab.textContent).toContain("Failed to refresh Electron targets: HTTP 503");
		expect(sessionArea.set).not.toHaveBeenCalled();
		tab.remove();
	});
});
