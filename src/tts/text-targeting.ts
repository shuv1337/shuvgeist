export interface ResolvedTtsTextTarget {
	text: string;
	truncated: boolean;
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
]);
const NOISY_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "NAV", "HEADER", "FOOTER"]);

function clamp(text: string, maxChars = 3000): ResolvedTtsTextTarget {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxChars) {
		return { text: normalized, truncated: false };
	}
	return {
		text: normalized.slice(0, maxChars).trimEnd(),
		truncated: true,
	};
}

function textFromNode(node: Node | null): string {
	if (!node) return "";
	if (node.nodeType === Node.TEXT_NODE) {
		return node.textContent || "";
	}
	if (node instanceof HTMLElement) {
		if (NOISY_TAGS.has(node.tagName) || node.closest("#shuvgeist-tts-overlay")) {
			return "";
		}
		return node.innerText || node.textContent || "";
	}
	return "";
}

function nearestReadableBlock(element: HTMLElement | null): HTMLElement | null {
	let current = element;
	while (current) {
		if (READABLE_BLOCK_TAGS.has(current.tagName)) {
			return current;
		}
		current = current.parentElement;
	}
	return element;
}

export function resolveTtsTextTarget(
	target: EventTarget | null,
	options: {
		maxChars?: number;
		selection?: Selection | null;
	} = {},
): ResolvedTtsTextTarget | null {
	const maxChars = options.maxChars ?? 3000;
	const selection = options.selection;
	if (selection?.toString().trim()) {
		return clamp(selection.toString(), maxChars);
	}

	const node = target instanceof Node ? target : null;
	const element = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
	if (!element) return null;
	if (element.closest("#shuvgeist-tts-overlay")) return null;
	if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable) {
		return null;
	}

	const directText = textFromNode(node);
	if (directText.trim().length >= 8) {
		return clamp(directText, maxChars);
	}

	const readableBlock = nearestReadableBlock(element);
	const blockText = textFromNode(readableBlock);
	if (blockText.trim().length < 8) {
		return null;
	}

	return clamp(blockText, maxChars);
}
