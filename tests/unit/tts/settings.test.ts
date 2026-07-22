import { beforeEach, describe, expect, it, vi } from "vitest";

const settingsStore = new Map<string, unknown>();
const storageMock = {
	settings: {
		get: vi.fn(async (key: string) => settingsStore.get(key) ?? null),
		set: vi.fn(async (key: string, value: unknown) => {
			settingsStore.set(key, value);
		}),
	},
};

vi.mock("@shuv1337/pi-web-ui", async () => {
	const actual = await vi.importActual<typeof import("@shuv1337/pi-web-ui")>("@shuv1337/pi-web-ui");
	return {
		...actual,
		getAppStorage: () => storageMock,
	};
});

const settingsModule = await import("@shuvgeist/extension/tts/settings");

const EXPECTED_TTS_STORAGE_KEYS = [
	"tts.enabled",
	"tts.provider",
	"tts.voiceId",
	"tts.speed",
	"tts.clickModeDefault",
	"tts.readAlongEnabled",
	"tts.maxTextChars",
	"tts.kokoro.baseUrl",
	"tts.kokoro.modelId",
	"tts.kokoro.voiceId",
	"tts.openai.modelId",
	"tts.openai.voiceId",
	"tts.elevenlabs.modelId",
	"tts.elevenlabs.outputFormat",
	"tts.elevenlabs.voiceId",
] as const;

describe("tts settings", () => {
	beforeEach(() => {
		settingsStore.clear();
		storageMock.settings.get.mockClear();
		storageMock.settings.set.mockClear();
	});

	it("normalizes missing values to defaults", () => {
		expect(settingsModule.normalizeTtsSettings({})).toEqual(settingsModule.DEFAULT_TTS_SETTINGS);
		expect(settingsModule.DEFAULT_TTS_SETTINGS.voiceId).toBe("am_onyx");
		expect(settingsModule.DEFAULT_TTS_SETTINGS.readAlongEnabled).toBe(true);
	});

	it("keeps every TTS descriptor, default, key, and persisted value in lockstep", async () => {
		const fields = Object.keys(settingsModule.TTS_SETTING_DESCRIPTORS);
		const keys = Object.values(settingsModule.TTS_SETTINGS_KEYS);

		expect(settingsModule.TTS_SETTINGS_FIELDS).toEqual(fields);
		expect(Object.keys(settingsModule.DEFAULT_TTS_SETTINGS)).toEqual(fields);
		expect(keys).toEqual(EXPECTED_TTS_STORAGE_KEYS);
		expect(new Set(keys).size).toBe(keys.length);

		await settingsModule.saveTtsSettings({});
		expect(new Set(settingsStore.keys())).toEqual(new Set(EXPECTED_TTS_STORAGE_KEYS));
		expect(storageMock.settings.set).toHaveBeenCalledTimes(EXPECTED_TTS_STORAGE_KEYS.length);
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

	it("merges a partial patch without resetting other settings or read-along", async () => {
		settingsStore.set(settingsModule.TTS_SETTINGS_KEYS.provider, "openai");
		settingsStore.set(settingsModule.TTS_SETTINGS_KEYS.voiceId, "nova");
		settingsStore.set(settingsModule.TTS_SETTINGS_KEYS.readAlongEnabled, false);
		settingsStore.set(settingsModule.TTS_SETTINGS_KEYS.kokoroBaseUrl, "http://kokoro.test/v1");

		const settings = await settingsModule.saveTtsSettings({ speed: 1.5 });

		expect(settings).toMatchObject({
			provider: "openai",
			voiceId: "nova",
			readAlongEnabled: false,
			kokoroBaseUrl: "http://kokoro.test/v1",
			speed: 1.5,
		});
		expect(settingsStore.get(settingsModule.TTS_SETTINGS_KEYS.readAlongEnabled)).toBe(false);
	});
});
