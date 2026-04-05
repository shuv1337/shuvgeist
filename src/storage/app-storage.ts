import { AppStorage as BaseAppStorage, getAppStorage } from "@mariozechner/pi-web-ui/storage/app-storage.js";
import { IndexedDBStorageBackend } from "@mariozechner/pi-web-ui/storage/backends/indexeddb-storage-backend.js";
import { ProviderKeysStore } from "@mariozechner/pi-web-ui/storage/stores/provider-keys-store.js";
import { SessionsStore } from "@mariozechner/pi-web-ui/storage/stores/sessions-store.js";
import { SettingsStore } from "@mariozechner/pi-web-ui/storage/stores/settings-store.js";
import { CostStore } from "./stores/cost-store.js";
import { CustomProvidersStore } from "./stores/custom-providers-store.js";
import { ShuvgeistSessionsStore } from "./stores/sessions-store.js";
import { SkillsStore } from "./stores/skills-store.js";

/**
 * Extended AppStorage for Shuvgeist with skills, memories, and prompts stores.
 */
export class ShuvgeistAppStorage extends BaseAppStorage {
	readonly skills: SkillsStore;
	readonly costs: CostStore;

	constructor() {
		// 1. Create all stores (no backend yet)
		const settings = new SettingsStore();
		const providerKeys = new ProviderKeysStore();
		const sessions = new ShuvgeistSessionsStore();
		const customProviders = new CustomProvidersStore();
		const skills = new SkillsStore();
		const costs = new CostStore();

		// 2. Gather configs from all stores
		const configs = [
			settings.getConfig(),
			SessionsStore.getMetadataConfig(),
			providerKeys.getConfig(),
			customProviders.getConfig(),
			sessions.getConfig(),
			skills.getConfig(),
			costs.getConfig(),
		];

		// 3. Create backend with all configs
		const backend = new IndexedDBStorageBackend({
			dbName: "shuvgeist-storage",
			version: 3, // Increment version to add custom-providers store
			stores: configs,
		});

		// 4. Wire backend to all stores
		settings.setBackend(backend);
		providerKeys.setBackend(backend);
		customProviders.setBackend(backend);
		sessions.setBackend(backend);
		skills.setBackend(backend);
		costs.setBackend(backend);

		// 5. Pass base stores to parent
		super(settings, providerKeys, sessions, customProviders, backend);

		// 6. Store references to shuvgeist-specific stores
		this.skills = skills;
		this.costs = costs;
	}
}

/**
 * Helper to get typed Shuvgeist storage.
 */
export function getShuvgeistStorage(): ShuvgeistAppStorage {
	return getAppStorage() as ShuvgeistAppStorage;
}
