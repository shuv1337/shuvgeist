import type { Model } from "@shuv1337/pi-ai";
import {
	isProxxProviderName,
	normalizeModelForRuntime,
	resolveDefaultModel,
	resolveProviderCredential,
	resolveModelSpec,
} from "../../src/sidepanel/model-resolution.js";

function model(provider: string, id: string, baseUrl?: string): Model<any> {
	return { provider, id, name: id, api: "openai-responses", input: ["text"], baseUrl } as Model<any>;
}

describe("sidepanel model resolution", () => {
	it("normalizes local proxx runtime URLs to the shared shuvdev endpoint", () => {
		expect(isProxxProviderName(" Proxx ")).toBe(true);
		expect(normalizeModelForRuntime(model("proxx", "gpt-5", "http://127.0.0.1:8789/v1/"))).toMatchObject({
			baseUrl: "http://shuvdev:8789/v1",
		});
		expect(normalizeModelForRuntime(model("openai", "gpt-5", "http://127.0.0.1:8789/v1"))).toMatchObject({
			baseUrl: "http://127.0.0.1:8789/v1",
		});
	});

	it("resolves provider-qualified built-in and custom model specs", async () => {
		const builtIn = model("anthropic", "claude-sonnet-4-6");
		const custom = model("custom-ai", "deep-model");
		const sources = {
			getBuiltInModel: vi.fn((provider: string, modelId: string) =>
				provider === builtIn.provider && modelId === builtIn.id ? builtIn : undefined,
			),
			getCustomProviderByName: vi.fn(async (name: string) =>
				name === "custom-ai" ? ({ name, models: [custom] } as any) : undefined,
			),
			getAllCustomProviders: vi.fn(async () => []),
		};

		await expect(resolveModelSpec("anthropic/claude-sonnet-4-6", undefined, sources)).resolves.toBe(builtIn);
		await expect(resolveModelSpec("custom-ai/deep-model", undefined, sources)).resolves.toBe(custom);
	});

	it("resolves plain model ids with provider hint before searching all custom providers", async () => {
		const hinted = model("custom-ai", "fast");
		const global = model("other-ai", "global");
		const sources = {
			getBuiltInModel: vi.fn(() => undefined),
			getCustomProviderByName: vi.fn(async (name: string) =>
				name === "custom-ai" ? ({ name, models: [hinted] } as any) : undefined,
			),
			getAllCustomProviders: vi.fn(async () => [{ name: "other-ai", models: [global] } as any]),
		};

		await expect(resolveModelSpec("fast", "custom-ai", sources)).resolves.toBe(hinted);
		await expect(resolveModelSpec("global", undefined, sources)).resolves.toBe(global);
		await expect(resolveModelSpec("missing", "custom-ai", sources)).rejects.toThrow(
			"Model not found: missing (provider: custom-ai)",
		);
	});

	it("resolves catalog default models before provider fallback models", async () => {
		const catalogDefault = model("anthropic", "claude-sonnet-4-6");
		const fallback = model("anthropic", "first-model");
		const sources = {
			getBuiltInModel: vi.fn((provider: string, modelId: string) =>
				provider === "anthropic" && modelId === "claude-sonnet-4-6" ? catalogDefault : undefined,
			),
			getBuiltInModels: vi.fn(() => [fallback]),
			getCustomProviderByName: vi.fn(async () => undefined),
			getAllCustomProviders: vi.fn(async () => []),
		};

		await expect(resolveDefaultModel(["anthropic"], sources)).resolves.toBe(catalogDefault);
		expect(sources.getBuiltInModels).not.toHaveBeenCalled();
	});

	it("falls back to built-in and custom provider first models when no catalog default exists", async () => {
		const builtIn = model("uncataloged", "first-built-in");
		const custom = model("custom-ai", "first-custom");
		const sources = {
			getBuiltInModel: vi.fn(() => undefined),
			getBuiltInModels: vi.fn((provider: string) => (provider === "uncataloged" ? [builtIn] : [])),
			getCustomProviderByName: vi.fn(async (name: string) =>
				name === "custom-ai" ? ({ name, models: [custom] } as any) : undefined,
			),
			getAllCustomProviders: vi.fn(async () => []),
		};

		await expect(resolveDefaultModel(["uncataloged"], sources)).resolves.toBe(builtIn);
		await expect(resolveDefaultModel(["custom-ai"], sources)).resolves.toBe(custom);
	});

	it("resolves the bundled free-tier provider without a stored custom provider", async () => {
		const sources = {
			getBuiltInModel: vi.fn(() => undefined),
			getBuiltInModels: vi.fn(() => []),
			getCustomProviderByName: vi.fn(async () => undefined),
			getAllCustomProviders: vi.fn(async () => []),
		};

		await expect(resolveDefaultModel(["proxx"], sources)).resolves.toMatchObject({
			provider: "proxx",
			id: "gpt-5",
			baseUrl: "http://shuvdev:8789/v1",
		});
	});

	it("resolves stored, custom, and canonical proxx provider credentials", async () => {
		const storedResolver = vi.fn(async (stored: string, provider: string) => `${provider}:${stored}`);
		const sources = {
			getStoredProviderKey: vi.fn(async (provider: string) => (provider === "proxx" ? "stored-proxx" : undefined)),
			getCustomProviderByName: vi.fn(async (name: string) =>
				name === "custom-ai" ? ({ name, apiKey: "custom-key", models: [] } as any) : undefined,
			),
			resolveStoredCredential: storedResolver,
		};

		await expect(resolveProviderCredential("custom-ai", sources)).resolves.toMatchObject({
			apiKey: "custom-key",
			source: "custom",
		});
		await expect(resolveProviderCredential("Proxx", sources)).resolves.toMatchObject({
			apiKey: "proxx:stored-proxx",
			providerName: "proxx",
			source: "stored",
		});
	});
});
