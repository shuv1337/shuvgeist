import type { Api, Model } from "@shuv1337/pi-ai";
import { getAppStorage } from "@shuv1337/pi-web-ui";
import {
	TTS_SETTINGS_KEYS,
	type TtsPersistentSettingsSchema,
	type TtsSettingsField,
	type TtsSettingsSnapshot,
} from "../tts/settings-schema.js";

export const PERSISTENT_TTS_SETTING_KEYS = TTS_SETTINGS_KEYS;

export const PERSISTENT_APP_SETTING_KEYS = {
	proxyEnabled: "proxy.enabled",
	proxyUrl: "proxy.url",
	lastUsedModel: "lastUsedModel",
	plannerValidatorEnabled: "agent.plannerValidator.enabled",
	...PERSISTENT_TTS_SETTING_KEYS,
} as const;

interface PersistentNonTtsSettingsSchema {
	"proxy.enabled": boolean;
	"proxy.url": string;
	lastUsedModel: Model<Api>;
	"agent.plannerValidator.enabled": boolean;
}

export type PersistentAppSettingsSchema = PersistentNonTtsSettingsSchema & TtsPersistentSettingsSchema;

export type PersistentAppSettingKey = keyof PersistentAppSettingsSchema;

export interface PersistentAppSettingsStore {
	get<T>(key: string): Promise<T | null>;
	set<T>(key: string, value: T): Promise<void>;
}

export interface ProxySettings {
	enabled: boolean;
	url?: string;
}

function defaultSettingsStore(): PersistentAppSettingsStore {
	return getAppStorage().settings;
}

export function getPersistentAppSetting<K extends PersistentAppSettingKey>(
	key: K,
	store: PersistentAppSettingsStore = defaultSettingsStore(),
): Promise<PersistentAppSettingsSchema[K] | null> {
	return store.get<PersistentAppSettingsSchema[K]>(key);
}

export function setPersistentAppSetting<K extends PersistentAppSettingKey>(
	key: K,
	value: PersistentAppSettingsSchema[K],
	store: PersistentAppSettingsStore = defaultSettingsStore(),
): Promise<void> {
	return store.set(key, value);
}

export function getPersistentTtsSetting<Field extends TtsSettingsField>(
	field: Field,
	store: PersistentAppSettingsStore = defaultSettingsStore(),
): Promise<TtsSettingsSnapshot[Field] | null> {
	return store.get<TtsSettingsSnapshot[Field]>(TTS_SETTINGS_KEYS[field]);
}

export function setPersistentTtsSetting<Field extends TtsSettingsField>(
	field: Field,
	value: TtsSettingsSnapshot[Field],
	store: PersistentAppSettingsStore = defaultSettingsStore(),
): Promise<void> {
	return store.set(TTS_SETTINGS_KEYS[field], value);
}

export async function loadProxySettings(store?: PersistentAppSettingsStore): Promise<ProxySettings> {
	const [enabled, url] = await Promise.all([
		getPersistentAppSetting(PERSISTENT_APP_SETTING_KEYS.proxyEnabled, store),
		getPersistentAppSetting(PERSISTENT_APP_SETTING_KEYS.proxyUrl, store),
	]);
	return {
		enabled: enabled === true,
		...(typeof url === "string" && url.length > 0 ? { url } : {}),
	};
}

export function setProxyEnabled(enabled: boolean, store?: PersistentAppSettingsStore): Promise<void> {
	return setPersistentAppSetting(PERSISTENT_APP_SETTING_KEYS.proxyEnabled, enabled, store);
}

export async function loadLastUsedModel(store?: PersistentAppSettingsStore): Promise<Model<Api> | null> {
	const value = await getPersistentAppSetting(PERSISTENT_APP_SETTING_KEYS.lastUsedModel, store);
	if (!value || typeof value !== "object") return null;
	if (typeof value.provider !== "string" || typeof value.id !== "string") return null;
	return value;
}

export function saveLastUsedModel(model: Model<Api>, store?: PersistentAppSettingsStore): Promise<void> {
	return setPersistentAppSetting(PERSISTENT_APP_SETTING_KEYS.lastUsedModel, model, store);
}

export async function loadPlannerValidatorEnabled(store?: PersistentAppSettingsStore): Promise<boolean> {
	return (await getPersistentAppSetting(PERSISTENT_APP_SETTING_KEYS.plannerValidatorEnabled, store)) !== false;
}
