import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { type Static, Type } from "@sinclair/typebox";
import { resolveTabTarget } from "./helpers/browser-target.js";

const EXTRACT_IMAGE_DESCRIPTION = `Extract images from the current page. Returns image data that you can see and analyze.

Modes:
- selector: Extract an image matching a CSS selector (e.g. "img.hero", "#logo", "img:nth-child(2)")
- screenshot: Capture the visible area of the current tab`;

const extractImageSchema = Type.Object({
	mode: Type.Union([Type.Literal("selector"), Type.Literal("screenshot")], {
		description: "How to extract: 'selector' for a specific image, 'screenshot' for visible tab",
	}),
	selector: Type.Optional(
		Type.String({ description: "CSS selector for the image element (required for 'selector' mode)" }),
	),
	maxWidth: Type.Optional(
		Type.Number({ description: "Max width to resize image to (default 800). Reduces token usage." }),
	),
});

export type ExtractImageParams = Static<typeof extractImageSchema>;

export interface ExtractImageDetails {
	mode: string;
	selector?: string;
}

/**
 * Get image info from the page via userScripts.
 * Only reads the src/currentSrc URL or data URL from the DOM.
 * Does NOT try to draw or fetch anything in page context.
 */
async function getImageInfoFromPage(
	tabId: number,
	selector: string,
): Promise<{ src: string; width: number; height: number } | string> {
	const code = `(async () => {
		const sel = ${JSON.stringify(selector)};
		const el = document.querySelector(sel);
		if (!el) return { success: false, error: 'No element found for selector: ' + sel };

		if (el instanceof HTMLImageElement) {
			if (!el.complete) {
				await new Promise((resolve, reject) => {
					el.onload = resolve;
					el.onerror = () => reject(new Error('Image failed to load'));
					setTimeout(() => reject(new Error('Image load timeout')), 10000);
				});
			}
			const src = el.currentSrc || el.src;
			if (!src) return { success: false, error: 'Image has no src' };
			return { success: true, src, width: el.naturalWidth, height: el.naturalHeight };
		}

		if (el instanceof HTMLCanvasElement) {
			try {
				const dataUrl = el.toDataURL('image/png');
				return { success: true, src: dataUrl, width: el.width, height: el.height };
			} catch (e) {
				return { success: false, error: 'Cannot read canvas: ' + e.message };
			}
		}

		// Check for background-image
		const bg = getComputedStyle(el).backgroundImage;
		if (bg && bg !== 'none') {
			const match = bg.match(/url\\(["']?(.+?)["']?\\)/);
			if (match) return { success: true, src: match[1], width: 0, height: 0 };
		}

		return { success: false, error: 'Element <' + el.tagName.toLowerCase() + '> is not an image, canvas, or element with background-image' };
	})()`;

	try {
		await chrome.userScripts.configureWorld({
			worldId: "shuvgeist-extract-image",
			messaging: true,
		});
	} catch {
		// Already configured
	}

	const results = await chrome.userScripts.execute({
		js: [{ code }],
		target: { tabId, allFrames: false },
		world: "USER_SCRIPT",
		worldId: "shuvgeist-extract-image",
		injectImmediately: true,
	} as any);

	const result = (results as any)?.[0]?.result;
	if (!result) return "Failed to execute script in page";
	if (!result.success) return result.error;
	return { src: result.src, width: result.width || 0, height: result.height || 0 };
}

/** Default WebP quality for token-efficient image encoding. */
const IMAGE_WEBP_QUALITY = 0.8;

/**
 * Convert a data URL to a Blob without fetch() (Chrome removed fetch on
 * data: URLs in recent versions).
 */
function dataUrlToBlob(dataUrl: string): Blob {
	const [header, b64] = dataUrl.split(",");
	const mime = header.match(/:(.*?);/)?.[1] || "application/octet-stream";
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes], { type: mime });
}

/**
 * Fetch an image URL from the extension context (has host_permissions),
 * resize it, and return as base64 WebP ImageContent.
 *
 * Uses WebP encoding at quality 80 for ~95% size reduction vs PNG,
 * significantly reducing token usage when images are sent to LLMs.
 */
async function fetchAndResizeImage(src: string, maxWidth: number): Promise<ImageContent> {
	let blob: Blob;

	if (src.startsWith("data:")) {
		blob = dataUrlToBlob(src);
	} else {
		const response = await fetch(src);
		if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
		blob = await response.blob();
	}

	const img = await createImageBitmap(blob);
	let w = img.width;
	let h = img.height;

	if (w > maxWidth) {
		h = Math.round(h * (maxWidth / w));
		w = maxWidth;
	}

	const canvas = new OffscreenCanvas(w, h);
	const ctx = canvas.getContext("2d")!;
	ctx.drawImage(img, 0, 0, w, h);

	const outBlob = await canvas.convertToBlob({ type: "image/webp", quality: IMAGE_WEBP_QUALITY });
	const reader = new FileReader();
	const base64 = await new Promise<string>((resolve) => {
		reader.onload = () => resolve((reader.result as string).split(",")[1]);
		reader.readAsDataURL(outBlob);
	});

	return { type: "image", data: base64, mimeType: "image/webp" };
}

async function captureScreenshot(maxWidth: number, windowId: number): Promise<ImageContent> {
	const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
	return fetchAndResizeImage(dataUrl, maxWidth);
}

export class ExtractImageTool implements AgentTool<typeof extractImageSchema, ExtractImageDetails> {
	name = "extract_image";
	label = "Extract Image";
	description = EXTRACT_IMAGE_DESCRIPTION;
	parameters = extractImageSchema;
	windowId?: number;

	async execute(
		_toolCallId: string,
		args: ExtractImageParams,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<ExtractImageDetails>> {
		const maxWidth = args.maxWidth || 800;
		const content: (TextContent | ImageContent)[] = [];
		const details: ExtractImageDetails = { mode: args.mode, selector: args.selector };

		if (args.mode === "screenshot") {
			if (!this.windowId) throw new Error("windowId not set on ExtractImageTool");
			const image = await captureScreenshot(maxWidth, this.windowId);
			content.push(image);
			content.push({ type: "text", text: `Screenshot captured (max ${maxWidth}px width)` });
		} else if (args.mode === "selector") {
			if (!args.selector) throw new Error("selector is required for 'selector' mode");
			const { tabId } = await resolveTabTarget({ windowId: this.windowId });

			const info = await getImageInfoFromPage(tabId, args.selector);
			if (typeof info === "string") throw new Error(info);

			const image = await fetchAndResizeImage(info.src, maxWidth);
			content.push(image);
			content.push({
				type: "text",
				text: `Image extracted from "${args.selector}" (${info.width}x${info.height}, resized to max ${maxWidth}px)`,
			});
		}

		return { content, details };
	}
}
