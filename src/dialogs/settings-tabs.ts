import type { SettingsTab } from "@mariozechner/pi-web-ui";
import { AboutTab } from "./AboutTab.js";
import { ApiKeysOAuthTab } from "./ApiKeysOAuthTab.js";
import { BridgeTab } from "./BridgeTab.js";
import { CostsTab } from "./CostsTab.js";
import { ElectronTargetsTab } from "./ElectronTargetsTab.js";
import { ShuvgeistProvidersTab } from "./ShuvgeistProvidersTab.js";
import { SkillsTab } from "./SkillsTab.js";
import { TtsTab } from "./TtsTab.js";

export type SettingsInitialTab = "providers" | "subscriptions";

export function createSettingsTabs(initialTab: SettingsInitialTab = "providers"): SettingsTab[] {
	const commonTabs = [
		new TtsTab(),
		new CostsTab(),
		new SkillsTab(),
		new BridgeTab(),
		new ElectronTargetsTab(),
		new AboutTab(),
	];
	if (initialTab === "subscriptions") {
		return [new ApiKeysOAuthTab(), new ShuvgeistProvidersTab(), ...commonTabs];
	}

	return [new ShuvgeistProvidersTab(), new ApiKeysOAuthTab(), ...commonTabs];
}
