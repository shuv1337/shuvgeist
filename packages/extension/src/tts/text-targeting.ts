import { clampReadableText, type NormalizedText } from "./text-normalization.js";

export type ResolvedTtsTextTarget = NormalizedText;

export interface ResolvedTtsPageTarget extends NormalizedText {
	source: "selection" | "click";
	blocks: HTMLElement[];
	selection: Selection | null;
	targetSummary: {
		blockCount: number;
		textLength: number;
	};
}

const READABLE_BLOCK_TAGS = new Set([
	"P",
	"LI",
	"BLOCKQUOTE",
	"TD",
	"TH",
	"H1",
	"H2",
	"H3",
	"H4",
	"H5",
	"H6",
	"ARTICLE",
	"SECTION",
]);
const NOISY_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "NAV", "HEADER", "FOOTER", "ASIDE"]);
const OVERLAY_ROOT_SELECTORS = "#shuvgeist-tts-overlay, shuvgeist-tts-root";

function clamp(text: string, maxChars = 3000): NormalizedText {
	return clampReadableText(text, maxChars);
}

export function isTtsOverlayElement(element: Element | null): boolean {
	return Boolean(element?.closest(OVERLAY_ROOT_SELECTORS));
}

export function isTtsExcludedElement(element: HTMLElement | null): boolean {
	if (!element) return true;
	if (isTtsOverlayElement(element)) return true;
	if (NOISY_TAGS.has(element.tagName)) return true;
	return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable;
}

export function textFromNode(node: Node | null): string {
	if (!node) return "";
	if (node.nodeType === Node.TEXT_NODE) {
		return node.textContent || "";
	}
	if (node instanceof HTMLElement) {
		if (NOISY_TAGS.has(node.tagName) || isTtsOverlayElement(node)) {
			return "";
		}
		return node.innerText || node.textContent || "";
	}
	return "";
}

export function nearestReadableBlock(element: HTMLElement | null): HTMLElement | null {
	let current = element;
	while (current) {
		if (READABLE_BLOCK_TAGS.has(current.tagName)) {
			return current;
		}
		current = current.parentElement;
	}
	return element;
}

export function collectBlocksFromRange(range: Range): HTMLElement[] {
	const blocks = new Set<HTMLElement>();
	const commonAncestor = range.commonAncestorContainer;
	const container =
		commonAncestor.nodeType === Node.ELEMENT_NODE ? (commonAncestor as HTMLElement) : commonAncestor.parentElement;

	if (!container) {
		return [];
	}

	const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
		acceptNode: (node) => {
			const element = node as HTMLElement;
			if (NOISY_TAGS.has(element.tagName) || isTtsOverlayElement(element)) {
				return NodeFilter.FILTER_REJECT;
			}
			return READABLE_BLOCK_TAGS.has(element.tagName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
		},
	});

	let node: Node | null = walker.nextNode();
	while (node) {
		const element = node as HTMLElement;
		if (range.intersectsNode(element)) {
			blocks.add(element);
		}
		node = walker.nextNode();
	}

	if (blocks.size === 0) {
		const fallbackBlock = nearestReadableBlock(container);
		if (fallbackBlock) {
			blocks.add(fallbackBlock);
		}
	}

	return Array.from(blocks);
}

export function resolveTtsPageTarget(
	target: EventTarget | null,
	options: {
		maxChars?: number;
		selection?: Selection | null;
	} = {},
): ResolvedTtsPageTarget | null {
	const maxChars = options.maxChars ?? 3000;
	const selection = options.selection;
	const selectedText = selection?.toString().trim();
	if (selectedText) {
		const blocks =
			typeof selection?.rangeCount === "number" && selection.rangeCount > 0
				? collectBlocksFromRange(selection.getRangeAt(0))
				: [];
		const resolved = clamp(selectedText, maxChars);
		return {
			...resolved,
			source: "selection",
			blocks,
			selection: selection ?? null,
			targetSummary: {
				blockCount: blocks.length,
				textLength: resolved.text.length,
			},
		};
	}

	const node = target instanceof Node ? target : null;
	const element = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
	if (!element || isTtsExcludedElement(element)) {
		return null;
	}

	const directText = textFromNode(node);
	if (directText.trim().length >= 8) {
		const resolved = clamp(directText, maxChars);
		const block = nearestReadableBlock(element);
		return {
			...resolved,
			source: "click",
			blocks: block ? [block] : [],
			selection: null,
			targetSummary: {
				blockCount: block ? 1 : 0,
				textLength: resolved.text.length,
			},
		};
	}

	const readableBlock = nearestReadableBlock(element);
	if (!readableBlock || isTtsExcludedElement(readableBlock)) {
		return null;
	}

	const blockText = textFromNode(readableBlock);
	if (blockText.trim().length < 8) {
		return null;
	}

	const resolved = clamp(blockText, maxChars);
	return {
		...resolved,
		source: "click",
		blocks: [readableBlock],
		selection: null,
		targetSummary: {
			blockCount: 1,
			textLength: resolved.text.length,
		},
	};
}

export function resolveTtsTextTarget(
	target: EventTarget | null,
	options: {
		maxChars?: number;
		selection?: Selection | null;
	} = {},
): ResolvedTtsTextTarget | null {
	const resolved = resolveTtsPageTarget(target, options);
	if (!resolved) {
		return null;
	}

	return {
		text: resolved.text,
		truncated: resolved.truncated,
	};
}
