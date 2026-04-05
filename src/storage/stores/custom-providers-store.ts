import { getModels, type Model } from "@mariozechner/pi-ai";
import {
	CustomProvidersStore as BaseCustomProvidersStore,
	type CustomProvider,
} from "@mariozechner/pi-web-ui/storage/stores/custom-providers-store.js";

const PROXX_PROVIDER_NAME = "proxx";
const PROXX_CANONICAL_BASE_URL = "http://shuvdev:8789/v1";
const PROXX_OPENAI_MODEL_IDS = [
	"gpt-5",
	"gpt-5-chat-latest",
	"gpt-5-codex",
	"gpt-5-mini",
	"gpt-5-nano",
	"gpt-5-pro",
	"gpt-5.1",
	"gpt-5.1-chat-latest",
	"gpt-5.1-codex",
	"gpt-5.1-codex-max",
	"gpt-5.1-codex-mini",
	"gpt-5.2",
	"gpt-5.2-chat-latest",
	"gpt-5.2-codex",
	"gpt-5.2-pro",
	"gpt-5.3-codex",
	"gpt-5.3-codex-spark",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.4-pro",
] as const;

function normalizeOpenAIBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function normalizeProxxBaseUrl(baseUrl: string): string {
	const normalized = normalizeOpenAIBaseUrl(baseUrl);
	const withoutProtocol = normalized.replace(/^https?:\/\//i, "");
	if (withoutProtocol === "127.0.0.1:8789/v1" || withoutProtocol === "localhost:8789/v1") {
		return PROXX_CANONICAL_BASE_URL;
	}
	return normalized;
}

function isProxxProvider(provider: CustomProvider): boolean {
	return provider.name.trim().toLowerCase() === PROXX_PROVIDER_NAME;
}

function getBuiltInOpenAIModel(modelId: string): Model<any> | null {
	return getModels("openai").find((candidate) => candidate.id === modelId) ?? null;
}

function normalizeModelForProvider(provider: CustomProvider, model: Model<any>): Model<any> {
	const normalizedBaseUrl = isProxxProvider(provider)
		? normalizeProxxBaseUrl(provider.baseUrl)
		: normalizeOpenAIBaseUrl(provider.baseUrl);
	const builtInOpenAIModel = isProxxProvider(provider) ? getBuiltInOpenAIModel(model.id) : null;

	if (builtInOpenAIModel) {
		return {
			...builtInOpenAIModel,
			name: model.name,
			provider: provider.name,
			baseUrl: normalizedBaseUrl,
		};
	}

	return {
		...model,
		provider: provider.name,
		baseUrl: normalizedBaseUrl,
	};
}

function buildProxxOpenAIModel(
	provider: CustomProvider,
	modelId: (typeof PROXX_OPENAI_MODEL_IDS)[number],
): Model<any> | null {
	const builtInModel = getBuiltInOpenAIModel(modelId);
	if (!builtInModel) return null;

	return {
		...builtInModel,
		provider: provider.name,
		baseUrl: normalizeProxxBaseUrl(provider.baseUrl),
	};
}

function augmentProvider(provider: CustomProvider): CustomProvider {
	if (!isProxxProvider(provider)) return provider;

	const existingModels = (provider.models || []).map((model) => normalizeModelForProvider(provider, model));
	const modelsById = new Map<string, Model<any>>();

	for (const model of existingModels) {
		modelsById.set(model.id, model);
	}

	for (const modelId of PROXX_OPENAI_MODEL_IDS) {
		if (modelsById.has(modelId)) continue;
		const proxxModel = buildProxxOpenAIModel(provider, modelId);
		if (proxxModel) {
			modelsById.set(modelId, proxxModel);
		}
	}

	return {
		...provider,
		baseUrl: normalizeProxxBaseUrl(provider.baseUrl),
		models: [...modelsById.values()],
	};
}

function providerChanged(original: CustomProvider, updated: CustomProvider): boolean {
	return JSON.stringify(original) !== JSON.stringify(updated);
}

export class CustomProvidersStore extends BaseCustomProvidersStore {
	override async get(id: string): Promise<CustomProvider | null> {
		const provider = await super.get(id);
		if (!provider) return null;

		const augmentedProvider = augmentProvider(provider);
		if (providerChanged(provider, augmentedProvider)) {
			await super.set(augmentedProvider);
		}
		return augmentedProvider;
	}

	override async set(provider: CustomProvider): Promise<void> {
		await super.set(augmentProvider(provider));
	}
}
