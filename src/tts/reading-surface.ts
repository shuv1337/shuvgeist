import { normalizeReadableText } from "./text-normalization.js";
import { collectBlocksFromRange, isTtsOverlayElement } from "./text-targeting.js";

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
const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

export function collectReadableBlocks(root: HTMLElement = document.body): HTMLElement[] {
	const blocks: HTMLElement[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
		acceptNode: (node) => {
			const element = node as HTMLElement;
			if (NOISY_TAGS.has(element.tagName) || isTtsOverlayElement(element)) {
				return NodeFilter.FILTER_REJECT;
			}
			if (!READABLE_BLOCK_TAGS.has(element.tagName)) {
				return NodeFilter.FILTER_SKIP;
			}
			const text = getVisibleText(element).trim();
			return text.length >= 8 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
		},
	});

	let node: Node | null = walker.nextNode();
	while (node) {
		blocks.push(node as HTMLElement);
		node = walker.nextNode();
	}

	return blocks;
}

function getVisibleText(element: HTMLElement): string {
	const style = window.getComputedStyle(element);
	if (style.display === "none" || style.visibility === "hidden") {
		return "";
	}
	return element.innerText || element.textContent || "";
}

function collectTextNodes(block: HTMLElement, range?: Range | null): Text[] {
	const texts: Text[] = [];
	const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => {
			const parent = node.parentElement;
			if (!parent) return NodeFilter.FILTER_REJECT;
			if (NOISY_TAGS.has(parent.tagName) || isTtsOverlayElement(parent)) {
				return NodeFilter.FILTER_REJECT;
			}
			if (range && !range.intersectsNode(node)) {
				return NodeFilter.FILTER_REJECT;
			}
			const text = node.textContent || "";
			return text.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
		},
	});

	let node: Node | null = walker.nextNode();
	while (node) {
		texts.push(node as Text);
		node = walker.nextNode();
	}

	return texts;
}

function getNodeSlice(node: Text, range?: Range | null): { text: string; startOffset: number } | null {
	const value = node.textContent || "";
	if (!value) {
		return null;
	}

	let startOffset = 0;
	let endOffset = value.length;

	if (range?.intersectsNode(node)) {
		if (range.startContainer === node) {
			startOffset = range.startOffset;
		}
		if (range.endContainer === node) {
			endOffset = range.endOffset;
		}
	}

	if (endOffset <= startOffset) {
		return null;
	}

	const text = value.slice(startOffset, endOffset);
	if (!text.trim()) {
		return null;
	}

	return { text, startOffset };
}

function extractWordMatches(text: string): Array<{ word: string; start: number; end: number }> {
	return Array.from(text.matchAll(WORD_PATTERN)).map((match) => ({
		word: match[0],
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length,
	}));
}

export function buildReadingSurface(options: {
	sessionId: string;
	blocks?: HTMLElement[];
	selection?: Selection | null;
	maxChars?: number;
}): PreparedReadingSurface | null {
	const { sessionId, maxChars = 3000 } = options;
	const selection = options.selection;
	const range = selection && selection.rangeCount > 0 && !selection.isCollapsed ? selection.getRangeAt(0) : null;

	let blocks = options.blocks;
	if ((!blocks || blocks.length === 0) && range) {
		blocks = collectBlocksFromRange(range);
	}
	if (!blocks || blocks.length === 0) {
		blocks = collectReadableBlocks();
	}
	if (blocks.length === 0) {
		return null;
	}

	const tokens: TokenMapEntry[] = [];
	const mutObservers: MutationObserver[] = [];
	let charOffset = 0;
	let tokenIndex = 0;
	let truncated = false;
	const activeBlocks: HTMLElement[] = [];

	for (const [blockId, block] of blocks.entries()) {
		const textNodes = collectTextNodes(block, range);
		if (textNodes.length === 0) {
			continue;
		}

		const blockStartTokenCount = tokens.length;
		for (const node of textNodes) {
			const slice = getNodeSlice(node, range);
			if (!slice) {
				continue;
			}

			for (const match of extractWordMatches(slice.text)) {
				const charStart = charOffset;
				const charEnd = charStart + match.word.length;
				if (charEnd > maxChars) {
					truncated = true;
					break;
				}

				tokens.push({
					blockId,
					tokenIndex,
					charStart,
					charEnd,
					startNode: node,
					startOffset: slice.startOffset + match.start,
					endNode: node,
					endOffset: slice.startOffset + match.end,
					dirty: false,
				});
				tokenIndex += 1;
				charOffset = charEnd + 1;
			}

			if (truncated) {
				break;
			}
		}

		if (tokens.length > blockStartTokenCount) {
			activeBlocks.push(block);
			const observer = new MutationObserver(() => {
				for (const token of tokens) {
					if (token.blockId === blockId) {
						token.dirty = true;
					}
				}
			});
			observer.observe(block, {
				childList: true,
				subtree: true,
				characterData: true,
			});
			mutObservers.push(observer);
		}

		if (truncated) {
			break;
		}
	}

	if (tokens.length === 0) {
		for (const observer of mutObservers) {
			observer.disconnect();
		}
		return null;
	}

	const text = normalizeReadableText(
		tokens.map((token) => token.startNode.textContent?.slice(token.startOffset, token.endOffset) || "").join(" "),
	);

	return {
		sessionId,
		text,
		truncated,
		tokens,
		blocks: activeBlocks,
		mutObservers,
	};
}

export function findTokenAtCharIndex(surface: PreparedReadingSurface, charIndex: number): TokenMapEntry | null {
	const { tokens } = surface;
	if (tokens.length === 0) {
		return null;
	}

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

export function findTokenForWord(surface: PreparedReadingSurface, word: string, afterIndex = -1): TokenMapEntry | null {
	const normalizedWord = normalizeReadableText(word)
		.toLowerCase()
		.replace(/[^\p{L}\p{N}'’_-]+/gu, "");
	for (let index = Math.max(0, afterIndex + 1); index < surface.tokens.length; index += 1) {
		const token = surface.tokens[index];
		if (token.dirty) {
			continue;
		}
		const tokenText = (token.startNode.textContent?.slice(token.startOffset, token.endOffset) || "")
			.toLowerCase()
			.replace(/[^\p{L}\p{N}'’_-]+/gu, "");
		if (tokenText === normalizedWord) {
			return token;
		}
	}
	return null;
}

export function disposeReadingSurface(surface: PreparedReadingSurface): void {
	for (const observer of surface.mutObservers) {
		observer.disconnect();
	}
	surface.mutObservers.length = 0;
	surface.tokens.length = 0;
	surface.blocks.length = 0;
}

export function hasDirtyTokens(surface: PreparedReadingSurface): boolean {
	return surface.tokens.some((token) => token.dirty);
}

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
		dirtyCount: surface.tokens.filter((token) => token.dirty).length,
	};
}
