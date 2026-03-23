import { defineConfig } from "vitest/config";

const gatedCoverageFiles = [
	"src/bridge/protocol.ts",
	"src/bridge/session-bridge.ts",
	"src/storage/stores/cost-store.ts",
	"src/storage/stores/skills-store.ts",
	"src/background-state.ts",
	"src/bridge/cli-core.ts",
	"src/bridge/browser-command-executor.ts",
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
