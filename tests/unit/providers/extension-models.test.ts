import { getModels } from "@shuv1337/pi-ai";
import { describe, expect, it } from "vitest";
import {
	OPENAI_CODEX_EXTENSION_MODELS,
	registerCatalogExtensionModels,
	XAI_EXTENSION_MODELS,
} from "@shuvgeist/extension/providers/extension-models";

describe("extension model catalog", () => {
	it("registers Grok models through 4.7 and the current Codex models", () => {
		registerCatalogExtensionModels();

		const xaiIds = getModels("xai").map((model) => model.id);
		for (const model of XAI_EXTENSION_MODELS) {
			expect(xaiIds).toContain(model.id);
		}
		expect(getModels("xai").find((model) => model.id === "grok-4.7")).toMatchObject({
			provider: "xai",
			api: "openai-responses",
			baseUrl: "https://api.x.ai/v1",
			contextWindow: 500000,
			input: ["text", "image"],
		});

		const codexIds = getModels("openai-codex").map((model) => model.id);
		for (const model of OPENAI_CODEX_EXTENSION_MODELS) {
			expect(codexIds).toContain(model.id);
		}
		expect(getModels("openai-codex").find((model) => model.id === "gpt-6-astra")).toMatchObject({
			provider: "openai-codex",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
			contextWindow: 272000,
		});
	});
});
