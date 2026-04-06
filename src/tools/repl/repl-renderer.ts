import { i18n } from "@mariozechner/mini-lit";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import {
	type Attachment,
	registerToolRenderer,
	renderCollapsibleHeader,
	renderHeader,
	type ToolRenderer,
	type ToolRenderResult,
} from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Code } from "lucide";
import type { ReplParams, ReplResult } from "./repl.js";

export const javascriptReplRenderer: ToolRenderer<ReplParams, ReplResult> = {
	render(
		params: ReplParams | undefined,
		result: ToolResultMessage<ReplResult> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		// Determine status
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";

		// Create refs for collapsible code section
		const codeContentRef = createRef<HTMLDivElement>();
		const codeChevronRef = createRef<HTMLSpanElement>();

		// With result: show params + result
		if (result && params) {
			const output = result.content.find((c) => c.type === "text")?.text || "";
			const files = result.details?.files || [];

			const attachments: Attachment[] = files.map((f, i) => {
				// Decode base64 content for text files to show in overlay
				let extractedText: string | undefined;
				const isTextBased =
					f.mimeType?.startsWith("text/") ||
					f.mimeType === "application/json" ||
					f.mimeType === "application/javascript" ||
					f.mimeType?.includes("xml");

				if (isTextBased && f.contentBase64) {
					try {
						extractedText = atob(f.contentBase64);
					} catch (e) {
						console.warn("Failed to decode base64 content for", f.fileName);
					}
				}

				return {
					id: `repl-${Date.now()}-${i}`,
					type: f.mimeType?.startsWith("image/") ? "image" : "document",
					fileName: f.fileName || `file-${i}`,
					mimeType: f.mimeType || "application/octet-stream",
					size: f.size ?? 0,
					content: f.contentBase64,
					preview: f.mimeType?.startsWith("image/") ? f.contentBase64 : undefined,
					extractedText,
				};
			});

			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, Code, params.title ? params.title : "Executing JavaScript", codeContentRef, codeChevronRef, false)}
						<div ${ref(codeContentRef)} class="max-h-0 overflow-hidden transition-all duration-300 space-y-3">
							<code-block .code=${params.code || ""} language="javascript"></code-block>
							${output ? html`<console-block .content=${output} .variant=${result.isError ? "error" : "default"}></console-block>` : ""}
						</div>
						${
							attachments.length
								? html`<div class="flex flex-wrap gap-2 mt-3">
									${attachments.map((att) => html`<attachment-tile .attachment=${att}></attachment-tile>`)}
							  </div>`
								: ""
						}
					</div>
				`,
				isCustom: false,
			};
		}

		// Just params (streaming or waiting for result)
		if (params) {
			return {
				content: html`
					<div>
						${renderCollapsibleHeader(state, Code, params.title ? params.title : "Executing JavaScript", codeContentRef, codeChevronRef, false)}
						<div ${ref(codeContentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
							${params.code ? html`<code-block .code=${params.code} language="javascript"></code-block>` : ""}
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// No params or result yet
		return { content: renderHeader(state, Code, i18n("Preparing JavaScript...")), isCustom: false };
	},
};

// Auto-register the renderer (using "repl" name)
export function registerReplRenderer() {
	registerToolRenderer("repl", javascriptReplRenderer);
}
