import { describe, expect, it } from "vitest";
import {
	DEVELOPER_SETTING_KEYS,
	loadDeveloperSettings,
	updateDeveloperSettings,
	type DeveloperSettingsStorageArea,
} from "@shuvgeist/extension/storage/developer-settings";

function createStorage(initial: Record<string, unknown> = {}): DeveloperSettingsStorageArea & {
	values: Map<string, unknown>;
} {
	const values = new Map(Object.entries(initial));
	return {
		values,
		async get(keys) {
			return Object.fromEntries(keys.filter((key) => values.has(key)).map((key) => [key, values.get(key)]));
		},
		async set(items) {
			for (const [key, value] of Object.entries(items)) values.set(key, value);
		},
	};
}

describe("developer settings", () => {
	it("defaults both existing chrome.local flags to false", async () => {
		await expect(loadDeveloperSettings(createStorage())).resolves.toEqual({
			debuggerMode: false,
			showJsonMode: false,
		});
	});

	it("patches one flag without overwriting the other", async () => {
		const storage = createStorage({
			[DEVELOPER_SETTING_KEYS.debuggerMode]: true,
			[DEVELOPER_SETTING_KEYS.showJsonMode]: true,
		});

		await updateDeveloperSettings({ debuggerMode: false }, storage);
		await expect(loadDeveloperSettings(storage)).resolves.toEqual({
			debuggerMode: false,
			showJsonMode: true,
		});
	});
});
