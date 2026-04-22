import { describe, expect, it, vi } from "vitest";
import { synthesizeWithOpenAi } from "../../../src/tts/providers/openai.js";

describe("openai provider", () => {
	it("sends the expected OpenAI speech payload", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
			ok: true,
			arrayBuffer: async () => new TextEncoder().encode("audio").buffer,
			headers: new Headers({ "x-request-id": "req-1" }),
		} as Response);

		const result = await synthesizeWithOpenAi(
			{ apiKey: "sk-test", modelId: "gpt-4o-mini-tts" },
			{
				text: "hello world",
				voiceId: "alloy",
				speed: 1.2,
			},
			fetchImpl,
		);

		expect(fetchImpl).toHaveBeenCalledWith(
			"https://api.openai.com/v1/audio/speech",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					authorization: "Bearer sk-test",
				}),
			}),
		);
		expect(result.providerRequestId).toBe("req-1");
	});
});
