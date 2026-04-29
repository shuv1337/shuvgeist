import { resolveTabTarget } from "../helpers/browser-target.js";
import { createOverlayScript, removeOverlayScript } from "./overlay-content.js";

const OVERLAY_WORLD_ID = "shuvgeist-repl-overlay";

/**
 * Get the currently active tab ID.
 * @returns Tab ID of the active tab in the current window
 * @throws Error if no active tab is found
 */
async function getTargetTabId(windowId?: number, tabId?: number): Promise<number> {
	const resolved = await resolveTabTarget({ windowId, tabId });
	return resolved.tabId;
}

/**
 * Inject the REPL overlay into the active tab.
 * @param tabId - ID of the tab to inject into
 * @param taskName - Name of the task being executed (shown in overlay)
 */
export async function injectOverlay(tabId: number, taskName: string): Promise<void> {
	try {
		// Check if tab is a restricted URL
		const tab = await chrome.tabs.get(tabId);
		if (
			tab.url?.startsWith("chrome://") ||
			tab.url?.startsWith("chrome-extension://") ||
			tab.url?.startsWith("moz-extension://") ||
			tab.url?.startsWith("about:")
		) {
			// Can't inject into system pages - skip overlay
			console.warn("[Overlay] Cannot inject overlay into system page:", tab.url);
			return;
		}

		// Use userScripts API with messaging enabled
		if (chrome.userScripts && typeof chrome.userScripts.execute === "function") {
			// Configure world with messaging enabled
			try {
				await chrome.userScripts.configureWorld({
					worldId: OVERLAY_WORLD_ID,
					messaging: true,
					csp: "script-src 'unsafe-eval' 'unsafe-inline'; style-src 'unsafe-inline'; default-src 'none';",
				});
			} catch (e) {
				console.warn("[Overlay] Failed to configure userScripts world:", e);
			}

			// Inject overlay script
			await chrome.userScripts.execute({
				js: [{ code: createOverlayScript(taskName) }],
				target: { tabId, allFrames: false },
				world: "USER_SCRIPT",
				worldId: OVERLAY_WORLD_ID,
				injectImmediately: true,
			});

			console.log("[Overlay] Injected overlay into tab", tabId);
		} else {
			console.warn("[Overlay] userScripts API not available");
		}
	} catch (error) {
		// Don't fail the REPL if overlay injection fails
		console.warn("[Overlay] Failed to inject overlay:", error);
	}
}

/**
 * Remove the REPL overlay from the active tab.
 * @param tabId - ID of the tab to remove overlay from
 */
export async function removeOverlay(tabId: number): Promise<void> {
	try {
		if (chrome.userScripts && typeof chrome.userScripts.execute === "function") {
			await chrome.userScripts.execute({
				js: [{ code: removeOverlayScript() }],
				target: { tabId, allFrames: false },
				world: "USER_SCRIPT",
				worldId: OVERLAY_WORLD_ID,
				injectImmediately: true,
			});

			console.log("[Overlay] Removed overlay from tab", tabId);
		}
	} catch (error) {
		// Don't fail the REPL if overlay removal fails (tab might be closed)
		console.warn("[Overlay] Failed to remove overlay:", error);
	}
}

/**
 * Inject overlay for the currently active tab.
 * Automatically determines the active tab.
 * @param taskName - Name of the task being executed
 * @returns Tab ID where overlay was injected
 */
export async function injectOverlayForActiveTab(taskName: string, windowId?: number, tabId?: number): Promise<number> {
	const targetTabId = await getTargetTabId(windowId, tabId);
	await injectOverlay(targetTabId, taskName);
	return targetTabId;
}

/**
 * Remove overlay from the currently active tab.
 * Automatically determines the active tab.
 */
export async function removeOverlayForActiveTab(windowId?: number, tabId?: number): Promise<void> {
	try {
		const targetTabId = await getTargetTabId(windowId, tabId);
		await removeOverlay(targetTabId);
	} catch (error) {
		// Tab might have been closed
		console.warn("[Overlay] Failed to remove overlay from active tab:", error);
	}
}
