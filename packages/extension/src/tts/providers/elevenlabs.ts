import type { TtsProviderConfig, TtsSynthesisRequest, TtsSynthesisResult, TtsVoice } from "../types.js";

interface ElevenLabsVoiceListResponse {
	voices?: Array<{ voice_id?: string; name?: string; labels?: Record<string, string> }>;
}

export async function listElevenLabsVoices(
	config: TtsProviderConfig,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<TtsVoice[]> {
	if (!config.apiKey) {
		return [];
	}

	const response = await fetchImpl("https://api.elevenlabs.io/v1/voices", {
		headers: {
			"xi-api-key": config.apiKey,
		},
		signal,
	});

	if (!response.ok) {
		throw new Error(`ElevenLabs voice list failed: ${response.status} ${await response.text()}`);
	}

	const payload = (await response.json()) as ElevenLabsVoiceListResponse;
	return (payload.voices ?? [])
		.filter((voice) => voice.voice_id && voice.name)
		.map((voice) => ({
			id: voice.voice_id as string,
			label: voice.name as string,
			provider: "elevenlabs",
			description: voice.labels?.accent || voice.labels?.age,
		}));
}

export async function synthesizeWithElevenLabs(
	config: TtsProviderConfig,
	request: TtsSynthesisRequest,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<TtsSynthesisResult> {
	if (!config.apiKey) {
		throw new Error("ElevenLabs API key is not configured");
	}
	if (!request.voiceId) {
		throw new Error("ElevenLabs voice is required");
	}

	const outputFormat = config.outputFormat || "mp3_44100_128";
	const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(request.voiceId)}`);
	url.searchParams.set("output_format", outputFormat);

	const response = await fetchImpl(url.toString(), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"xi-api-key": config.apiKey,
		},
		body: JSON.stringify({
			text: request.text,
			model_id: config.modelId || request.modelId || "eleven_turbo_v2_5",
		}),
		signal,
	});

	if (!response.ok) {
		throw new Error(`ElevenLabs TTS failed: ${response.status} ${await response.text()}`);
	}

	return {
		audioData: await response.arrayBuffer(),
		mimeType: "audio/mpeg",
		providerRequestId: response.headers.get("request-id") ?? undefined,
	};
}
