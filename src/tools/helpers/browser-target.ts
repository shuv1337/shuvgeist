export interface BrowserTarget {
	tabId?: number;
	frameId?: number;
}

export interface BrowserTargetResolverOptions extends BrowserTarget {
	windowId?: number;
}

/**
 * Single source of truth for window-id validity in bridge/browser target
 * resolution. A window id is only usable when it is a positive integer.
 *
 * Rejects: `undefined`, `0`, negative ids, `chrome.windows.WINDOW_ID_NONE`,
 * and any non-integer/non-finite value.
 */
export function isUsableWindowId(windowId: number | undefined): windowId is number {
	return typeof windowId === "number" && Number.isInteger(windowId) && windowId > 0;
}

export interface ResolvedTabTarget {
	tabId: number;
	tab: chrome.tabs.Tab;
	source: "explicit" | "active";
}

export interface ResolvedBrowserTarget extends ResolvedTabTarget {
	frameId: number;
}

export function isProtectedTabUrl(url?: string): boolean {
	return (
		url?.startsWith("chrome://") === true ||
		url?.startsWith("chrome-extension://") === true ||
		url?.startsWith("moz-extension://") === true ||
		url?.startsWith("about:") === true
	);
}

export function assertTabCanExecuteScripts(tab: chrome.tabs.Tab): void {
	if (!tab.id) {
		throw new Error("No active tab found");
	}
	if (isProtectedTabUrl(tab.url)) {
		throw new Error(`Cannot execute scripts on ${tab.url}. Extension pages and internal URLs are protected.`);
	}
}

export async function resolveTabTarget(options: BrowserTargetResolverOptions = {}): Promise<ResolvedTabTarget> {
	if (typeof options.tabId === "number") {
		const tab = await chrome.tabs.get(options.tabId);
		if (!tab.id) {
			throw new Error(`Tab ${options.tabId} was not found`);
		}
		return {
			tabId: tab.id,
			tab,
			source: "explicit",
		};
	}

	const queryOptions: chrome.tabs.QueryInfo = isUsableWindowId(options.windowId)
		? { active: true, windowId: options.windowId }
		: { active: true, currentWindow: true };
	const [tab] = await chrome.tabs.query(queryOptions);
	if (!tab?.id) {
		throw new Error("No active tab found");
	}

	return {
		tabId: tab.id,
		tab,
		source: "active",
	};
}

export async function resolveBrowserTarget(options: BrowserTargetResolverOptions = {}): Promise<ResolvedBrowserTarget> {
	const resolved = await resolveTabTarget(options);
	return {
		...resolved,
		frameId: options.frameId ?? 0,
	};
}
