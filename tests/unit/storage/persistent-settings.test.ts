import { getModel } from "@shuv1337/pi-ai";
import { describe, expect, it } from "vitest";
import {
	loadLastUsedModel,
	loadPlannerValidatorEnabled,
	loadProxySettings,
	PERSISTENT_APP_SETTING_KEYS,
	saveLastUsedModel,
	setProxyEnabled,
	type PersistentAppSettingsStore,
} from "@shuvgeist/extension/storage/persistent-settings";

function createStore(initial: Record<string, unknown> = {}): PersistentAppSettingsStore & {
	values: Map<string, unknown>;
} {
	const values = new Map(Object.entries(initial));
	return {
		values,
		async get<T>(key: string) {
			return (values.get(key) as T | undefined) ?? null;
		},
		async set<T>(key: string, value: T) {
			values.set(key, value);
		},
	};
}

describe("persistent application settings", () => {
	it("normalizes retained proxy settings without removing their stored values", async () => {
		const store = createStore({
			[PERSISTENT_APP_SETTING_KEYS.proxyEnabled]: true,
			[PERSISTENT_APP_SETTING_KEYS.proxyUrl]: "http://127.0.0.1:3001",
		});

		await expect(loadProxySettings(store)).resolves.toEqual({
			enabled: true,
			url: "http://127.0.0.1:3001",
		});

		await setProxyEnabled(false, store);
		expect(store.values.get(PERSISTENT_APP_SETTING_KEYS.proxyEnabled)).toBe(false);
		expect(store.values.get(PERSISTENT_APP_SETTING_KEYS.proxyUrl)).toBe("http://127.0.0.1:3001");
	});

	it("defaults planner validation on unless the durable key is explicitly false", async () => {
		await expect(loadPlannerValidatorEnabled(createStore())).resolves.toBe(true);
		await expect(
			loadPlannerValidatorEnabled(
				createStore({ [PERSISTENT_APP_SETTING_KEYS.plannerValidatorEnabled]: false }),
			),
		).resolves.toBe(false);
	});

	it("round-trips a typed model and rejects malformed stored values", async () => {
		const store = createStore();
		const model = getModel("anthropic", "claude-sonnet-4-5-20250929");
		expect(model).toBeDefined();
		if (!model) throw new Error("Expected test model");

		await saveLastUsedModel(model, store);
		await expect(loadLastUsedModel(store)).resolves.toEqual(model);

		store.values.set(PERSISTENT_APP_SETTING_KEYS.lastUsedModel, { provider: "anthropic" });
		await expect(loadLastUsedModel(store)).resolves.toBeNull();
	});
});
