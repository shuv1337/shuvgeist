import { getAppStorage } from "@mariozechner/pi-web-ui";
import type { TtsProviderId, TtsSettingsSnapshot, TtsVoice } from "./types.js";

export const TTS_SETTINGS_KEYS = {
	enabled: "tts.enabled",
	provider: "tts.provider",
	voiceId: "tts.voiceId",
	speed: "tts.speed",
	clickModeDefault: "tts.clickModeDefault",
	kokoroBaseUrl: "tts.kokoro.baseUrl",
	kokoroModelId: "tts.kokoro.modelId",
	kokoroVoiceId: "tts.kokoro.voiceId",
	openaiModelId: "tts.openai.modelId",
	openaiVoiceId: "tts.openai.voiceId",
	elevenLabsModelId: "tts.elevenlabs.modelId",
	elevenLabsOutputFormat: "tts.elevenlabs.outputFormat",
	elevenLabsVoiceId: "tts.elevenlabs.voiceId",
	maxTextChars: "tts.maxTextChars",
} as const;

export const DEFAULT_KOKORO_VOICES: TtsVoice[] = [
	{ id: "am_onyx", label: "AM Onyx", provider: "kokoro", description: "Default Kokoro voice" },
	{ id: "af_heart", label: "AF Heart", provider: "kokoro" },
	{ id: "af_bella", label: "AF Bella", provider: "kokoro" },
	{ id: "af_nicole", label: "AF Nicole", provider: "kokoro" },
	{ id: "am_adam", label: "AM Adam", provider: "kokoro" },
];

export const OPENAI_TTS_VOICES: TtsVoice[] = [
	{ id: "alloy", label: "Alloy", provider: "openai" },
	{ id: "ash", label: "Ash", provider: "openai" },
	{ id: "ballad", label: "Ballad", provider: "openai" },
	{ id: "coral", label: "Coral", provider: "openai" },
	{ id: "echo", label: "Echo", provider: "openai" },
	{ id: "fable", label: "Fable", provider: "openai" },
	{ id: "nova", label: "Nova", provider: "openai" },
	{ id: "onyx", label: "Onyx", provider: "openai" },
	{ id: "sage", label: "Sage", provider: "openai" },
	{ id: "shimmer", label: "Shimmer", provider: "openai" },
];

export const DEFAULT_TTS_SETTINGS: TtsSettingsSnapshot = {
	enabled: true,
	provider: "kokoro",
	voiceId: "am_onyx",
	speed: 1,
	clickModeDefault: false,
	maxTextChars: 3000,
	kokoroBaseUrl: "http://127.0.0.1:8880/v1",
	kokoroModelId: "kokoro",
	kokoroVoiceId: "am_onyx",
	openaiModelId: "gpt-4o-mini-tts",
	openaiVoiceId: "alloy",
	elevenLabsModelId: "eleven_turbo_v2_5",
	elevenLabsOutputFormat: "mp3_44100_128",
	elevenLabsVoiceId: "",
};

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizeNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeString(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

export function normalizeTtsProvider(
	value: unknown,
	fallback: TtsProviderId = DEFAULT_TTS_SETTINGS.provider,
): TtsProviderId {
	return value === "kokoro" || value === "openai" || value === "elevenlabs" ? value : fallback;
}

export function normalizeTtsSettings(raw: Partial<Record<string, unknown>> = {}): TtsSettingsSnapshot {
	const provider = normalizeTtsProvider(raw[TTS_SETTINGS_KEYS.provider], DEFAULT_TTS_SETTINGS.provider);
	const snapshot: TtsSettingsSnapshot = {
		enabled: normalizeBoolean(raw[TTS_SETTINGS_KEYS.enabled], DEFAULT_TTS_SETTINGS.enabled),
		provider,
		voiceId: normalizeString(raw[TTS_SETTINGS_KEYS.voiceId], DEFAULT_TTS_SETTINGS.voiceId),
		speed: normalizeNumber(raw[TTS_SETTINGS_KEYS.speed], DEFAULT_TTS_SETTINGS.speed),
		clickModeDefault: normalizeBoolean(
			raw[TTS_SETTINGS_KEYS.clickModeDefault],
			DEFAULT_TTS_SETTINGS.clickModeDefault,
		),
		maxTextChars: normalizeNumber(raw[TTS_SETTINGS_KEYS.maxTextChars], DEFAULT_TTS_SETTINGS.maxTextChars),
		kokoroBaseUrl: normalizeString(raw[TTS_SETTINGS_KEYS.kokoroBaseUrl], DEFAULT_TTS_SETTINGS.kokoroBaseUrl),
		kokoroModelId: normalizeString(raw[TTS_SETTINGS_KEYS.kokoroModelId], DEFAULT_TTS_SETTINGS.kokoroModelId),
		kokoroVoiceId: normalizeString(raw[TTS_SETTINGS_KEYS.kokoroVoiceId], DEFAULT_TTS_SETTINGS.kokoroVoiceId),
		openaiModelId: normalizeString(raw[TTS_SETTINGS_KEYS.openaiModelId], DEFAULT_TTS_SETTINGS.openaiModelId),
		openaiVoiceId: normalizeString(raw[TTS_SETTINGS_KEYS.openaiVoiceId], DEFAULT_TTS_SETTINGS.openaiVoiceId),
		elevenLabsModelId: normalizeString(
			raw[TTS_SETTINGS_KEYS.elevenLabsModelId],
			DEFAULT_TTS_SETTINGS.elevenLabsModelId,
		),
		elevenLabsOutputFormat: normalizeString(
			raw[TTS_SETTINGS_KEYS.elevenLabsOutputFormat],
			DEFAULT_TTS_SETTINGS.elevenLabsOutputFormat,
		),
		elevenLabsVoiceId:
			typeof raw[TTS_SETTINGS_KEYS.elevenLabsVoiceId] === "string"
				? (raw[TTS_SETTINGS_KEYS.elevenLabsVoiceId] as string)
				: DEFAULT_TTS_SETTINGS.elevenLabsVoiceId,
	};

	if (!snapshot.voiceId) {
		snapshot.voiceId = getDefaultVoiceId(snapshot.provider, snapshot);
	}

	return snapshot;
}

export function getDefaultVoiceId(provider: TtsProviderId, settings = DEFAULT_TTS_SETTINGS): string {
	switch (provider) {
		case "kokoro":
			return settings.kokoroVoiceId;
		case "openai":
			return settings.openaiVoiceId;
		case "elevenlabs":
			return settings.elevenLabsVoiceId;
	}
}

export async function loadTtsSettings(): Promise<TtsSettingsSnapshot> {
	const storage = getAppStorage();
	const entries = await Promise.all(
		Object.values(TTS_SETTINGS_KEYS).map(async (key) => {
			const value = await storage.settings.get(key);
			return [key, value] as const;
		}),
	);
	return normalizeTtsSettings(Object.fromEntries(entries));
}

export async function saveTtsSettings(partial: Partial<TtsSettingsSnapshot>): Promise<TtsSettingsSnapshot> {
	const storage = getAppStorage();
	const next = normalizeTtsSettings({
		[TTS_SETTINGS_KEYS.enabled]: partial.enabled,
		[TTS_SETTINGS_KEYS.provider]: partial.provider,
		[TTS_SETTINGS_KEYS.voiceId]: partial.voiceId,
		[TTS_SETTINGS_KEYS.speed]: partial.speed,
		[TTS_SETTINGS_KEYS.clickModeDefault]: partial.clickModeDefault,
		[TTS_SETTINGS_KEYS.maxTextChars]: partial.maxTextChars,
		[TTS_SETTINGS_KEYS.kokoroBaseUrl]: partial.kokoroBaseUrl,
		[TTS_SETTINGS_KEYS.kokoroModelId]: partial.kokoroModelId,
		[TTS_SETTINGS_KEYS.kokoroVoiceId]: partial.kokoroVoiceId,
		[TTS_SETTINGS_KEYS.openaiModelId]: partial.openaiModelId,
		[TTS_SETTINGS_KEYS.openaiVoiceId]: partial.openaiVoiceId,
		[TTS_SETTINGS_KEYS.elevenLabsModelId]: partial.elevenLabsModelId,
		[TTS_SETTINGS_KEYS.elevenLabsOutputFormat]: partial.elevenLabsOutputFormat,
		[TTS_SETTINGS_KEYS.elevenLabsVoiceId]: partial.elevenLabsVoiceId,
	});

	await Promise.all(
		(
			[
				[TTS_SETTINGS_KEYS.enabled, next.enabled],
				[TTS_SETTINGS_KEYS.provider, next.provider],
				[TTS_SETTINGS_KEYS.voiceId, next.voiceId],
				[TTS_SETTINGS_KEYS.speed, next.speed],
				[TTS_SETTINGS_KEYS.clickModeDefault, next.clickModeDefault],
				[TTS_SETTINGS_KEYS.maxTextChars, next.maxTextChars],
				[TTS_SETTINGS_KEYS.kokoroBaseUrl, next.kokoroBaseUrl],
				[TTS_SETTINGS_KEYS.kokoroModelId, next.kokoroModelId],
				[TTS_SETTINGS_KEYS.kokoroVoiceId, next.kokoroVoiceId],
				[TTS_SETTINGS_KEYS.openaiModelId, next.openaiModelId],
				[TTS_SETTINGS_KEYS.openaiVoiceId, next.openaiVoiceId],
				[TTS_SETTINGS_KEYS.elevenLabsModelId, next.elevenLabsModelId],
				[TTS_SETTINGS_KEYS.elevenLabsOutputFormat, next.elevenLabsOutputFormat],
				[TTS_SETTINGS_KEYS.elevenLabsVoiceId, next.elevenLabsVoiceId],
			] as const
		).map(([key, value]) => storage.settings.set(key, value)),
	);

	return next;
}
