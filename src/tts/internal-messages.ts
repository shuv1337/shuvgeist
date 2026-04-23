import type {
	KokoroHealthStatus,
	TtsPlaybackState,
	TtsPlayhead,
	TtsProviderConfig,
	TtsProviderId,
	TtsSettingsSnapshot,
	TtsVoice,
} from "./types.js";

export interface TtsSpeakPayload {
	text: string;
	source: "overlay" | "click" | "sidepanel";
}

export type TtsOverlayCommand =
	| { type: "speak"; payload: TtsSpeakPayload }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "stop" }
	| { type: "close" }
	| { type: "set-click-mode"; armed: boolean }
	| { type: "set-provider"; provider: TtsProviderId }
	| { type: "set-voice"; voiceId: string };

export interface TtsOverlayReadyMessage {
	type: "tts-overlay-ready";
}

export interface TtsOverlayCommandMessage {
	type: "tts-overlay-command";
	command: TtsOverlayCommand;
}

export type TtsOverlayMessage = TtsOverlayReadyMessage | TtsOverlayCommandMessage;

export interface TtsStateResponse {
	ok: true;
	state: TtsPlaybackState;
	settings: TtsSettingsSnapshot;
}

export interface TtsErrorResponse {
	ok: false;
	error: string;
}

export type TtsRuntimeResponse = TtsStateResponse | TtsErrorResponse;

export type TtsRuntimeMessage =
	| { type: "tts-open-overlay"; windowId?: number }
	| { type: "tts-close-overlay"; tabId?: number }
	| { type: "tts-get-state" }
	| { type: "tts-speak-test-phrase"; text?: string }
	| { type: "tts-speak-text"; text: string; source?: "overlay" | "click" | "sidepanel" }
	| { type: "tts-pause" }
	| { type: "tts-resume" }
	| { type: "tts-stop" }
	| { type: "tts-set-click-mode"; armed: boolean }
	| { type: "tts-set-provider"; provider: TtsProviderId }
	| { type: "tts-set-voice"; voiceId: string }
	| { type: "tts-kokoro-probe"; baseUrl: string; apiKey?: string };

export type TtsOffscreenMessage =
	| {
			type: "tts-offscreen-synthesize";
			provider: TtsProviderId;
			request: {
				text: string;
				voiceId: string;
				speed: number;
				modelId?: string;
			};
			config: TtsProviderConfig;
			wantTimings?: boolean;
	  }
	| {
			type: "tts-offscreen-synthesize-captioned";
			request: {
				text: string;
				voiceId: string;
				speed: number;
				modelId?: string;
			};
			config: TtsProviderConfig;
	  }
	| { type: "tts-offscreen-pause" }
	| { type: "tts-offscreen-resume" }
	| { type: "tts-offscreen-stop" }
	| { type: "tts-offscreen-get-state" };

export type TtsOffscreenResponse =
	| { ok: true; event: "playing" | "paused" | "stopped"; requestId?: string }
	| { ok: false; error: string };

export interface TtsVoicesResponse {
	ok: true;
	voices: TtsVoice[];
}

// Port-based messages (for persistent overlay connection)
export type TtsPortMessage =
	| { type: "tts-session-ack"; sessionId: string; hasReadAlong: boolean }
	| { type: "tts-playhead"; playhead: TtsPlayhead }
	| { type: "tts-session-end"; sessionId: string }
	| { type: "tts-kokoro-probe-result"; status: KokoroHealthStatus }
	| { type: "tts-sync-state"; state: TtsPlaybackState };
