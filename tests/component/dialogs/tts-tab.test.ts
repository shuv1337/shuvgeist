import { beforeEach, describe, expect, it, vi } from "vitest";
import { setAppStorage } from "@mariozechner/pi-web-ui";

const settingsStore = new Map<string, unknown>();
const providerKeyStore = new Map<string, string>();

const storageMock = {
	settings: {
		get: vi.fn(async (key: string) => settingsStore.get(key) ?? null),
		set: vi.fn(async (key: string, value: unknown) => {
			settingsStore.set(key, value);
		}),
	},
	providerKeys: {
		get: vi.fn(async (key: string) => providerKeyStore.get(key) ?? null),
		set: vi.fn(async (key: string, value: string) => {
			providerKeyStore.set(key, value);
		}),
	},
};

vi.mock("@mariozechner/pi-web-ui", async () => {
	const actual = await vi.importActual<typeof import("@mariozechner/pi-web-ui")>("@mariozechner/pi-web-ui");
	return {
		...actual,
		getAppStorage: () => storageMock,
	};
});

describe("TtsTab", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
		settingsStore.clear();
		providerKeyStore.clear();
		setAppStorage(storageMock as never);
		(globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = {
			runtime: {
				sendMessage: vi.fn().mockResolvedValue({ ok: true }),
			},
		} as unknown as typeof chrome;
	});

	it("renders the shared OpenAI key state and overlay button", async () => {
		providerKeyStore.set("openai", "sk-test");
		settingsStore.set("tts.provider", "openai");
		settingsStore.set("tts.voiceId", "alloy");
		const { TtsTab } = await import("../../../src/dialogs/TtsTab.js");
		const tab = new TtsTab();
		document.body.appendChild(tab);
		await tab.updateComplete;
		await new Promise((resolve) => setTimeout(resolve, 0));
		await tab.updateComplete;

		expect(tab.textContent).toContain("Text to Speech");
		expect(tab.textContent).toContain('Using the shared provider-keys["openai"] credential.');
		expect(tab.textContent).toContain("Open overlay on current page");
	});
});
