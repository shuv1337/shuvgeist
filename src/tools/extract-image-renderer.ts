import type { ImageContent, ToolResultMessage } from "@mariozechner/pi-ai";
import { registerToolRenderer, renderHeader, type ToolRenderer, type ToolRenderResult } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { Image as ImageIcon } from "lucide";
import type { ExtractImageDetails, ExtractImageParams } from "./extract-image.js";

const extractImageRenderer: ToolRenderer<ExtractImageParams, ExtractImageDetails> = {
	render(
		params: ExtractImageParams | undefined,
		result: ToolResultMessage<ExtractImageDetails> | undefined,
	): ToolRenderResult {
		const mode = params?.mode || "unknown";
		const selector = params?.selector || "";
		const label = mode === "screenshot" ? "Screenshot" : `Image: ${selector}`;
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";

		const hasImage = result?.content?.some((c) => c.type === "image");

		return {
			content: html`
				${renderHeader(state, ImageIcon, label)}
				${
					hasImage
						? html`<div class="p-2">
								${result?.content
									?.filter((c) => c.type === "image")
									.map(
										(c) =>
											html`<img
												src="data:${(c as ImageContent).mimeType};base64,${(c as ImageContent).data}"
												class="max-w-full rounded"
											/>`,
									)}
							</div>`
						: ""
				}
			`,
			isCustom: false,
		};
	},
};

export function registerExtractImageRenderer() {
	registerToolRenderer("extract_image", extractImageRenderer);
}
