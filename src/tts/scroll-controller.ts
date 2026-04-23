/**
 * Scroll controller for TTS read-along.
 *
 * Implements center-band auto-scroll with hysteresis and requestAnimationFrame
 * batching. Scrolls only when the current token exits the 35%-65% center band.
 */

import type { TokenMapEntry } from "./reading-surface.js";

export interface ScrollController {
	scrollToToken(token: TokenMapEntry): void;
	reset(): void;
	dispose(): void;
}

interface ScrollState {
	rafId: number | null;
	lastTokenMidpointY: number | null;
	scrollContainer: Element | null;
	isScrolling: boolean;
}

// Center band boundaries (35% - 65% of viewport)
const CENTER_BAND_TOP = 0.35;
const CENTER_BAND_BOTTOM = 0.65;

// Minimum scroll distance to trigger a scroll (prevents jitter)
const MIN_SCROLL_DISTANCE = 20;

// Hysteresis factor - once outside band, need to get further inside to reset
const HYSTERESIS_FACTOR = 0.05;

const state: ScrollState = {
	rafId: null,
	lastTokenMidpointY: null,
	scrollContainer: null,
	isScrolling: false,
};

/**
 * Find the scroll container for an element.
 * Returns the document body if no scroll container found.
 */
export function findScrollContainer(element: Element): Element {
	let current: Element | null = element;

	while (current && current !== document.body && current !== document.documentElement) {
		const style = window.getComputedStyle(current);
		const overflowY = style.overflowY;

		if (overflowY === "auto" || overflowY === "scroll") {
			return current;
		}

		current = current.parentElement;
	}

	return document.documentElement;
}

/**
 * Get the visible viewport height.
 */
function getViewportHeight(): number {
	return window.innerHeight;
}

/**
 * Calculate the target scroll position to center a token.
 */
function calculateTargetScroll(tokenMidpointY: number, container: Element): number {
	const viewportHeight = getViewportHeight();
	const centerY = viewportHeight / 2;

	if (container === document.documentElement || container === document.body) {
		// Page-level scrolling
		return tokenMidpointY - centerY;
	}

	// Container-level scrolling
	const containerRect = container.getBoundingClientRect();
	const tokenRelativeY = tokenMidpointY - containerRect.top;
	const containerCenterY = containerRect.height / 2;
	const currentScrollTop = (container as HTMLElement).scrollTop;

	return currentScrollTop + tokenRelativeY - containerCenterY;
}

/**
 * Check if a Y position is within the center band.
 */
function isInCenterBand(y: number, hysteresis = false): boolean {
	const viewportHeight = getViewportHeight();
	const top = viewportHeight * (CENTER_BAND_TOP - (hysteresis ? HYSTERESIS_FACTOR : 0));
	const bottom = viewportHeight * (CENTER_BAND_BOTTOM + (hysteresis ? HYSTERESIS_FACTOR : 0));
	return y >= top && y <= bottom;
}

/**
 * Perform the scroll action with smooth behavior.
 */
function performScroll(targetY: number, container: Element): void {
	if (state.isScrolling) return;

	state.isScrolling = true;

	if (container === document.documentElement || container === document.body) {
		window.scrollTo({
			top: targetY,
			behavior: "smooth",
		});
	} else {
		(container as HTMLElement).scrollTo({
			top: targetY,
			behavior: "smooth",
		});
	}

	// Reset scrolling flag after animation likely completes
	setTimeout(() => {
		state.isScrolling = false;
	}, 300);
}

/**
 * Process scroll for a token.
 */
function processScroll(token: TokenMapEntry): void {
	try {
		// Get the token's bounding rect
		const range = document.createRange();
		range.setStart(token.startNode, token.startOffset);
		range.setEnd(token.endNode, token.endOffset);

		const rect = range.getBoundingClientRect();
		const tokenMidpointY = rect.top + rect.height / 2;

		// Check if we need to scroll
		if (isInCenterBand(tokenMidpointY)) {
			state.lastTokenMidpointY = tokenMidpointY;
			return;
		}

		// Check hysteresis - don't scroll back immediately
		if (state.lastTokenMidpointY !== null) {
			const wasOutside = !isInCenterBand(state.lastTokenMidpointY, true);
			const isOutside = !isInCenterBand(tokenMidpointY, true);

			if (wasOutside && isOutside) {
				// Still outside, check if we crossed the center
				const crossedCenter =
					state.lastTokenMidpointY < getViewportHeight() / 2 !== tokenMidpointY < getViewportHeight() / 2;

				if (!crossedCenter) {
					state.lastTokenMidpointY = tokenMidpointY;
					return;
				}
			}
		}

		// Find scroll container if not cached
		if (!state.scrollContainer) {
			state.scrollContainer = findScrollContainer(token.startNode.parentElement || document.body);
			// Add scroll anchoring defense
			if (state.scrollContainer instanceof HTMLElement) {
				state.scrollContainer.style.overflowAnchor = "none";
			}
		}

		// Calculate and perform scroll
		const targetY = calculateTargetScroll(tokenMidpointY + window.scrollY, state.scrollContainer);
		const currentY =
			state.scrollContainer === document.documentElement
				? window.scrollY
				: (state.scrollContainer as HTMLElement).scrollTop;

		if (Math.abs(targetY - currentY) > MIN_SCROLL_DISTANCE) {
			performScroll(targetY, state.scrollContainer);
		}

		state.lastTokenMidpointY = tokenMidpointY;
	} catch {
		// Silently fail on scroll errors
	}
}

/**
 * Create a scroll controller for read-along.
 */
export function createScrollController(): ScrollController {
	return {
		scrollToToken(token: TokenMapEntry): void {
			// Cancel any pending scroll
			if (state.rafId !== null) {
				cancelAnimationFrame(state.rafId);
			}

			// Schedule scroll processing in next frame
			state.rafId = requestAnimationFrame(() => {
				state.rafId = null;
				processScroll(token);
			});
		},

		reset(): void {
			if (state.rafId !== null) {
				cancelAnimationFrame(state.rafId);
				state.rafId = null;
			}
			state.lastTokenMidpointY = null;

			// Restore scroll anchoring
			if (state.scrollContainer instanceof HTMLElement) {
				state.scrollContainer.style.overflowAnchor = "";
			}
			state.scrollContainer = null;
		},

		dispose(): void {
			this.reset();
		},
	};
}

/**
 * Temporarily disable scroll anchoring on a container.
 */
export function disableScrollAnchoring(container: HTMLElement): () => void {
	const original = container.style.overflowAnchor;
	container.style.overflowAnchor = "none";

	return () => {
		container.style.overflowAnchor = original;
	};
}
