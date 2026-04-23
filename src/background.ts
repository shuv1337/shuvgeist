/**
 * Background service worker for the Shuvgeist extension.
 *
 * Owns the bridge WebSocket connection (BridgeClient + BrowserCommandExecutor)
 * so it stays alive as long as the browser runs, regardless of sidepanel state.
 *
 * Routes session commands and REPL execution to the sidepanel (when open)
 * or offscreen document (for REPL when sidepanel is closed).
 */

import { setAppStorage } from "@mariozechner/pi-web-ui";
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
import { handleBgRuntimeExec, resolveBackgroundUserScriptMessage } from "./bridge/background-runtime-handler.js";
import { bootstrapTokenIfNeeded } from "./bridge/bootstrap.js";
import { BrowserCommandExecutor, type ReplRouter, type ScreenshotRouter } from "./bridge/browser-command-executor.js";
import { BridgeClient } from "./bridge/extension-client.js";
import {
	BRIDGE_OTEL_STATE_KEY,
	BRIDGE_SETTINGS_KEY,
	BRIDGE_STATE_KEY,
	type BridgeOtelStateData,
	type BridgeReplMessageResponse,
	type BridgeSessionCommandMessageResponse,
	type BridgeSettings,
	type BridgeStateData,
	type BridgeToOffscreenMessage,
	type BridgeToSidepanelMessage,
} from "./bridge/internal-messages.js";
import { type BridgeCapability, ErrorCodes, getBridgeCapabilities } from "./bridge/protocol.js";
import type { SessionBridgeAdapter } from "./bridge/session-bridge.js";
import {
	createChromeStorageBridgeSettingsAdapter,
	loadBridgeSettings,
	settingsRequireReconnect,
} from "./bridge/settings.js";
import { BridgeTelemetry, formatTraceparent, parseTraceparent } from "./bridge/telemetry.js";
import { ShuvgeistAppStorage } from "./storage/app-storage.js";
import { isProtectedTabUrl, isUsableWindowId, resolveTabTarget } from "./tools/helpers/browser-target.js";
import { configureSharedDebuggerManagerTelemetry, getSharedDebuggerManager } from "./tools/helpers/debugger-manager.js";
import type {
	TtsOffscreenMessage,
	TtsOffscreenResponse,
	TtsOverlayMessage,
	TtsRuntimeMessage,
	TtsRuntimeResponse,
} from "./tts/internal-messages.js";
import { configureTtsOverlayWorld, injectTtsOverlay, removeTtsOverlay } from "./tts/overlay-inject.js";
import {
	buildProviderConfig,
	getProviderVoiceId,
	getSampleTtsPhrase,
	listTtsVoices,
	prepareTtsText,
} from "./tts/service.js";
import { DEFAULT_TTS_SETTINGS, loadTtsSettings } from "./tts/settings.js";
import {
	createInitialTtsPlaybackState,
	reduceTtsPlaybackState,
	type TtsOverlayState,
	type TtsProviderId,
	type TtsSettingsSnapshot,
	type TtsVoice,
} from "./tts/types.js";
import type { SidepanelToBackgroundMessage } from "./utils/port.js";
import { getShuvgeistVersion } from "./version.js";

// ============================================================================
// SIDEPANEL STATE TRACKING
// ============================================================================

// ============================================================================
// BACKGROUND APP STORAGE (for skill lookup during bridge-initiated REPL)
// ============================================================================

let backgroundStorage: ShuvgeistAppStorage | null = null;

/**
 * Lazily initialize the ShuvgeistAppStorage singleton for the background service worker.
 * IndexedDB is available in service workers, so skill lookup / settings reads work here too.
 * This is required so the bridge-initiated REPL path (offscreen -> background -> userScripts)
 * can load domain-scoped skill libraries before injecting browserjs() code.
 */
function ensureBackgroundStorage(): ShuvgeistAppStorage {
	if (!backgroundStorage) {
		backgroundStorage = new ShuvgeistAppStorage();
		setAppStorage(backgroundStorage);
	}
	return backgroundStorage;
}

async function setBridgeOtelState(state: BridgeOtelStateData): Promise<void> {
	await chrome.storage.session.set({ [BRIDGE_OTEL_STATE_KEY]: state });
}

const extensionTelemetry = new BridgeTelemetry(
	{
		serviceName: "shuvgeist-extension",
		serviceVersion: getShuvgeistVersion(),
		resourceAttributes: {
			"app.environment": "extension",
		},
	},
	{
		onExportStateChange: (state) => {
			void setBridgeOtelState(state);
		},
	},
);

configureSharedDebuggerManagerTelemetry(extensionTelemetry);
void setBridgeOtelState(extensionTelemetry.getExportState());

let openSidepanels = new Set<number>();

chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
	openSidepanels = initializeOpenSidepanels(data[SIDEPANEL_OPEN_KEY] as number[] | undefined);
	console.log("[Background] Initialized openSidepanels cache:", Array.from(openSidepanels));
});

function isSidepanelOpen(): boolean {
	return openSidepanels.size > 0;
}

// ============================================================================
// TTS RUNTIME STATE
// ============================================================================

let ttsSettingsSnapshot: TtsSettingsSnapshot = DEFAULT_TTS_SETTINGS;
let ttsVoices: TtsVoice[] = [];
let ttsState = createInitialTtsPlaybackState(DEFAULT_TTS_SETTINGS, []);
let ttsOverlayTabId: number | null = null;
let ttsWorldConfigured = false;

// Overlay port registry: tabId -> port
const overlayPorts = new Map<number, chrome.runtime.Port>();

// Active reading sessions by session ID
interface ActiveReadingSession {
	id: string;
	tabId: number;
	provider: TtsProviderId;
	sourceKind: "raw-text" | "page-target";
	text: string;
	startedAt: number;
	hasReadAlong: boolean;
	port: chrome.runtime.Port | null;
}

const activeReadingSessions = new Map<string, ActiveReadingSession>();

function generateSessionId(): string {
	return `tts-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function registerOverlayPort(tabId: number, port: chrome.runtime.Port): void {
	// Clean up existing port for this tab
	const existing = overlayPorts.get(tabId);
	if (existing) {
		try {
			existing.disconnect();
		} catch {}
	}

	overlayPorts.set(tabId, port);

	port.onDisconnect.addListener(() => {
		if (overlayPorts.get(tabId) === port) {
			overlayPorts.delete(tabId);
		}
	});
}

function sendToOverlay(tabId: number, message: unknown): void {
	const port = overlayPorts.get(tabId);
	if (port) {
		try {
			port.postMessage(message);
		} catch {
			overlayPorts.delete(tabId);
		}
	}
}

function endReadingSession(sessionId: string): void {
	const session = activeReadingSessions.get(sessionId);
	if (session) {
		activeReadingSessions.delete(sessionId);

		// Send session end to overlay if connected
		if (session.port) {
			try {
				session.port.postMessage({ type: "tts-session-end", sessionId });
			} catch {}
		}
	}
}

function getBackgroundProviderSecrets() {
	const storage = ensureBackgroundStorage();
	return Promise.all([
		storage.providerKeys.get("openai"),
		storage.providerKeys.get("tts-elevenlabs"),
		storage.providerKeys.get("tts-kokoro"),
	]).then(([openaiKey, elevenLabsKey, kokoroKey]) => ({
		openaiKey: typeof openaiKey === "string" ? openaiKey : undefined,
		elevenLabsKey: typeof elevenLabsKey === "string" ? elevenLabsKey : undefined,
		kokoroKey: typeof kokoroKey === "string" ? kokoroKey : undefined,
	}));
}

async function refreshTtsSettingsState(): Promise<void> {
	ensureBackgroundStorage();
	ttsSettingsSnapshot = await loadTtsSettings();
	const providerSecrets = await getBackgroundProviderSecrets();
	ttsVoices = await listTtsVoices(ttsSettingsSnapshot.provider, ttsSettingsSnapshot, providerSecrets).catch(
		(error) => {
			console.warn("[Background:TTS] Failed to list voices:", error);
			return [];
		},
	);
	ttsState = reduceTtsPlaybackState(ttsState, {
		type: "sync-settings",
		settings: ttsSettingsSnapshot,
		voices: ttsVoices,
	});
}

function currentTtsOverlayState(): TtsOverlayState {
	return {
		...ttsState,
		enabled: ttsSettingsSnapshot.enabled,
	};
}

async function ensureTtsOverlayWorld(): Promise<void> {
	if (ttsWorldConfigured) return;
	await configureTtsOverlayWorld();
	ttsWorldConfigured = true;
}

async function syncTtsOverlay(): Promise<void> {
	if (!ttsOverlayTabId || !ttsState.overlayVisible) return;
	await ensureTtsOverlayWorld();
	await injectTtsOverlay(ttsOverlayTabId, currentTtsOverlayState());
}

async function closeTtsOverlay(tabId = ttsOverlayTabId): Promise<void> {
	if (!tabId) return;
	try {
		await removeTtsOverlay(tabId);
	} catch (error) {
		console.warn("[Background:TTS] Failed to remove overlay:", error);
	}
	if (tabId === ttsOverlayTabId) {
		ttsState = reduceTtsPlaybackState(ttsState, { type: "overlay-closed" });
		ttsOverlayTabId = null;
	}
}

export function getOffscreenDocumentReasons(): chrome.offscreen.Reason[] {
	return [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.AUDIO_PLAYBACK, chrome.offscreen.Reason.BLOBS];
}

let offscreenReady = false;
let offscreenSetupPromise: Promise<void> | null = null;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pingOffscreenDocument(): Promise<boolean> {
	const response = await sendMessageSafe<{ ok?: boolean }>({
		type: "bridge-keepalive-ping",
	} as BridgeToOffscreenMessage);
	return response?.ok === true;
}

async function waitForOffscreenDocumentReady(): Promise<void> {
	const maxAttempts = 40;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (await pingOffscreenDocument()) {
			offscreenReady = true;
			return;
		}
		await delay(25);
	}
	throw new Error("Offscreen document did not become ready");
}

async function ensureOffscreenDocument(): Promise<void> {
	if (offscreenReady) {
		if (await pingOffscreenDocument()) return;
		offscreenReady = false;
	}

	if (offscreenSetupPromise) {
		return offscreenSetupPromise;
	}

	offscreenSetupPromise = (async () => {
		const offscreenUrl = chrome.runtime.getURL("offscreen.html");
		const contexts = await chrome.runtime.getContexts({
			contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
			documentUrls: [offscreenUrl],
		});
		if (contexts.length === 0) {
			await chrome.offscreen.createDocument({
				url: "offscreen.html",
				reasons: getOffscreenDocumentReasons(),
				justification: "REPL sandbox execution and TTS audio playback",
			});
		}
		await waitForOffscreenDocumentReady();
	})();

	try {
		await offscreenSetupPromise;
	} finally {
		offscreenSetupPromise = null;
	}
}

async function getTtsStateResponse(): Promise<TtsRuntimeResponse> {
	await refreshTtsSettingsState();
	return {
		ok: true,
		state: ttsState,
		settings: ttsSettingsSnapshot,
	};
}

async function dispatchTtsOffscreenMessage(message: TtsOffscreenMessage): Promise<TtsOffscreenResponse> {
	await ensureOffscreenDocument();
	const response = await sendMessageSafe<TtsOffscreenResponse>(message);
	if (!response) {
		return {
			ok: false,
			error: "Offscreen TTS runtime is unavailable",
		};
	}
	return response;
}

async function applyOffscreenEvent(response: TtsOffscreenResponse): Promise<void> {
	if (!response.ok) {
		ttsState = reduceTtsPlaybackState(ttsState, {
			type: "error",
			message: response.error,
		});
		await syncTtsOverlay();
		return;
	}

	ttsState = reduceTtsPlaybackState(
		ttsState,
		response.event === "playing"
			? { type: "playing" }
			: response.event === "paused"
				? { type: "paused" }
				: { type: "stopped" },
	);
	await syncTtsOverlay();
}

async function speakText(text: string, source: "overlay" | "click" | "sidepanel"): Promise<TtsRuntimeResponse> {
	await refreshTtsSettingsState();
	if (!ttsSettingsSnapshot.enabled) {
		return { ok: false, error: "TTS is disabled in settings" };
	}

	const prepared = prepareTtsText(text, ttsSettingsSnapshot.maxTextChars);
	if (!prepared.text) {
		return { ok: false, error: "No readable text to speak" };
	}

	// Determine if this is page-target or raw-text
	// click source and typed text from overlay are page-target candidates
	const isPageTarget = source === "click";
	const isRawText = source === "overlay" || source === "sidepanel";

	// Check if read-along is possible
	const canReadAlong =
		isPageTarget && ttsSettingsSnapshot.provider === "kokoro" && ttsSettingsSnapshot.readAlongEnabled;

	const providerSecrets = await getBackgroundProviderSecrets();
	const voiceId = ttsState.voiceId || getProviderVoiceId(ttsSettingsSnapshot, ttsSettingsSnapshot.provider);

	ttsState = reduceTtsPlaybackState(ttsState, {
		type: "speak-start",
		text: prepared.text,
		truncated: prepared.truncated,
	});
	console.log("[Background:TTS] speak start", {
		provider: ttsSettingsSnapshot.provider,
		source,
		length: prepared.text.length,
		truncated: prepared.truncated,
		canReadAlong,
	});
	await syncTtsOverlay();

	// Choose synthesis path
	const offscreenMessage: TtsOffscreenMessage = canReadAlong
		? {
				type: "tts-offscreen-synthesize-captioned",
				request: {
					text: prepared.text,
					voiceId,
					speed: ttsSettingsSnapshot.speed,
					modelId: ttsSettingsSnapshot.kokoroModelId,
				},
				config: buildProviderConfig(ttsSettingsSnapshot, "kokoro", providerSecrets),
			}
		: {
				type: "tts-offscreen-synthesize",
				provider: ttsSettingsSnapshot.provider,
				request: {
					text: prepared.text,
					voiceId,
					speed: ttsSettingsSnapshot.speed,
					modelId:
						ttsSettingsSnapshot.provider === "kokoro"
							? ttsSettingsSnapshot.kokoroModelId
							: ttsSettingsSnapshot.provider === "openai"
								? ttsSettingsSnapshot.openaiModelId
								: ttsSettingsSnapshot.elevenLabsModelId,
				},
				config: buildProviderConfig(ttsSettingsSnapshot, ttsSettingsSnapshot.provider, providerSecrets),
			};

	const response = await dispatchTtsOffscreenMessage(offscreenMessage);

	// Track reading session for read-along
	if (response.ok && canReadAlong && ttsOverlayTabId) {
		const sessionId = generateSessionId();
		const port = overlayPorts.get(ttsOverlayTabId) ?? null;
		activeReadingSessions.set(sessionId, {
			id: sessionId,
			tabId: ttsOverlayTabId,
			provider: "kokoro",
			sourceKind: "page-target",
			text: prepared.text,
			startedAt: Date.now(),
			hasReadAlong: true,
			port,
		});

		// Send session ack to overlay
		if (port) {
			try {
				port.postMessage({ type: "tts-session-ack", sessionId, hasReadAlong: true });
			} catch {}
		}
	}

	await applyOffscreenEvent(response);
	return response.ok
		? {
				ok: true,
				state: ttsState,
				settings: ttsSettingsSnapshot,
			}
		: {
				ok: false,
				error: response.error,
			};
}

async function openTtsOverlay(windowId?: number): Promise<TtsRuntimeResponse> {
	await refreshTtsSettingsState();
	if (!ttsSettingsSnapshot.enabled) {
		return { ok: false, error: "TTS is disabled in settings" };
	}
	if (!chrome.userScripts?.execute) {
		return { ok: false, error: "userScripts API is not available" };
	}

	const { tab, tabId } = await resolveTabTarget({ windowId });
	if (isProtectedTabUrl(tab.url)) {
		return { ok: false, error: "Cannot open the TTS overlay on this page" };
	}

	if (ttsOverlayTabId && ttsOverlayTabId !== tabId) {
		await removeTtsOverlay(ttsOverlayTabId).catch(() => {});
	}

	await ensureTtsOverlayWorld();
	ttsOverlayTabId = tabId;
	ttsState = reduceTtsPlaybackState(ttsState, { type: "overlay-opened" });
	await syncTtsOverlay();
	return {
		ok: true,
		state: ttsState,
		settings: ttsSettingsSnapshot,
	};
}

async function handleTtsRuntimeMessage(
	message: TtsRuntimeMessage,
	sender?: chrome.runtime.MessageSender,
): Promise<TtsRuntimeResponse> {
	switch (message.type) {
		case "tts-open-overlay":
			return openTtsOverlay(message.windowId);
		case "tts-close-overlay":
			await closeTtsOverlay(message.tabId ?? sender?.tab?.id ?? ttsOverlayTabId ?? undefined);
			return getTtsStateResponse();
		case "tts-get-state":
			return getTtsStateResponse();
		case "tts-speak-test-phrase":
			return speakText(message.text || getSampleTtsPhrase(), "sidepanel");
		case "tts-speak-text":
			return speakText(message.text, message.source || "sidepanel");
		case "tts-pause": {
			const response = await dispatchTtsOffscreenMessage({ type: "tts-offscreen-pause" });
			await applyOffscreenEvent(response);
			return response.ok ? getTtsStateResponse() : { ok: false, error: response.error };
		}
		case "tts-resume": {
			const response = await dispatchTtsOffscreenMessage({ type: "tts-offscreen-resume" });
			await applyOffscreenEvent(response);
			return response.ok ? getTtsStateResponse() : { ok: false, error: response.error };
		}
		case "tts-stop": {
			const response = await dispatchTtsOffscreenMessage({ type: "tts-offscreen-stop" });
			await applyOffscreenEvent(response);
			return response.ok ? getTtsStateResponse() : { ok: false, error: response.error };
		}
		case "tts-set-click-mode":
			ttsState = reduceTtsPlaybackState(ttsState, {
				type: "set-click-mode",
				armed: message.armed,
			});
			await syncTtsOverlay();
			return getTtsStateResponse();
		case "tts-set-provider": {
			const provider = message.provider as TtsProviderId;
			const storage = ensureBackgroundStorage();
			await storage.settings.set("tts.provider", provider);
			ttsSettingsSnapshot = {
				...ttsSettingsSnapshot,
				provider,
			};
			const providerSecrets = await getBackgroundProviderSecrets();
			ttsVoices = await listTtsVoices(provider, ttsSettingsSnapshot, providerSecrets).catch(() => []);
			const voiceId = getProviderVoiceId(ttsSettingsSnapshot, provider);
			ttsSettingsSnapshot = {
				...ttsSettingsSnapshot,
				voiceId,
			};
			ttsState = reduceTtsPlaybackState(ttsState, {
				type: "set-provider",
				provider,
				voiceId,
				voices: ttsVoices,
			});
			await storage.settings.set("tts.voiceId", voiceId);
			await syncTtsOverlay();
			return getTtsStateResponse();
		}
		case "tts-set-voice":
			ttsState = reduceTtsPlaybackState(ttsState, {
				type: "set-voice",
				voiceId: message.voiceId,
			});
			ttsSettingsSnapshot = {
				...ttsSettingsSnapshot,
				voiceId: message.voiceId,
				...(ttsSettingsSnapshot.provider === "kokoro" ? { kokoroVoiceId: message.voiceId } : {}),
				...(ttsSettingsSnapshot.provider === "openai" ? { openaiVoiceId: message.voiceId } : {}),
				...(ttsSettingsSnapshot.provider === "elevenlabs" ? { elevenLabsVoiceId: message.voiceId } : {}),
			};
			await ensureBackgroundStorage().settings.set("tts.voiceId", message.voiceId);
			if (ttsSettingsSnapshot.provider === "kokoro") {
				await ensureBackgroundStorage().settings.set("tts.kokoro.voiceId", message.voiceId);
			}
			if (ttsSettingsSnapshot.provider === "openai") {
				await ensureBackgroundStorage().settings.set("tts.openai.voiceId", message.voiceId);
			}
			if (ttsSettingsSnapshot.provider === "elevenlabs") {
				await ensureBackgroundStorage().settings.set("tts.elevenlabs.voiceId", message.voiceId);
			}
			await syncTtsOverlay();
			return getTtsStateResponse();
	}

	return {
		ok: false,
		error: `Unsupported TTS runtime message: ${String((message as { type?: unknown }).type)}`,
	};
}

async function handleTtsOverlayMessage(
	message: TtsOverlayMessage,
	sender?: chrome.runtime.MessageSender,
): Promise<TtsRuntimeResponse> {
	if (message.type === "tts-overlay-ready") {
		await syncTtsOverlay();
		return getTtsStateResponse();
	}

	switch (message.command.type) {
		case "speak":
			return speakText(message.command.payload.text, message.command.payload.source);
		case "pause":
			return handleTtsRuntimeMessage({ type: "tts-pause" });
		case "resume":
			return handleTtsRuntimeMessage({ type: "tts-resume" });
		case "stop":
			return handleTtsRuntimeMessage({ type: "tts-stop" }, sender);
		case "close":
			return handleTtsRuntimeMessage({ type: "tts-close-overlay" }, sender);
		case "set-click-mode":
			return handleTtsRuntimeMessage({ type: "tts-set-click-mode", armed: message.command.armed }, sender);
		case "set-provider":
			return handleTtsRuntimeMessage({ type: "tts-set-provider", provider: message.command.provider }, sender);
		case "set-voice":
			return handleTtsRuntimeMessage({ type: "tts-set-voice", voiceId: message.command.voiceId }, sender);
	}

	return {
		ok: false,
		error: `Unsupported TTS overlay command: ${String((message as { type?: unknown }).type)}`,
	};
}

// ============================================================================
// REPL ROUTER (background -> sidepanel or offscreen)
// ============================================================================

const replRouter: ReplRouter = {
	async execute(params, signal, traceContext) {
		if (signal?.aborted) {
			throw Object.assign(new Error("REPL execution aborted"), { code: ErrorCodes.ABORTED });
		}

		const traceHeaders = traceContext
			? {
					traceparent: formatTraceparent(traceContext),
					tracestate: traceContext.tracestate,
				}
			: {};

		// Strategy 1: Route to sidepanel if open.
		// - response.ok === true  -> success, return.
		// - response.ok === false -> REAL error from user code; rethrow so the caller sees it.
		// - response === null     -> no receiver (sidepanel actually closed between isSidepanelOpen()
		//                            check and sendMessage); fall through to offscreen.
		if (isSidepanelOpen()) {
			const response = await sendMessageSafe<BridgeReplMessageResponse>({
				type: "bridge-repl-execute",
				params,
				...traceHeaders,
			} as BridgeToSidepanelMessage);
			if (response?.ok) return response.result;
			if (response && !response.ok) {
				throw new Error(response.error);
			}
			console.warn("[Background] Sidepanel did not respond to bridge-repl-execute; falling back to offscreen");
		}

		// Strategy 2: Route to offscreen document.
		// We only translate INFRASTRUCTURE failures (offscreen doc creation/ping)
		// into the capability-disabled error. User-code errors from a working
		// offscreen doc are returned as response.ok === false and MUST be propagated
		// untouched so the CLI shows the actual message.
		let infraError: unknown;
		try {
			await ensureOffscreenDocument();
			// Ensure background-side app storage is available so offscreen's
			// proxy providers can rely on the background-owned browserjs handler
			// reading the IndexedDB-backed skills store.
			ensureBackgroundStorage();
		} catch (err) {
			infraError = err;
			console.warn("[Background] REPL offscreen setup failed:", err);
		}

		if (!infraError) {
			const windowId = await resolveWindowId();
			const response = await sendMessageSafe<BridgeReplMessageResponse>({
				type: "bridge-repl-execute",
				params,
				windowId,
				...traceHeaders,
			} as BridgeToOffscreenMessage);
			if (response?.ok) return response.result;
			if (response && !response.ok) {
				throw new Error(response.error);
			}
			console.warn("[Background] Offscreen did not respond to bridge-repl-execute");
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
	async capture(_params, signal, traceContext) {
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

		await sharedDebuggerManager.acquireWithTrace(tabId, owner, { parent: traceContext });
		try {
			await sharedDebuggerManager.ensureDomainWithTrace(tabId, "Page", { parent: traceContext });
			const result = await sharedDebuggerManager.sendCommandWithTrace<{ data: string }>(
				tabId,
				"Page.captureScreenshot",
				{
					format: "png",
					captureBeyondViewport: false,
				},
				{ parent: traceContext },
			);
			if (!result?.data) throw new Error("CDP Page.captureScreenshot returned no data");
			return { mimeType: "image/png", dataUrl: `data:image/png;base64,${result.data}` };
		} finally {
			await sharedDebuggerManager.releaseWithTrace(tabId, owner, { parent: traceContext });
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
		// REPL is available even with the sidepanel closed because the background
		// worker can lazily create and warm the offscreen document on demand.
		return true;
	});
}

// ============================================================================
// BRIDGE CLIENT
// ============================================================================

const bridgeClient = new BridgeClient();
const bridgeSettingsStorage = createChromeStorageBridgeSettingsAdapter();
let currentSettings: BridgeSettings | null = null;
let bootstrapSettingsPromise: Promise<BridgeSettings> | null = null;
let bootstrapSettingsUrl: string | null = null;
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

async function setBridgeState(state: BridgeStateData["state"], detail?: string): Promise<void> {
	const stateData: BridgeStateData = { state, detail };
	await chrome.storage.session.set({ [BRIDGE_STATE_KEY]: stateData });
}

function applyBridgeObservabilitySettings(settings: BridgeSettings): void {
	extensionTelemetry.updateConfig({
		enabled: settings.observability.enabled,
		ingestUrl: settings.observability.ingestUrl,
		ingestKey: settings.observability.publicIngestKey,
	});
}

async function bootstrapSettingsForLoopback(settings: BridgeSettings): Promise<BridgeSettings> {
	if (!bootstrapSettingsPromise || bootstrapSettingsUrl !== settings.url) {
		bootstrapSettingsUrl = settings.url;
		bootstrapSettingsPromise = bootstrapTokenIfNeeded(settings).then((result) => result.settings);
	}

	try {
		return await bootstrapSettingsPromise;
	} finally {
		bootstrapSettingsPromise = null;
		bootstrapSettingsUrl = null;
	}
}

async function ensureBridgeConnection(): Promise<void> {
	const previousSettings = currentSettings;
	const { settings } = await loadBridgeSettings(bridgeSettingsStorage);
	applyBridgeObservabilitySettings(settings);

	if (!settings.enabled) {
		bridgeClient.disconnect();
		currentSettings = settings;
		lastConnectedWindowId = undefined;
		await setBridgeState("disabled");
		return;
	}

	let resolvedSettings = settings;

	if (!resolvedSettings.token) {
		try {
			const bootstrappedSettings = await bootstrapSettingsForLoopback(resolvedSettings);
			if (bootstrappedSettings.token && bootstrappedSettings.token !== resolvedSettings.token) {
				currentSettings = resolvedSettings;
				await bridgeSettingsStorage.setLocalSettings(bootstrappedSettings);
				return;
			}
			resolvedSettings = bootstrappedSettings;
		} catch (error) {
			bridgeClient.disconnect();
			currentSettings = resolvedSettings;
			lastConnectedWindowId = undefined;
			await setBridgeState("disconnected", error instanceof Error ? error.message : "Local bridge bootstrap failed");
			return;
		}
	}

	if (!resolvedSettings.token) {
		bridgeClient.disconnect();
		currentSettings = resolvedSettings;
		lastConnectedWindowId = undefined;
		await setBridgeState("disconnected", "Enter the remote bridge token to connect.");
		return;
	}

	currentSettings = resolvedSettings;

	const windowId = await resolveWindowId();

	// Never register the bridge with an invalid target. Defer connection until a
	// usable focused window becomes available (chrome.windows.onFocusChanged or
	// the next keepalive alarm will retry).
	if (!isUsableWindowId(windowId)) {
		console.log("[Background] Deferring bridge connection until a usable window id is available");
		lastConnectedWindowId = undefined;
		await setBridgeState("disconnected", "Waiting for a usable browser window");
		return;
	}

	const stateRequiresReconnect =
		bridgeClient.connectionState === "disabled" ||
		bridgeClient.connectionState === "disconnected" ||
		bridgeClient.connectionState === "error";
	const windowIdChanged = lastConnectedWindowId !== windowId;
	const settingsChanged = settingsRequireReconnect(previousSettings, resolvedSettings);
	const needsReconnect = stateRequiresReconnect || windowIdChanged || settingsChanged;

	if (!needsReconnect) return;

	const executor = new BrowserCommandExecutor({
		windowId,
		sensitiveAccessEnabled: resolvedSettings.sensitiveAccessEnabled,
		sessionBridge: backgroundSessionBridge,
		replRouter,
		screenshotRouter,
		telemetry: extensionTelemetry,
	});

	bridgeClient.connect({
		url: resolvedSettings.url,
		token: resolvedSettings.token,
		windowId,
		sensitiveAccessEnabled: resolvedSettings.sensitiveAccessEnabled,
		executor,
		telemetry: extensionTelemetry,
		capabilitiesProvider: getCurrentCapabilities,
		onStateChange: (state, detail) => {
			void setBridgeState(state, detail);
		},
	});
	lastConnectedWindowId = windowId;
}

// ============================================================================
// KEEPALIVE (alarms)
// ============================================================================

chrome.alarms.create("bridge-keepalive", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "bridge-keepalive") {
		void ensureBridgeConnection().then(() => {
			// If the client settled into a disconnected/error state (bridge
			// server was down, extension backoff hit its cap, ...), bypass the
			// in-flight exponential backoff and retry now. Without this, the
			// extension can sit in a long wait even after the bridge has come
			// back up, which makes cold-start CLI commands look as if the
			// extension is not connected.
			bridgeClient.nudgeReconnect();
		});
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
	void refreshTtsSettingsState();
	void ensureTtsOverlayWorld().catch((error) => {
		console.warn("[Background:TTS] Failed to configure overlay world on startup:", error);
	});
});

chrome.runtime.onInstalled.addListener(() => {
	console.log("[Background] Extension installed/updated");
	void ensureBridgeConnection();
	void refreshTtsSettingsState();
});

// Also connect immediately when service worker loads
void ensureBridgeConnection();
void refreshTtsSettingsState();

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

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (tabId !== ttsOverlayTabId || changeInfo.status !== "complete") return;
	if (!ttsState.overlayVisible || isProtectedTabUrl(tab.url)) return;
	void syncTtsOverlay().catch((error) => {
		console.warn("[Background:TTS] Failed to re-sync overlay after navigation:", error);
	});
});

chrome.tabs.onRemoved.addListener((tabId) => {
	if (tabId !== ttsOverlayTabId) return;
	ttsOverlayTabId = null;
	ttsState = reduceTtsPlaybackState(ttsState, { type: "overlay-closed" });
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
	if (tabId) {
		chrome.sidePanel.open({ tabId });
	}
});

// Listen for messages from userScripts (overlay in page, nested runtime calls
// from background-initiated chrome.userScripts.execute() invocations)
if (chrome.runtime.onUserScriptMessage) {
	chrome.runtime.onUserScriptMessage.addListener((message, sender, sendResponse) => {
		if (
			message &&
			typeof message === "object" &&
			typeof (message as { type?: unknown }).type === "string" &&
			(message as { type: string }).type.startsWith("tts-")
		) {
			void handleTtsOverlayMessage(message as TtsOverlayMessage, sender)
				.then((response) => sendResponse(response))
				.catch((error: unknown) =>
					sendResponse({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					} satisfies TtsRuntimeResponse),
				);
			return true;
		}

		// First, try to route to active background-initiated executions. This
		// handles nested nativeClick()/nativeType()/etc. calls issued from
		// inside skill code running in a browserjs() wrapper that was launched
		// by the offscreen REPL path (sidepanel closed).
		if (resolveBackgroundUserScriptMessage(message, sender, sendResponse)) {
			return true;
		}

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
		if (message.type === "tts-overlay-command" || message.type === "tts-overlay-ready") {
			void handleTtsOverlayMessage(message as unknown as TtsOverlayMessage, _sender)
				.then((response) => sendResponse(response))
				.catch((error: unknown) =>
					sendResponse({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					} satisfies TtsRuntimeResponse),
				);
			return true;
		}

		if (typeof message.type === "string" && message.type.startsWith("tts-")) {
			void handleTtsRuntimeMessage(message as TtsRuntimeMessage, _sender)
				.then((response) => sendResponse(response))
				.catch((error: unknown) =>
					sendResponse({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					} satisfies TtsRuntimeResponse),
				);
			return true;
		}

		if (message.type === "bridge-get-state") {
			const stateData: BridgeStateData = {
				state: bridgeClient.connectionState,
				detail: bridgeClient.connectionDetail,
			};
			sendResponse(stateData);
			return false;
		}

		// Offscreen REPL proxy runtime relay: executes browserjs() / navigate() /
		// nativeClick()-family calls on behalf of the offscreen sandbox when the
		// sidepanel is closed. See src/bridge/offscreen-runtime-providers.ts.
		if (message.type === "bg-runtime-exec") {
			const runtimeType = message.runtimeType as "browser-js" | "navigate" | "native-input";
			const payload = (message.payload as Record<string, unknown>) ?? {};
			const reqWindowId = typeof message.windowId === "number" ? (message.windowId as number) : currentWindowId;
			const traceContext = parseTraceparent(
				typeof message.traceparent === "string" ? message.traceparent : undefined,
				typeof message.tracestate === "string" ? message.tracestate : undefined,
			);
			// Ensure storage exists for skill lookup during browser-js execution.
			if (runtimeType === "browser-js") {
				ensureBackgroundStorage();
			}
			handleBgRuntimeExec(runtimeType, payload, reqWindowId, extensionTelemetry, traceContext)
				.then((response) => sendResponse(response))
				.catch((err: unknown) =>
					sendResponse({
						success: false,
						error: err instanceof Error ? err.message : String(err),
					}),
				);
			return true; // async response
		}

		return false;
	},
);

// Handle port connections from sidepanels (session locks + sidepanel tracking)
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
	// Handle overlay port connections from userScript
	if (port.name === "shuvgeist-tts-overlay") {
		const tabId = port.sender?.tab?.id;
		if (tabId) {
			registerOverlayPort(tabId, port);
			// Send current state to overlay
			try {
				port.postMessage({ type: "tts-sync-state", state: ttsState });
			} catch {}
		}
		return;
	}

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
function sendMessageSafe<T>(
	message: BridgeToSidepanelMessage | BridgeToOffscreenMessage | TtsOffscreenMessage,
): Promise<T | null> {
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
