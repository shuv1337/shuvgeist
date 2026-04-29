import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageContent, Static, TextContent } from "@mariozechner/pi-ai";
import { Type } from "@mariozechner/pi-ai";
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

export interface ExtractImageScreenshotMetadata {
	imageWidth: number;
	imageHeight: number;
	cssWidth: number;
	cssHeight: number;
	devicePixelRatio: number;
	scale: number;
}

export interface ExtractImageDetails {
	mode: string;
	selector?: string;
	screenshot?: ExtractImageScreenshotMetadata;
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
async function fetchAndResizeImage(
	src: string,
	maxWidth: number,
): Promise<{
	image: ImageContent;
	imageWidth: number;
	imageHeight: number;
	sourceWidth: number;
	sourceHeight: number;
}> {
	let blob: Blob;

	if (src.startsWith("data:")) {
		blob = dataUrlToBlob(src);
	} else {
		const response = await fetch(src);
		if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
		blob = await response.blob();
	}

	const img = await createImageBitmap(blob);
	const sourceWidth = img.width;
	const sourceHeight = img.height;
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

	return {
		image: { type: "image", data: base64, mimeType: "image/webp" },
		imageWidth: w,
		imageHeight: h,
		sourceWidth,
		sourceHeight,
	};
}

async function getViewportMetadata(
	tabId: number,
	fallbackWidth: number,
	fallbackHeight: number,
): Promise<{ cssWidth: number; cssHeight: number; devicePixelRatio: number }> {
	const fallback = { cssWidth: fallbackWidth, cssHeight: fallbackHeight, devicePixelRatio: 1 };
	try {
		try {
			await chrome.userScripts.configureWorld({
				worldId: "shuvgeist-extract-image",
				messaging: true,
			});
		} catch {
			// Already configured.
		}
		const results = await chrome.userScripts.execute({
			js: [
				{
					code: "({ cssWidth: window.innerWidth, cssHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 })",
				},
			] as unknown as chrome.userScripts.UserScriptInjection["js"],
			target: { tabId, allFrames: false },
			world: "USER_SCRIPT",
			worldId: "shuvgeist-extract-image",
			injectImmediately: true,
		} as chrome.userScripts.UserScriptInjection);
		const value = results[0]?.result;
		if (!value || typeof value !== "object") return fallback;
		const candidate = value as Record<string, unknown>;
		const cssWidth =
			typeof candidate.cssWidth === "number" && candidate.cssWidth > 0 ? candidate.cssWidth : fallbackWidth;
		const cssHeight =
			typeof candidate.cssHeight === "number" && candidate.cssHeight > 0 ? candidate.cssHeight : fallbackHeight;
		const devicePixelRatio =
			typeof candidate.devicePixelRatio === "number" && candidate.devicePixelRatio > 0
				? candidate.devicePixelRatio
				: 1;
		return { cssWidth, cssHeight, devicePixelRatio };
	} catch {
		return fallback;
	}
}

async function captureScreenshot(
	maxWidth: number,
	windowId: number,
): Promise<{ image: ImageContent; metadata: ExtractImageScreenshotMetadata }> {
	const { tabId } = await resolveTabTarget({ windowId });
	const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
	const resized = await fetchAndResizeImage(dataUrl, maxWidth);
	const viewport = await getViewportMetadata(tabId, resized.sourceWidth, resized.sourceHeight);
	return {
		image: resized.image,
		metadata: {
			imageWidth: resized.imageWidth,
			imageHeight: resized.imageHeight,
			cssWidth: viewport.cssWidth,
			cssHeight: viewport.cssHeight,
			devicePixelRatio: viewport.devicePixelRatio,
			scale: resized.imageWidth / viewport.cssWidth,
		},
	};
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
			const screenshot = await captureScreenshot(maxWidth, this.windowId);
			details.screenshot = screenshot.metadata;
			content.push(screenshot.image);
			content.push({ type: "text", text: `Screenshot captured (max ${maxWidth}px width)` });
		} else if (args.mode === "selector") {
			if (!args.selector) throw new Error("selector is required for 'selector' mode");
			const { tabId } = await resolveTabTarget({ windowId: this.windowId });

			const info = await getImageInfoFromPage(tabId, args.selector);
			if (typeof info === "string") throw new Error(info);

			const image = await fetchAndResizeImage(info.src, maxWidth);
			content.push(image.image);
			content.push({
				type: "text",
				text: `Image extracted from "${args.selector}" (${info.width}x${info.height}, resized to max ${maxWidth}px)`,
			});
		}

		return { content, details };
	}
}
