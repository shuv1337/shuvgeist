import { type Api, getModel, getModels, type Model } from "@shuv1337/pi-ai";
import type { CustomProvider } from "@shuv1337/pi-web-ui/storage/stores/custom-providers-store.js";
import { getProviderCredentialStorageKey, getProviderDefaultModelId } from "../providers/catalog.js";
import { BUNDLED_FREE_TIER_PROVIDER, createBundledFreeTierModel } from "../providers/free-tier.js";

export interface ModelResolutionSources {
	getCustomProviderByName(providerName: string): Promise<CustomProvider | undefined>;
	getAllCustomProviders(): Promise<CustomProvider[]>;
	getBuiltInModel?: (provider: string, modelId: string) => Model<Api> | undefined;
	getBuiltInModels?: (provider: string) => Model<Api>[];
}

export interface ProviderCredentialResolutionSources {
	getStoredProviderKey(providerName: string): Promise<string | undefined>;
	getCustomProviderByName(providerName: string): Promise<CustomProvider | undefined>;
	resolveStoredCredential(storedValue: string, providerName: string): Promise<string>;
}

export interface ResolvedProviderCredential {
	apiKey: string;
	providerName: string;
	source: "stored" | "custom";
}

export function isProxxProviderName(providerName: string): boolean {
	return providerName.trim().toLowerCase() === "proxx";
}

export function normalizeModelForRuntime(model: Model<Api>): Model<Api> {
	if (!isProxxProviderName(model.provider)) return model;

	const normalizedBaseUrl = model.baseUrl?.trim().replace(/\/+$/, "") || "";
	const withoutProtocol = normalizedBaseUrl.replace(/^https?:\/\//i, "");
	if (withoutProtocol === "127.0.0.1:8789/v1" || withoutProtocol === "localhost:8789/v1") {
		return {
			...model,
			baseUrl: "http://shuvdev:8789/v1",
		};
	}

	return model;
}

function defaultBuiltInModel(provider: string, modelId: string): Model<Api> | undefined {
	return getModel(provider as never, modelId as never) as Model<Api> | undefined;
}

function defaultBuiltInModels(provider: string): Model<Api>[] {
	return getModels(provider as never) as Model<Api>[];
}

export async function resolveProviderCredential(
	providerName: string,
	sources: ProviderCredentialResolutionSources,
): Promise<ResolvedProviderCredential | undefined> {
	const storageKey = getProviderCredentialStorageKey(providerName);
	const stored = await sources.getStoredProviderKey(storageKey);
	if (stored) {
		return {
			apiKey: await sources.resolveStoredCredential(stored, storageKey),
			providerName: storageKey,
			source: "stored",
		};
	}

	const customProvider = await sources.getCustomProviderByName(providerName);
	if (customProvider?.apiKey) {
		return {
			apiKey: customProvider.apiKey,
			providerName,
			source: "custom",
		};
	}

	const proxxStorageKey = getProviderCredentialStorageKey("proxx");
	if (isProxxProviderName(providerName) && storageKey !== proxxStorageKey) {
		const proxxStored = await sources.getStoredProviderKey(proxxStorageKey);
		if (proxxStored) {
			return {
				apiKey: await sources.resolveStoredCredential(proxxStored, proxxStorageKey),
				providerName: proxxStorageKey,
				source: "stored",
			};
		}
	}

	return undefined;
}

export async function resolveDefaultModel(
	providerNames: readonly string[],
	sources: ModelResolutionSources,
): Promise<Model<Api> | undefined> {
	const getBuiltInModel = sources.getBuiltInModel ?? defaultBuiltInModel;
	const getBuiltInModels = sources.getBuiltInModels ?? defaultBuiltInModels;

	for (const provider of providerNames) {
		const modelId = getProviderDefaultModelId(provider);
		if (!modelId) continue;

		const model = getBuiltInModel(provider, modelId);
		if (model) return model;
	}

	for (const provider of providerNames) {
		const builtInModels = getBuiltInModels(provider);
		if (builtInModels.length > 0) {
			return builtInModels[0];
		}

		const customProvider = await sources.getCustomProviderByName(provider);
		const customModel = customProvider?.models?.[0];
		if (customModel) return customModel;

		if (provider === BUNDLED_FREE_TIER_PROVIDER) {
			const bundledModel = createBundledFreeTierModel();
			if (bundledModel) return bundledModel;
		}
	}

	return undefined;
}

export async function resolveModelSpec(
	spec: string,
	providerHint: string | undefined,
	sources: ModelResolutionSources,
): Promise<Model<any>> {
	const getBuiltInModel = sources.getBuiltInModel ?? defaultBuiltInModel;
	if (spec.includes("/")) {
		const [provider, ...rest] = spec.split("/");
		const modelId = rest.join("/");
		const builtIn = getBuiltInModel(provider, modelId);
		if (builtIn) return builtIn;

		const customProvider = await sources.getCustomProviderByName(provider);
		const customModel = customProvider?.models?.find((model) => model.id === modelId);
		if (customModel) return customModel;

		throw new Error(`Model not found: ${spec}`);
	}

	if (providerHint) {
		const builtIn = getBuiltInModel(providerHint, spec);
		if (builtIn) return builtIn;

		const customProvider = await sources.getCustomProviderByName(providerHint);
		const customModel = customProvider?.models?.find((model) => model.id === spec);
		if (customModel) return customModel;
	}

	for (const customProvider of await sources.getAllCustomProviders()) {
		const match = customProvider.models?.find((model) => model.id === spec);
		if (match) return match;
	}

	throw new Error(`Model not found: ${spec}${providerHint ? ` (provider: ${providerHint})` : ""}`);
}
