import { describe, expect, it } from "vitest";
import { DEFAULT_TTS_SETTINGS } from "../../../src/tts/settings.js";
import { createInitialTtsPlaybackState, reduceTtsPlaybackState } from "../../../src/tts/types.js";

describe("tts runtime state", () => {
	it("marks the overlay as open and disarmed when launched", () => {
		const next = reduceTtsPlaybackState(createInitialTtsPlaybackState(DEFAULT_TTS_SETTINGS), {
			type: "overlay-opened",
		});
		expect(next.overlayVisible).toBe(true);
		expect(next.clickModeArmed).toBe(false);
	});

	it("tracks provider changes without losing the voice list", () => {
		const next = reduceTtsPlaybackState(createInitialTtsPlaybackState(DEFAULT_TTS_SETTINGS), {
			type: "set-provider",
			provider: "openai",
			voiceId: "alloy",
			voices: [{ id: "alloy", label: "Alloy", provider: "openai" }],
		});
		expect(next.provider).toBe("openai");
		expect(next.voiceId).toBe("alloy");
		expect(next.availableVoices).toHaveLength(1);
	});
});
