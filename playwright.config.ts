import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "tests/e2e",
		timeout: 60_000,
		expect: {
			timeout: 10_000,
		},
		use: {
			trace: "retain-on-failure",
			headless: true,
		},
		projects: [
			{
				name: "extension",
				testMatch: /extension\/.*\.spec\.ts/,
			},
			{
				name: "site",
				testMatch: /site\/.*\.spec\.ts/,
			},
		],
});
