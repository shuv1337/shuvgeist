/**
 * Overlay controller - extracted, unit-testable helpers for the TTS overlay.
 *
 * This module provides the business logic for the overlay, separate from
 * the DOM injection mechanism. It handles:
 * - State management
 * - Port-based communication with background
 * - Click-to-speak mode
 * - UI updates
 */

import type { TtsOverlayState, TtsPlaybackStatus, TtsProviderId, TtsStateEvent } from "./types.js";

export interface OverlayControllerOptions {
	onCommand: (command: OverlayCommand) => void;
	onStateChange?: (state: TtsOverlayState) => void;
}

export type OverlayCommand =
	| { type: "speak"; payload: { text: string; source: "overlay" | "click" } }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "stop" }
	| { type: "close" }
	| { type: "set-click-mode"; armed: boolean }
	| { type: "set-provider"; provider: TtsProviderId }
	| { type: "set-voice"; voiceId: string };

export interface OverlayState {
	state: TtsOverlayState;
	clickModeArmed: boolean;
	port: chrome.runtime.Port | null;
}

export function createInitialOverlayState(initialState: TtsOverlayState): OverlayState {
	return {
		state: initialState,
		clickModeArmed: false,
		port: null,
	};
}

export function reduceOverlayState(state: OverlayState, event: TtsStateEvent): OverlayState {
	switch (event.type) {
		case "sync-settings":
			return {
				...state,
				state: {
					...state.state,
					provider: event.settings.provider,
					voiceId: event.settings.voiceId,
					speed: event.settings.speed,
					clickModeArmed: false,
					availableVoices: event.voices,
				},
			};
		case "overlay-opened":
			return {
				...state,
				state: {
					...state.state,
					overlayVisible: true,
					clickModeArmed: false,
				},
				clickModeArmed: false,
			};
		case "overlay-closed":
			return {
				...state,
				state: {
					...state.state,
					overlayVisible: false,
					clickModeArmed: false,
					status:
						state.state.status === "playing" || state.state.status === "paused" ? state.state.status : "idle",
				},
				clickModeArmed: false,
			};
		case "set-click-mode":
			return {
				...state,
				state: {
					...state.state,
					clickModeArmed: event.armed,
				},
				clickModeArmed: event.armed,
			};
		case "set-voice":
			return {
				...state,
				state: {
					...state.state,
					voiceId: event.voiceId,
					availableVoices: event.voices ?? state.state.availableVoices,
				},
			};
		case "set-provider":
			return {
				...state,
				state: {
					...state.state,
					provider: event.provider,
					voiceId: event.voiceId,
					availableVoices: event.voices,
					error: undefined,
				},
			};
		case "speak-start":
			return {
				...state,
				state: {
					...state.state,
					status: "loading",
					currentText: event.text,
					currentTextLength: event.text.length,
					truncated: event.truncated,
					error: undefined,
				},
				clickModeArmed: false,
			};
		case "playing":
			return {
				...state,
				state: {
					...state.state,
					status: "playing",
					error: undefined,
				},
				clickModeArmed: false,
			};
		case "paused":
			return {
				...state,
				state: {
					...state.state,
					status: "paused",
				},
			};
		case "stopped":
			return {
				...state,
				state: {
					...state.state,
					status: "idle",
					clickModeArmed: false,
				},
				clickModeArmed: false,
			};
		case "error":
			return {
				...state,
				state: {
					...state.state,
					status: "error",
					error: event.message,
					clickModeArmed: false,
				},
				clickModeArmed: false,
			};
		case "clear-error":
			return {
				...state,
				state: {
					...state.state,
					error: undefined,
				},
			};
	}
}

export function createOverlayController(options: OverlayControllerOptions) {
	let state: OverlayState | null = null;
	let port: chrome.runtime.Port | null = null;
	let clickHandler: ((event: MouseEvent) => void) | null = null;
	let keyHandler: ((event: KeyboardEvent) => void) | null = null;

	function setClickMode(armed: boolean): void {
		if (armed && !clickHandler) {
			clickHandler = (event: MouseEvent) => {
				const text = resolveSpeakableText(event);
				if (!text) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				options.onCommand({ type: "speak", payload: { text, source: "click" } });
			};
			keyHandler = (event: KeyboardEvent) => {
				if (event.key === "Escape") {
					options.onCommand({ type: "set-click-mode", armed: false });
				}
			};
			document.addEventListener("click", clickHandler, { capture: true });
			document.addEventListener("keydown", keyHandler, { capture: true });
		}
		if (!armed && clickHandler && keyHandler) {
			document.removeEventListener("click", clickHandler, { capture: true });
			document.removeEventListener("keydown", keyHandler, { capture: true });
			clickHandler = null;
			keyHandler = null;
		}
	}

	function resolveSpeakableText(event: MouseEvent): string {
		const selection = window.getSelection();
		if (selection?.toString().trim()) {
			return selection.toString().replace(/\s+/g, " ").trim();
		}
		const target = event.target instanceof Node ? event.target : null;
		const element = target instanceof HTMLElement ? target : target?.parentElement;
		if (!element || element.closest("shuvgeist-tts-root")) return "";
		if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable) {
			return "";
		}
		const block = element.closest("p,li,blockquote,td,th,h1,h2,h3,h4,h5,h6,article") || element;
		const text = ((block as HTMLElement).innerText || block.textContent || "").replace(/\s+/g, " ").trim();
		return text.length >= 8 ? text : "";
	}

	function connectPort(): void {
		if (port) return;
		port = chrome.runtime.connect({ name: "shuvgeist-tts-overlay" });
		port.onMessage.addListener((message: unknown) => {
			if (typeof message !== "object" || message === null) return;
			const msg = message as { type?: string; state?: TtsOverlayState };
			if (msg.type === "tts-sync-state" && msg.state) {
				updateState(msg.state);
			}
		});
		port.onDisconnect.addListener(() => {
			port = null;
		});
	}

	function disconnectPort(): void {
		if (port) {
			port.disconnect();
			port = null;
		}
	}

	function updateState(newState: TtsOverlayState): void {
		if (!state) return;
		state.state = newState;
		setClickMode(newState.clickModeArmed);
		options.onStateChange?.(newState);
	}

	function initialize(initialState: TtsOverlayState): void {
		state = createInitialOverlayState(initialState);
		connectPort();
	}

	function dispose(): void {
		setClickMode(false);
		disconnectPort();
		state = null;
	}

	return {
		initialize,
		dispose,
		setClickMode,
		getPort: () => port,
		getState: () => state,
	};
}

export type OverlayController = ReturnType<typeof createOverlayController>;

export function formatStatusText(status: TtsPlaybackStatus, error?: string): string {
	if (error) return "Error";
	return status.charAt(0).toUpperCase() + status.slice(1);
}

export function formatExtraText(state: TtsOverlayState): string {
	if (state.error) return state.error;
	if (state.truncated) return "Truncated to 3000 chars";
	if (state.currentTextLength) return `${state.currentTextLength} chars`;
	return "";
}
