/**
 * Shared text normalization for TTS read-along correctness.
 *
 * This module ensures that text sent to Kokoro matches the character axis
 * used by the page token map. It must be reused by:
 * - prepareTtsText() in service.ts
 * - resolveTtsTextTarget() / page-target capture logic
 * - buildReadingSurface() logic
 */

export interface NormalizedText {
	text: string;
	truncated: boolean;
}

/**
 * Normalize readable text by collapsing whitespace and trimming.
 * This is the canonical normalization used across all TTS paths.
 */
export function normalizeReadableText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Clamp text to a maximum character limit.
 * Returns the normalized and potentially truncated text.
 */
export function clampReadableText(text: string, maxChars: number): NormalizedText {
	const normalized = normalizeReadableText(text);
	if (normalized.length <= maxChars) {
		return {
			text: normalized,
			truncated: false,
		};
	}
	return {
		text: normalized.slice(0, maxChars).trimEnd(),
		truncated: true,
	};
}

/**
 * Get the effective character limit based on provider and mode.
 * - Kokoro page-target with read-along uses the standard cap for non-streaming
 * - Cloud providers (OpenAI/ElevenLabs) use the standard cap
 * - Raw text always uses the standard cap
 */
export function getEffectiveTtsCharLimit(
	_provider: "kokoro" | "openai" | "elevenlabs",
	_mode: "raw-text" | "page-target",
	_streamingEnabled: boolean,
	baseLimit: number,
): number {
	// For now, all modes use the same cap until streaming is proven reliable
	// In Phase 4, this will be expanded for Kokoro page-target with streaming
	return baseLimit;
}

/**
 * Check if two normalized texts are equivalent.
 * Useful for verifying that page text matches synthesized text.
 */
export function textsEquivalent(a: string, b: string): boolean {
	return normalizeReadableText(a) === normalizeReadableText(b);
}

/**
 * Find the position of a word within normalized text, allowing for minor
 * normalization differences. Returns -1 if not found.
 */
export function findWordPosition(haystack: string, needle: string, startIndex = 0): number {
	const normalizedHaystack = normalizeReadableText(haystack).toLowerCase();
	const normalizedNeedle = normalizeReadableText(needle).toLowerCase();
	return normalizedHaystack.indexOf(normalizedNeedle, startIndex);
}
