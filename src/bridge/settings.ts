import { BRIDGE_SETTINGS_KEY, type BridgeObservabilitySettings, type BridgeSettings } from "./internal-messages.js";

export const LEGACY_BRIDGE_SETTINGS_DB_NAME = "shuvgeist-storage";
export const LEGACY_BRIDGE_SETTINGS_STORE_NAME = "settings";

const LEGACY_BRIDGE_SETTINGS_KEYS = {
	enabled: "bridge.enabled",
	url: "bridge.url",
	token: "bridge.token",
	sensitiveAccessEnabled: "bridge.sensitiveAccessEnabled",
} as const;

export interface BridgeSettingsStorageAdapter {
	getLocalSettings(): Promise<BridgeSettings | undefined>;
	setLocalSettings(settings: BridgeSettings): Promise<void>;
}

export interface LegacyIndexedDbLike {
	open(name: string): IDBOpenDBRequest;
}

export interface LoadBridgeSettingsResult {
	settings: BridgeSettings;
	source: "local" | "legacy" | "defaults";
	seededLocalStorage: boolean;
}

export function getDefaultBridgeSettings(): BridgeSettings {
	return {
		enabled: true,
		url: "ws://127.0.0.1:19285/ws",
		token: "",
		sensitiveAccessEnabled: false,
		observability: {
			enabled: false,
			ingestUrl: "http://localhost:3474",
			publicIngestKey: "",
		},
	};
}

export function normalizeBridgeSettings(settings?: Partial<BridgeSettings> | null): BridgeSettings {
	const defaults = getDefaultBridgeSettings();
	return {
		enabled: settings?.enabled ?? defaults.enabled,
		url: settings?.url ?? defaults.url,
		token: settings?.token ?? defaults.token,
		sensitiveAccessEnabled: settings?.sensitiveAccessEnabled ?? defaults.sensitiveAccessEnabled,
		observability: normalizeBridgeObservabilitySettings(settings?.observability),
	};
}

export function normalizeBridgeObservabilitySettings(
	settings?: Partial<BridgeObservabilitySettings> | null,
): BridgeObservabilitySettings {
	const defaults = getDefaultBridgeSettings().observability;
	return {
		enabled: settings?.enabled ?? defaults.enabled,
		ingestUrl: settings?.ingestUrl ?? defaults.ingestUrl,
		publicIngestKey: settings?.publicIngestKey ?? defaults.publicIngestKey,
	};
}

export function isLoopbackBridgeUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "ws:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
	} catch {
		return false;
	}
}

export function settingsRequireReconnect(previous: BridgeSettings | null, next: BridgeSettings): boolean {
	if (!previous) return true;
	return (
		previous.enabled !== next.enabled ||
		previous.url !== next.url ||
		previous.token !== next.token ||
		previous.sensitiveAccessEnabled !== next.sensitiveAccessEnabled
	);
}

export async function readLegacyBridgeSettingsFromIndexedDb(
	indexedDbFactory: LegacyIndexedDbLike = indexedDB,
): Promise<Partial<BridgeSettings> | null> {
	const database = await openLegacyBridgeDatabase(indexedDbFactory);
	if (!database) return null;

	try {
		if (!database.objectStoreNames.contains(LEGACY_BRIDGE_SETTINGS_STORE_NAME)) {
			return null;
		}

		const transaction = database.transaction(LEGACY_BRIDGE_SETTINGS_STORE_NAME, "readonly");
		const store = transaction.objectStore(LEGACY_BRIDGE_SETTINGS_STORE_NAME);
		const [enabled, url, token, sensitiveAccessEnabled] = await Promise.all([
			readStoreValue<boolean>(store, LEGACY_BRIDGE_SETTINGS_KEYS.enabled),
			readStoreValue<string>(store, LEGACY_BRIDGE_SETTINGS_KEYS.url),
			readStoreValue<string>(store, LEGACY_BRIDGE_SETTINGS_KEYS.token),
			readStoreValue<boolean>(store, LEGACY_BRIDGE_SETTINGS_KEYS.sensitiveAccessEnabled),
		]);

		const hasAnyLegacyValue =
			enabled !== undefined || url !== undefined || token !== undefined || sensitiveAccessEnabled !== undefined;
		if (!hasAnyLegacyValue) return null;

		return {
			enabled,
			url,
			token,
			sensitiveAccessEnabled,
		};
	} finally {
		database.close();
	}
}

export async function loadBridgeSettings(
	storage: BridgeSettingsStorageAdapter,
	readLegacy: () => Promise<Partial<BridgeSettings> | null> = () => readLegacyBridgeSettingsFromIndexedDb(),
): Promise<LoadBridgeSettingsResult> {
	const localSettings = await storage.getLocalSettings();
	if (localSettings) {
		return {
			settings: normalizeBridgeSettings(localSettings),
			source: "local",
			seededLocalStorage: false,
		};
	}

	const legacySettings = await readLegacy();
	const settings = normalizeBridgeSettings(legacySettings);
	await storage.setLocalSettings(settings);
	return {
		settings,
		source: legacySettings ? "legacy" : "defaults",
		seededLocalStorage: true,
	};
}

export function createChromeStorageBridgeSettingsAdapter(): BridgeSettingsStorageAdapter {
	return {
		async getLocalSettings() {
			const data = await chrome.storage.local.get(BRIDGE_SETTINGS_KEY);
			return data[BRIDGE_SETTINGS_KEY] as BridgeSettings | undefined;
		},
		async setLocalSettings(settings) {
			await chrome.storage.local.set({ [BRIDGE_SETTINGS_KEY]: settings });
		},
	};
}

async function openLegacyBridgeDatabase(indexedDbFactory: LegacyIndexedDbLike): Promise<IDBDatabase | null> {
	return new Promise((resolve, reject) => {
		const request = indexedDbFactory.open(LEGACY_BRIDGE_SETTINGS_DB_NAME);
		let createdFreshDatabase = false;

		request.onupgradeneeded = () => {
			createdFreshDatabase = request.result.version === 1;
		};
		request.onerror = () => reject(request.error ?? new Error("Failed to open legacy bridge settings database"));
		request.onsuccess = () => {
			const database = request.result;
			if (createdFreshDatabase) {
				database.close();
				resolve(null);
				return;
			}
			resolve(database);
		};
	});
}

async function readStoreValue<T>(store: IDBObjectStore, key: string): Promise<T | undefined> {
	return new Promise((resolve, reject) => {
		const request = store.get(key);
		request.onerror = () => reject(request.error ?? new Error(`Failed to read legacy bridge setting: ${key}`));
		request.onsuccess = () => resolve(request.result as T | undefined);
	});
}
