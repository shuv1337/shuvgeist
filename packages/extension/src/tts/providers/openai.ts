import { OPENAI_TTS_VOICES } from "../settings.js";
import type { TtsProviderConfig, TtsSynthesisRequest, TtsSynthesisResult, TtsVoice } from "../types.js";

export function getOpenAiVoiceOptions(): TtsVoice[] {
	return OPENAI_TTS_VOICES;
}

export async function synthesizeWithOpenAi(
	config: TtsProviderConfig,
	request: TtsSynthesisRequest,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<TtsSynthesisResult> {
	if (!config.apiKey) {
		throw new Error("OpenAI API key is not configured");
	}

	const response = await fetchImpl("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${config.apiKey}`,
		},
		body: JSON.stringify({
			model: config.modelId || request.modelId || "gpt-4o-mini-tts",
			voice: request.voiceId,
			input: request.text,
			response_format: "mp3",
			speed: Math.min(4, Math.max(0.25, request.speed)),
		}),
		signal,
	});

	if (!response.ok) {
		throw new Error(`OpenAI TTS failed: ${response.status} ${await response.text()}`);
	}

	return {
		audioData: await response.arrayBuffer(),
		mimeType: "audio/mpeg",
		providerRequestId: response.headers.get("x-request-id") ?? undefined,
	};
}
