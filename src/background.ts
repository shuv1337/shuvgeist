/**
 * Background service worker for the Shuvgeist extension.
 *
 * Owns the bridge WebSocket connection (BridgeClient + BrowserCommandExecutor)
 * so it stays alive as long as the browser runs, regardless of sidepanel state.
 *
 * Routes session commands and REPL execution to the sidepanel (when open)
 * or offscreen document (for REPL when sidepanel is closed).
 */

import {
	buildLockedSessionsMessage,
	buildLockResult,
	initializeOpenSidepanels,
	markSidepanelOpen,
	releaseWindowState,
	SESSION_LOCKS_KEY,
	SIDEPANEL_OPEN_KEY,
	shouldCloseSidepanel,
} from "./background-state.js";
import { BrowserCommandExecutor, type ReplRouter, type ScreenshotRouter } from "./bridge/browser-command-executor.js";
import { BridgeClient } from "./bridge/extension-client.js";
import {
	BRIDGE_SETTINGS_KEY,
	BRIDGE_STATE_KEY,
	type BridgeReplMessageResponse,
	type BridgeSessionCommandMessageResponse,
	type BridgeSettings,
	type BridgeStateData,
	type BridgeToOffscreenMessage,
	type BridgeToSidepanelMessage,
} from "./bridge/internal-messages.js";
import { type BridgeCapability, ErrorCodes, getBridgeCapabilities } from "./bridge/protocol.js";
import type { SessionBridgeAdapter } from "./bridge/session-bridge.js";
import { isUsableWindowId, resolveTabTarget } from "./tools/helpers/browser-target.js";
import { getSharedDebuggerManager } from "./tools/helpers/debugger-manager.js";
import type { SidepanelToBackgroundMessage } from "./utils/port.js";

// ============================================================================
// SIDEPANEL STATE TRACKING
// ============================================================================

let openSidepanels = new Set<number>();

chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
	openSidepanels = initializeOpenSidepanels(data[SIDEPANEL_OPEN_KEY] as number[] | undefined);
	console.log("[Background] Initialized openSidepanels cache:", Array.from(openSidepanels));
});

function isSidepanelOpen(): boolean {
	return openSidepanels.size > 0;
}

// ============================================================================
// OFFSCREEN DOCUMENT MANAGEMENT
// ============================================================================

let offscreenReady = false;

async function ensureOffscreenDocument(): Promise<void> {
	if (offscreenReady) return;

	// Check if offscreen document already exists
	const contexts = await chrome.runtime.getContexts({
		contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
	});
	if (contexts.length > 0) {
		offscreenReady = true;
		return;
	}

	try {
		await chrome.offscreen.createDocument({
			url: "offscreen.html",
			reasons: [chrome.offscreen.Reason.WORKERS],
			justification: "REPL sandbox execution for bridge commands",
		});
		offscreenReady = true;
		console.log("[Background] Offscreen document created");
	} catch (err) {
		console.error("[Background] Failed to create offscreen document:", err);
		throw err;
	}
}

// ============================================================================
// REPL ROUTER (background -> sidepanel or offscreen)
// ============================================================================

const replRouter: ReplRouter = {
	async execute(params, signal) {
		if (signal?.aborted) {
			throw Object.assign(new Error("REPL execution aborted"), { code: ErrorCodes.ABORTED });
		}

		// Strategy 1: Route to sidepanel if open
		if (isSidepanelOpen()) {
			try {
				const response = await sendMessageSafe<BridgeReplMessageResponse>({
					type: "bridge-repl-execute",
					params,
				} as BridgeToSidepanelMessage);
				if (response?.ok) return response.result;
				if (response && !response.ok) throw new Error(response.error);
			} catch (err) {
				console.warn("[Background] REPL routing to sidepanel failed, trying offscreen:", err);
			}
		}

		// Strategy 2: Route to offscreen document
		try {
			await ensureOffscreenDocument();
			const response = await sendMessageSafe<BridgeReplMessageResponse>({
				type: "bridge-repl-execute",
				params,
			} as BridgeToOffscreenMessage);
			if (response?.ok) return response.result;
			if (response && !response.ok) throw new Error(response.error);
		} catch (err) {
			console.warn("[Background] REPL routing to offscreen failed:", err);
		}

		throw Object.assign(new Error("REPL requires sidepanel or offscreen document"), {
			code: ErrorCodes.CAPABILITY_DISABLED,
		});
	},
};

// ============================================================================
// SCREENSHOT ROUTER (background -> sidepanel or CDP fallback)
// ============================================================================

const sharedDebuggerManager = getSharedDebuggerManager();

const screenshotRouter: ScreenshotRouter = {
	async capture(_params, signal) {
		if (signal?.aborted) {
			throw Object.assign(new Error("Screenshot capture aborted"), { code: ErrorCodes.ABORTED });
		}

		// Use CDP Page.captureScreenshot via DebuggerManager.
		// captureVisibleTab + canvas image processing hangs in service worker context.
		// Resolve the active tab through the shared helper so screenshot follows the
		// same window-id semantics as every other bridge command (no inline
		// `windowId=0` query that can fall through to "no tab").
		const windowId = await resolveWindowId();
		let tabId: number;
		try {
			const resolved = await resolveTabTarget({ windowId });
			tabId = resolved.tabId;
		} catch {
			throw new Error("No active tab for screenshot");
		}
		const owner = `screenshot:${tabId}:${Date.now()}`;

		await sharedDebuggerManager.acquire(tabId, owner);
		try {
			await sharedDebuggerManager.ensureDomain(tabId, "Page");
			const result = await sharedDebuggerManager.sendCommand<{ data: string }>(tabId, "Page.captureScreenshot", {
				format: "png",
				captureBeyondViewport: false,
			});
			if (!result?.data) throw new Error("CDP Page.captureScreenshot returned no data");
			return { mimeType: "image/png", dataUrl: `data:image/png;base64,${result.data}` };
		} finally {
			await sharedDebuggerManager.release(tabId, owner);
		}
	},
};

// ============================================================================
// SESSION BRIDGE ADAPTER (background -> sidepanel routing)
// ============================================================================

const backgroundSessionBridge: SessionBridgeAdapter = {
	getSnapshot() {
		return {
			sessionId: undefined,
			persisted: false,
			title: "",
			model: undefined,
			isStreaming: false,
			messageCount: 0,
			lastMessageIndex: -1,
			messages: [],
		};
	},
	async waitForIdle() {
		if (!isSidepanelOpen())
			throw Object.assign(new Error("Session operations require sidepanel"), { code: ErrorCodes.NO_ACTIVE_SESSION });
		const resp = await sendSessionCommand("waitForIdle", {});
		if (!resp.ok) throw new Error(resp.error);
	},
	async appendInjectedMessage(params) {
		if (!isSidepanelOpen())
			throw Object.assign(new Error("Session inject requires sidepanel"), { code: ErrorCodes.NO_ACTIVE_SESSION });
		const resp = await sendSessionCommand("session_inject", params as unknown as Record<string, unknown>);
		if (!resp.ok) throw Object.assign(new Error(resp.error), { code: resp.code });
		return resp.result as Awaited<ReturnType<SessionBridgeAdapter["appendInjectedMessage"]>>;
	},
	async newSession(params) {
		if (!isSidepanelOpen())
			throw Object.assign(new Error("Session creation requires sidepanel"), { code: ErrorCodes.NO_ACTIVE_SESSION });
		const resp = await sendSessionCommand("session_new", params as unknown as Record<string, unknown>);
		if (!resp.ok) throw Object.assign(new Error(resp.error), { code: resp.code });
		return resp.result as Awaited<ReturnType<SessionBridgeAdapter["newSession"]>>;
	},
	async setModel(params) {
		if (!isSidepanelOpen())
			throw Object.assign(new Error("Model change requires sidepanel"), { code: ErrorCodes.NO_ACTIVE_SESSION });
		const resp = await sendSessionCommand("session_set_model", params as unknown as Record<string, unknown>);
		if (!resp.ok) throw Object.assign(new Error(resp.error), { code: resp.code });
		return resp.result as Awaited<ReturnType<SessionBridgeAdapter["setModel"]>>;
	},
	getArtifacts() {
		return { sessionId: undefined, artifacts: [] };
	},
	subscribe() {
		return () => {};
	},
};

async function sendSessionCommand(
	method: string,
	params: Record<string, unknown>,
): Promise<BridgeSessionCommandMessageResponse> {
	try {
		const response = await sendMessageSafe<BridgeSessionCommandMessageResponse>({
			type: "bridge-session-command",
			method,
			params,
		} as BridgeToSidepanelMessage);
		if (!response) return { ok: false, error: "No response from sidepanel", code: ErrorCodes.NO_ACTIVE_SESSION };
		return response;
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err), code: ErrorCodes.NO_ACTIVE_SESSION };
	}
}

// ============================================================================
// DYNAMIC CAPABILITY REPORTING
// ============================================================================

function getCurrentCapabilities(): BridgeCapability[] {
	const allCapabilities = getBridgeCapabilities(currentSettings?.sensitiveAccessEnabled ?? false);
	const sessionCapabilities = new Set<BridgeCapability>([
		"session_history",
		"session_inject",
		"session_new",
		"session_set_model",
		"session_artifacts",
	]);

	const sidepanelOpen = isSidepanelOpen();

	return allCapabilities.filter((cap) => {
		if (sessionCapabilities.has(cap)) {
			return sidepanelOpen;
		}
		if (cap === "repl") {
			return sidepanelOpen || offscreenReady;
		}
		return true;
	});
}

// ============================================================================
// BRIDGE CLIENT
// ============================================================================

const bridgeClient = new BridgeClient();
let currentSettings: BridgeSettings | null = null;
/**
 * Last cached usable window id (positive integer). `undefined` means we have
 * never observed a usable focused window. Treated as "no target" everywhere.
 */
let currentWindowId: number | undefined;
/**
 * Window id the active BrowserCommandExecutor was constructed with. Used to
 * detect when focus has moved to a different window so we can rebuild the
 * executor (its `windowId` is `readonly` so updating in place is impossible).
 */
let lastConnectedWindowId: number | undefined;

async function resolveWindowId(): Promise<number | undefined> {
	try {
		const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
		if (isUsableWindowId(win?.id)) {
			currentWindowId = win.id;
		}
	} catch {
		// Use cached value
	}
	return currentWindowId;
}

async function ensureBridgeConnection(): Promise<void> {
	const data = await chrome.storage.local.get(BRIDGE_SETTINGS_KEY);
	const settings = data[BRIDGE_SETTINGS_KEY] as BridgeSettings | undefined;

	if (!settings?.enabled || !settings.url || !settings.token) {
		bridgeClient.disconnect();
		currentSettings = null;
		lastConnectedWindowId = undefined;
		return;
	}

	currentSettings = settings;

	const windowId = await resolveWindowId();

	// Never register the bridge with an invalid target. Defer connection until a
	// usable focused window becomes available (chrome.windows.onFocusChanged or
	// the next keepalive alarm will retry).
	if (!isUsableWindowId(windowId)) {
		console.log("[Background] Deferring bridge connection until a usable window id is available");
		return;
	}

	const stateRequiresReconnect =
		bridgeClient.connectionState === "disabled" ||
		bridgeClient.connectionState === "disconnected" ||
		bridgeClient.connectionState === "error";
	const windowIdChanged = lastConnectedWindowId !== windowId;
	const needsReconnect = stateRequiresReconnect || windowIdChanged;

	if (needsReconnect) {
		const executor = new BrowserCommandExecutor({
			windowId,
			sensitiveAccessEnabled: settings.sensitiveAccessEnabled,
			sessionBridge: backgroundSessionBridge,
			replRouter,
			screenshotRouter,
		});

		bridgeClient.connect({
			url: settings.url,
			token: settings.token,
			windowId,
			sensitiveAccessEnabled: settings.sensitiveAccessEnabled,
			executor,
			capabilitiesProvider: getCurrentCapabilities,
			onStateChange: (state, detail) => {
				const stateData: BridgeStateData = { state, detail };
				chrome.storage.session.set({ [BRIDGE_STATE_KEY]: stateData });
			},
		});
		lastConnectedWindowId = windowId;
	}
}

// ============================================================================
// KEEPALIVE (alarms)
// ============================================================================

chrome.alarms.create("bridge-keepalive", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "bridge-keepalive") {
		void ensureBridgeConnection();
	}
});

// ============================================================================
// STORAGE CHANGE LISTENER (bridge settings)
// ============================================================================

chrome.storage.onChanged.addListener((changes, areaName) => {
	if (areaName === "local" && changes[BRIDGE_SETTINGS_KEY]) {
		console.log("[Background] Bridge settings changed, reconnecting");
		void ensureBridgeConnection();
	}
});

// ============================================================================
// STARTUP / INSTALL HOOKS
// ============================================================================

chrome.runtime.onStartup.addListener(() => {
	console.log("[Background] Extension startup");
	void ensureBridgeConnection();
});

chrome.runtime.onInstalled.addListener(() => {
	console.log("[Background] Extension installed/updated");
	void ensureBridgeConnection();
});

// Also connect immediately when service worker loads
void ensureBridgeConnection();

// ============================================================================
// ACTIVE TAB TRACKING
// ============================================================================

chrome.tabs.onActivated.addListener(async (activeInfo) => {
	if (bridgeClient.connectionState !== "connected") return;
	try {
		const tab = await chrome.tabs.get(activeInfo.tabId);
		bridgeClient.sendEvent("active_tab_changed", {
			url: tab.url || "",
			title: tab.title || "",
			tabId: tab.id,
		});
	} catch {
		// Tab may not exist
	}
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
	if (bridgeClient.connectionState !== "connected") return;
	if (changeInfo.status !== "complete" || !tab.active) return;
	bridgeClient.sendEvent("active_tab_changed", {
		url: tab.url || "",
		title: tab.title || "",
		tabId: tab.id,
	});
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
	if (!isUsableWindowId(windowId)) return;
	currentWindowId = windowId;

	// If the bridge has not yet connected (deferred at startup because no
	// usable window was available) OR the executor was built around a different
	// window id, rebuild via ensureBridgeConnection() so the new window becomes
	// the live target. BrowserCommandExecutor.windowId is readonly, so an
	// in-place update is not possible.
	if (lastConnectedWindowId !== windowId) {
		await ensureBridgeConnection();
	}

	if (bridgeClient.connectionState !== "connected") return;
	try {
		const [tab] = await chrome.tabs.query({ active: true, windowId });
		if (tab?.id) {
			bridgeClient.sendEvent("active_tab_changed", {
				url: tab.url || "",
				title: tab.title || "",
				tabId: tab.id,
			});
		}
	} catch {
		// Window may not exist
	}
});

// ============================================================================
// SIDEPANEL <-> BACKGROUND PORT + MESSAGE HANDLING
// ============================================================================

// Called when Shuvgeist icon is clicked - opens sidepanel for current tab
chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
	const tabId = tab?.id;
	if (tabId && chrome.sidePanel.open) {
		chrome.sidePanel.open({ tabId });
	}
});

// Listen for messages from userScripts (overlay in page)
if (chrome.runtime.onUserScriptMessage) {
	chrome.runtime.onUserScriptMessage.addListener((message, _sender, sendResponse) => {
		if (message.type === "abort-repl") {
			chrome.runtime.sendMessage(message);
			sendResponse({ success: true });
			return true;
		}
	});
}

// Handle messages from sidepanel and offscreen
chrome.runtime.onMessage.addListener(
	(
		message: Record<string, unknown>,
		_sender: chrome.runtime.MessageSender,
		sendResponse: (response: unknown) => void,
	) => {
		if (message.type === "bridge-get-state") {
			const stateData: BridgeStateData = {
				state: bridgeClient.connectionState,
				detail: bridgeClient.connectionDetail,
			};
			sendResponse(stateData);
			return false;
		}

		if (message.type === "bridge-settings-changed") {
			const settings = message.settings as BridgeSettings;
			chrome.storage.local.set({ [BRIDGE_SETTINGS_KEY]: settings });
			void ensureBridgeConnection();
			sendResponse({ ok: true });
			return false;
		}

		return false;
	},
);

// Handle port connections from sidepanels (session locks + sidepanel tracking)
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
	const match = /^sidepanel:(\d+)$/.exec(port.name);
	if (!match) return;

	const windowId = Number(match[1]);

	openSidepanels = markSidepanelOpen(openSidepanels, windowId);

	// Persist open state
	chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
		const openWindows = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
		openWindows.add(windowId);
		chrome.storage.session.set({ [SIDEPANEL_OPEN_KEY]: Array.from(openWindows) });
	});

	// Update bridge capabilities when sidepanel opens
	bridgeClient.sendCapabilitiesUpdate();

	port.onMessage.addListener((msg: SidepanelToBackgroundMessage) => {
		if (msg.type === "acquireLock") {
			const { sessionId, windowId: reqWindowId } = msg;
			chrome.storage.session.get(SESSION_LOCKS_KEY, (data) => {
				const sessionLocks: Record<string, number> = (data[SESSION_LOCKS_KEY] as Record<string, number>) || {};
				const { response, nextLocks } = buildLockResult(sessionLocks, openSidepanels, sessionId, reqWindowId);
				if (response.success) {
					chrome.storage.session.set({ [SESSION_LOCKS_KEY]: nextLocks });
				}
				port.postMessage(response);
			});
		} else if (msg.type === "getLockedSessions") {
			chrome.storage.session.get(SESSION_LOCKS_KEY, (data) => {
				const locks: Record<string, number> = (data[SESSION_LOCKS_KEY] as Record<string, number>) || {};
				port.postMessage(buildLockedSessionsMessage(locks));
			});
		}
	});

	port.onDisconnect.addListener(() => {
		closeSidepanel(windowId, false);
		// Update bridge capabilities when sidepanel closes
		bridgeClient.sendCapabilitiesUpdate();
	});
});

// Clean up locks when entire window closes
chrome.windows.onRemoved.addListener((windowId: number) => {
	closeSidepanel(windowId, false);
});

// Handle keyboard shortcut - toggle sidepanel open/close
chrome.commands.onCommand.addListener((command: string, sender?: chrome.tabs.Tab) => {
	if (command === "toggle-sidepanel") {
		if (!sender?.windowId) return;
		const windowId = sender.windowId;
		if (shouldCloseSidepanel(openSidepanels, windowId)) {
			closeSidepanel(windowId);
		} else {
			chrome.sidePanel.open({ windowId });
		}
	}
});

function closeSidepanel(windowId: number, callCloseOnSidePanelAPI = true) {
	if (callCloseOnSidePanelAPI) {
		(chrome.sidePanel as { close(options: { windowId: number }): void }).close({ windowId });
	}

	openSidepanels = initializeOpenSidepanels(
		releaseWindowState({ sessionLocks: {}, openWindows: Array.from(openSidepanels) }, windowId).openWindows,
	);

	chrome.storage.session.get([SESSION_LOCKS_KEY, SIDEPANEL_OPEN_KEY], (data) => {
		const sessionLocks: Record<string, number> = (data[SESSION_LOCKS_KEY] as Record<string, number>) || {};
		const openWindows = (data[SIDEPANEL_OPEN_KEY] as number[]) || [];
		const nextState = releaseWindowState({ sessionLocks, openWindows }, windowId);
		chrome.storage.session.set({
			[SESSION_LOCKS_KEY]: nextState.sessionLocks,
			[SIDEPANEL_OPEN_KEY]: nextState.openWindows,
		});
	});
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Send a message via chrome.runtime.sendMessage with error handling.
 * Returns null if no receivers are available (sidepanel closed).
 */
function sendMessageSafe<T>(message: BridgeToSidepanelMessage | BridgeToOffscreenMessage): Promise<T | null> {
	return new Promise((resolve) => {
		chrome.runtime.sendMessage(message, (response?: T) => {
			if (chrome.runtime.lastError) {
				// "Could not establish connection. Receiving end does not exist."
				resolve(null);
			} else {
				resolve(response ?? null);
			}
		});
	});
}
