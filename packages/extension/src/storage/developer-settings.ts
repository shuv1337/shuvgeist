export const DEVELOPER_SETTING_KEYS = {
	debuggerMode: "debuggerMode",
	showJsonMode: "showJsonMode",
} as const;

export interface DeveloperSettings {
	debuggerMode: boolean;
	showJsonMode: boolean;
}

export interface DeveloperSettingsStorageArea {
	get(keys: string[]): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
}

export async function loadDeveloperSettings(
	storage: DeveloperSettingsStorageArea = chrome.storage.local,
): Promise<DeveloperSettings> {
	const stored = await storage.get(Object.values(DEVELOPER_SETTING_KEYS));
	return {
		debuggerMode: stored[DEVELOPER_SETTING_KEYS.debuggerMode] === true,
		showJsonMode: stored[DEVELOPER_SETTING_KEYS.showJsonMode] === true,
	};
}

export function updateDeveloperSettings(
	settings: Partial<DeveloperSettings>,
	storage: DeveloperSettingsStorageArea = chrome.storage.local,
): Promise<void> {
	const updates: Record<string, unknown> = {};
	if (settings.debuggerMode !== undefined) {
		updates[DEVELOPER_SETTING_KEYS.debuggerMode] = settings.debuggerMode;
	}
	if (settings.showJsonMode !== undefined) {
		updates[DEVELOPER_SETTING_KEYS.showJsonMode] = settings.showJsonMode;
	}
	return storage.set(updates);
}
