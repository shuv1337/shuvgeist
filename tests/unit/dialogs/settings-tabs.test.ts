import { createSettingsTabs } from "../../../src/dialogs/settings-tabs.js";

describe("settings tab ordering", () => {
	it("opens provider setup on providers by default", () => {
		expect(createSettingsTabs().map((tab) => tab.getTabName()).slice(0, 2)).toEqual([
			"Providers & Models",
			"Subscriptions",
		]);
	});

	it("opens subscription setup on subscriptions first", () => {
		expect(createSettingsTabs("subscriptions").map((tab) => tab.getTabName()).slice(0, 2)).toEqual([
			"Subscriptions",
			"Providers & Models",
		]);
	});
});
