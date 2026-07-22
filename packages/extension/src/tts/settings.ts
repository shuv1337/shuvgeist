import { getPersistentTtsSetting, setPersistentTtsSetting } from "../storage/persistent-settings.js";
import {
	DEFAULT_TTS_SETTINGS,
	normalizeTtsProvider,
	normalizeTtsSettings as normalizeTtsSettingsFromSchema,
	TTS_SETTING_DESCRIPTORS,
	TTS_SETTINGS_FIELDS,
	TTS_SETTINGS_KEYS,
	toTtsSettingsStorageValues,
} from "./settings-schema.js";
import type { TtsProviderId, TtsSettingsSnapshot, TtsVoice } from "./types.js";

export { DEFAULT_TTS_SETTINGS, normalizeTtsProvider, TTS_SETTING_DESCRIPTORS, TTS_SETTINGS_FIELDS, TTS_SETTINGS_KEYS };

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

export function normalizeTtsSettings(raw: Partial<Record<string, unknown>> = {}): TtsSettingsSnapshot {
	const snapshot = normalizeTtsSettingsFromSchema(raw);

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
	const entries = await Promise.all(
		TTS_SETTINGS_FIELDS.map(async (field) => {
			const value = await getPersistentTtsSetting(field);
			return [TTS_SETTINGS_KEYS[field], value] as const;
		}),
	);
	return normalizeTtsSettings(Object.fromEntries(entries));
}

export async function saveTtsSettings(partial: Partial<TtsSettingsSnapshot>): Promise<TtsSettingsSnapshot> {
	const current = await loadTtsSettings();
	const merged: TtsSettingsSnapshot = { ...current, ...partial };
	const next = normalizeTtsSettings(toTtsSettingsStorageValues(merged));

	await Promise.all(TTS_SETTINGS_FIELDS.map((field) => setPersistentTtsSetting(field, next[field])));

	return next;
}
