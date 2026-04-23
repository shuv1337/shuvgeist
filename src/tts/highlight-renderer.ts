/**
 * Highlight renderer for TTS read-along.
 *
 * Uses CSS Custom Highlight API when available, with a pooled rect overlay fallback.
 */

import type { PreparedReadingSurface, TokenMapEntry } from "./reading-surface.js";

const HIGHLIGHT_NAME = "shuvgeist-tts-readalong";

export interface HighlightRenderer {
	highlight(token: TokenMapEntry | null): void;
	clear(): void;
	dispose(): void;
}

/**
 * Check if CSS Custom Highlight API is supported.
 */
export function isCustomHighlightSupported(): boolean {
	return "highlights" in CSS && typeof (CSS as { highlights?: { set?: unknown } }).highlights?.set === "function";
}

/**
 * Create a highlight renderer using CSS Custom Highlight API.
 */
export function createCustomHighlightRenderer(): HighlightRenderer {
	let currentRange: Range | null = null;

	// Register the highlight style if not already present
	ensureHighlightStyle();

	return {
		highlight(token: TokenMapEntry | null): void {
			this.clear();

			if (!token || token.dirty) return;

			try {
				const range = document.createRange();
				range.setStart(token.startNode, token.startOffset);
				range.setEnd(token.endNode, token.endOffset);

				const highlight = new (window as { Highlight?: new (range: Range) => Highlight }).Highlight!(range);
				(CSS as { highlights?: { set: (name: string, h: Highlight) => void } }).highlights?.set(
					HIGHLIGHT_NAME,
					highlight,
				);

				currentRange = range;
			} catch {
				// Silently fail if highlight API has issues
			}
		},

		clear(): void {
			try {
				(CSS as { highlights?: { delete: (name: string) => void } }).highlights?.delete(HIGHLIGHT_NAME);
			} catch {
				// Ignore errors during cleanup
			}
			currentRange = null;
		},

		dispose(): void {
			this.clear();
		},
	};
}

/**
 * Create a fallback highlight renderer using positioned divs.
 */
export function createRectHighlightRenderer(container: HTMLElement = document.body): HighlightRenderer {
	const rects: HTMLDivElement[] = [];
	let currentToken: TokenMapEntry | null = null;

	function createRect(): HTMLDivElement {
		const rect = document.createElement("div");
		rect.style.cssText = `
			position: absolute;
			pointer-events: none;
			background: rgba(249, 115, 22, 0.3);
			border-radius: 2px;
			z-index: 2147483646;
			transition: all 0.1s ease-out;
		`;
		return rect;
	}

	function getRect(): HTMLDivElement {
		let rect = rects.find((r) => !r.isConnected);
		if (!rect) {
			rect = createRect();
			rects.push(rect);
		}
		return rect;
	}

	function clearRects(): void {
		rects.forEach((rect) => {
			if (rect.isConnected) {
				rect.remove();
			}
		});
	}

	return {
		highlight(token: TokenMapEntry | null): void {
			clearRects();
			currentToken = token;

			if (!token || token.dirty) return;

			try {
				const range = document.createRange();
				range.setStart(token.startNode, token.startOffset);
				range.setEnd(token.endNode, token.endOffset);

				const clientRects = range.getClientRects();

				for (let i = 0; i < clientRects.length; i++) {
					const clientRect = clientRects[i];
					const rect = getRect();

					rect.style.left = `${clientRect.left + window.scrollX}px`;
					rect.style.top = `${clientRect.top + window.scrollY}px`;
					rect.style.width = `${clientRect.width}px`;
					rect.style.height = `${clientRect.height}px`;
					rect.style.willChange = "transform";

					container.appendChild(rect);
				}
			} catch {
				// Silently fail
			}
		},

		clear(): void {
			clearRects();
			currentToken = null;
		},

		dispose(): void {
			clearRects();
			rects.length = 0;
		},
	};
}

/**
 * Create the best available highlight renderer.
 */
export function createHighlightRenderer(container?: HTMLElement): HighlightRenderer {
	if (isCustomHighlightSupported()) {
		return createCustomHighlightRenderer();
	}
	return createRectHighlightRenderer(container);
}

/**
 * Ensure the highlight CSS style is injected.
 */
function ensureHighlightStyle(): void {
	const styleId = "shuvgeist-tts-highlight-style";
	if (document.getElementById(styleId)) return;

	const style = document.createElement("style");
	style.id = styleId;
	style.textContent = `
		::highlight(${HIGHLIGHT_NAME}) {
			background-color: rgba(249, 115, 22, 0.3);
			border-radius: 2px;
		}
	`;
	document.head.appendChild(style);
}

/**
 * Highlight a token in a reading surface.
 */
export function highlightToken(surface: PreparedReadingSurface, tokenIndex: number, renderer: HighlightRenderer): void {
	if (tokenIndex < 0 || tokenIndex >= surface.tokens.length) {
		renderer.clear();
		return;
	}

	const token = surface.tokens[tokenIndex];
	renderer.highlight(token);
}

/**
 * Clear all highlights.
 */
export function clearHighlights(renderer: HighlightRenderer): void {
	renderer.clear();
}
