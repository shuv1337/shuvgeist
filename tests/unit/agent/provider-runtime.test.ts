import type { Model } from "@shuv1337/pi-ai";
import type { CustomProvider } from "@shuv1337/pi-web-ui/storage/stores/custom-providers-store.js";
import { describe, expect, it, vi } from "vitest";
import {
	createOffscreenProviderRuntime,
	modelFromRuntimeDescriptor,
	modelToRuntimeDescriptor,
	type OffscreenProviderRuntimeStorage,
} from "@shuvgeist/extension/agent/provider-runtime";
import {
	PERSISTENT_APP_SETTING_KEYS,
	type PersistentAppSettingsStore,
} from "@shuvgeist/extension/storage/persistent-settings";

const customModel: Model<"openai-completions"> = {
	id: "custom-model",
	name: "Custom Model",
	api: "openai-completions",
	provider: "custom-provider",
	baseUrl: "https://custom.example/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16384,
	maxTokens: 2048,
	thinkingLevelMap: { off: null, low: "low", high: "high" },
	headers: { "x-custom-header": "custom-value" },
	compat: {
		maxTokensField: "max_tokens",
		supportsDeveloperRole: false,
		requiresThinkingAsText: true,
	},
};

class TestSettingsStore implements PersistentAppSettingsStore {
	private readonly values = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | null> {
		return (this.values.get(key) as T | undefined) ?? null;
	}

	async set<T>(key: string, value: T): Promise<void> {
		this.values.set(key, value);
	}
}

class TestProviderStorage implements OffscreenProviderRuntimeStorage {
	readonly settings = new TestSettingsStore();
	readonly keys = new Map<string, string>();
	readonly providers: CustomProvider[] = [];
	readonly providerKeys = {
		get: async (provider: string) => this.keys.get(provider) ?? null,
		set: async (provider: string, value: string) => {
			this.keys.set(provider, value);
		},
		list: async () => [...this.keys.keys()],
	};
	readonly customProviders = {
		getAll: async () => this.providers.slice(),
	};
}

describe("createOffscreenProviderRuntime", () => {
	it("round-trips every execution field for custom models without registry loss", () => {
		const descriptor = modelToRuntimeDescriptor(customModel);

		expect(descriptor).toEqual({
			provider: customModel.provider,
			id: customModel.id,
			name: customModel.name,
			api: customModel.api,
			baseUrl: customModel.baseUrl,
			reasoning: customModel.reasoning,
			thinkingLevelMap: customModel.thinkingLevelMap,
			input: customModel.input,
			cost: customModel.cost,
			contextWindow: customModel.contextWindow,
			maxTokens: customModel.maxTokens,
			headers: customModel.headers,
			compat: customModel.compat,
		});
		expect(modelFromRuntimeDescriptor(descriptor)).toEqual(customModel);

		const optionalUndefined = modelToRuntimeDescriptor({
			...customModel,
			compat: { ...customModel.compat, supportsStore: undefined },
		});
		expect(optionalUndefined.compat).not.toHaveProperty("supportsStore");
	});

	it("resolves registered app models and stored custom models in the offscreen owner", async () => {
		const storage = new TestProviderStorage();
		storage.providers.push({
			id: "custom-provider",
			name: "custom-provider",
			type: "openai-completions",
			baseUrl: customModel.baseUrl,
			models: [customModel],
		});
		const runtime = createOffscreenProviderRuntime({ storage });
		const signal = new AbortController().signal;

		await expect(
			runtime.resolveModel({ provider: "custom-provider", id: "custom-model" }, signal),
		).resolves.toEqual(customModel);
		await expect(
			runtime.resolveModel(
				{ provider: "fireworks", id: "accounts/fireworks/routers/kimi-k2p6-turbo" },
				signal,
			),
		).resolves.toMatchObject({
			provider: "fireworks",
			id: "accounts/fireworks/routers/kimi-k2p6-turbo",
			api: "openai-completions",
		});
	});

	it("prefers a complete wire model over a changed registry entry with the same identity", async () => {
		const storage = new TestProviderStorage();
		storage.providers.push({
			id: "custom-provider",
			name: "custom-provider",
			type: "openai-completions",
			baseUrl: "https://changed.example/v1",
			models: [{ ...customModel, baseUrl: "https://changed.example/v1", headers: {} }],
		});
		const runtime = createOffscreenProviderRuntime({ storage });

		await expect(
			runtime.resolveModel(modelToRuntimeDescriptor(customModel), new AbortController().signal),
		).resolves.toEqual(customModel);
	});

	it("resolves credentials with the configured proxy and updates refreshed values through the store", async () => {
		const storage = new TestProviderStorage();
		storage.keys.set("anthropic", "stored-oauth-value");
		await storage.settings.set(PERSISTENT_APP_SETTING_KEYS.proxyEnabled, true);
		await storage.settings.set(PERSISTENT_APP_SETTING_KEYS.proxyUrl, "https://proxy.example");
		const resolveStoredCredential = vi.fn(async () => "refreshed-token");
		const runtime = createOffscreenProviderRuntime({ storage, resolveStoredCredential });

		await expect(runtime.getApiKey("anthropic")).resolves.toBe("refreshed-token");
		expect(resolveStoredCredential).toHaveBeenCalledWith(
			"stored-oauth-value",
			"anthropic",
			"https://proxy.example",
		);
	});

	it("single-flights concurrent credential refreshes per provider and clears the flight after success", async () => {
		const storage = new TestProviderStorage();
		storage.keys.set("anthropic", "stored-oauth-value");
		let release: ((token: string) => void) | undefined;
		const resolveStoredCredential = vi.fn(
			async () =>
				await new Promise<string>((resolve) => {
					release = resolve;
				}),
		);
		const runtime = createOffscreenProviderRuntime({ storage, resolveStoredCredential });

		const first = runtime.getApiKey("anthropic");
		const second = runtime.getApiKey("anthropic");
		await vi.waitFor(() => expect(resolveStoredCredential).toHaveBeenCalledTimes(1));
		release?.("shared-token");
		await expect(Promise.all([first, second])).resolves.toEqual(["shared-token", "shared-token"]);

		const third = runtime.getApiKey("anthropic");
		await vi.waitFor(() => expect(resolveStoredCredential).toHaveBeenCalledTimes(2));
		release?.("next-token");
		await expect(third).resolves.toBe("next-token");
	});

	it("clears a rejected credential flight so the next request can retry", async () => {
		const storage = new TestProviderStorage();
		storage.keys.set("anthropic", "stored-oauth-value");
		const resolveStoredCredential = vi
			.fn<(storedValue: string, provider: string, proxyUrl?: string) => Promise<string>>()
			.mockRejectedValueOnce(new Error("refresh failed"))
			.mockResolvedValueOnce("retry-token");
		const runtime = createOffscreenProviderRuntime({ storage, resolveStoredCredential });

		await expect(runtime.getApiKey("anthropic")).rejects.toThrow("refresh failed");
		await expect(runtime.getApiKey("anthropic")).resolves.toBe("retry-token");
		expect(resolveStoredCredential).toHaveBeenCalledTimes(2);
	});

	it("selects the durable last-used model and reads planner validation from offscreen storage", async () => {
		const storage = new TestProviderStorage();
		await storage.settings.set(PERSISTENT_APP_SETTING_KEYS.lastUsedModel, customModel);
		await storage.settings.set(PERSISTENT_APP_SETTING_KEYS.plannerValidatorEnabled, false);
		const runtime = createOffscreenProviderRuntime({ storage });
		const signal = new AbortController().signal;

		await expect(runtime.resolveDefaultModel(signal)).resolves.toEqual(customModel);
		await expect(runtime.isPlannerValidatorEnabled(signal)).resolves.toBe(false);
		await runtime.saveSelectedModel({ ...customModel, id: "new-default" }, signal);
		await expect(storage.settings.get(PERSISTENT_APP_SETTING_KEYS.lastUsedModel)).resolves.toMatchObject({
			id: "new-default",
		});
	});

	it("honors cancellation during model and settings resolution", async () => {
		const storage = new TestProviderStorage();
		const runtime = createOffscreenProviderRuntime({ storage });
		const controller = new AbortController();
		controller.abort();

		await expect(runtime.resolveDefaultModel(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		await expect(runtime.isPlannerValidatorEnabled(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
	});

	it("fails closed when a wire descriptor cannot be resolved to a complete Pi model", async () => {
		const storage = new TestProviderStorage();
		const runtime = createOffscreenProviderRuntime({ storage });

		await expect(
			runtime.resolveModel(
				{ provider: "missing-provider", id: "missing-model", api: "openai-completions" },
				new AbortController().signal,
			),
		).rejects.toThrow("Model not found: missing-provider/missing-model");
	});
});
