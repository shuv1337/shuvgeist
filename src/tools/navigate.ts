import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { NAVIGATE_TOOL_DESCRIPTION } from "../prompts/prompts.js";
import { getShuvgeistStorage } from "../storage/app-storage.js";
import type { Skill } from "../storage/stores/skills-store.js";
import { formatSkills } from "../utils/format-skills.js";
import { resolveTabTarget } from "./helpers/browser-target.js";

// Track tool-initiated navigations to filter out duplicate navigation messages
let isNavigating = false;

export function isToolNavigating(): boolean {
	return isNavigating;
}

function markNavigationStart() {
	isNavigating = true;
}

function markNavigationEnd() {
	isNavigating = false;
}

// ============================================================================
// TYPES
// ============================================================================

const navigateSchema = Type.Object({
	url: Type.Optional(Type.String({ description: "URL to navigate to (in current tab or new tab if newTab is true)" })),
	newTab: Type.Optional(Type.Boolean({ description: "Set to true to open URL in a new tab instead of current tab" })),
	tabId: Type.Optional(Type.Number({ description: "Explicit tab ID to navigate instead of the active tab" })),
	listTabs: Type.Optional(Type.Boolean({ description: "Set to true to list all open tabs" })),
	switchToTab: Type.Optional(Type.Number({ description: "Tab ID to switch to (get IDs from listTabs)" })),
});

export type NavigateParams = Static<typeof navigateSchema>;

export interface TabInfo {
	id: number;
	url: string;
	title: string;
	active: boolean;
	favicon?: string;
}

export interface NavigateResult {
	finalUrl?: string;
	title?: string;
	favicon?: string;
	tabId?: number;
	skills?: Array<{ name: string; shortDescription: string; fullDetails?: Skill }>;
	tabs?: TabInfo[];
	switchedToTab?: number;
}

// ============================================================================
// TOOL
// ============================================================================

export class NavigateTool implements AgentTool<typeof navigateSchema, NavigateResult> {
	label = "Navigate";
	name = "navigate";
	description = NAVIGATE_TOOL_DESCRIPTION;
	parameters = navigateSchema;
	windowId?: number;

	constructor(options: { windowId?: number } = {}) {
		this.windowId = options.windowId;
	}

	async execute(
		_toolCallId: string,
		args: NavigateParams,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		if (signal?.aborted) {
			throw new Error("Navigation aborted");
		}

		// Handle list tabs action
		if ("listTabs" in args) {
			return this.listTabs();
		}

		// Handle switch tab action
		if ("switchToTab" in args && args.switchToTab !== undefined) {
			markNavigationStart();
			try {
				return await this.switchToTab(args.switchToTab);
			} finally {
				markNavigationEnd();
			}
		}

		// Get active tab for navigation actions
		const { tabId } = await resolveTabTarget({ windowId: this.windowId, tabId: args.tabId });

		let finalUrl: string;
		let targetTabId = tabId;

		markNavigationStart();
		try {
			if ("url" in args && args.url !== undefined) {
				// Check if opening in new tab
				if ("newTab" in args && args.newTab) {
					const newTab = await this.openInNewTab(args.url, signal);
					finalUrl = newTab.finalUrl;
					targetTabId = newTab.tabId;
				} else {
					finalUrl = await this.navigateToUrl(tabId, args.url, signal);
				}
			} else {
				throw new Error("Invalid navigation parameters");
			}
		} finally {
			markNavigationEnd();
		}

		// Get updated tab info using query (better cross-browser support)
		const updatedTabs = await chrome.tabs.query({});
		const updatedTab = updatedTabs.find((t: chrome.tabs.Tab) => t.id === targetTabId);
		const title = updatedTab?.title || "Untitled";
		const favicon = updatedTab?.favIconUrl;

		const { skills, skillsOutput } = await this.getSkillsForUrlSafe(finalUrl);

		const details: NavigateResult = {
			finalUrl,
			title,
			favicon,
			tabId: targetTabId,
			skills,
		};

		// Build output message
		let output = "";
		if ("newTab" in args && args.newTab) {
			output = `Opened in new tab: ${finalUrl} (tab ${targetTabId})\n`;
		} else {
			output = `Navigated to: ${finalUrl} (tab ${targetTabId})\n`;
		}

		output += `\n${skillsOutput}`;

		return { content: [{ type: "text", text: output }], details };
	}

	private async navigateToUrl(tabId: number, url: string, signal?: AbortSignal): Promise<string> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Aborted"));
				return;
			}

			let settled = false;

			const cleanup = () => {
				if (chrome.webNavigation?.onDOMContentLoaded) {
					chrome.webNavigation.onDOMContentLoaded.removeListener(webNavListener);
				}
				if (chrome.tabs?.onUpdated) {
					chrome.tabs.onUpdated.removeListener(tabUpdatedListener);
				}
				signal?.removeEventListener("abort", abortListener);
			};

			const settle = (action: () => void) => {
				if (settled) return;
				settled = true;
				cleanup();
				action();
			};

			// Primary signal: webNavigation.onDOMContentLoaded fires for http(s),
			// file, ftp, and most real navigations as soon as the DOM is parsed.
			const webNavListener = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
				if (details.tabId === tabId && details.frameId === 0) {
					settle(() => resolve(details.url));
				}
			};

			// Fallback signal: chrome.tabs.onUpdated fires for ALL URL schemes
			// (including data:, blob:, javascript:) which webNavigation skips.
			// We accept the navigation as complete when the tab transitions to
			// status === "complete".
			const tabUpdatedListener = (
				updatedTabId: number,
				changeInfo: chrome.tabs.OnUpdatedInfo,
				tab: chrome.tabs.Tab,
			) => {
				if (updatedTabId !== tabId) return;
				if (changeInfo.status === "complete") {
					settle(() => resolve(tab.url || url));
				}
			};

			const abortListener = () => {
				settle(() => reject(new Error("Aborted")));
			};

			if (signal) {
				signal.addEventListener("abort", abortListener);
			}

			chrome.webNavigation.onDOMContentLoaded.addListener(webNavListener);
			chrome.tabs.onUpdated.addListener(tabUpdatedListener);

			// Trigger navigation
			chrome.tabs.update(tabId, { url }).catch((err: Error) => {
				settle(() => reject(err));
			});
		});
	}

	private async openInNewTab(url: string, signal?: AbortSignal): Promise<{ finalUrl: string; tabId: number }> {
		if (signal?.aborted) {
			throw new Error("Aborted");
		}

		const newTab = await chrome.tabs.create({ url, active: true });

		if (!newTab.id) {
			throw new Error("Failed to create new tab");
		}
		const newTabId = newTab.id;

		// Wait for the tab to load. Same dual-listener race as navigateToUrl so
		// data:/blob:/javascript: URLs do not hang waiting for a webNavigation
		// event that never fires.
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Aborted"));
				return;
			}

			let settled = false;

			const cleanup = () => {
				if (chrome.webNavigation?.onDOMContentLoaded) {
					chrome.webNavigation.onDOMContentLoaded.removeListener(webNavListener);
				}
				if (chrome.tabs?.onUpdated) {
					chrome.tabs.onUpdated.removeListener(tabUpdatedListener);
				}
				signal?.removeEventListener("abort", abortListener);
			};

			const settle = (action: () => void) => {
				if (settled) return;
				settled = true;
				cleanup();
				action();
			};

			const webNavListener = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
				if (details.tabId === newTabId && details.frameId === 0) {
					settle(() => resolve({ finalUrl: details.url, tabId: newTabId }));
				}
			};

			const tabUpdatedListener = (
				updatedTabId: number,
				changeInfo: chrome.tabs.OnUpdatedInfo,
				tab: chrome.tabs.Tab,
			) => {
				if (updatedTabId !== newTabId) return;
				if (changeInfo.status === "complete") {
					settle(() => resolve({ finalUrl: tab.url || url, tabId: newTabId }));
				}
			};

			const abortListener = () => {
				settle(() => reject(new Error("Aborted")));
			};

			if (signal) {
				signal.addEventListener("abort", abortListener);
			}

			chrome.webNavigation.onDOMContentLoaded.addListener(webNavListener);
			chrome.tabs.onUpdated.addListener(tabUpdatedListener);
		});
	}

	private async listTabs(): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		const tabs = await chrome.tabs.query({});

		const tabInfos: TabInfo[] = tabs
			.filter(
				(t: chrome.tabs.Tab): t is chrome.tabs.Tab & { id: number; url: string } =>
					t.id !== undefined && t.url !== undefined,
			)
			.map((t: chrome.tabs.Tab & { id: number; url: string }) => ({
				id: t.id,
				url: t.url,
				title: t.title || "Untitled",
				active: t.active || false,
				favicon: t.favIconUrl,
			}));

		const details: NavigateResult = {
			tabs: tabInfos,
		};

		let output = `Found ${tabInfos.length} open tabs:\n`;
		for (const tab of tabInfos) {
			const activeMarker = tab.active ? " [ACTIVE]" : "";
			output += `  - Tab ${tab.id}: ${tab.title}${activeMarker}\n`;
			output += `    URL: ${tab.url}\n`;
		}

		return { content: [{ type: "text", text: output }], details };
	}

	private async switchToTab(
		tabId: number,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		// Ensure tabId is a number (in case it comes through as string)
		const numericTabId = typeof tabId === "string" ? parseInt(tabId, 10) : tabId;

		// Query for the tab to get its details
		const tabs = await chrome.tabs.query({});
		const tab = tabs.find((t: chrome.tabs.Tab) => t.id === numericTabId);

		if (!tab) {
			throw new Error(`Tab ${numericTabId} not found`);
		}

		// Activate the tab
		await chrome.tabs.update(numericTabId, { active: true });

		// Focus the window containing the tab
		if (tab.windowId) {
			await chrome.windows.update(tab.windowId, { focused: true });
		}

		const finalUrl = tab.url || "";
		const title = tab.title || "Untitled";
		const favicon = tab.favIconUrl;

		const { skills, skillsOutput } = await this.getSkillsForUrlSafe(finalUrl);

		const details: NavigateResult = {
			finalUrl,
			title,
			favicon,
			tabId: numericTabId,
			skills,
			switchedToTab: numericTabId,
		};

		let output = `Switched to tab ${numericTabId}: ${title}\n`;
		output += `URL: ${finalUrl}\n`;
		output += `\n${skillsOutput}`;

		return { content: [{ type: "text", text: output }], details };
	}

	private async getSkillsForUrlSafe(url?: string): Promise<{
		skills: Array<{ name: string; shortDescription: string; fullDetails?: Skill }>;
		skillsOutput: string;
	}> {
		if (!url) {
			return { skills: [], skillsOutput: "No matching skills found." };
		}

		try {
			const skillsRepo = getShuvgeistStorage().skills;
			const matchingSkills = await skillsRepo.getSkillsForUrl(url);
			const { newOrUpdated, unchanged, formattedText } = formatSkills(matchingSkills);
			const skills = [
				...newOrUpdated.map((s) => ({
					name: s.name,
					shortDescription: s.shortDescription,
					fullDetails: s,
				})),
				...unchanged.map((s) => ({
					name: s.name,
					shortDescription: s.shortDescription,
					fullDetails: s,
				})),
			];
			return { skills, skillsOutput: formattedText };
		} catch (error) {
			if (error instanceof Error && error.message.includes("AppStorage not initialized")) {
				return { skills: [], skillsOutput: "No matching skills found." };
			}
			throw error;
		}
	}
}
