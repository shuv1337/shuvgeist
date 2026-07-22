// ============================================================================
// ELEMENT -> ATTACHMENT SERIALIZATION
//
// Converts an `ElementInfo` captured by the element picker into a
// `type: "document"` Attachment that rides along with the next user message.
//
// The model consumes the JSON payload via `extractedText` through
// pi-web-ui's `convertAttachments()`. `content` (base64) is populated for
// parity with PDF/DOCX attachments so the AttachmentOverlay can preview the
// raw payload — the LLM path does not read it.
// ============================================================================

import type { Attachment } from "@shuv1337/pi-web-ui";
import type { ElementInfo } from "./element-picker.js";

// Curated allowlist of computed styles to forward to the model. Anything not
// in this set is dropped by `pruneComputedStyles`. Keep this stable: the
// agent-tool path still receives the raw ElementInfo and is unaffected.
const COMPUTED_STYLE_ALLOWLIST = [
	"display",
	"position",
	"width",
	"height",
	"margin",
	"padding",
	"border",
	"color",
	"backgroundColor",
	"fontFamily",
	"fontSize",
	"fontWeight",
	"lineHeight",
	"textAlign",
	"opacity",
	"zIndex",
	"overflow",
	"visibility",
	"cursor",
	"boxSizing",
] as const;

const HTML_MAX = 4096;
const TEXT_MAX = 1000;
const PARENT_CHAIN_MAX = 6;
const TRUNCATION_MARKER = "<!-- [truncated] -->";

// ----------------------------------------------------------------------------
// SANITIZERS
// ----------------------------------------------------------------------------

/**
 * Turn a selector / tag into a filesystem-safe slug. Selectors contain
 * characters invalid in filenames (`/`, `:`, `[`, `]`, `#`, `"`, spaces);
 * this keeps AttachmentTile's 10-char truncation readable.
 */
function sanitizeFileNameSlug(info: ElementInfo): string {
	const raw = info.selector || info.tagName || "element";
	const slug = raw
		.replace(/[^a-zA-Z0-9._-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 64);
	return slug || "element";
}

/**
 * UTF-8-safe base64. `btoa()` throws on non-ASCII (emoji, CJK, em-dash, etc.),
 * which is common in real page text.
 */
function utf8ToBase64(s: string): string {
	const bytes = new TextEncoder().encode(s);
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.substring(0, max);
}

function truncateHtml(s: string): string {
	if (s.length <= HTML_MAX) return s;
	// If the overlay already marked it, avoid a double marker.
	if (s.endsWith(TRUNCATION_MARKER)) return s.length > HTML_MAX ? s.substring(0, HTML_MAX) + TRUNCATION_MARKER : s;
	return `${s.substring(0, HTML_MAX)}${TRUNCATION_MARKER}`;
}

function pruneComputedStyles(styles: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of COMPUTED_STYLE_ALLOWLIST) {
		const v = styles[key];
		if (typeof v === "string" && v.length > 0) {
			out[key] = v;
		}
	}
	return out;
}

// ----------------------------------------------------------------------------
// PUBLIC API
// ----------------------------------------------------------------------------

export interface ElementAttachmentContext {
	url: string;
	title?: string;
}

export function elementToAttachment(info: ElementInfo, context: ElementAttachmentContext): Attachment {
	const payload = {
		kind: "inspected-element",
		page: {
			url: context.url,
			title: context.title,
		},
		element: {
			selector: info.selector,
			xpath: info.xpath,
			tagName: info.tagName,
			text: truncate(info.text || "", TEXT_MAX),
			boundingBox: info.boundingBox,
			attributes: info.attributes,
			computedStyles: pruneComputedStyles(info.computedStyles || {}),
			parentChain: (info.parentChain || []).slice(-PARENT_CHAIN_MAX),
			html: truncateHtml(info.html || ""),
		},
	};

	const extractedText = JSON.stringify(payload, null, 2);
	const slug = sanitizeFileNameSlug(info);
	const fileName = `${slug}.json`;

	const id = `element_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

	return {
		id,
		type: "document",
		fileName,
		mimeType: "application/json",
		size: extractedText.length,
		content: utf8ToBase64(extractedText),
		extractedText,
	};
}
