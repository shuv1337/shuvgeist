import {
	selectTtsProviderForSpeak,
	TtsPlaybackCoordinator,
} from "../../../src/tts/playback-coordinator.js";
import { DEFAULT_TTS_SETTINGS } from "../../../src/tts/settings.js";
import type { TtsPortMessage, TtsSpeakPayload } from "../../../src/tts/internal-messages.js";
import type { TtsPlayhead } from "../../../src/tts/types.js";

const pagePayload: TtsSpeakPayload = {
	sessionId: "session-1",
	command: {
		kind: "page-target",
		text: "Read this text",
		source: "selection",
		truncated: false,
		targetSummary: { blockCount: 1, textLength: 14 },
	},
};

describe("tts playback coordinator", () => {
	it("selects Kokoro read-along when Kokoro is healthy and a tab is available", () => {
		expect(
			selectTtsProviderForSpeak({
				commandKind: "page-target",
				requestedProvider: "kokoro",
				readAlongEnabled: true,
				tabId: 123,
				kokoroStatus: { status: "ok" },
			}),
		).toEqual({ provider: "kokoro", hasReadAlong: true });
	});

	it("keeps Kokoro audio-only when caption timing is unavailable", () => {
		expect(
			selectTtsProviderForSpeak({
				commandKind: "page-target",
				requestedProvider: "kokoro",
				readAlongEnabled: true,
				tabId: 123,
				kokoroStatus: { status: "captioned-unsupported" },
			}),
		).toEqual({ provider: "kokoro", hasReadAlong: false, fallbackReason: "captioned-unsupported" });
	});

	it("uses an explicit fallback when Kokoro is unavailable", () => {
		expect(
			selectTtsProviderForSpeak({
				commandKind: "page-target",
				requestedProvider: "kokoro",
				fallbackProvider: "openai",
				readAlongEnabled: true,
				tabId: 123,
				kokoroStatus: { status: "unreachable", message: "offline" },
			}),
		).toEqual({ provider: "openai", hasReadAlong: false, fallbackReason: "kokoro-unreachable" });
	});

	it("reports a fallback-required error when Kokoro is unavailable with no fallback", () => {
		expect(
			selectTtsProviderForSpeak({
				commandKind: "page-target",
				requestedProvider: "kokoro",
				readAlongEnabled: true,
				tabId: 123,
				kokoroStatus: { status: "unreachable", message: "offline" },
			}),
		).toEqual({ provider: "kokoro", hasReadAlong: false, error: "offline" });
	});

	it("marks legacy providers as audio-only for page targets", () => {
		expect(
			selectTtsProviderForSpeak({
				commandKind: "page-target",
				requestedProvider: "elevenlabs",
				readAlongEnabled: true,
				tabId: 123,
			}),
		).toEqual({ provider: "elevenlabs", hasReadAlong: false, fallbackReason: "legacy-provider-mode" });
	});

	it("plans speech with normalized text, voice, model, and read-along decision", () => {
		const { coordinator } = createCoordinator();
		const plan = coordinator.planSpeak({
			payload: pagePayload,
			sessionId: "session-1",
			settings: DEFAULT_TTS_SETTINGS,
			tabId: 123,
			kokoroStatus: { status: "ok" },
		});

		expect(plan).toMatchObject({
			sessionId: "session-1",
			preparedText: "Read this text",
			provider: "kokoro",
			voiceId: DEFAULT_TTS_SETTINGS.kokoroVoiceId,
			modelId: DEFAULT_TTS_SETTINGS.kokoroModelId,
			hasReadAlong: true,
			truncated: false,
		});
		expect("error" in plan ? undefined : coordinator.createOffscreenMessage(plan, DEFAULT_TTS_SETTINGS, {})).toMatchObject({
			type: "tts-offscreen-synthesize-captioned",
			sessionId: "session-1",
			request: {
				text: "Read this text",
				voiceId: DEFAULT_TTS_SETTINGS.kokoroVoiceId,
				modelId: DEFAULT_TTS_SETTINGS.kokoroModelId,
			},
		});
	});

	it("owns reading-session overlay attachment, playhead forwarding, and cleanup", () => {
		const { coordinator, sent, logEvent } = createCoordinator();
		coordinator.startReadingSession({
			sessionId: "session-1",
			tabId: 123,
			provider: "kokoro",
			sourceKind: "page-target",
			text: "Read this",
			hasReadAlong: true,
		});

		expect(
			coordinator.currentOverlayState({
				overlayTabId: 123,
				playbackState: { ...DEFAULT_PLAYBACK_STATE, overlayVisible: true },
				settings: DEFAULT_TTS_SETTINGS,
			}).hasReadAlong,
		).toBe(true);

		coordinator.forwardPlayhead("session-1", { wordIndex: 1, charStart: 5, charEnd: 9, currentTime: 0.5 });
		expect(sent).toEqual([
			{
				tabId: 123,
				message: {
					type: "tts-playhead",
					sessionId: "session-1",
					playhead: { wordIndex: 1, charStart: 5, charEnd: 9, currentTime: 0.5 },
				},
			},
		]);

		coordinator.markOverlayDetached(123);
		coordinator.forwardPlayhead("session-1", { wordIndex: 2, charStart: 10, charEnd: 14, currentTime: 1 } as TtsPlayhead);
		expect(sent).toHaveLength(1);

		coordinator.markOverlayAttached(123);
		coordinator.endReadingSession("session-1");
		expect(sent.at(-1)).toEqual({ tabId: 123, message: { type: "tts-session-end", sessionId: "session-1" } });
		expect(logEvent).toHaveBeenCalledWith("session.end", expect.objectContaining({ sessionId: "session-1" }));
	});
});

const DEFAULT_PLAYBACK_STATE = {
	status: "idle",
	provider: DEFAULT_TTS_SETTINGS.provider,
	voiceId: DEFAULT_TTS_SETTINGS.voiceId,
	speed: DEFAULT_TTS_SETTINGS.speed,
	clickModeArmed: false,
	overlayVisible: false,
	currentText: "",
	currentTextLength: 0,
	truncated: false,
	availableVoices: [],
} as const;

function createCoordinator() {
	const sent: Array<{ tabId: number; message: TtsPortMessage }> = [];
	const logEvent = vi.fn();
	const coordinator = new TtsPlaybackCoordinator({
		sendToOverlay: (tabId, message) => sent.push({ tabId, message }),
		logEvent,
		now: () => 1000,
		createSessionId: () => "generated-session",
	});
	return { coordinator, sent, logEvent };
}
