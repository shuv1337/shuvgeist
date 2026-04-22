import { DEFAULT_KOKORO_VOICES } from "../settings.js";
import type { TtsProviderConfig, TtsSynthesisRequest, TtsSynthesisResult, TtsVoice } from "../types.js";

interface KokoroVoicesResponse {
	voices?: Array<string | { id?: string; name?: string }>;
}

function formatKokoroVoiceLabel(voiceId: string): string {
	return voiceId
		.split("_")
		.map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
		.join(" ");
}

function normalizeKokoroVoices(payload: unknown): TtsVoice[] {
	const rawVoices: Array<string | { id?: string; name?: string }> = Array.isArray(payload)
		? payload
		: typeof payload === "object" && payload !== null && Array.isArray((payload as KokoroVoicesResponse).voices)
			? ((payload as KokoroVoicesResponse).voices ?? [])
			: [];

	const voices: TtsVoice[] = [];
	for (const voice of rawVoices) {
		if (typeof voice === "string") {
			voices.push({
				id: voice,
				label: formatKokoroVoiceLabel(voice),
				provider: "kokoro",
			});
			continue;
		}
		if (voice && typeof voice === "object" && typeof voice.id === "string") {
			voices.push({
				id: voice.id,
				label:
					typeof voice.name === "string" && voice.name.trim().length > 0
						? voice.name
						: formatKokoroVoiceLabel(voice.id),
				provider: "kokoro",
			});
		}
	}

	return voices;
}

export async function listKokoroVoices(
	config: TtsProviderConfig,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<TtsVoice[]> {
	const baseUrl = (config.baseUrl || "http://127.0.0.1:8880/v1").replace(/\/+$/, "");
	const candidateEndpoints = Array.from(
		new Set([
			`${baseUrl}/audio/voices`,
			`${baseUrl}/voices`,
			`${baseUrl.replace(/\/v1$/i, "")}/v1/audio/voices`,
			`${baseUrl.replace(/\/v1$/i, "")}/audio/voices`,
		]),
	);

	for (const endpoint of candidateEndpoints) {
		try {
			const response = await fetchImpl(endpoint, { signal });
			if (!response.ok) {
				continue;
			}
			const payload = (await response.json()) as unknown;
			const voices = normalizeKokoroVoices(payload);
			if (voices.length > 0) {
				return voices;
			}
		} catch {}
	}

	return DEFAULT_KOKORO_VOICES;
}

export async function synthesizeWithKokoro(
	config: TtsProviderConfig,
	request: TtsSynthesisRequest,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<TtsSynthesisResult> {
	const baseUrl = (config.baseUrl || "http://127.0.0.1:8880/v1").replace(/\/+$/, "");
	const response = await fetchImpl(`${baseUrl}/audio/speech`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
		},
		body: JSON.stringify({
			model: config.modelId || request.modelId || "kokoro",
			voice: request.voiceId,
			input: request.text,
			response_format: "mp3",
			speed: Math.min(4, Math.max(0.25, request.speed)),
		}),
		signal,
	});

	if (!response.ok) {
		throw new Error(`Kokoro TTS failed: ${response.status} ${await response.text()}`);
	}

	return {
		audioData: await response.arrayBuffer(),
		mimeType: "audio/mpeg",
		providerRequestId: response.headers.get("x-request-id") ?? undefined,
	};
}
