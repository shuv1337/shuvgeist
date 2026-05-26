import { getModel, type Model } from "@mariozechner/pi-ai";
import type { CustomProvider } from "@mariozechner/pi-web-ui/storage/stores/custom-providers-store.js";

export interface ModelResolutionSources {
	getCustomProviderByName(providerName: string): Promise<CustomProvider | undefined>;
	getAllCustomProviders(): Promise<CustomProvider[]>;
	getBuiltInModel?: (provider: string, modelId: string) => Model<any> | undefined;
}

export function isProxxProviderName(providerName: string): boolean {
	return providerName.trim().toLowerCase() === "proxx";
}

export function normalizeModelForRuntime(model: Model<any>): Model<any> {
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

export async function resolveModelSpec(
	spec: string,
	providerHint: string | undefined,
	sources: ModelResolutionSources,
): Promise<Model<any>> {
	const getBuiltInModel = sources.getBuiltInModel ?? ((provider, modelId) => getModel(provider as any, modelId));
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
