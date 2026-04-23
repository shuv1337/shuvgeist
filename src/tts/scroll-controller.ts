import type { TokenMapEntry } from "./reading-surface.js";

export interface ScrollController {
	scrollToToken(token: TokenMapEntry): void;
	reset(): void;
	dispose(): void;
}

const CENTER_BAND_TOP = 0.35;
const CENTER_BAND_BOTTOM = 0.65;
const HYSTERESIS = 0.05;
const MIN_SCROLL_DISTANCE = 20;
const ROOT_SCROLL_CONTAINER = document.scrollingElement || document.documentElement;

function getScrollableContainer(element: Element | null): HTMLElement {
	let current = element;
	while (current && current !== document.body && current !== document.documentElement) {
		if (current instanceof HTMLElement) {
			const style = window.getComputedStyle(current);
			if (/(auto|scroll|overlay)/.test(style.overflowY) && current.scrollHeight > current.clientHeight) {
				return current;
			}
		}
		current = current.parentElement;
	}
	return ROOT_SCROLL_CONTAINER instanceof HTMLElement ? ROOT_SCROLL_CONTAINER : document.documentElement;
}

export function findScrollContainer(element: Element): Element {
	return getScrollableContainer(element);
}

function getContainerMetrics(container: HTMLElement): { top: number; height: number; scrollTop: number } {
	if (container === ROOT_SCROLL_CONTAINER || container === document.documentElement || container === document.body) {
		return {
			top: 0,
			height: window.innerHeight,
			scrollTop: window.scrollY,
		};
	}

	const rect = container.getBoundingClientRect();
	return {
		top: rect.top,
		height: rect.height,
		scrollTop: container.scrollTop,
	};
}

function isWithinBand(midpointY: number, metrics: { top: number; height: number }, hysteresis = false): boolean {
	const topBound = metrics.top + metrics.height * (CENTER_BAND_TOP - (hysteresis ? HYSTERESIS : 0));
	const bottomBound = metrics.top + metrics.height * (CENTER_BAND_BOTTOM + (hysteresis ? HYSTERESIS : 0));
	return midpointY >= topBound && midpointY <= bottomBound;
}

function computeTargetScroll(midpointY: number, metrics: { top: number; height: number; scrollTop: number }): number {
	return metrics.scrollTop + (midpointY - metrics.top) - metrics.height / 2;
}

export function disableScrollAnchoring(container: HTMLElement): () => void {
	const original = container.style.overflowAnchor;
	container.style.overflowAnchor = "none";
	return () => {
		container.style.overflowAnchor = original;
	};
}

export function createScrollController(): ScrollController {
	let rafId: number | null = null;
	let lastMidpointY: number | null = null;
	let scrollContainer: HTMLElement | null = null;
	let restoreAnchoring: (() => void) | null = null;

	function performScroll(token: TokenMapEntry): void {
		const range = document.createRange();
		range.setStart(token.startNode, token.startOffset);
		range.setEnd(token.endNode, token.endOffset);
		const rect = range.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) {
			return;
		}

		const midpointY = rect.top + rect.height / 2;
		if (!scrollContainer) {
			scrollContainer = getScrollableContainer(token.startNode.parentElement);
			if (
				scrollContainer !== ROOT_SCROLL_CONTAINER &&
				scrollContainer !== document.documentElement &&
				scrollContainer !== document.body
			) {
				restoreAnchoring = disableScrollAnchoring(scrollContainer);
			}
		}

		const metrics = getContainerMetrics(scrollContainer);
		if (isWithinBand(midpointY, metrics)) {
			lastMidpointY = midpointY;
			return;
		}

		if (
			lastMidpointY !== null &&
			isWithinBand(lastMidpointY, metrics, true) &&
			isWithinBand(midpointY, metrics, true)
		) {
			lastMidpointY = midpointY;
			return;
		}

		const targetScrollTop = computeTargetScroll(midpointY, metrics);
		if (Math.abs(targetScrollTop - metrics.scrollTop) < MIN_SCROLL_DISTANCE) {
			lastMidpointY = midpointY;
			return;
		}

		if (
			scrollContainer === ROOT_SCROLL_CONTAINER ||
			scrollContainer === document.documentElement ||
			scrollContainer === document.body
		) {
			window.scrollTo({ top: targetScrollTop, behavior: "smooth" });
		} else {
			scrollContainer.scrollTo({ top: targetScrollTop, behavior: "smooth" });
		}

		lastMidpointY = midpointY;
	}

	return {
		scrollToToken(token: TokenMapEntry): void {
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
			}
			rafId = requestAnimationFrame(() => {
				rafId = null;
				performScroll(token);
			});
		},
		reset(): void {
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
				rafId = null;
			}
			lastMidpointY = null;
			restoreAnchoring?.();
			restoreAnchoring = null;
			scrollContainer = null;
		},
		dispose(): void {
			this.reset();
		},
	};
}
