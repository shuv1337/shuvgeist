import { i18n, icon } from "@mariozechner/mini-lit";
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
import { Loader2, MousePointer2 } from "lucide";
import type { SelectElementParams, SelectElementResult } from "./ask-user-which-element.js";

// ============================================================================
// RENDERER
// ============================================================================

export const selectElementRenderer: ToolRenderer<SelectElementParams, SelectElementResult> = {
	render(
		params: SelectElementParams | undefined,
		result: ToolResultMessage<SelectElementResult> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		// Determine state
		const state = result ? (result.isError ? "error" : "complete") : params ? "inprogress" : "inprogress";

		// Create refs for collapsible section
		const detailsContentRef = createRef<HTMLDivElement>();
		const detailsChevronRef = createRef<HTMLSpanElement>();

		// With result: show element info or error
		if (result && !result.isError && result.details) {
			const el = result.details;

			return {
				content: html`
					<div>
						${renderCollapsibleHeader(
							state,
							MousePointer2,
							`Selected: <${el.tagName}>`,
							detailsContentRef,
							detailsChevronRef,
							false,
						)}
						<div
							${ref(detailsContentRef)}
							class="max-h-0 overflow-hidden transition-all duration-300 space-y-3"
						>
							<!-- CSS Selector -->
							<div>
								<div class="text-xs text-muted-foreground mb-1">CSS Selector</div>
								<div class="font-mono text-xs bg-muted px-2 py-1 rounded">
									${el.selector}
								</div>
							</div>

							<!-- XPath -->
							<div>
								<div class="text-xs text-muted-foreground mb-1">XPath</div>
								<div
									class="font-mono text-xs bg-muted px-2 py-1 rounded break-all"
								>
									${el.xpath}
								</div>
							</div>

							<!-- Attributes -->
							${
								Object.keys(el.attributes).length > 0
									? html`
										<div>
											<div class="text-xs text-muted-foreground mb-1">
												Attributes
											</div>
											<div class="text-xs space-y-1">
												${Object.entries(el.attributes).map(
													([key, value]) => html`
														<div class="flex gap-2">
															<span class="text-muted-foreground">${key}:</span>
															<span class="font-mono">${value}</span>
														</div>
													`,
												)}
											</div>
										</div>
									  `
									: ""
							}

							<!-- Text Content -->
							${
								el.text
									? html`
										<div>
											<div class="text-xs text-muted-foreground mb-1">
												Text Content
											</div>
											<div class="text-xs text-muted-foreground">
												${el.text.substring(0, 200)}${el.text.length > 200 ? "..." : ""}
											</div>
										</div>
									  `
									: ""
							}

							<!-- Bounding Box -->
							<div>
								<div class="text-xs text-muted-foreground mb-1">
									Position & Size
								</div>
								<div class="text-xs space-y-1">
									<div>
										Position: (${Math.round(el.boundingBox.x)},
										${Math.round(el.boundingBox.y)})
									</div>
									<div>
										Size: ${Math.round(el.boundingBox.width)}x${Math.round(el.boundingBox.height)}
									</div>
								</div>
							</div>

							<!-- Computed Styles (selected ones) -->
							${
								Object.keys(el.computedStyles).length > 0
									? html`
										<div>
											<div class="text-xs text-muted-foreground mb-1">
												Computed Styles
											</div>
											<div class="text-xs space-y-1">
												${Object.entries(el.computedStyles).map(
													([key, value]) => html`
														<div class="flex gap-2">
															<span class="text-muted-foreground">${key}:</span>
															<span class="font-mono">${value}</span>
														</div>
													`,
												)}
											</div>
										</div>
									  `
									: ""
							}

							<!-- Parent Chain -->
							${
								el.parentChain.length > 0
									? html`
										<div>
											<div class="text-xs text-muted-foreground mb-1">
												Parent Chain
											</div>
											<div class="text-xs font-mono text-muted-foreground">
												${el.parentChain.join(" > ")}
											</div>
										</div>
									  `
									: ""
							}
						</div>
					</div>
				`,
				isCustom: false,
			};
		}

		// Error state (aborted or failed)
		if (result?.isError) {
			const message = params?.message || "Click an element to select it";
			return {
				content: renderHeader(state, MousePointer2, message),
				isCustom: false,
			};
		}

		// Just params (waiting for user selection)
		if (params || isStreaming) {
			const message = params?.message || "Click an element to select it";
			return {
				content: html`
					<div class="my-2">
						<div
							class="inline-flex items-center gap-2 px-3 py-2 text-sm text-card-foreground bg-card border border-border rounded-lg max-w-full shadow-lg"
						>
							<div class="w-4 h-4 flex-shrink-0 flex items-center justify-center">
								${icon(Loader2, "sm", "animate-spin")}
							</div>
							<div class="w-4 h-4 flex-shrink-0 flex items-center justify-center">
								${icon(MousePointer2, "sm")}
							</div>
							<span class="truncate font-medium"
								>${i18n("Waiting for selection")}: ${message}</span
							>
						</div>
					</div>
				`,
				isCustom: true,
			};
		}

		// No params or result yet
		return {
			content: html`
				<div class="my-2">
					<div
						class="inline-flex items-center gap-2 px-3 py-2 text-sm text-card-foreground bg-card border border-border rounded-lg max-w-full shadow-lg"
					>
						<div class="w-4 h-4 flex-shrink-0 flex items-center justify-center">
							${icon(Loader2, "sm", "animate-spin")}
						</div>
						<div class="w-4 h-4 flex-shrink-0 flex items-center justify-center">
							${icon(MousePointer2, "sm")}
						</div>
						<span class="truncate font-medium"
							>${i18n("Preparing element selector...")}</span
						>
					</div>
				</div>
			`,
			isCustom: true,
		};
	},
};

// Auto-register the renderer
export function registerAskUserWhichElementRenderer() {
	registerToolRenderer("ask_user_which_element", selectElementRenderer);
}
