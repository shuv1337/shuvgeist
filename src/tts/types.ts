export const TTS_PROVIDER_IDS = ["kokoro", "openai", "elevenlabs"] as const;

export type TtsProviderId = (typeof TTS_PROVIDER_IDS)[number];

export const TTS_PLAYBACK_STATUSES = ["idle", "loading", "playing", "paused", "error"] as const;

export type TtsPlaybackStatus = (typeof TTS_PLAYBACK_STATUSES)[number];

export interface TtsVoice {
	id: string;
	label: string;
	provider: TtsProviderId;
	description?: string;
}

export interface TtsSynthesisRequest {
	text: string;
	voiceId: string;
	speed: number;
	modelId?: string;
}

export interface TtsSynthesisResult {
	audioData: ArrayBuffer;
	mimeType: string;
	providerRequestId?: string;
}

export interface TtsProviderConfig {
	apiKey?: string;
	baseUrl?: string;
	modelId?: string;
	outputFormat?: string;
}

export interface TtsPlaybackState {
	status: TtsPlaybackStatus;
	provider: TtsProviderId;
	voiceId: string;
	speed: number;
	clickModeArmed: boolean;
	overlayVisible: boolean;
	currentText: string;
	currentTextLength: number;
	truncated: boolean;
	availableVoices: TtsVoice[];
	error?: string;
}

export interface TtsSettingsSnapshot {
	enabled: boolean;
	provider: TtsProviderId;
	voiceId: string;
	speed: number;
	clickModeDefault: boolean;
	maxTextChars: number;
	kokoroBaseUrl: string;
	kokoroModelId: string;
	kokoroVoiceId: string;
	openaiModelId: string;
	openaiVoiceId: string;
	elevenLabsModelId: string;
	elevenLabsOutputFormat: string;
	elevenLabsVoiceId: string;
}

export interface TtsOverlayState extends TtsPlaybackState {
	enabled: boolean;
}

export type TtsStateEvent =
	| { type: "sync-settings"; settings: TtsSettingsSnapshot; voices: TtsVoice[] }
	| { type: "overlay-opened" }
	| { type: "overlay-closed" }
	| { type: "set-click-mode"; armed: boolean }
	| { type: "set-voice"; voiceId: string; voices?: TtsVoice[] }
	| { type: "set-provider"; provider: TtsProviderId; voiceId: string; voices: TtsVoice[] }
	| { type: "speak-start"; text: string; truncated: boolean }
	| { type: "playing" }
	| { type: "paused" }
	| { type: "stopped" }
	| { type: "error"; message: string }
	| { type: "clear-error" };

export function createInitialTtsPlaybackState(
	settings: TtsSettingsSnapshot,
	voices: TtsVoice[] = [],
): TtsPlaybackState {
	return {
		status: "idle",
		provider: settings.provider,
		voiceId: settings.voiceId,
		speed: settings.speed,
		clickModeArmed: settings.clickModeDefault,
		overlayVisible: false,
		currentText: "",
		currentTextLength: 0,
		truncated: false,
		availableVoices: voices,
	};
}

export function reduceTtsPlaybackState(state: TtsPlaybackState, event: TtsStateEvent): TtsPlaybackState {
	switch (event.type) {
		case "sync-settings":
			return {
				...state,
				provider: event.settings.provider,
				voiceId: event.settings.voiceId,
				speed: event.settings.speed,
				clickModeArmed: state.overlayVisible ? state.clickModeArmed : event.settings.clickModeDefault,
				availableVoices: event.voices,
			};
		case "overlay-opened":
			return {
				...state,
				overlayVisible: true,
				clickModeArmed: false,
			};
		case "overlay-closed":
			return {
				...state,
				overlayVisible: false,
				clickModeArmed: false,
			};
		case "set-click-mode":
			return {
				...state,
				clickModeArmed: event.armed,
			};
		case "set-voice":
			return {
				...state,
				voiceId: event.voiceId,
				availableVoices: event.voices ?? state.availableVoices,
			};
		case "set-provider":
			return {
				...state,
				provider: event.provider,
				voiceId: event.voiceId,
				availableVoices: event.voices,
				error: undefined,
			};
		case "speak-start":
			return {
				...state,
				status: "loading",
				currentText: event.text,
				currentTextLength: event.text.length,
				truncated: event.truncated,
				error: undefined,
			};
		case "playing":
			return {
				...state,
				status: "playing",
				error: undefined,
			};
		case "paused":
			return {
				...state,
				status: "paused",
			};
		case "stopped":
			return {
				...state,
				status: "idle",
				clickModeArmed: false,
			};
		case "error":
			return {
				...state,
				status: "error",
				error: event.message,
				clickModeArmed: false,
			};
		case "clear-error":
			return {
				...state,
				error: undefined,
			};
	}
}
