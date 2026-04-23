import { describe, expect, it, vi, beforeAll } from "vitest";
import {
	createInitialOverlayState,
	createOverlayController,
	formatExtraText,
	formatStatusText,
	reduceOverlayState,
} from "../../../src/tts/overlay-controller.js";
import { DEFAULT_TTS_SETTINGS } from "../../../src/tts/settings.js";
import { createInitialTtsPlaybackState, type TtsOverlayState } from "../../../src/tts/types.js";

// Mock chrome API
beforeAll(() => {
	Object.defineProperty(global, "chrome", {
		value: {
			runtime: {
				connect: vi.fn(() => ({
					postMessage: vi.fn(),
					onMessage: { addListener: vi.fn() },
					onDisconnect: { addListener: vi.fn() },
					disconnect: vi.fn(),
				})),
			},
		},
		writable: true,
	});
});

describe("overlay-controller", () => {
	describe("createInitialOverlayState", () => {
		it("creates state with initial values", () => {
			const initialPlaybackState = createInitialTtsPlaybackState(DEFAULT_TTS_SETTINGS);
			const overlayState: TtsOverlayState = { ...initialPlaybackState, enabled: true };
			const state = createInitialOverlayState(overlayState);

			expect(state.state).toEqual(overlayState);
			expect(state.clickModeArmed).toBe(false);
			expect(state.port).toBeNull();
		});
	});

	describe("reduceOverlayState", () => {
		const initialPlaybackState = createInitialTtsPlaybackState(DEFAULT_TTS_SETTINGS);
		const overlayState: TtsOverlayState = { ...initialPlaybackState, enabled: true };
		const baseState = createInitialOverlayState(overlayState);

		it("handles sync-settings", () => {
			const next = reduceOverlayState(baseState, {
				type: "sync-settings",
				settings: { ...DEFAULT_TTS_SETTINGS, provider: "openai" },
				voices: [],
			});
			expect(next.state.provider).toBe("openai");
			expect(next.clickModeArmed).toBe(false);
		});

		it("handles overlay-opened", () => {
			const next = reduceOverlayState(baseState, { type: "overlay-opened" });
			expect(next.state.overlayVisible).toBe(true);
			expect(next.clickModeArmed).toBe(false);
		});

		it("handles overlay-closed", () => {
			const opened = reduceOverlayState(baseState, { type: "overlay-opened" });
			const next = reduceOverlayState(opened, { type: "overlay-closed" });
			expect(next.state.overlayVisible).toBe(false);
			expect(next.clickModeArmed).toBe(false);
		});

		it("handles set-click-mode", () => {
			const next = reduceOverlayState(baseState, { type: "set-click-mode", armed: true });
			expect(next.state.clickModeArmed).toBe(true);
			expect(next.clickModeArmed).toBe(true);
		});

		it("handles speak-start", () => {
			const next = reduceOverlayState(baseState, {
				type: "speak-start",
				text: "Hello world",
				truncated: false,
			});
			expect(next.state.status).toBe("loading");
			expect(next.state.currentText).toBe("Hello world");
			expect(next.clickModeArmed).toBe(false);
		});

		it("handles playing", () => {
			const next = reduceOverlayState(baseState, { type: "playing" });
			expect(next.state.status).toBe("playing");
			expect(next.clickModeArmed).toBe(false);
		});

		it("handles error", () => {
			const next = reduceOverlayState(baseState, { type: "error", message: "Test error" });
			expect(next.state.status).toBe("error");
			expect(next.state.error).toBe("Test error");
			expect(next.clickModeArmed).toBe(false);
		});
	});

	describe("createOverlayController", () => {
		it("initializes with initial state", () => {
			const onCommand = vi.fn();
			const controller = createOverlayController({ onCommand });

			const initialPlaybackState = createInitialTtsPlaybackState(DEFAULT_TTS_SETTINGS);
			const overlayState: TtsOverlayState = { ...initialPlaybackState, enabled: true };

			controller.initialize(overlayState);

			expect(controller.getState()?.state).toEqual(overlayState);
		});

		it("calls onCommand when commands are triggered", () => {
			const onCommand = vi.fn();
			const controller = createOverlayController({ onCommand });

			const initialPlaybackState = createInitialTtsPlaybackState(DEFAULT_TTS_SETTINGS);
			const overlayState: TtsOverlayState = { ...initialPlaybackState, enabled: true };

			controller.initialize(overlayState);
			controller.dispose();

			expect(controller.getState()).toBeNull();
		});
	});

	describe("formatStatusText", () => {
		it("capitalizes status", () => {
			expect(formatStatusText("playing")).toBe("Playing");
			expect(formatStatusText("paused")).toBe("Paused");
			expect(formatStatusText("idle")).toBe("Idle");
		});

		it("returns Error when error is present", () => {
			expect(formatStatusText("playing", "Something went wrong")).toBe("Error");
		});
	});

	describe("formatExtraText", () => {
		it("shows error message", () => {
			const state = createInitialTtsPlaybackState(DEFAULT_TTS_SETTINGS);
			const overlayState: TtsOverlayState = { ...state, enabled: true, error: "Test error" };
			expect(formatExtraText(overlayState)).toBe("Test error");
		});

		it("shows truncated message", () => {
			const state = createInitialTtsPlaybackState(DEFAULT_TTS_SETTINGS);
			const overlayState: TtsOverlayState = { ...state, enabled: true, truncated: true };
			expect(formatExtraText(overlayState)).toBe("Truncated to 3000 chars");
		});

		it("shows character count", () => {
			const state = createInitialTtsPlaybackState(DEFAULT_TTS_SETTINGS);
			const overlayState: TtsOverlayState = { ...state, enabled: true, currentTextLength: 150 };
			expect(formatExtraText(overlayState)).toBe("150 chars");
		});

		it("returns empty string when no info", () => {
			const state = createInitialTtsPlaybackState(DEFAULT_TTS_SETTINGS);
			const overlayState: TtsOverlayState = { ...state, enabled: true };
			expect(formatExtraText(overlayState)).toBe("");
		});
	});
});
