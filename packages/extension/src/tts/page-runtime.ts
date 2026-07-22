/**
 * Page runtime for TTS read-along.
 *
 * Lives in the userScript context and handles:
 * - Receiving playhead updates from background
 * - Highlighting current word
 * - Auto-scrolling
 * - Session lifecycle
 */

import { createHighlightRenderer } from "./highlight-renderer.js";
import {
	buildReadingSurface,
	disposeReadingSurface,
	findTokenAtCharIndex,
	findTokenForWord,
	type PreparedReadingSurface,
} from "./reading-surface.js";
import { createScrollController } from "./scroll-controller.js";
import type { TtsPlayhead } from "./types.js";

export interface ReadAlongSession {
	id: string;
	surface: PreparedReadingSurface;
	currentWordIndex: number;
	highlightRenderer: ReturnType<typeof createHighlightRenderer>;
	scrollController: ReturnType<typeof createScrollController>;
}

let activeSession: ReadAlongSession | null = null;

/**
 * Start a new read-along session.
 */
export function startReadAlongSession(
	sessionId: string,
	options: {
		selection?: Selection | null;
		maxChars?: number;
		surface?: PreparedReadingSurface;
	} = {},
): { success: boolean; error?: string; surfaceText?: string } {
	// Clean up any existing session
	endReadAlongSession();

	try {
		const surface =
			options.surface ??
			buildReadingSurface({
				sessionId,
				selection: options.selection,
				maxChars: options.maxChars ?? 3000,
			});

		if (!surface) {
			return { success: false, error: "No readable text found on page" };
		}

		if (surface.tokens.length === 0) {
			disposeReadingSurface(surface);
			return { success: false, error: "Could not tokenize page text" };
		}

		activeSession = {
			id: sessionId,
			surface,
			currentWordIndex: -1,
			highlightRenderer: createHighlightRenderer(),
			scrollController: createScrollController(),
		};

		return {
			success: true,
			surfaceText: surface.text,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * End the current read-along session.
 */
export function endReadAlongSession(): void {
	if (!activeSession) return;

	activeSession.highlightRenderer.dispose();
	activeSession.scrollController.dispose();
	disposeReadingSurface(activeSession.surface);
	activeSession = null;
}

/**
 * Handle a playhead update from the offscreen audio player.
 */
export function handlePlayheadUpdate(playhead: TtsPlayhead): void {
	if (!activeSession) return;

	const { surface, highlightRenderer, scrollController } = activeSession;

	const token =
		findTokenAtCharIndex(surface, playhead.charStart) ??
		findTokenForWord(surface, playhead.word, activeSession.currentWordIndex);

	if (token && !token.dirty) {
		// Update highlight
		highlightRenderer.highlight(token);

		// Update scroll position
		scrollController.scrollToToken(token);

		// Track current position
		activeSession.currentWordIndex = surface.tokens.indexOf(token);
	} else {
		// Word not found or token is dirty, clear highlight
		highlightRenderer.clear();
	}
}

/**
 * Check if a read-along session is active.
 */
export function hasActiveReadAlongSession(): boolean {
	return activeSession !== null;
}

/**
 * Get the current session ID.
 */
export function getActiveSessionId(): string | null {
	return activeSession?.id ?? null;
}

/**
 * Get session statistics for debugging.
 */
export function getReadAlongStats(): {
	hasSession: boolean;
	sessionId?: string;
	tokenCount?: number;
	charCount?: number;
	currentWordIndex?: number;
} {
	if (!activeSession) {
		return { hasSession: false };
	}

	return {
		hasSession: true,
		sessionId: activeSession.id,
		tokenCount: activeSession.surface.tokens.length,
		charCount: activeSession.surface.text.length,
		currentWordIndex: activeSession.currentWordIndex,
	};
}

/**
 * Clean up on navigation or disconnect.
 */
export function cleanupPageRuntime(): void {
	endReadAlongSession();
}

// Auto-cleanup on page unload
if (typeof window !== "undefined") {
	window.addEventListener("beforeunload", cleanupPageRuntime);
}
