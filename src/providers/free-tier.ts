import { getModels, type Model } from "@mariozechner/pi-ai";
import type { CustomProvider } from "@mariozechner/pi-web-ui/storage/stores/custom-providers-store.js";

export const BUNDLED_FREE_TIER_PROVIDER = "proxx";
export const BUNDLED_FREE_TIER_MODEL = "gpt-5";
export const BUNDLED_FREE_TIER_BASE_URL = "http://shuvdev:8789/v1";
export const BUNDLED_FREE_TIER_KEY = "shuvgeist-free-tier";

export function createBundledFreeTierModel(modelId = BUNDLED_FREE_TIER_MODEL): Model<any> | undefined {
	const builtIn = getModels("openai").find((candidate) => candidate.id === modelId);
	if (!builtIn) return undefined;

	return {
		...builtIn,
		provider: BUNDLED_FREE_TIER_PROVIDER,
		baseUrl: BUNDLED_FREE_TIER_BASE_URL,
		name: `${builtIn.name} (Free tier)`,
	};
}

export function createBundledFreeTierProvider(): CustomProvider {
	const model = createBundledFreeTierModel();
	return {
		id: BUNDLED_FREE_TIER_PROVIDER,
		name: BUNDLED_FREE_TIER_PROVIDER,
		type: "openai-responses",
		baseUrl: BUNDLED_FREE_TIER_BASE_URL,
		apiKey: "",
		models: model ? [model] : [],
	};
}
