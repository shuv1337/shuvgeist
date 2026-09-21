import { type Model, registerModels } from "@shuv1337/pi-ai";

const XAI_BASE_URL = "https://api.x.ai/v1";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

const XAI_RESPONSES_COMPAT = {
	sendSessionIdHeader: false,
	supportsLongCacheRetention: false,
} as const;

/**
 * Grok models missing from the bundled pi-ai catalog.
 * docs.x.ai serves grok-4.7 through the Responses API at https://api.x.ai/v1/responses.
 * Costs and context windows are the short-context rates. Output is capped at 128k;
 * the model pages publish context, not a separate output limit.
 */
export const XAI_EXTENSION_MODELS: Model<"openai-responses">[] = [
	{
		id: "grok-4.5",
		name: "Grok 4.5",
		api: "openai-responses",
		provider: "xai",
		baseUrl: XAI_BASE_URL,
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: null },
		input: ["text", "image"],
		cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
		contextWindow: 500000,
		maxTokens: 128000,
		compat: XAI_RESPONSES_COMPAT,
	},
	{
		id: "grok-4.6",
		name: "Grok 4.6",
		api: "openai-responses",
		provider: "xai",
		baseUrl: XAI_BASE_URL,
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: null },
		input: ["text", "image"],
		cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 500000,
		maxTokens: 128000,
		compat: XAI_RESPONSES_COMPAT,
	},
	{
		id: "grok-4.7",
		name: "Grok 4.7",
		api: "openai-responses",
		provider: "xai",
		baseUrl: XAI_BASE_URL,
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh" },
		input: ["text", "image"],
		cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 500000,
		maxTokens: 128000,
		compat: XAI_RESPONSES_COMPAT,
	},
];

const CODEX_THINKING_LEVEL_MAP = { xhigh: "xhigh", minimal: "low" } as const;

/**
 * ChatGPT Codex models missing from the bundled catalog.
 * Context is the Codex OAuth backend window (272k), not the 1.05M public API window.
 * Costs are the public short-context API rates.
 */
export const OPENAI_CODEX_EXTENSION_MODELS: Model<"openai-codex-responses">[] = [
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6 Luna",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: CODEX_BASE_URL,
		reasoning: true,
		thinkingLevelMap: CODEX_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		cost: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: CODEX_BASE_URL,
		reasoning: true,
		thinkingLevelMap: CODEX_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: CODEX_BASE_URL,
		reasoning: true,
		thinkingLevelMap: CODEX_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
	{
		id: "gpt-6-astra",
		name: "GPT-6 Astra",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: CODEX_BASE_URL,
		reasoning: true,
		thinkingLevelMap: CODEX_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 0 },
		contextWindow: 272000,
		maxTokens: 128000,
	},
];

export function registerCatalogExtensionModels(): void {
	registerModels(XAI_EXTENSION_MODELS);
	registerModels(OPENAI_CODEX_EXTENSION_MODELS);
}
