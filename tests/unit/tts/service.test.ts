import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TTS_SETTINGS } from "../../../src/tts/settings.js";
import { buildProviderConfig, prepareTtsText, synthesizeTts } from "../../../src/tts/service.js";

describe("tts service", () => {
	it("clamps long text at 3000 characters", () => {
		const prepared = prepareTtsText("x".repeat(3200));
		expect(prepared.text).toHaveLength(3000);
		expect(prepared.truncated).toBe(true);
	});

	it("builds the provider config from settings and secrets", () => {
		expect(
			buildProviderConfig(
				{
					...DEFAULT_TTS_SETTINGS,
					provider: "kokoro",
				},
				"kokoro",
				{ kokoroKey: "local-key" },
			),
		).toEqual({
			apiKey: "local-key",
			baseUrl: DEFAULT_TTS_SETTINGS.kokoroBaseUrl,
			modelId: DEFAULT_TTS_SETTINGS.kokoroModelId,
		});
	});

	it("falls back from gpt-4o-mini-tts to tts-1 when the first OpenAI request fails", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce({
				ok: false,
				status: 400,
				text: async () => "unsupported model",
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				arrayBuffer: async () => new TextEncoder().encode("mp3").buffer,
				headers: new Headers(),
			} as Response);

		const result = await synthesizeTts(
			"openai",
			DEFAULT_TTS_SETTINGS,
			{
				text: "hello",
				voiceId: "alloy",
				speed: 1,
				modelId: DEFAULT_TTS_SETTINGS.openaiModelId,
			},
			{ openaiKey: "test-key" },
			fetchImpl,
		);

		const firstBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
		const secondBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
		expect(firstBody.model).toBe("gpt-4o-mini-tts");
		expect(secondBody.model).toBe("tts-1");
		expect(result.mimeType).toBe("audio/mpeg");
	});
});
