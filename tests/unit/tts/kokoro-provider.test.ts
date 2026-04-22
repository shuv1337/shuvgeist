import { describe, expect, it, vi } from "vitest";
import { listKokoroVoices, synthesizeWithKokoro } from "../../../src/tts/providers/kokoro.js";

describe("kokoro provider", () => {
	it("falls back to the curated voice list when voice discovery fails", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline"));
		const voices = await listKokoroVoices({ baseUrl: "http://127.0.0.1:8880/v1" }, fetchImpl);
		expect(voices[0]?.id).toBe("am_onyx");
	});

	it("loads voices from the local /v1/audio/voices endpoint and formats labels", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue({
				ok: true,
				json: async () => ({
					voices: ["am_onyx", "af_heart"],
				}),
			} as Response);

		const voices = await listKokoroVoices({ baseUrl: "http://127.0.0.1:8880/v1" }, fetchImpl);
		expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://127.0.0.1:8880/v1/audio/voices");
		expect(voices.map((voice) => voice.label)).toEqual(["Am Onyx", "Af Heart"]);
	});

	it("forwards an explicit model override to the local speech endpoint", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
			ok: true,
			arrayBuffer: async () => new ArrayBuffer(2),
			headers: new Headers(),
		} as Response);

		await synthesizeWithKokoro(
			{ baseUrl: "http://127.0.0.1:8880/v1", modelId: "kokoro" },
			{
				text: "hello",
				voiceId: "af_heart",
				speed: 1,
				modelId: "kokoro-en",
			},
			fetchImpl,
		);

		const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
		expect(body.model).toBe("kokoro");
	});
});
