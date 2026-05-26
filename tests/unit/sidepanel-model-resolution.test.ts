import type { Model } from "@mariozechner/pi-ai";
import {
	isProxxProviderName,
	normalizeModelForRuntime,
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
});
