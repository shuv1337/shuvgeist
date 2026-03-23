import { getAppStorage } from "@mariozechner/pi-web-ui";
import { BridgeTab, getBridgeSettingsChangeCallback, getBridgeStateForTab, setBridgeSettingsChangeCallback, setBridgeStateForTab } from "../../../src/dialogs/BridgeTab.js";

const settingsGet = vi.fn();
const settingsSet = vi.fn();

vi.mock("@mariozechner/pi-web-ui", async () => {
	const actual = await vi.importActual<object>("@mariozechner/pi-web-ui");
	return {
		...actual,
		getAppStorage: vi.fn(() => ({
			settings: {
				get: settingsGet,
				set: settingsSet,
			},
		})),
	};
});

describe("BridgeTab", () => {
	beforeEach(() => {
		settingsGet.mockReset();
		settingsSet.mockReset();
		setBridgeStateForTab("disabled");
		setBridgeSettingsChangeCallback(() => {});
	});

	it("exposes and updates shared bridge state", () => {
		setBridgeStateForTab("connected", "ok");
		expect(getBridgeStateForTab()).toEqual({ state: "connected", detail: "ok" });
		const callback = vi.fn();
		setBridgeSettingsChangeCallback(callback);
		expect(getBridgeSettingsChangeCallback()).toBe(callback);
	});

	it("loads persisted settings and notifies on commits", async () => {
		settingsGet.mockImplementation(async (key: string) => {
			switch (key) {
				case "bridge.enabled":
					return true;
				case "bridge.url":
					return "ws://127.0.0.1:9999/ws";
				case "bridge.token":
					return "abc123";
				default:
					return null;
			}
		});
		const callback = vi.fn();
		setBridgeSettingsChangeCallback(callback);
		setBridgeStateForTab("connected", "ready");
		expect(getBridgeStateForTab()).toEqual({ state: "connected", detail: "ready" });

		const tab = new BridgeTab();
		document.body.appendChild(tab);
		await tab.updateComplete;
		await Promise.resolve();
		await tab.updateComplete;

		const root = tab as unknown as HTMLElement;
		const checkbox = root.querySelector('input[type="checkbox"]') as HTMLInputElement;
		const inputs = root.querySelectorAll('input[type="text"], input[type="password"]');
		const urlInput = inputs[0] as HTMLInputElement;
		const tokenInput = inputs[1] as HTMLInputElement;
		expect(checkbox.checked).toBe(true);
		expect(urlInput.value).toBe("ws://127.0.0.1:9999/ws");
		expect(root.textContent).toContain("Disabled");

		urlInput.value = "ws://bridge.local:19285/ws";
		urlInput.dispatchEvent(new Event("input"));
		await Promise.resolve();
		expect(settingsSet).toHaveBeenCalledWith("bridge.url", "ws://bridge.local:19285/ws");

		tokenInput.value = "updated-token";
		tokenInput.dispatchEvent(new Event("input"));
		await Promise.resolve();
		expect(settingsSet).toHaveBeenCalledWith("bridge.token", "updated-token");

		urlInput.dispatchEvent(new Event("blur"));
		expect(callback).toHaveBeenCalledWith({
			enabled: true,
			url: "ws://bridge.local:19285/ws",
			token: "updated-token",
		});

		checkbox.checked = false;
		checkbox.dispatchEvent(new Event("change"));
		await Promise.resolve();
		expect(settingsSet).toHaveBeenCalledWith("bridge.enabled", false);
		expect(callback).toHaveBeenLastCalledWith({
			enabled: false,
			url: "ws://bridge.local:19285/ws",
			token: "updated-token",
		});

		tab.remove();
	});
});
