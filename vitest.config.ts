import { defineConfig } from "vitest/config";

const gatedCoverageFiles = [
	"packages/protocol/src/protocol.ts",
	"packages/extension/src/bridge/session-bridge.ts",
	"packages/extension/src/storage/stores/cost-store.ts",
	"packages/extension/src/storage/stores/skills-store.ts",
	"packages/extension/src/background-state.ts",
	"packages/cli/src/cli-core.ts",
	"packages/extension/src/bridge/browser-command-executor.ts",
];

export default defineConfig({
	test: {
		globals: true,
		setupFiles: ["tests/setup.ts"],
		environment: "node",
		include: [
			"tests/unit/**/*.test.ts",
			"tests/integration/**/*.test.ts",
			"tests/component/**/*.test.ts",
			"proxy/tests/**/*.test.ts",
		],
		coverage: {
			provider: "v8",
			reporter: ["text", "html", "json-summary"],
			thresholds: {
				lines: 70,
				functions: 70,
				statements: 70,
				branches: 60,
				include: gatedCoverageFiles,
			},
		},
	},
});
