import type { ToolResultMessage } from "@mariozechner/pi-ai";
import {
	registerToolRenderer,
	renderCollapsibleHeader,
	renderHeader,
	type ToolRenderer,
	type ToolRenderResult,
} from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Bug } from "lucide";
import type { DebuggerParams, DebuggerResult } from "./debugger.js";

export const debuggerRenderer: ToolRenderer<DebuggerParams, DebuggerResult> = {
	render(
		params: DebuggerParams | undefined,
		result: ToolResultMessage<DebuggerResult> | undefined,
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
			const title = params.action === "cookies" ? "Get Cookies" : "MAIN World";

			return {
				content: html`
				<div>
					${renderCollapsibleHeader(state, Bug, title, codeContentRef, codeChevronRef, false)}
					<div ${ref(codeContentRef)} class="max-h-0 overflow-hidden transition-all duration-300 space-y-3">
						${params.action === "eval" && params.code ? html`<code-block .code=${params.code} language="javascript"></code-block>` : ""}
						${output ? html`<console-block .content=${output} .variant=${result.isError ? "error" : "default"}></console-block>` : ""}
					</div>
				</div>
			`,
				isCustom: false,
			};
		}

		// Just params (streaming or waiting for result)
		if (params) {
			const title = params.action === "cookies" ? "Getting Cookies" : "MAIN World";

			return {
				content: html`
				<div>
					${renderCollapsibleHeader(state, Bug, title, codeContentRef, codeChevronRef, false)}
					<div ${ref(codeContentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						${params.action === "eval" && params.code ? html`<code-block .code=${params.code} language="javascript"></code-block>` : ""}
					</div>
				</div>
			`,
				isCustom: false,
			};
		}

		// No params or result yet
		return {
			content: renderHeader(state, Bug, "Preparing debugger..."),
			isCustom: false,
		};
	},
};

// Auto-register the renderer
registerToolRenderer("debugger", debuggerRenderer);
