import { describe, expect, it, vi } from "vitest";

const settingsStore = new Map<string, unknown>();
const storageMock = {
	settings: {
		get: vi.fn(async (key: string) => settingsStore.get(key) ?? null),
		set: vi.fn(async (key: string, value: unknown) => {
			settingsStore.set(key, value);
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

const settingsModule = await import("../../../src/tts/settings.js");

describe("tts settings", () => {
	it("normalizes missing values to defaults", () => {
		expect(settingsModule.normalizeTtsSettings({})).toEqual(settingsModule.DEFAULT_TTS_SETTINGS);
		expect(settingsModule.DEFAULT_TTS_SETTINGS.voiceId).toBe("am_onyx");
		expect(settingsModule.DEFAULT_TTS_SETTINGS.readAlongEnabled).toBe(true);
	});

	it("loads settings from the existing flat store keys", async () => {
		settingsStore.set(settingsModule.TTS_SETTINGS_KEYS.provider, "openai");
		settingsStore.set(settingsModule.TTS_SETTINGS_KEYS.voiceId, "nova");
		settingsStore.set(settingsModule.TTS_SETTINGS_KEYS.speed, 1.25);

		const settings = await settingsModule.loadTtsSettings();
		expect(settings.provider).toBe("openai");
		expect(settings.voiceId).toBe("nova");
		expect(settings.speed).toBe(1.25);
	});

	it("persists normalized settings back to flat keys", async () => {
		await settingsModule.saveTtsSettings({
			...settingsModule.DEFAULT_TTS_SETTINGS,
			provider: "kokoro",
			voiceId: "af_bella",
		});

		expect(storageMock.settings.set).toHaveBeenCalledWith("tts.provider", "kokoro");
		expect(storageMock.settings.set).toHaveBeenCalledWith("tts.voiceId", "af_bella");
		expect(storageMock.settings.set).toHaveBeenCalledWith("tts.readAlongEnabled", true);
	});
});
