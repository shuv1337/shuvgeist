/**
 * Page-local reading surface for TTS read-along.
 *
 * This module builds and maintains the mapping between synthesized text
 * character positions and actual DOM Text nodes. It lives entirely in the
 * page/userScript context and never crosses context boundaries.
 */

import { normalizeReadableText } from "./text-normalization.js";

export interface TokenMapEntry {
	blockId: number;
	tokenIndex: number;
	charStart: number;
	charEnd: number;
	startNode: Text;
	startOffset: number;
	endNode: Text;
	endOffset: number;
	dirty: boolean;
}

export interface PreparedReadingSurface {
	sessionId: string;
	text: string;
	truncated: boolean;
	tokens: TokenMapEntry[];
	blocks: HTMLElement[];
	mutObservers: MutationObserver[];
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
	"DIV",
]);

const NOISY_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "NAV", "HEADER", "FOOTER", "ASIDE"]);

/**
 * Collect all readable blocks within a root element.
 */
export function collectReadableBlocks(root: HTMLElement = document.body): HTMLElement[] {
	const blocks: HTMLElement[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
		acceptNode: (node) => {
			const el = node as HTMLElement;
			if (NOISY_TAGS.has(el.tagName) || el.closest("#shuvgeist-tts-overlay, shuvgeist-tts-root")) {
				return NodeFilter.FILTER_REJECT;
			}
			if (READABLE_BLOCK_TAGS.has(el.tagName)) {
				// Check if it has visible text content
				const text = getVisibleText(el).trim();
				if (text.length >= 8) {
					return NodeFilter.FILTER_ACCEPT;
				}
			}
			return NodeFilter.FILTER_SKIP;
		},
	});

	let node: Node | null = walker.nextNode();
	while (node) {
		blocks.push(node as HTMLElement);
		node = walker.nextNode();
	}

	return blocks;
}

/**
 * Get visible text from an element, excluding hidden elements.
 */
function getVisibleText(element: HTMLElement): string {
	const style = window.getComputedStyle(element);
	if (style.display === "none" || style.visibility === "hidden") {
		return "";
	}
	return element.innerText || "";
}

/**
 * Collect all text nodes within a block element.
 */
function collectTextNodes(block: HTMLElement): Text[] {
	const texts: Text[] = [];
	const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => {
			const parent = node.parentElement;
			if (!parent) return NodeFilter.FILTER_REJECT;
			if (NOISY_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
			const text = node.textContent || "";
			if (text.trim().length === 0) return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		},
	});

	let node: Node | null = walker.nextNode();
	while (node) {
		texts.push(node as Text);
		node = walker.nextNode();
	}

	return texts;
}

/**
 * Build a reading surface from blocks or selection.
 */
export function buildReadingSurface(options: {
	sessionId: string;
	blocks?: HTMLElement[];
	selection?: Selection | null;
	maxChars?: number;
}): PreparedReadingSurface | null {
	const { sessionId, maxChars = 3000 } = options;

	let blocks = options.blocks;
	let truncated = false;

	// If selection provided, try to get blocks from selection
	if (options.selection && !options.selection.isCollapsed) {
		const range = options.selection.getRangeAt(0);
		const selectedBlocks = getBlocksFromRange(range);
		if (selectedBlocks.length > 0) {
			blocks = selectedBlocks;
		}
	}

	// Collect blocks if not provided
	if (!blocks || blocks.length === 0) {
		blocks = collectReadableBlocks();
	}

	if (blocks.length === 0) {
		return null;
	}

	const tokens: TokenMapEntry[] = [];
	let charOffset = 0;
	const mutObservers: MutationObserver[] = [];

	for (let blockId = 0; blockId < blocks.length; blockId++) {
		const block = blocks[blockId];
		const textNodes = collectTextNodes(block);

		if (textNodes.length === 0) continue;

		// Build tokens for this block
		for (let nodeIdx = 0; nodeIdx < textNodes.length; nodeIdx++) {
			const node = textNodes[nodeIdx];
			const text = node.textContent || "";
			const words = splitIntoWords(text);

			let nodeOffset = 0;
			for (let wordIdx = 0; wordIdx < words.length; wordIdx++) {
				const word = words[wordIdx];
				const wordStart = text.indexOf(word, nodeOffset);
				if (wordStart === -1) continue;

				const wordEnd = wordStart + word.length;
				const charStart = charOffset;
				const charEnd = charStart + word.length;

				// Check max chars limit
				if (charEnd > maxChars) {
					truncated = true;
					break;
				}

				tokens.push({
					blockId,
					tokenIndex: wordIdx,
					charStart,
					charEnd,
					startNode: node,
					startOffset: wordStart,
					endNode: node,
					endOffset: wordEnd,
					dirty: false,
				});

				charOffset = charEnd + 1; // +1 for space between words
				nodeOffset = wordEnd;
			}

			if (truncated) break;
		}

		if (truncated) break;

		// Add block separator (space)
		charOffset++;

		// Setup mutation observer for this block
		const observer = new MutationObserver(() => {
			// Mark all tokens in this block as dirty
			tokens.forEach((token) => {
				if (token.blockId === blockId) {
					token.dirty = true;
				}
			});
		});

		observer.observe(block, {
			childList: true,
			subtree: true,
			characterData: true,
		});

		mutObservers.push(observer);
	}

	// Build the normalized text string
	const text = tokens.map((t) => t.startNode.textContent?.slice(t.startOffset, t.endOffset) || "").join(" ");

	return {
		sessionId,
		text: normalizeReadableText(text),
		truncated,
		tokens,
		blocks,
		mutObservers,
	};
}

/**
 * Split text into words for tokenization.
 */
function splitIntoWords(text: string): string[] {
	// Split on whitespace and punctuation, keeping words
	return text
		.replace(/[^\w\s'-]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 0);
}

/**
 * Get blocks that intersect with a range.
 */
function getBlocksFromRange(range: Range): HTMLElement[] {
	const blocks = new Set<HTMLElement>();
	const commonAncestor = range.commonAncestorContainer;

	// Get the parent element
	let container: HTMLElement | null;
	if (commonAncestor.nodeType === Node.ELEMENT_NODE) {
		container = commonAncestor as HTMLElement;
	} else {
		container = commonAncestor.parentElement;
	}

	if (!container) return [];

	// Walk through the range and collect blocks
	const treeWalker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
		acceptNode: (node) => {
			if (READABLE_BLOCK_TAGS.has((node as HTMLElement).tagName)) {
				return NodeFilter.FILTER_ACCEPT;
			}
			return NodeFilter.FILTER_SKIP;
		},
	});

	let node: Node | null = treeWalker.nextNode();
	while (node) {
		const el = node as HTMLElement;
		// Check if element intersects with range
		if (range.intersectsNode(el) || el.contains(range.startContainer) || el.contains(range.endContainer)) {
			blocks.add(el);
		}
		node = treeWalker.nextNode();
	}

	return Array.from(blocks);
}

/**
 * Find the token at a given character index.
 * Uses binary search for efficiency.
 */
export function findTokenAtCharIndex(surface: PreparedReadingSurface, charIndex: number): TokenMapEntry | null {
	const { tokens } = surface;
	if (tokens.length === 0) return null;

	let left = 0;
	let right = tokens.length - 1;

	while (left <= right) {
		const mid = Math.floor((left + right) / 2);
		const token = tokens[mid];

		if (charIndex >= token.charStart && charIndex < token.charEnd) {
			return token;
		}

		if (charIndex < token.charStart) {
			right = mid - 1;
		} else {
			left = mid + 1;
		}
	}

	return null;
}

/**
 * Find the best matching token for a word, accounting for normalization drift.
 */
export function findTokenForWord(surface: PreparedReadingSurface, word: string, afterIndex = 0): TokenMapEntry | null {
	const normalizedWord = normalizeReadableText(word).toLowerCase();
	const { tokens } = surface;

	// Search forward from afterIndex
	for (let i = afterIndex; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.dirty) continue;

		const tokenText = (token.startNode.textContent?.slice(token.startOffset, token.endOffset) || "")
			.toLowerCase()
			.replace(/[^\w]/g, "");

		if (tokenText === normalizedWord) {
			return token;
		}
	}

	return null;
}

/**
 * Dispose of a reading surface, cleaning up mutation observers.
 */
export function disposeReadingSurface(surface: PreparedReadingSurface): void {
	for (const observer of surface.mutObservers) {
		observer.disconnect();
	}
	surface.mutObservers.length = 0;
	surface.tokens.length = 0;
	surface.blocks.length = 0;
}

/**
 * Check if a reading surface has any dirty tokens.
 */
export function hasDirtyTokens(surface: PreparedReadingSurface): boolean {
	return surface.tokens.some((t) => t.dirty);
}

/**
 * Get statistics about a reading surface.
 */
export function getReadingSurfaceStats(surface: PreparedReadingSurface): {
	tokenCount: number;
	blockCount: number;
	charCount: number;
	dirtyCount: number;
} {
	return {
		tokenCount: surface.tokens.length,
		blockCount: surface.blocks.length,
		charCount: surface.text.length,
		dirtyCount: surface.tokens.filter((t) => t.dirty).length,
	};
}
