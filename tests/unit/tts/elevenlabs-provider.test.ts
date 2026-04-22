import { describe, expect, it, vi } from "vitest";
import { listElevenLabsVoices, synthesizeWithElevenLabs } from "../../../src/tts/providers/elevenlabs.js";

describe("elevenlabs provider", () => {
	it("lists voices from the ElevenLabs API", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
			ok: true,
			json: async () => ({
				voices: [{ voice_id: "voice-1", name: "Rachel" }],
			}),
		} as Response);

		const voices = await listElevenLabsVoices({ apiKey: "test-key" }, fetchImpl);
		expect(voices).toEqual([{ id: "voice-1", label: "Rachel", provider: "elevenlabs", description: undefined }]);
	});

	it("uses the configured output format for synthesis", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
			ok: true,
			arrayBuffer: async () => new ArrayBuffer(4),
			headers: new Headers(),
		} as Response);

		await synthesizeWithElevenLabs(
			{
				apiKey: "test-key",
				modelId: "eleven_turbo_v2_5",
				outputFormat: "mp3_44100_128",
			},
			{
				text: "hello",
				voiceId: "voice-1",
				speed: 1,
			},
			fetchImpl,
		);

		expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("output_format=mp3_44100_128");
	});
});
