import {
	AppStorage as BaseAppStorage,
	getAppStorage,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	SessionsStore,
	SettingsStore,
} from "@mariozechner/pi-web-ui";
import { SkillsStore } from "./stores/skills-store.js";

/**
 * Extended AppStorage for Sitegeist with skills, memories, and prompts stores.
 */
export class SitegeistAppStorage extends BaseAppStorage {
	readonly skills: SkillsStore;

	constructor() {
		// 1. Create all stores (no backend yet)
		const settings = new SettingsStore();
		const providerKeys = new ProviderKeysStore();
		const sessions = new SessionsStore();
		const skills = new SkillsStore();

		// 2. Gather configs from all stores
		const configs = [
			settings.getConfig(),
			SessionsStore.getMetadataConfig(),
			providerKeys.getConfig(),
			sessions.getConfig(),
			skills.getConfig(),
		];

		// 3. Create backend with all configs
		const backend = new IndexedDBStorageBackend({
			dbName: "sitegeist-storage",
			version: 1,
			stores: configs,
		});

		// 4. Wire backend to all stores
		settings.setBackend(backend);
		providerKeys.setBackend(backend);
		sessions.setBackend(backend);
		skills.setBackend(backend);

		// 5. Pass base stores to parent
		super(settings, providerKeys, sessions, backend);

		// 6. Store references to sitegeist-specific stores
		this.skills = skills;
	}
}

/**
 * Helper to get typed Sitegeist storage.
 */
export function getSitegeistStorage(): SitegeistAppStorage {
	return getAppStorage() as SitegeistAppStorage;
}
