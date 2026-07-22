import type { AgentTool } from "@shuv1337/pi-agent-core";
import { type Static, Type } from "@shuv1337/pi-ai";
import { NAVIGATE_TOOL_DESCRIPTION } from "../prompts/prompts.js";
import { getShuvgeistStorage } from "../storage/app-storage.js";
import type { Skill } from "../storage/stores/skills-store.js";
import { formatSkills } from "../utils/format-skills.js";
import { ShownSkillsState } from "../utils/shown-skills.js";
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

const closeTabFilterSchema = Type.Object({
	titleIncludes: Type.Optional(Type.String({ description: "Close tabs whose title contains this substring" })),
	titlePattern: Type.Optional(Type.String({ description: "Close tabs whose title matches this JS RegExp source" })),
	urlIncludes: Type.Optional(Type.String({ description: "Close tabs whose URL contains this substring" })),
	urlPattern: Type.Optional(Type.String({ description: "Close tabs whose URL matches this JS RegExp source" })),
	windowId: Type.Optional(Type.Number({ description: "Only close tabs in this window" })),
	includePinned: Type.Optional(Type.Boolean({ description: "Include pinned tabs (default false for filters)" })),
	includeProtected: Type.Optional(
		Type.Boolean({ description: "Include chrome:// and extension pages (default false for filters)" }),
	),
});

const navigateSchema = Type.Object({
	url: Type.Optional(Type.String({ description: "URL to navigate to (in current tab or new tab if newTab is true)" })),
	newTab: Type.Optional(Type.Boolean({ description: "Set to true to open URL in a new tab instead of current tab" })),
	tabId: Type.Optional(Type.Number({ description: "Explicit tab ID to navigate instead of the active tab" })),
	listTabs: Type.Optional(Type.Boolean({ description: "Set to true to list all open tabs" })),
	switchToTab: Type.Optional(Type.Number({ description: "Tab ID to switch to (get IDs from listTabs)" })),
	closeTab: Type.Optional(Type.Number({ description: "Close a single tab by Chrome tab ID" })),
	closeTabs: Type.Optional(Type.Array(Type.Number(), { description: "Close multiple tabs by Chrome tab IDs" })),
	closeTabFilter: Type.Optional(closeTabFilterSchema),
	dryRun: Type.Optional(
		Type.Boolean({ description: "When true with close ops, report what would close without removing tabs" }),
	),
	requireMatch: Type.Optional(
		Type.Boolean({ description: "When true, treat zero closed tabs as failure (ok: false)" }),
	),
	listWindows: Type.Optional(Type.Boolean({ description: "Set to true to list browser windows" })),
	closeWindow: Type.Optional(Type.Number({ description: "Close a browser window by Chrome window ID" })),
});

export type NavigateParams = Static<typeof navigateSchema>;

export interface TabInfo {
	id: number;
	url: string;
	title: string;
	active: boolean;
	favicon?: string;
	windowId: number;
	index: number;
	pinned: boolean;
	status?: string;
}

export interface WindowInfo {
	id: number;
	focused: boolean;
	type?: string;
	tabCount: number;
}

export interface CloseSkipInfo {
	tabId?: number;
	windowId?: number;
	reason: string;
	title?: string;
	url?: string;
}

export interface NavigateResult {
	finalUrl?: string;
	title?: string;
	favicon?: string;
	tabId?: number;
	skills?: Array<{ name: string; shortDescription: string; fullDetails?: Skill }>;
	tabs?: TabInfo[];
	switchedToTab?: number;
	windows?: WindowInfo[];
	closedTabIds?: number[];
	closedWindowIds?: number[];
	skipped?: CloseSkipInfo[];
	dryRun?: boolean;
	/** false when explicit close ids failed, requireMatch found nothing, or window close failed */
	ok?: boolean;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Filter closes skip "browser chrome" URLs by default.
 * Bare about:blank is intentionally not protected so agents can clean blank tabs
 * via --title-match / --url-match without --include-protected.
 */
function isProtectedUrl(url: string | undefined): boolean {
	if (!url) return false;
	if (url === "about:blank" || url === "about:blank/") return false;
	return (
		url.startsWith("chrome://") ||
		url.startsWith("chrome-extension://") ||
		url.startsWith("edge://") ||
		url.startsWith("about:") ||
		url.startsWith("devtools://") ||
		url.startsWith("chrome-search://") ||
		url.startsWith("brave://")
	);
}

function compilePattern(source: string | undefined, label: string): RegExp | undefined {
	if (!source) return undefined;
	try {
		return new RegExp(source);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Invalid ${label}: ${message}`);
	}
}

function tabToInfo(t: chrome.tabs.Tab & { id: number }): TabInfo {
	return {
		id: t.id,
		url: t.url || "",
		title: t.title || "Untitled",
		active: t.active || false,
		favicon: t.favIconUrl,
		windowId: t.windowId,
		index: t.index,
		pinned: t.pinned || false,
		status: t.status,
	};
}

function hasTabCloseAction(args: NavigateParams): boolean {
	return (
		args.closeTab !== undefined ||
		(args.closeTabs !== undefined && args.closeTabs.length > 0) ||
		args.closeTabFilter !== undefined
	);
}

function hasCloseAction(args: NavigateParams): boolean {
	return hasTabCloseAction(args) || args.closeWindow !== undefined;
}

function countPrimaryActions(args: NavigateParams): number {
	let count = 0;
	if ("listTabs" in args && args.listTabs) count++;
	if ("listWindows" in args && args.listWindows) count++;
	if ("switchToTab" in args && args.switchToTab !== undefined) count++;
	// Tab close and window close are distinct primary actions (cannot combine).
	if (hasTabCloseAction(args)) count++;
	if (args.closeWindow !== undefined) count++;
	if ("url" in args && args.url !== undefined) count++;
	return count;
}

// ============================================================================
// TOOL
// ============================================================================

export interface NavigateToolOptions {
	windowId?: number;
	shownSkillsState?: ShownSkillsState;
}

export class NavigateTool implements AgentTool<typeof navigateSchema, NavigateResult> {
	label = "Navigate";
	name = "navigate";
	description = NAVIGATE_TOOL_DESCRIPTION;
	parameters = navigateSchema;
	windowId?: number;
	private readonly shownSkillsState: ShownSkillsState;

	constructor(options: NavigateToolOptions = {}) {
		this.windowId = options.windowId;
		this.shownSkillsState = options.shownSkillsState ?? new ShownSkillsState();
	}

	async execute(
		_toolCallId: string,
		args: NavigateParams,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		if (signal?.aborted) {
			throw new Error("Navigation aborted");
		}

		if (countPrimaryActions(args) > 1) {
			throw new Error(
				"Invalid navigation parameters: listTabs, listWindows, switchToTab, closeTab/closeTabs/closeTabFilter/closeWindow, and url are mutually exclusive",
			);
		}

		// Precedence: listTabs > listWindows > switchToTab > close tabs/window > url
		// (listWindows is phase-D companion; mutually exclusive with other primary actions)
		if (args.listTabs) {
			return this.listTabs();
		}

		if (args.listWindows) {
			return this.listWindows();
		}

		if ("switchToTab" in args && args.switchToTab !== undefined) {
			markNavigationStart();
			try {
				return await this.switchToTab(args.switchToTab);
			} finally {
				markNavigationEnd();
			}
		}

		if (args.closeWindow !== undefined) {
			return this.closeWindowById(args.closeWindow, { dryRun: !!args.dryRun, requireMatch: !!args.requireMatch });
		}

		if (hasTabCloseAction(args)) {
			return this.closeTabsAction(args);
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

		const newTab = await chrome.tabs.create({
			url,
			active: true,
			...(typeof this.windowId === "number" && this.windowId > 0 ? { windowId: this.windowId } : {}),
		});

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

	private async collectWindowsSummary(tabs: TabInfo[]): Promise<WindowInfo[]> {
		const countByWindow = new Map<number, number>();
		for (const tab of tabs) {
			countByWindow.set(tab.windowId, (countByWindow.get(tab.windowId) ?? 0) + 1);
		}

		let chromeWindows: chrome.windows.Window[] = [];
		try {
			chromeWindows = await chrome.windows.getAll({ populate: false });
		} catch {
			// Some environments may lack windows API; fall back to tab-derived summary.
			return [...countByWindow.entries()].map(([id, tabCount]) => ({
				id,
				focused: false,
				tabCount,
			}));
		}

		const summary: WindowInfo[] = chromeWindows
			.filter((w): w is chrome.windows.Window & { id: number } => typeof w.id === "number")
			.map((w) => ({
				id: w.id,
				focused: !!w.focused,
				type: w.type,
				tabCount: countByWindow.get(w.id) ?? 0,
			}));

		// Include any windowIds seen on tabs but missing from getAll (edge cases).
		for (const [id, tabCount] of countByWindow) {
			if (!summary.some((w) => w.id === id)) {
				summary.push({ id, focused: false, tabCount });
			}
		}

		return summary;
	}

	private async listTabs(): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		const tabs = await chrome.tabs.query({});

		const tabInfos: TabInfo[] = tabs
			.filter((t: chrome.tabs.Tab): t is chrome.tabs.Tab & { id: number } => t.id !== undefined)
			.map((t) => tabToInfo(t));

		const windows = await this.collectWindowsSummary(tabInfos);

		const details: NavigateResult = {
			tabs: tabInfos,
			windows,
		};

		let output = `Found ${tabInfos.length} open tabs:\n`;
		for (const tab of tabInfos) {
			const activeMarker = tab.active ? " [ACTIVE]" : "";
			const pinnedMarker = tab.pinned ? " [PINNED]" : "";
			output += `  - Tab ${tab.id} (window ${tab.windowId}, index ${tab.index}): ${tab.title}${activeMarker}${pinnedMarker}\n`;
			output += `    URL: ${tab.url}\n`;
		}
		if (windows.length > 0) {
			output += `\nWindows (${windows.length}):\n`;
			for (const w of windows) {
				const focused = w.focused ? " [FOCUSED]" : "";
				output += `  - Window ${w.id}: ${w.tabCount} tab(s)${focused}${w.type ? ` type=${w.type}` : ""}\n`;
			}
		}

		return { content: [{ type: "text", text: output }], details };
	}

	private async listWindows(): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		const tabs = await chrome.tabs.query({});
		const tabInfos: TabInfo[] = tabs
			.filter((t: chrome.tabs.Tab): t is chrome.tabs.Tab & { id: number } => t.id !== undefined)
			.map((t) => tabToInfo(t));
		const windows = await this.collectWindowsSummary(tabInfos);

		const details: NavigateResult = { windows, tabs: tabInfos };
		let output = `Found ${windows.length} windows:\n`;
		for (const w of windows) {
			const focused = w.focused ? " [FOCUSED]" : "";
			output += `  - Window ${w.id}: ${w.tabCount} tab(s)${focused}${w.type ? ` type=${w.type}` : ""}\n`;
		}
		return { content: [{ type: "text", text: output }], details };
	}

	private async closeWindowById(
		windowId: number,
		options: { dryRun?: boolean; requireMatch?: boolean },
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		const skipped: CloseSkipInfo[] = [];
		const closedWindowIds: number[] = [];
		const wouldCloseTabs: number[] = [];

		let win: chrome.windows.Window | undefined;
		try {
			win = await chrome.windows.get(windowId, { populate: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			skipped.push({ windowId, reason: message || `No window with id ${windowId}` });
			const remaining = await this.listTabsQuiet();
			const windows = await this.collectWindowsSummary(remaining);
			const details: NavigateResult = {
				closedWindowIds: [],
				closedTabIds: [],
				skipped,
				dryRun: !!options.dryRun,
				ok: false,
				tabs: remaining,
				windows,
			};
			return {
				content: [{ type: "text", text: `Window ${windowId} not found` }],
				details,
			};
		}

		const tabs = (win.tabs ?? []).filter((t): t is chrome.tabs.Tab & { id: number } => t.id !== undefined);
		for (const t of tabs) {
			wouldCloseTabs.push(t.id);
		}

		if (options.dryRun) {
			const remaining = await this.listTabsQuiet();
			const windows = await this.collectWindowsSummary(remaining);
			let ok = true;
			if (options.requireMatch && wouldCloseTabs.length === 0) {
				ok = false;
			}
			const details: NavigateResult = {
				closedWindowIds: [windowId],
				closedTabIds: wouldCloseTabs,
				skipped,
				dryRun: true,
				ok,
				tabs: remaining,
				windows,
			};
			const titles = tabs.map((t) => t.title || "Untitled").join(", ");
			return {
				content: [
					{
						type: "text",
						text: `Would close window ${windowId} (${tabs.length} tabs: ${titles || "none"})`,
					},
				],
				details,
			};
		}

		try {
			await chrome.windows.remove(windowId);
			closedWindowIds.push(windowId);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			skipped.push({ windowId, reason: message });
		}

		const remaining = await this.listTabsQuiet();
		const windows = await this.collectWindowsSummary(remaining);

		let ok = closedWindowIds.length > 0;
		if (options.requireMatch && wouldCloseTabs.length === 0) {
			ok = false;
		}
		if (closedWindowIds.length === 0) {
			ok = false;
		}

		const details: NavigateResult = {
			closedWindowIds,
			closedTabIds: closedWindowIds.length > 0 ? wouldCloseTabs : [],
			skipped,
			dryRun: false,
			ok,
			tabs: remaining,
			windows,
		};
		const output =
			closedWindowIds.length > 0
				? `Closed window ${windowId} (${wouldCloseTabs.length} tabs)`
				: `Failed to close window ${windowId}`;
		return { content: [{ type: "text", text: output }], details };
	}

	private async closeTabsAction(
		args: NavigateParams,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		const dryRun = !!args.dryRun;
		const explicitIds: number[] = [];
		if (args.closeTab !== undefined) explicitIds.push(args.closeTab);
		if (args.closeTabs) {
			for (const id of args.closeTabs) {
				if (!explicitIds.includes(id)) explicitIds.push(id);
			}
		}

		const isExplicit = explicitIds.length > 0;
		const isFilter = args.closeTabFilter !== undefined;

		if (isExplicit && isFilter) {
			throw new Error("Invalid navigation parameters: closeTab/closeTabs and closeTabFilter are mutually exclusive");
		}

		let idsToClose: number[] = [];
		const skipped: CloseSkipInfo[] = [];

		if (isExplicit) {
			idsToClose = explicitIds;
		} else if (args.closeTabFilter) {
			const filter = args.closeTabFilter;
			const titleRe = compilePattern(filter.titlePattern, "titlePattern");
			const urlRe = compilePattern(filter.urlPattern, "urlPattern");
			const hasMatcher =
				!!filter.titleIncludes ||
				!!filter.titlePattern ||
				!!filter.urlIncludes ||
				!!filter.urlPattern ||
				filter.windowId !== undefined;

			if (!hasMatcher) {
				throw new Error(
					"closeTabFilter requires at least one of titleIncludes, titlePattern, urlIncludes, urlPattern, or windowId",
				);
			}

			const tabs = await chrome.tabs.query({});
			for (const tab of tabs) {
				if (tab.id === undefined) continue;
				const title = tab.title || "";
				const url = tab.url || "";

				if (filter.windowId !== undefined && tab.windowId !== filter.windowId) continue;
				if (filter.titleIncludes && !title.includes(filter.titleIncludes)) continue;
				if (titleRe && !titleRe.test(title)) continue;
				if (filter.urlIncludes && !url.includes(filter.urlIncludes)) continue;
				if (urlRe && !urlRe.test(url)) continue;

				if (tab.pinned && !filter.includePinned) {
					skipped.push({
						tabId: tab.id,
						reason: "pinned (use includePinned / --include-pinned)",
						title,
						url,
					});
					continue;
				}
				if (isProtectedUrl(url) && !filter.includeProtected) {
					skipped.push({
						tabId: tab.id,
						reason: "protected URL (use includeProtected / --include-protected)",
						title,
						url,
					});
					continue;
				}

				idsToClose.push(tab.id);
			}
		}

		const { closedTabIds, closeSkipped } = await this.closeTabsByIds(idsToClose, {
			dryRun,
			// Explicit ids: do not skip pinned/protected — user chose the id
			// Filter path already applied skips above
			skipPinned: false,
			skipProtected: false,
		});
		// closeSkipped are remove-phase failures (missing id, race, API error) — not policy skips
		const removePhaseSkipped = closeSkipped;
		skipped.push(...closeSkipped);

		const remaining = await this.listTabsQuiet();
		const windows = await this.collectWindowsSummary(remaining);

		let ok = true;
		if (isExplicit) {
			// Non-zero exit when any requested explicit id failed to close
			const closedSet = new Set(closedTabIds);
			if (explicitIds.some((id) => !closedSet.has(id))) {
				ok = false;
			}
		}
		if (isFilter && !dryRun && removePhaseSkipped.length > 0) {
			// Matched tabs that failed during remove (race / missing id)
			ok = false;
		}
		// Filter matched only policy-skipped rows (pinned/protected) — closed nothing
		if (isFilter && closedTabIds.length === 0 && skipped.length > 0) {
			ok = false;
		}
		if (args.requireMatch && closedTabIds.length === 0) {
			ok = false;
		}

		const details: NavigateResult = {
			closedTabIds,
			skipped,
			dryRun,
			ok,
			tabs: remaining,
			windows,
		};

		const verb = dryRun ? "Would close" : "Closed";
		let output = `${verb} ${closedTabIds.length} tab(s)`;
		if (closedTabIds.length > 0) {
			output += `: ${closedTabIds.join(", ")}`;
		}
		if (skipped.length > 0) {
			output += `\nSkipped ${skipped.length}:`;
			for (const s of skipped) {
				output += `\n  - ${s.tabId ?? s.windowId ?? "?"}: ${s.reason}`;
			}
		}
		return { content: [{ type: "text", text: output }], details };
	}

	private async closeTabsByIds(
		ids: number[],
		options: { dryRun?: boolean; skipPinned?: boolean; skipProtected?: boolean } = {},
	): Promise<{ closedTabIds: number[]; closeSkipped: CloseSkipInfo[] }> {
		const closedTabIds: number[] = [];
		const closeSkipped: CloseSkipInfo[] = [];

		for (const id of ids) {
			try {
				const tab = await chrome.tabs.get(id);
				const title = tab.title || "Untitled";
				const url = tab.url || "";

				if (options.skipPinned && tab.pinned) {
					closeSkipped.push({
						tabId: id,
						reason: "pinned (use includePinned / --include-pinned)",
						title,
						url,
					});
					continue;
				}
				if (options.skipProtected && isProtectedUrl(url)) {
					closeSkipped.push({
						tabId: id,
						reason: "protected URL (use includeProtected / --include-protected)",
						title,
						url,
					});
					continue;
				}

				if (options.dryRun) {
					closedTabIds.push(id);
					continue;
				}

				await chrome.tabs.remove(id);
				closedTabIds.push(id);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				closeSkipped.push({
					tabId: id,
					reason: message || `No tab with id ${id}`,
				});
			}
		}

		return { closedTabIds, closeSkipped };
	}

	private async listTabsQuiet(): Promise<TabInfo[]> {
		const tabs = await chrome.tabs.query({});
		return tabs
			.filter((t: chrome.tabs.Tab): t is chrome.tabs.Tab & { id: number } => t.id !== undefined)
			.map((t) => tabToInfo(t));
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
			const storage = getShuvgeistStorage();
			const skillsRepo = storage.skills;
			const matchingSkills = await skillsRepo.getSkillsForUrl(url);
			const { newOrUpdated, unchanged, formattedText } = await formatSkills(matchingSkills, {
				getMemoriesForSkill: (skill) => storage.memories.getForSkill(skill.name),
				shownSkillsState: this.shownSkillsState,
			});
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
