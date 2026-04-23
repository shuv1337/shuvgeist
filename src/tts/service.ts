import { listElevenLabsVoices, synthesizeWithElevenLabs } from "./providers/elevenlabs.js";
import { listKokoroVoices, synthesizeKokoroCaptioned, synthesizeWithKokoro } from "./providers/kokoro.js";
import { getOpenAiVoiceOptions, synthesizeWithOpenAi } from "./providers/openai.js";
import { DEFAULT_TTS_SETTINGS, getDefaultVoiceId, OPENAI_TTS_VOICES } from "./settings.js";
import { clampReadableText, type NormalizedText } from "./text-normalization.js";
import type {
	TtsProviderConfig,
	TtsProviderId,
	TtsSettingsSnapshot,
	TtsSynthesisRequest,
	TtsSynthesisResult,
	TtsVoice,
} from "./types.js";

export type { NormalizedText as PreparedTtsText };

export interface TtsProviderSecrets {
	openaiKey?: string;
	elevenLabsKey?: string;
	kokoroKey?: string;
}

/**
 * Prepare text for TTS synthesis using shared normalization.
 */
export function prepareTtsText(text: string, maxChars = DEFAULT_TTS_SETTINGS.maxTextChars): NormalizedText {
	return clampReadableText(text, maxChars);
}

export function buildProviderConfig(
	settings: TtsSettingsSnapshot,
	provider: TtsProviderId,
	secrets: TtsProviderSecrets = {},
): TtsProviderConfig {
	switch (provider) {
		case "kokoro":
			return {
				apiKey: secrets.kokoroKey,
				baseUrl: settings.kokoroBaseUrl,
				modelId: settings.kokoroModelId,
			};
		case "openai":
			return {
				apiKey: secrets.openaiKey,
				modelId: settings.openaiModelId,
			};
		case "elevenlabs":
			return {
				apiKey: secrets.elevenLabsKey,
				modelId: settings.elevenLabsModelId,
				outputFormat: settings.elevenLabsOutputFormat,
			};
	}
}

export async function listTtsVoices(
	provider: TtsProviderId,
	settings: TtsSettingsSnapshot,
	secrets: TtsProviderSecrets = {},
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<TtsVoice[]> {
	switch (provider) {
		case "openai":
			return getOpenAiVoiceOptions();
		case "elevenlabs":
			return listElevenLabsVoices(buildProviderConfig(settings, provider, secrets), fetchImpl, signal);
		case "kokoro":
			return listKokoroVoices(buildProviderConfig(settings, provider, secrets), fetchImpl, signal);
	}
}

export async function synthesizeTts(
	provider: TtsProviderId,
	settings: TtsSettingsSnapshot,
	request: TtsSynthesisRequest,
	secrets: TtsProviderSecrets = {},
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
	wantReadAlong = false,
): Promise<TtsSynthesisResult> {
	const config = buildProviderConfig(settings, provider, secrets);
	switch (provider) {
		case "openai": {
			try {
				return await synthesizeWithOpenAi(config, request, fetchImpl, signal);
			} catch (error) {
				if (!settings.openaiModelId || settings.openaiModelId === "tts-1") {
					throw error;
				}
				return synthesizeWithOpenAi(
					{
						...config,
						modelId: "tts-1",
					},
					request,
					fetchImpl,
					signal,
				);
			}
		}
		case "elevenlabs":
			return synthesizeWithElevenLabs(config, request, fetchImpl, signal);
		case "kokoro": {
			if (wantReadAlong) {
				try {
					return await synthesizeKokoroCaptioned(config, request, fetchImpl, signal);
				} catch (captionError) {
					// If captioned fails, fall back to regular synthesis
					console.warn("[TTS] Captioned synthesis failed, falling back to regular:", captionError);
					return synthesizeWithKokoro(config, request, fetchImpl, signal);
				}
			}
			return synthesizeWithKokoro(config, request, fetchImpl, signal);
		}
	}
}

export function getProviderVoiceId(settings: TtsSettingsSnapshot, provider: TtsProviderId): string {
	switch (provider) {
		case "kokoro":
			return settings.kokoroVoiceId;
		case "openai":
			return settings.openaiVoiceId;
		case "elevenlabs":
			return settings.elevenLabsVoiceId || getDefaultVoiceId(provider, settings);
	}
}

export function getSampleTtsPhrase(): string {
	return "Shuvgeist text to speech is ready.";
}

export const OPENAI_VOICE_OPTIONS = OPENAI_TTS_VOICES;
