export type OAuthProviderId = "anthropic" | "openai-codex" | "github-copilot" | "google-gemini-cli";

export interface ProviderCatalogEntry {
	id: string;
	credentialStorageKey: string;
	defaultModelId?: string;
	oauthDisplayName?: string;
}

export const PROVIDER_CATALOG = {
	"amazon-bedrock": {
		id: "amazon-bedrock",
		credentialStorageKey: "amazon-bedrock",
		defaultModelId: "us.anthropic.claude-opus-4-6-v1",
	},
	anthropic: {
		id: "anthropic",
		credentialStorageKey: "anthropic",
		defaultModelId: "claude-sonnet-4-6",
		oauthDisplayName: "Anthropic (Claude Pro/Max)",
	},
	"azure-openai-responses": {
		id: "azure-openai-responses",
		credentialStorageKey: "azure-openai-responses",
		defaultModelId: "gpt-5.2",
	},
	cerebras: { id: "cerebras", credentialStorageKey: "cerebras", defaultModelId: "zai-glm-4.6" },
	fireworks: {
		id: "fireworks",
		credentialStorageKey: "fireworks",
		defaultModelId: "accounts/fireworks/routers/kimi-k2p5-turbo",
	},
	"github-copilot": {
		id: "github-copilot",
		credentialStorageKey: "github-copilot",
		defaultModelId: "gpt-4o",
		oauthDisplayName: "GitHub Copilot",
	},
	google: { id: "google", credentialStorageKey: "google", defaultModelId: "gemini-2.5-flash" },
	"google-antigravity": {
		id: "google-antigravity",
		credentialStorageKey: "google-antigravity",
		defaultModelId: "gemini-3.1-pro-high",
	},
	"google-gemini-cli": {
		id: "google-gemini-cli",
		credentialStorageKey: "google-gemini-cli",
		defaultModelId: "gemini-2.5-pro",
		oauthDisplayName: "Google Gemini",
	},
	"google-vertex": {
		id: "google-vertex",
		credentialStorageKey: "google-vertex",
		defaultModelId: "gemini-3-pro-preview",
	},
	groq: { id: "groq", credentialStorageKey: "groq", defaultModelId: "openai/gpt-oss-20b" },
	huggingface: {
		id: "huggingface",
		credentialStorageKey: "huggingface",
		defaultModelId: "moonshotai/Kimi-K2.5",
	},
	"kimi-coding": {
		id: "kimi-coding",
		credentialStorageKey: "kimi-coding",
		defaultModelId: "kimi-k2-thinking",
	},
	minimax: { id: "minimax", credentialStorageKey: "minimax", defaultModelId: "MiniMax-M2.7" },
	"minimax-cn": {
		id: "minimax-cn",
		credentialStorageKey: "minimax-cn",
		defaultModelId: "MiniMax-M2.1",
	},
	mistral: { id: "mistral", credentialStorageKey: "mistral", defaultModelId: "devstral-medium-latest" },
	openai: { id: "openai", credentialStorageKey: "openai", defaultModelId: "gpt-4o-mini" },
	"openai-codex": {
		id: "openai-codex",
		credentialStorageKey: "openai-codex",
		defaultModelId: "gpt-5.1-codex-mini",
		oauthDisplayName: "ChatGPT Plus/Pro",
	},
	opencode: { id: "opencode", credentialStorageKey: "opencode", defaultModelId: "claude-opus-4-6" },
	"opencode-go": {
		id: "opencode-go",
		credentialStorageKey: "opencode-go",
		defaultModelId: "kimi-k2.5",
	},
	openrouter: {
		id: "openrouter",
		credentialStorageKey: "openrouter",
		defaultModelId: "openai/gpt-5.1-codex",
	},
	proxx: { id: "proxx", credentialStorageKey: "proxx", defaultModelId: "gpt-5" },
	"vercel-ai-gateway": {
		id: "vercel-ai-gateway",
		credentialStorageKey: "vercel-ai-gateway",
		defaultModelId: "anthropic/claude-opus-4-6",
	},
	xai: { id: "xai", credentialStorageKey: "xai", defaultModelId: "grok-4-fast-non-reasoning" },
	zai: { id: "zai", credentialStorageKey: "zai", defaultModelId: "glm-4.6" },
} as const satisfies Record<string, ProviderCatalogEntry>;

export const OAUTH_PROVIDER_IDS = [
	"anthropic",
	"openai-codex",
	"github-copilot",
	"google-gemini-cli",
] as const satisfies readonly OAuthProviderId[];

export function getProviderCatalogEntry(provider: string): ProviderCatalogEntry | undefined {
	return PROVIDER_CATALOG[provider as keyof typeof PROVIDER_CATALOG];
}

export function getProviderCredentialStorageKey(provider: string): string {
	return getProviderCatalogEntry(provider)?.credentialStorageKey ?? provider;
}

export function getProviderDefaultModelId(provider: string): string | undefined {
	return getProviderCatalogEntry(provider)?.defaultModelId;
}

export function isOAuthProviderId(provider: string): provider is OAuthProviderId {
	return OAUTH_PROVIDER_IDS.includes(provider as OAuthProviderId);
}

export function getOAuthProviderDisplayName(provider: OAuthProviderId): string {
	return PROVIDER_CATALOG[provider].oauthDisplayName ?? provider;
}
