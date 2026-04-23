import { createRemoveTtsOverlayScript } from "./overlay-content.js";
import type { TtsOverlayState } from "./types.js";

export const TTS_OVERLAY_WORLD_ID = "shuvgeist-tts-overlay";
export const TTS_OVERLAY_CSP = "style-src 'unsafe-inline'; default-src 'none';";

export async function configureTtsOverlayWorld(): Promise<void> {
	if (!chrome.userScripts?.configureWorld) {
		throw new Error("userScripts API not available");
	}
	await chrome.userScripts.configureWorld({
		worldId: TTS_OVERLAY_WORLD_ID,
		messaging: true,
		csp: TTS_OVERLAY_CSP,
	});
}

export async function injectTtsOverlay(tabId: number, _state: TtsOverlayState): Promise<void> {
	await chrome.userScripts.execute({
		js: [{ file: "tts-overlay-runtime.js" }],
		target: { tabId, allFrames: false },
		world: "USER_SCRIPT",
		worldId: TTS_OVERLAY_WORLD_ID,
		injectImmediately: true,
	});
}

export async function removeTtsOverlay(tabId: number): Promise<void> {
	await chrome.userScripts.execute({
		js: [{ code: createRemoveTtsOverlayScript() }],
		target: { tabId, allFrames: false },
		world: "USER_SCRIPT",
		worldId: TTS_OVERLAY_WORLD_ID,
		injectImmediately: true,
	});
}
