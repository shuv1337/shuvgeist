import { i18n, icon } from "@mariozechner/mini-lit";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { registerToolRenderer, type ToolRenderer, type ToolRenderResult } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { Loader2 } from "lucide";
import { SkillPill } from "../components/SkillPill.js";
import { TabPill } from "../components/TabPill.js";
import type { NavigateParams, NavigateResult } from "./navigate.js";

// ============================================================================
// RENDERER
// ============================================================================

function getFallbackFavicon(url: string): string {
	try {
		const urlObj = new URL(url);
		return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
	} catch {
		return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23999' d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z'/%3E%3C/svg%3E";
	}
}

export const navigateRenderer: ToolRenderer<NavigateParams, NavigateResult> = {
	render(
		params: NavigateParams | undefined,
		result: ToolResultMessage<NavigateResult> | undefined,
		_isStreaming?: boolean,
	): ToolRenderResult {
		// Loading state (params but no result)
		if (params && !result) {
			let displayText = "";
			if ("url" in params && params.url) {
				displayText = params.url;
			} else if ("listTabs" in params) {
				displayText = "Listing tabs...";
			} else if ("switchToTab" in params) {
				displayText = `Switching to tab ${params.switchToTab}`;
			}

			return {
				content: html`
					<div class="my-2">
						<div
							class="inline-flex items-center gap-2 px-3 py-2 text-sm text-card-foreground bg-card border border-border rounded-lg max-w-full shadow-lg"
						>
							<div class="w-4 h-4 flex-shrink-0 flex items-center justify-center">
								${icon(Loader2, "sm", "animate-spin")}
							</div>
							<span class="truncate font-medium">${i18n("Navigating to")} ${displayText}</span>
						</div>
					</div>
				`,
				isCustom: true,
			};
		}

		// Complete state (with result)
		if (result && !result.isError && result.details) {
			const { finalUrl, title, favicon, skills, tabs } = result.details;

			// Handle tab listing
			if (tabs) {
				return {
					content: html`
						<div class="flex items-center gap-2 flex-wrap">
							<span class="text-sm text-muted-foreground">${i18n("Open tabs")}</span>
							${tabs.map((tab) => TabPill(tab, true))}
						</div>
					`,
					isCustom: false,
				};
			}

			// Handle navigation/switch results
			if (finalUrl && title) {
				const faviconUrl = favicon || getFallbackFavicon(finalUrl);

				// Convert skills to Skill objects for SkillPill
				// Use fullDetails if available (for new/updated skills), otherwise create minimal skill
				const skillObjects = (skills || []).map((s) =>
					s.fullDetails
						? s.fullDetails
						: {
								name: s.name,
								shortDescription: s.shortDescription,
								description: "",
								examples: "",
								library: "",
								domainPatterns: [],
								createdAt: new Date().toISOString(),
								lastUpdated: new Date().toISOString(),
							},
				);

				return {
					content: html`
						<div class="my-2 space-y-2">
							<button
								class="inline-flex items-center gap-2 px-3 py-2 text-sm text-card-foreground bg-card border border-border rounded-lg hover:bg-accent/50 transition-colors max-w-full cursor-pointer shadow-lg"
								@click=${() => chrome.tabs.create({ url: finalUrl })}
								title="${i18n("Click to open")}: ${finalUrl}"
							>
								<img src="${faviconUrl}" alt="" class="w-4 h-4 flex-shrink-0" />
								<span class="truncate font-medium">${title}</span>
							</button>
							${
								skillObjects.length > 0
									? html`
										<div class="flex flex-wrap gap-2">
											${skillObjects.map((s) => SkillPill(s, true))}
										</div>
									  `
									: ""
							}
						</div>
					`,
					isCustom: true,
				};
			}
		}

		// Error state
		if (result?.isError) {
			const errorText = result.content.find((c) => c.type === "text")?.text || "Unknown error";
			return {
				content: html`
					<div class="my-2">
						<div class="text-sm text-destructive">${errorText}</div>
					</div>
				`,
				isCustom: true,
			};
		}

		// Waiting state
		return {
			content: html`<div class="my-2 text-sm text-muted-foreground">${i18n("Waiting...")}</div>`,
			isCustom: true,
		};
	},
};

// Auto-register renderer
registerToolRenderer("navigate", navigateRenderer);
