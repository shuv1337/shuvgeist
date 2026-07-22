import { TTS_PROVIDER_IDS, type TtsProviderId } from "./types.js";

interface TtsSettingDescriptor<Key extends string, Value> {
	readonly key: Key;
	readonly defaultValue: Value;
	readonly normalize: (value: unknown) => Value;
}

function booleanSetting<const Key extends string>(key: Key, defaultValue: boolean): TtsSettingDescriptor<Key, boolean> {
	return {
		key,
		defaultValue,
		normalize: (value) => (typeof value === "boolean" ? value : defaultValue),
	};
}

function numberSetting<const Key extends string>(key: Key, defaultValue: number): TtsSettingDescriptor<Key, number> {
	return {
		key,
		defaultValue,
		normalize: (value) => (typeof value === "number" && Number.isFinite(value) ? value : defaultValue),
	};
}

function nonEmptyStringSetting<const Key extends string>(
	key: Key,
	defaultValue: string,
): TtsSettingDescriptor<Key, string> {
	return {
		key,
		defaultValue,
		normalize: (value) => (typeof value === "string" && value.trim().length > 0 ? value : defaultValue),
	};
}

function stringSetting<const Key extends string>(key: Key, defaultValue: string): TtsSettingDescriptor<Key, string> {
	return {
		key,
		defaultValue,
		normalize: (value) => (typeof value === "string" ? value : defaultValue),
	};
}

function providerSetting<const Key extends string>(
	key: Key,
	defaultValue: TtsProviderId,
): TtsSettingDescriptor<Key, TtsProviderId> {
	return {
		key,
		defaultValue,
		normalize: (value) => normalizeTtsProvider(value, defaultValue),
	};
}

export const TTS_SETTING_DESCRIPTORS = {
	enabled: booleanSetting("tts.enabled", true),
	provider: providerSetting("tts.provider", "kokoro"),
	voiceId: nonEmptyStringSetting("tts.voiceId", "am_onyx"),
	speed: numberSetting("tts.speed", 1),
	clickModeDefault: booleanSetting("tts.clickModeDefault", false),
	readAlongEnabled: booleanSetting("tts.readAlongEnabled", true),
	maxTextChars: numberSetting("tts.maxTextChars", 3000),
	kokoroBaseUrl: nonEmptyStringSetting("tts.kokoro.baseUrl", "http://127.0.0.1:8880/v1"),
	kokoroModelId: nonEmptyStringSetting("tts.kokoro.modelId", "kokoro"),
	kokoroVoiceId: nonEmptyStringSetting("tts.kokoro.voiceId", "am_onyx"),
	openaiModelId: nonEmptyStringSetting("tts.openai.modelId", "gpt-4o-mini-tts"),
	openaiVoiceId: nonEmptyStringSetting("tts.openai.voiceId", "alloy"),
	elevenLabsModelId: nonEmptyStringSetting("tts.elevenlabs.modelId", "eleven_turbo_v2_5"),
	elevenLabsOutputFormat: nonEmptyStringSetting("tts.elevenlabs.outputFormat", "mp3_44100_128"),
	elevenLabsVoiceId: stringSetting("tts.elevenlabs.voiceId", ""),
} as const;

export type TtsSettingsField = keyof typeof TTS_SETTING_DESCRIPTORS;

export type TtsSettingsSnapshot = {
	[Field in TtsSettingsField]: ReturnType<(typeof TTS_SETTING_DESCRIPTORS)[Field]["normalize"]>;
};

export type TtsPersistentSettingsSchema = {
	[Field in TtsSettingsField as (typeof TTS_SETTING_DESCRIPTORS)[Field]["key"]]: TtsSettingsSnapshot[Field];
};

type TtsSettingsKeyMap = {
	readonly [Field in TtsSettingsField]: (typeof TTS_SETTING_DESCRIPTORS)[Field]["key"];
};

export const TTS_SETTINGS_FIELDS = Object.keys(TTS_SETTING_DESCRIPTORS) as TtsSettingsField[];

export const TTS_SETTINGS_KEYS = Object.fromEntries(
	TTS_SETTINGS_FIELDS.map((field) => [field, TTS_SETTING_DESCRIPTORS[field].key]),
) as TtsSettingsKeyMap;

export const DEFAULT_TTS_SETTINGS = Object.fromEntries(
	TTS_SETTINGS_FIELDS.map((field) => [field, TTS_SETTING_DESCRIPTORS[field].defaultValue]),
) as TtsSettingsSnapshot;

export function normalizeTtsProvider(
	value: unknown,
	fallback: TtsProviderId = DEFAULT_TTS_SETTINGS.provider,
): TtsProviderId {
	return typeof value === "string" && TTS_PROVIDER_IDS.includes(value as TtsProviderId)
		? (value as TtsProviderId)
		: fallback;
}

export function normalizeTtsSettings(raw: Partial<Record<string, unknown>> = {}): TtsSettingsSnapshot {
	return Object.fromEntries(
		TTS_SETTINGS_FIELDS.map((field) => {
			const descriptor = TTS_SETTING_DESCRIPTORS[field];
			return [field, descriptor.normalize(raw[descriptor.key])];
		}),
	) as TtsSettingsSnapshot;
}

export function toTtsSettingsStorageValues(settings: TtsSettingsSnapshot): TtsPersistentSettingsSchema {
	return Object.fromEntries(
		TTS_SETTINGS_FIELDS.map((field) => [TTS_SETTING_DESCRIPTORS[field].key, settings[field]]),
	) as TtsPersistentSettingsSchema;
}
