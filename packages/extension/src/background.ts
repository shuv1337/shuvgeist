/**
 * Background service worker for the Shuvgeist extension.
 *
 * Owns bridge connection recovery and coordinates window-scoped agent sessions
 * independently of sidepanel lifetime. Persistent agents, tools, and REPL
 * sandboxes live in the offscreen document; this worker authenticates clients
 * and authorizes their privileged page operations.
 */

import { setAppStorage } from "@shuv1337/pi-web-ui";
import type { ReplOverlayAbortIntent } from "@shuvgeist/driver/injected-contracts";
import {
	type BridgeCapability,
	ErrorCodes,
	getBridgeCapabilities,
	type SessionArtifactsResult,
	type SessionInjectParams,
	type SessionInjectResult,
	type SessionNewParams,
	type SessionNewResult,
	type SessionSetModelParams,
	type SessionSetModelResult,
} from "@shuvgeist/protocol/protocol";
import { BridgeTelemetry } from "@shuvgeist/protocol/telemetry";
import { getShuvgeistVersion } from "@shuvgeist/protocol/version";
import { modelToRuntimeDescriptor, registerShuvgeistProviderModels } from "./agent/provider-runtime.js";
import { runtimeClientRouteKey } from "./agent/runtime-identity.js";
import type { RuntimeAgentMessage } from "./agent/runtime-protocol.js";
import {
	SIDEPANEL_WINDOW_CONFIRM_MESSAGE_TYPE,
	SIDEPANEL_WINDOW_PREPARE_MESSAGE_TYPE,
	type SidepanelCapabilityMaterial,
	type SidepanelLeaseIdentity,
} from "./agent/sidepanel-context-identity.js";
import { SidepanelWindowAuthority, type SidepanelWindowAuthorityState } from "./agent/sidepanel-window-authority.js";
import {
	buildLockedSessionsMessage,
	buildLockResult,
	initializeOpenSidepanels,
	markSidepanelClosed,
	markSidepanelOpen,
	releaseWindowState,
	shouldCloseSidepanel,
} from "./background-state.js";
import {
	AgentRuntimeCoordinator,
	AgentRuntimeSidepanelTrackingRegistry,
	authenticateAndAcceptAgentRuntimePort,
	authenticateAndAcceptSidepanelTrackingPort,
} from "./bridge/agent-runtime-coordinator.js";
import { AgentRuntimeNavigationSteering, type AgentRuntimeNavigationTab } from "./bridge/agent-runtime-navigation.js";
import {
	authorizeAgentRuntimePageTarget,
	scopeAgentRuntimeNavigatePayload,
} from "./bridge/agent-runtime-page-authorization.js";
import {
	AgentRuntimePageController,
	type AgentRuntimePageDelegateInput,
} from "./bridge/agent-runtime-page-controller.js";
import {
	handleBackgroundPageRuntimeOperation,
	resolveBackgroundUserScriptMessage,
} from "./bridge/background-runtime-handler.js";
import { bootstrapTokenIfNeeded } from "./bridge/bootstrap.js";
import {
	BrowserCommandExecutor,
	type RecordingRouter,
	type ReplRouter,
	type ScreenshotRouter,
} from "./bridge/browser-command-executor.js";
import { ChromePageDriverRegistry } from "./bridge/chrome-page-driver-registry.js";
import { BridgeClient, type BridgeConnectionState } from "./bridge/extension-client.js";
import type {
	AgentRuntimeAbortIntent,
	AgentRuntimeConnectionDescriptor,
	AgentRuntimeConnectionRegistry,
	AgentRuntimeDeveloperSettingsResponse,
	BridgeElectronStateData,
	BridgeOtelStateData,
	BridgeSettings,
	BridgeStateData,
	BridgeToOffscreenMessage,
} from "./bridge/internal-messages.js";
import {
	BRIDGE_RUNTIME_STATE_KEYS,
	readBridgeRuntimeState,
	writeBridgeRuntimeState,
	writeBridgeRuntimeStates,
} from "./bridge/runtime-state.js";
import { projectSessionMessages, type SessionBridgeAdapter, type SessionSnapshot } from "./bridge/session-bridge.js";
import {
	bridgeSettingsFromStorageChange,
	createChromeStorageBridgeSettingsAdapter,
	loadBridgeSettings,
	settingsRequireReconnect,
} from "./bridge/settings.js";
import { createNavigationMessage } from "./messages/navigation-context.js";
import { SYSTEM_PROMPT } from "./prompts/prompts.js";
import { normalizeModelForRuntime, resolveModelSpec } from "./sidepanel/model-resolution.js";
import { ShuvgeistAppStorage } from "./storage/app-storage.js";
import { loadDeveloperSettings } from "./storage/developer-settings.js";
import { DebuggerTool } from "./tools/debugger.js";
import { getImageInfoFromPage } from "./tools/extract-image.js";
import { isProtectedTabUrl, isUsableWindowId, resolveTabTarget } from "./tools/helpers/browser-target.js";
import { configureSharedDebuggerManagerTelemetry, getSharedDebuggerManager } from "./tools/helpers/debugger-manager.js";
import type { PageSnapshotResult } from "./tools/page-snapshot.js";
import { RecordingTools } from "./tools/recording-tools.js";
import { injectOverlayForActiveTab, removeOverlayForActiveTab } from "./tools/repl/overlay-inject.js";
import type {
	TtsOffscreenMessage,
	TtsOffscreenResponse,
	TtsOverlayMessage,
	TtsPortMessage,
	TtsRuntimeMessage,
	TtsRuntimeResponse,
	TtsSpeakPayload,
} from "./tts/internal-messages.js";
import { isKokoroHealthStale, probeKokoroHealth, refreshKokoroHealth } from "./tts/kokoro-health.js";
import { configureTtsOverlayWorld, injectTtsOverlay, removeTtsOverlay } from "./tts/overlay-inject.js";
import { TtsPlaybackCoordinator } from "./tts/playback-coordinator.js";
import { getProviderVoiceId, getSampleTtsPhrase, listTtsVoices } from "./tts/service.js";
import { DEFAULT_TTS_SETTINGS, loadTtsSettings, saveTtsSettings } from "./tts/settings.js";
import {
	createInitialTtsPlaybackState,
	type KokoroHealthStatus,
	reduceTtsPlaybackState,
	type TtsOverlayState,
	type TtsPlayhead,
	type TtsProviderId,
	type TtsSettingsSnapshot,
	type TtsVoice,
} from "./tts/types.js";
import type { SidepanelToBackgroundMessage } from "./utils/port.js";
import { ShownSkillsState } from "./utils/shown-skills.js";

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
	await writeBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.observability, state);
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

void readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.openSidepanels).then((openWindows) => {
	openSidepanels = initializeOpenSidepanels(openWindows);
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

const overlayPorts = new Map<number, chrome.runtime.Port>();

function generateSessionId(): string {
	return `tts-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function logTtsEvent(event: string, attributes: Record<string, string | number | boolean | undefined> = {}): void {
	console.log("[Background:TTS]", event, attributes);
}

function sendToOverlay(tabId: number, message: TtsPortMessage): void {
	const port = overlayPorts.get(tabId);
	if (!port) {
		return;
	}
	try {
		port.postMessage(message);
	} catch {
		overlayPorts.delete(tabId);
	}
}

function markOverlayDetached(tabId: number): void {
	ttsCoordinator.markOverlayDetached(tabId);
}

const ttsCoordinator = new TtsPlaybackCoordinator({
	sendToOverlay,
	logEvent: logTtsEvent,
	now: () => Date.now(),
	createSessionId: generateSessionId,
});

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
	return ttsCoordinator.currentOverlayState({
		overlayTabId: ttsOverlayTabId,
		playbackState: ttsState,
		settings: ttsSettingsSnapshot,
	});
}

async function ensureTtsOverlayWorld(): Promise<void> {
	if (ttsWorldConfigured) return;
	await configureTtsOverlayWorld();
	ttsWorldConfigured = true;
}

async function sendKokoroProbeResult(tabId: number, force = false): Promise<KokoroHealthStatus> {
	const providerSecrets = await getBackgroundProviderSecrets();
	const span = extensionTelemetry.startSpan("tts.kokoro.probe", {
		attributes: {
			"tts.provider": "kokoro",
			"tts.force_probe": force,
		},
	});
	logTtsEvent("probe.start", { baseUrl: ttsSettingsSnapshot.kokoroBaseUrl, force });
	try {
		const status = force
			? await refreshKokoroHealth(ttsSettingsSnapshot.kokoroBaseUrl, providerSecrets.kokoroKey)
			: await probeKokoroHealth(ttsSettingsSnapshot.kokoroBaseUrl, providerSecrets.kokoroKey);
		span.setAttributes({
			"tts.kokoro.status": status.status,
			"tts.kokoro.latency_ms": status.latencyMs,
		});
		span.end("ok");
		logTtsEvent("probe.result", {
			status: status.status,
			latencyMs: status.latencyMs,
			message: status.message,
		});
		sendToOverlay(tabId, { type: "tts-kokoro-probe-result", status });
		return status;
	} catch (error) {
		span.recordError(error);
		span.end("error");
		const status: KokoroHealthStatus = {
			status: "error",
			message: error instanceof Error ? error.message : String(error),
		};
		sendToOverlay(tabId, { type: "tts-kokoro-probe-result", status });
		return status;
	}
}

async function syncTtsOverlay(): Promise<void> {
	if (!ttsOverlayTabId || !ttsState.overlayVisible) {
		return;
	}
	const port = overlayPorts.get(ttsOverlayTabId);
	if (port) {
		sendToOverlay(ttsOverlayTabId, {
			type: "tts-sync-state",
			state: currentTtsOverlayState(),
			settings: ttsSettingsSnapshot,
		});
		return;
	}
	await ensureTtsOverlayWorld();
	await injectTtsOverlay(ttsOverlayTabId, currentTtsOverlayState());
}

async function closeTtsOverlay(tabId = ttsOverlayTabId): Promise<void> {
	if (!tabId) {
		return;
	}
	try {
		await removeTtsOverlay(tabId);
	} catch (error) {
		console.warn("[Background:TTS] Failed to remove overlay:", error);
	}
	markOverlayDetached(tabId);
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
				justification: "Persistent agent sessions, REPL sandbox execution, and TTS audio playback",
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

function endReadingSession(sessionId: string, notifyOverlay = true): void {
	ttsCoordinator.endReadingSession(sessionId, notifyOverlay);
}

function forwardPlayhead(sessionId: string, playhead: TtsPlayhead): void {
	ttsCoordinator.forwardPlayhead(sessionId, playhead);
}

async function speakCommand(payload: TtsSpeakPayload, context: { tabId?: number } = {}): Promise<TtsRuntimeResponse> {
	await refreshTtsSettingsState();
	if (!ttsSettingsSnapshot.enabled) {
		return { ok: false, error: "TTS is disabled in settings" };
	}

	const tabId = context.tabId ?? ttsOverlayTabId ?? undefined;
	const sessionId = ttsCoordinator.createSessionId(payload);
	const requestedProvider = ttsSettingsSnapshot.provider;
	const fallbackProvider = ttsCoordinator.rememberFallbackProvider(sessionId, payload.fallbackProvider);
	let probeStatus: KokoroHealthStatus | null = null;
	if (payload.command.kind === "page-target" && requestedProvider === "kokoro") {
		probeStatus = isKokoroHealthStale(ttsSettingsSnapshot.kokoroBaseUrl)
			? await sendKokoroProbeResult(tabId ?? ttsOverlayTabId ?? 0, true)
			: await sendKokoroProbeResult(tabId ?? ttsOverlayTabId ?? 0, false);
	}
	const plan = ttsCoordinator.planSpeak({
		payload,
		sessionId,
		settings: ttsSettingsSnapshot,
		tabId,
		fallbackProvider,
		kokoroStatus: probeStatus,
	});
	if ("error" in plan) {
		return { ok: false, error: plan.error };
	}

	const providerSecrets = await getBackgroundProviderSecrets();
	ttsState = reduceTtsPlaybackState(ttsState, {
		type: "speak-start",
		text: plan.preparedText,
		truncated: plan.truncated,
	});
	logTtsEvent("session.start", {
		sessionId,
		provider: plan.provider,
		sourceKind: payload.command.kind,
		hasReadAlong: plan.hasReadAlong,
		fallbackReason: plan.fallbackReason,
		requestedProvider,
	});
	await syncTtsOverlay();

	const offscreenMessage: TtsOffscreenMessage = ttsCoordinator.createOffscreenMessage(
		plan,
		ttsSettingsSnapshot,
		providerSecrets,
	);

	const response = await dispatchTtsOffscreenMessage(offscreenMessage);
	if (!response.ok) {
		ttsCoordinator.clearFallbackProvider(sessionId);
		return { ok: false, error: response.error };
	}

	if (payload.command.kind === "page-target" && tabId) {
		if (plan.hasReadAlong) {
			ttsCoordinator.startReadingSession({
				sessionId,
				tabId,
				provider: plan.provider,
				sourceKind: "page-target",
				text: plan.preparedText,
				hasReadAlong: true,
				fallbackReason: plan.fallbackReason,
			});
		} else {
			ttsCoordinator.clearFallbackProvider(sessionId);
		}
		sendToOverlay(tabId, {
			type: "tts-session-ack",
			sessionId,
			hasReadAlong: plan.hasReadAlong,
			fallbackReason: plan.fallbackReason,
		});
	} else if (!plan.hasReadAlong) {
		ttsCoordinator.clearFallbackProvider(sessionId);
	}

	await applyOffscreenEvent(response);
	return {
		ok: true,
		state: ttsState,
		settings: ttsSettingsSnapshot,
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
		await closeTtsOverlay(ttsOverlayTabId);
	}

	await ensureTtsOverlayWorld();
	ttsOverlayTabId = tabId;
	ttsState = reduceTtsPlaybackState(ttsState, { type: "overlay-opened" });
	await syncTtsOverlay();
	void sendKokoroProbeResult(tabId, true);
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
			return speakCommand({
				command: {
					kind: "raw-text",
					text: message.text || getSampleTtsPhrase(),
					source: "sidepanel",
				},
			});
		case "tts-speak-text": {
			const source = message.source || "sidepanel";
			return speakCommand({
				command:
					source === "click"
						? {
								kind: "page-target",
								text: message.text,
								source: "click",
								truncated: false,
								targetSummary: {
									blockCount: 1,
									textLength: message.text.length,
								},
							}
						: {
								kind: "raw-text",
								text: message.text,
								source,
							},
			});
		}
		case "tts-kokoro-probe": {
			const status = await sendKokoroProbeResult(sender?.tab?.id ?? ttsOverlayTabId ?? 0, true);
			return status.status === "error"
				? { ok: false, error: status.message || "Kokoro probe failed" }
				: getTtsStateResponse();
		}
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
			ensureBackgroundStorage();
			ttsSettingsSnapshot = await saveTtsSettings({
				provider,
				voiceId: getProviderVoiceId(ttsSettingsSnapshot, provider),
			});
			const providerSecrets = await getBackgroundProviderSecrets();
			ttsVoices = await listTtsVoices(provider, ttsSettingsSnapshot, providerSecrets).catch(() => []);
			ttsState = reduceTtsPlaybackState(ttsState, {
				type: "set-provider",
				provider,
				voiceId: ttsSettingsSnapshot.voiceId,
				voices: ttsVoices,
			});
			await syncTtsOverlay();
			if (provider === "kokoro" && ttsOverlayTabId) {
				void sendKokoroProbeResult(ttsOverlayTabId, true);
			}
			return getTtsStateResponse();
		}
		case "tts-set-voice": {
			ttsState = reduceTtsPlaybackState(ttsState, {
				type: "set-voice",
				voiceId: message.voiceId,
			});
			ensureBackgroundStorage();
			ttsSettingsSnapshot = await saveTtsSettings({
				voiceId: message.voiceId,
				...(ttsSettingsSnapshot.provider === "kokoro" ? { kokoroVoiceId: message.voiceId } : {}),
				...(ttsSettingsSnapshot.provider === "openai" ? { openaiVoiceId: message.voiceId } : {}),
				...(ttsSettingsSnapshot.provider === "elevenlabs" ? { elevenLabsVoiceId: message.voiceId } : {}),
			});
			await syncTtsOverlay();
			return getTtsStateResponse();
		}
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
			return speakCommand(message.command.payload, { tabId: sender?.tab?.id });
		case "pause":
			return handleTtsRuntimeMessage({ type: "tts-pause" });
		case "resume":
			return handleTtsRuntimeMessage({ type: "tts-resume" });
		case "stop":
			return handleTtsRuntimeMessage({ type: "tts-stop" }, sender);
		case "close":
			return handleTtsRuntimeMessage({ type: "tts-close-overlay" }, sender);
		case "probe-kokoro":
			return handleTtsRuntimeMessage(
				{ type: "tts-kokoro-probe", baseUrl: ttsSettingsSnapshot.kokoroBaseUrl },
				sender,
			);
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

function handleTtsOverlayPortMessage(message: unknown, tabId: number): void {
	if (!message || typeof message !== "object") {
		return;
	}
	const typedMessage = message as TtsOverlayMessage;
	if ((typedMessage as { type?: string }).type !== "tts-overlay-command") {
		return;
	}
	void handleTtsOverlayMessage(typedMessage, { tab: { id: tabId } } as chrome.runtime.MessageSender).catch((error) => {
		console.warn("[Background:TTS] Overlay port command failed:", error);
	});
}

// ============================================================================
// REPL ROUTER (background -> exact offscreen window session)
// ============================================================================

function createReplRouter(windowId: number): ReplRouter {
	return {
		async execute(params, signal, traceContext) {
			if (signal?.aborted) {
				throw Object.assign(new Error("REPL execution aborted"), { code: ErrorCodes.ABORTED });
			}
			const descriptor = await requireAgentRuntimeDescriptor(windowId);
			const result = await agentRuntimeCoordinator.requestSession(
				descriptor,
				{
					type: "repl-execute",
					executionId: crypto.randomUUID(),
					code: params.code,
					language: "javascript",
				},
				{ signal, trace: traceContext },
			);
			if (!runtimeRecord(result)) throw new Error("Offscreen REPL returned a malformed result");
			const content = Array.isArray(result.content) ? result.content : [];
			const output = content
				.filter(runtimeTextContent)
				.map((entry) => entry.text)
				.join("\n");
			const details = runtimeRecord(result.details) ? result.details : undefined;
			const files = Array.isArray(details?.files)
				? details.files.filter(runtimeReplFile).map((file) => ({ ...file }))
				: [];
			return { output, files };
		},
	};
}

// ============================================================================
// SCREENSHOT ROUTER (background -> sidepanel or CDP fallback)
// ============================================================================

const sharedDebuggerManager = getSharedDebuggerManager();

function readPngDimensions(base64: string): { imageWidth: number; imageHeight: number } {
	const binary = atob(base64);
	if (binary.length < 24 || binary.slice(1, 4) !== "PNG") {
		throw new Error("Screenshot data is not a valid PNG");
	}
	const readUint32 = (offset: number) =>
		((binary.charCodeAt(offset) << 24) |
			(binary.charCodeAt(offset + 1) << 16) |
			(binary.charCodeAt(offset + 2) << 8) |
			binary.charCodeAt(offset + 3)) >>>
		0;
	return { imageWidth: readUint32(16), imageHeight: readUint32(20) };
}

function normalizeScreenshotViewport(value: unknown): {
	cssWidth: number;
	cssHeight: number;
	devicePixelRatio: number;
} {
	const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const cssWidth = typeof candidate.cssWidth === "number" && candidate.cssWidth > 0 ? candidate.cssWidth : 1;
	const cssHeight = typeof candidate.cssHeight === "number" && candidate.cssHeight > 0 ? candidate.cssHeight : 1;
	const devicePixelRatio =
		typeof candidate.devicePixelRatio === "number" && candidate.devicePixelRatio > 0 ? candidate.devicePixelRatio : 1;
	return { cssWidth, cssHeight, devicePixelRatio };
}

const screenshotRouter: ScreenshotRouter = {
	async capture(params, signal, traceContext) {
		return captureScreenshotForWindow(await resolveWindowId(), params, signal, traceContext);
	},
};

async function captureScreenshotForWindow(
	windowId: number | undefined,
	params: Parameters<ScreenshotRouter["capture"]>[0],
	signal?: AbortSignal,
	traceContext?: Parameters<ScreenshotRouter["capture"]>[2],
): ReturnType<ScreenshotRouter["capture"]> {
	if (signal?.aborted) {
		throw Object.assign(new Error("Screenshot capture aborted"), { code: ErrorCodes.ABORTED });
	}

	// Use CDP Page.captureScreenshot via DebuggerManager.
	// captureVisibleTab + canvas image processing hangs in service worker context.
	// Resolve the active tab through the shared helper so screenshot follows the
	// same window-id semantics as every other bridge command (no inline
	// `windowId=0` query that can fall through to "no tab").
	let tabId: number;
	try {
		const resolved = await resolveTabTarget({ windowId, tabId: params.tabId });
		tabId = resolved.tabId;
	} catch {
		throw new Error("No active tab for screenshot");
	}
	const owner = `screenshot:${tabId}:${Date.now()}`;

	await sharedDebuggerManager.acquireWithTrace(tabId, owner, { parent: traceContext });
	try {
		await sharedDebuggerManager.ensureDomainWithTrace(tabId, "Page", { parent: traceContext });
		await sharedDebuggerManager.ensureDomainWithTrace(tabId, "Runtime", { parent: traceContext });
		const viewportResult = await sharedDebuggerManager.sendCommandWithTrace<{
			result?: { value?: unknown };
		}>(
			tabId,
			"Runtime.evaluate",
			{
				expression:
					"({ cssWidth: window.innerWidth, cssHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 })",
				returnByValue: true,
			},
			{ parent: traceContext },
		);
		const result = await sharedDebuggerManager.sendCommandWithTrace<{ data: string }>(
			tabId,
			"Page.captureScreenshot",
			{
				format: "png",
				captureBeyondViewport: false,
			},
			{ parent: traceContext },
		);
		if (signal?.aborted) {
			throw Object.assign(new Error("Screenshot capture aborted"), { code: ErrorCodes.ABORTED });
		}
		if (!result?.data) throw new Error("CDP Page.captureScreenshot returned no data");
		const { imageWidth, imageHeight } = readPngDimensions(result.data);
		const viewport = normalizeScreenshotViewport(viewportResult.result?.value);
		return {
			mimeType: "image/png",
			dataUrl: `data:image/png;base64,${result.data}`,
			imageWidth,
			imageHeight,
			cssWidth: viewport.cssWidth,
			cssHeight: viewport.cssHeight,
			devicePixelRatio: viewport.devicePixelRatio,
			scale: imageWidth / viewport.cssWidth,
		};
	} finally {
		await sharedDebuggerManager.releaseWithTrace(tabId, owner, { parent: traceContext });
	}
}

// ============================================================================
// RECORDING ROUTER (background -> debugger screencast recorder)
// ============================================================================

const recordingToolsByWindowId = new Map<number, RecordingTools>();
const pageDriverRegistriesByWindowId = new Map<number, ChromePageDriverRegistry>();

function getPageDriverRegistry(windowId: number): ChromePageDriverRegistry {
	let registry = pageDriverRegistriesByWindowId.get(windowId);
	if (!registry) {
		registry = new ChromePageDriverRegistry({
			ownerWindowId: windowId,
			sessionId: `bridge-window:${windowId}`,
			debuggerManager: sharedDebuggerManager,
		});
		pageDriverRegistriesByWindowId.set(windowId, registry);
	}
	return registry;
}

async function getRecordingTools(): Promise<RecordingTools> {
	const windowId = await resolveWindowId();
	if (!isUsableWindowId(windowId)) {
		throw new Error("No usable browser window for recording");
	}
	let tools = recordingToolsByWindowId.get(windowId);
	if (!tools) {
		tools = new RecordingTools({
			windowId,
			pageDriverRegistry: getPageDriverRegistry(windowId),
			emitRecordFrame: (data) => getBridgeSessionForWindow(windowId)?.client.sendEvent("record_frame", { ...data }),
			telemetry: extensionTelemetry,
		});
		recordingToolsByWindowId.set(windowId, tools);
	}
	return tools;
}

async function getRecordingToolsForControl(tabId?: number): Promise<RecordingTools> {
	if (typeof tabId === "number") {
		for (const tools of recordingToolsByWindowId.values()) {
			if (tools.hasRecordingForTab(tabId)) return tools;
		}
		return getRecordingTools();
	}
	const activeTools = Array.from(recordingToolsByWindowId.values()).filter(
		(tools) => tools.getActiveTabIds().length > 0,
	);
	if (activeTools.length === 1) return activeTools[0];
	return getRecordingTools();
}

const recordingRouter: RecordingRouter = {
	async start(params, signal, traceContext) {
		return (await getRecordingTools()).start(params, signal, traceContext);
	},
	async stop(params, signal, traceContext) {
		return (await getRecordingToolsForControl(params.tabId)).stop(params, signal, traceContext);
	},
	async status(params, traceContext) {
		return (await getRecordingToolsForControl(params.tabId)).status(params, traceContext);
	},
};

// ============================================================================
// SESSION BRIDGE ADAPTER (background -> offscreen runtime)
// ============================================================================

function sessionBridgeError(message: string, code: number): Error {
	return Object.assign(new Error(message), { code });
}

async function requireAgentRuntimeDescriptor(windowId: number): Promise<AgentRuntimeConnectionDescriptor> {
	const descriptors = await agentRuntimeCoordinator.getDescriptorsForWindow(windowId);
	if (descriptors.length === 0) {
		throw sessionBridgeError("No active agent session", ErrorCodes.NO_ACTIVE_SESSION);
	}
	if (descriptors.length > 1) {
		throw sessionBridgeError("Browser window has multiple active agent sessions", ErrorCodes.SESSION_MISMATCH);
	}
	const descriptor = descriptors[0];
	if (!descriptor) throw sessionBridgeError("No active agent session", ErrorCodes.NO_ACTIVE_SESSION);
	try {
		await agentRuntimeCoordinator.waitForSessionReady(descriptor);
	} catch (error) {
		throw sessionBridgeError(
			error instanceof Error ? error.message : "Agent session did not become ready",
			ErrorCodes.NO_ACTIVE_SESSION,
		);
	}
	return descriptor;
}

async function resolveBackgroundModel(spec: string, providerHint?: string) {
	registerShuvgeistProviderModels();
	const storage = ensureBackgroundStorage();
	const customProviders = await storage.customProviders.getAll();
	const model = await resolveModelSpec(spec, providerHint, {
		getCustomProviderByName: async (providerName) =>
			customProviders.find((provider) => provider.name === providerName || provider.id === providerName),
		getAllCustomProviders: async () => customProviders.slice(),
	});
	return normalizeModelForRuntime(model);
}

async function runtimeSessionSnapshot(windowId: number): Promise<{
	descriptor: AgentRuntimeConnectionDescriptor;
	runtime: Awaited<ReturnType<AgentRuntimeCoordinator["refreshSnapshot"]>>;
	bridge: SessionSnapshot;
}> {
	const descriptor = await requireAgentRuntimeDescriptor(windowId);
	const runtime = await agentRuntimeCoordinator.refreshSnapshot(descriptor);
	const metadata = await ensureBackgroundStorage()
		.sessions.getMetadata(descriptor.sessionId)
		.catch(() => null);
	const messages = projectSessionMessages(runtime.messages as unknown as Parameters<typeof projectSessionMessages>[0]);
	return {
		descriptor,
		runtime,
		bridge: {
			sessionId: descriptor.sessionId,
			persisted: true,
			title: metadata?.title ?? "",
			model: runtime.model ? { provider: runtime.model.provider, id: runtime.model.id } : undefined,
			isStreaming: runtime.isStreaming,
			messageCount: runtime.messages.length,
			lastMessageIndex: runtime.messages.length - 1,
			messages,
		},
	};
}

async function replaceRuntimeSessionLock(windowId: number, sessionId: string): Promise<void> {
	const locks = (await readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.sessionLocks)) ?? {};
	const next = Object.fromEntries(Object.entries(locks).filter(([, ownerWindowId]) => ownerWindowId !== windowId));
	next[sessionId] = windowId;
	await writeBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.sessionLocks, next);
}

function runtimeRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyRecordKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function isAgentRuntimeAbortIntent(value: unknown): value is AgentRuntimeAbortIntent {
	if (
		!runtimeRecord(value) ||
		!hasOnlyRecordKeys(value, [
			"clientId",
			"windowId",
			"sessionId",
			"target",
			"executionId",
			"targetRequestId",
			"reason",
		]) ||
		typeof value.clientId !== "string" ||
		!value.clientId.trim() ||
		!Number.isSafeInteger(value.windowId) ||
		(value.windowId as number) < 0 ||
		typeof value.sessionId !== "string" ||
		!value.sessionId.trim() ||
		typeof value.executionId !== "string" ||
		!value.executionId.trim() ||
		typeof value.targetRequestId !== "string" ||
		!value.targetRequestId.trim() ||
		typeof value.reason !== "string" ||
		!value.reason.trim() ||
		!runtimeRecord(value.target)
	) {
		return false;
	}
	const target = value.target;
	return (
		hasOnlyRecordKeys(target, ["kind", "tabRef", "tabId", "frameId"]) &&
		target.kind === "chrome-tab" &&
		typeof target.tabRef === "string" &&
		(target.tabRef === "active" || /^window:\d+$/.test(target.tabRef)) &&
		(target.tabId === undefined || (Number.isSafeInteger(target.tabId) && (target.tabId as number) >= 0)) &&
		(target.frameId === undefined || (Number.isSafeInteger(target.frameId) && (target.frameId as number) >= 0))
	);
}

function abortIntentMatchesDescriptor(
	intent: AgentRuntimeAbortIntent,
	descriptor: AgentRuntimeConnectionDescriptor,
): boolean {
	if (
		intent.clientId !== descriptor.clientId ||
		intent.windowId !== descriptor.windowId ||
		intent.sessionId !== descriptor.sessionId ||
		intent.target.kind !== "chrome-tab" ||
		descriptor.target.kind !== "chrome-tab"
	) {
		return false;
	}
	return (
		intent.target.tabRef === descriptor.target.tabRef &&
		intent.target.tabId === descriptor.target.tabId &&
		intent.target.frameId === descriptor.target.frameId
	);
}

function runtimeTextContent(value: unknown): value is { type: "text"; text: string } {
	return runtimeRecord(value) && value.type === "text" && typeof value.text === "string";
}

function runtimeReplFile(value: unknown): value is {
	fileName: string;
	mimeType: string;
	size: number;
	contentBase64: string;
} {
	return (
		runtimeRecord(value) &&
		typeof value.fileName === "string" &&
		typeof value.mimeType === "string" &&
		typeof value.size === "number" &&
		typeof value.contentBase64 === "string"
	);
}

function createBackgroundSessionBridge(windowId: number): SessionBridgeAdapter {
	const waitForIdle = async (): Promise<void> => {
		for (;;) {
			const { runtime } = await runtimeSessionSnapshot(windowId);
			if (!runtime.isStreaming && runtime.activeExecutions.length === 0) return;
			await delay(50);
		}
	};

	return {
		async getSnapshot() {
			return (await runtimeSessionSnapshot(windowId)).bridge;
		},
		waitForIdle,
		async appendInjectedMessage(params: SessionInjectParams): Promise<SessionInjectResult> {
			let { descriptor, runtime } = await runtimeSessionSnapshot(windowId);
			if (params.expectedSessionId !== descriptor.sessionId) {
				throw sessionBridgeError("Active session changed", ErrorCodes.SESSION_MISMATCH);
			}
			if (runtime.isStreaming || runtime.activeExecutions.length > 0) {
				if (params.waitForIdle === false) {
					throw sessionBridgeError("Session is busy", ErrorCodes.SESSION_BUSY);
				}
				await waitForIdle();
				({ descriptor, runtime } = await runtimeSessionSnapshot(windowId));
			}
			const messageIndex = runtime.messages.length;
			const timestamp = Date.now();
			if (params.role === "assistant") {
				const model = runtime.model;
				if (!model) throw sessionBridgeError("Active session has no model", ErrorCodes.NO_ACTIVE_SESSION);
				await agentRuntimeCoordinator.requestSession(descriptor, {
					type: "replace-or-append-message",
					expectedRevision: runtime.revision,
					message: {
						role: "assistant",
						content: [{ type: "text", text: params.content }],
						api: model.api ?? "unknown",
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp,
					},
				});
			} else {
				void agentRuntimeCoordinator
					.requestSession(descriptor, {
						type: "prompt",
						executionId: crypto.randomUUID(),
						message: { role: "user", content: params.content, timestamp },
					})
					.catch((error: unknown) => console.warn("[Background:AgentRuntime] Injected prompt failed:", error));
			}
			return { ok: true, sessionId: descriptor.sessionId, messageIndex };
		},
		async newSession(params: SessionNewParams): Promise<SessionNewResult> {
			const existing = (await agentRuntimeCoordinator.getDescriptorsForWindow(windowId))[0];
			if (existing) await waitForIdle();
			const model = params.model ? await resolveBackgroundModel(params.model) : undefined;
			const descriptor: AgentRuntimeConnectionDescriptor = {
				clientId: existing?.clientId ?? "sidepanel",
				windowId,
				sessionId: crypto.randomUUID(),
				target: { kind: "chrome-tab", tabRef: `window:${windowId}` },
				mode: "create",
				systemPrompt: SYSTEM_PROMPT,
				...(model ? { model: modelToRuntimeDescriptor(model) } : {}),
			};
			if (existing) await agentRuntimeCoordinator.replaceSession(descriptor, "bridge-new-session");
			else await agentRuntimeCoordinator.bindSession(descriptor);
			await agentRuntimeCoordinator.requestSession(descriptor, {
				type: "create",
				systemPrompt: descriptor.systemPrompt,
				...(descriptor.model ? { model: descriptor.model } : {}),
			});
			const snapshot = await agentRuntimeCoordinator.waitForSessionReady(descriptor);
			await replaceRuntimeSessionLock(windowId, descriptor.sessionId);
			return {
				ok: true,
				sessionId: descriptor.sessionId,
				model: snapshot.model ? { provider: snapshot.model.provider, id: snapshot.model.id } : undefined,
			};
		},
		async setModel(params: SessionSetModelParams): Promise<SessionSetModelResult> {
			const descriptor = await requireAgentRuntimeDescriptor(windowId);
			const model = await resolveBackgroundModel(params.model, params.provider);
			const runtimeModel = modelToRuntimeDescriptor(model);
			await agentRuntimeCoordinator.requestSession(descriptor, { type: "set-model", model: runtimeModel });
			return { ok: true, model: { provider: runtimeModel.provider, id: runtimeModel.id } };
		},
		async getArtifacts(): Promise<SessionArtifactsResult> {
			const { descriptor, runtime } = await runtimeSessionSnapshot(windowId);
			const artifacts = await Promise.all(
				runtime.artifacts.map(async (artifact) => {
					const value = await agentRuntimeCoordinator.requestSession(descriptor, {
						type: "artifacts",
						payload: { action: "get", filename: artifact.filename },
					});
					const record = runtimeRecord(value) && runtimeRecord(value.artifact) ? value.artifact : undefined;
					if (!record || typeof record.content !== "string") return undefined;
					return {
						filename: artifact.filename,
						content: record.content,
						createdAt: typeof record.createdAt === "string" ? record.createdAt : (artifact.createdAt ?? ""),
						updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : (artifact.updatedAt ?? ""),
					};
				}),
			);
			return {
				sessionId: descriptor.sessionId,
				artifacts: artifacts.filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== undefined),
			};
		},
		subscribe() {
			return () => {};
		},
	};
}

// ============================================================================
// DYNAMIC CAPABILITY REPORTING
// ============================================================================

function getCurrentCapabilities(windowId: number): BridgeCapability[] {
	const allCapabilities = getBridgeCapabilities(currentSettings?.sensitiveAccessEnabled ?? false);
	const sessionCapabilities = new Set<BridgeCapability>([
		"repl",
		"session_history",
		"session_inject",
		"session_new",
		"session_set_model",
		"session_artifacts",
	]);

	const hasAgentSession = agentRuntimeCoordinator
		.getReadyDescriptors()
		.some((descriptor) => descriptor.windowId === windowId);

	return allCapabilities.filter((cap) => {
		if (sessionCapabilities.has(cap)) {
			return hasAgentSession;
		}
		return true;
	});
}

// ============================================================================
// BRIDGE CLIENT
// ============================================================================

interface BridgeWindowSession {
	windowId: number;
	client: BridgeClient;
	executor: BrowserCommandExecutor;
}

const bridgeWindowSessions = new Map<number, BridgeWindowSession>();
const bridgeSettingsStorage = createChromeStorageBridgeSettingsAdapter();
let currentSettings: BridgeSettings | null = null;
let bootstrapSettingsPromise: Promise<BridgeSettings> | null = null;
let bootstrapSettingsUrl: string | null = null;
/**
 * Last cached usable window id (positive integer). `undefined` means we have
 * never observed a usable focused window. Treated as "no target" everywhere.
 */
let currentWindowId: number | undefined;

function agentRuntimeDescriptorKey(
	descriptor: Pick<AgentRuntimeConnectionDescriptor, "clientId" | "windowId">,
): string {
	return runtimeClientRouteKey(descriptor.clientId, descriptor.windowId);
}

let agentRuntimeRegistryTail: Promise<void> = Promise.resolve();

function updateAgentRuntimeRegistry(
	update: (registry: AgentRuntimeConnectionRegistry) => AgentRuntimeConnectionRegistry,
): Promise<void> {
	const write = agentRuntimeRegistryTail
		.catch(() => undefined)
		.then(async () => {
			const registry = (await readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.agentRuntimeConnections)) ?? {};
			await writeBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.agentRuntimeConnections, update(registry));
		});
	agentRuntimeRegistryTail = write;
	return write;
}

const agentRuntimePageExecutors = new Map<string, BrowserCommandExecutor>();
const agentRuntimeShownSkillsStates = new Map<string, ShownSkillsState>();

type AgentRuntimeExecutorScope = Pick<AgentRuntimePageDelegateInput, "clientId" | "windowId" | "sessionId">;

function agentRuntimeExecutorKey(input: AgentRuntimeExecutorScope): string {
	return JSON.stringify([input.clientId, input.windowId, input.sessionId]);
}

function getAgentRuntimeShownSkillsState(input: AgentRuntimeExecutorScope): ShownSkillsState {
	const key = agentRuntimeExecutorKey(input);
	let state = agentRuntimeShownSkillsStates.get(key);
	if (!state) {
		state = new ShownSkillsState();
		agentRuntimeShownSkillsStates.set(key, state);
	}
	return state;
}

function getAgentRuntimePageExecutor(input: AgentRuntimeExecutorScope): BrowserCommandExecutor {
	const key = agentRuntimeExecutorKey(input);
	let executor = agentRuntimePageExecutors.get(key);
	if (!executor) {
		executor = new BrowserCommandExecutor({
			windowId: input.windowId,
			sessionId: input.sessionId,
			sensitiveAccessEnabled: currentSettings?.sensitiveAccessEnabled ?? false,
			pageDriverRegistry: getPageDriverRegistry(input.windowId),
			screenshotRouter: {
				capture: (params, signal, traceContext) =>
					captureScreenshotForWindow(input.windowId, params, signal, traceContext),
			},
			shownSkillsState: getAgentRuntimeShownSkillsState(input),
			telemetry: extensionTelemetry,
		});
		agentRuntimePageExecutors.set(key, executor);
	}
	return executor;
}

function pageSnapshotResult(value: unknown): PageSnapshotResult | undefined {
	if (!runtimeRecord(value) || !Array.isArray(value.entries)) return undefined;
	if (
		typeof value.tabId !== "number" ||
		!Number.isSafeInteger(value.tabId) ||
		typeof value.frameId !== "number" ||
		!Number.isSafeInteger(value.frameId) ||
		typeof value.url !== "string" ||
		typeof value.title !== "string" ||
		typeof value.generatedAt !== "number" ||
		!Number.isFinite(value.generatedAt) ||
		typeof value.totalCandidates !== "number" ||
		!Number.isSafeInteger(value.totalCandidates) ||
		typeof value.truncated !== "boolean"
	) {
		return undefined;
	}
	return structuredClone(value) as unknown as PageSnapshotResult;
}

async function createAgentRuntimeNavigationMessage(
	descriptor: AgentRuntimeExecutorScope,
	tab: AgentRuntimeNavigationTab,
): Promise<RuntimeAgentMessage | undefined> {
	if (!tab.url || isProtectedTabUrl(tab.url)) return undefined;
	ensureBackgroundStorage();
	let snapshot: PageSnapshotResult | undefined;
	if (typeof tab.id === "number") {
		try {
			const result = await getAgentRuntimePageExecutor(descriptor).dispatch("page_snapshot", {
				tabId: tab.id,
				maxEntries: 60,
			});
			snapshot = pageSnapshotResult(result);
		} catch (error) {
			console.warn("[Background:AgentRuntime] Failed to capture navigation snapshot:", error);
		}
	}
	const message = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id, snapshot, {
		shownSkillsState: getAgentRuntimeShownSkillsState(descriptor),
	});
	return structuredClone(message) as unknown as RuntimeAgentMessage;
}

async function executeAgentRuntimePageOperation(input: AgentRuntimePageDelegateInput): Promise<unknown> {
	if (input.operation === "navigation-context") {
		const [tab] = await chrome.tabs.query({ active: true, windowId: input.windowId });
		if (!tab) return null;
		return (await createAgentRuntimeNavigationMessage(input, tab)) ?? null;
	}
	if (input.operation === "browser-js" || input.operation === "native-input") {
		if (input.operation === "browser-js") ensureBackgroundStorage();
		const response = await handleBackgroundPageRuntimeOperation(
			input.operation,
			input.payload,
			input.windowId,
			extensionTelemetry,
			input.trace,
			input.signal,
		);
		if (!response.success) throw new Error(response.error || `${input.operation} failed`);
		return input.operation === "browser-js"
			? {
					success: true,
					...(response.result !== undefined ? { result: response.result } : {}),
					...(response.console !== undefined ? { console: response.console } : {}),
					...(response.artifactMutations !== undefined ? { artifactMutations: response.artifactMutations } : {}),
				}
			: (response.result ?? null);
	}
	if (input.operation === "repl-overlay-show") {
		const taskName = input.payload.taskName;
		if (typeof taskName !== "string" || !taskName.trim()) {
			throw new Error("REPL overlay requires a non-empty task name");
		}
		if (!input.executionId || !input.executionRequestId) {
			throw new Error("REPL overlay requires an exact parent execution identity");
		}
		const abortIntent: ReplOverlayAbortIntent = {
			clientId: input.clientId,
			windowId: input.windowId,
			sessionId: input.sessionId,
			target: input.target,
			executionId: input.executionId,
			targetRequestId: input.executionRequestId,
			reason: "Stopped from the page activity overlay",
		};
		await injectOverlayForActiveTab(taskName, abortIntent, input.windowId);
		return { shown: true };
	}
	if (input.operation === "repl-overlay-remove") {
		await removeOverlayForActiveTab(input.windowId);
		return { removed: true };
	}
	if (input.operation === "extract-image-source") {
		const selector = input.payload.selector;
		if (typeof selector !== "string" || !selector.trim()) {
			throw new Error("Image extraction requires a non-empty selector");
		}
		const { tabId } = await resolveTabTarget({ windowId: input.windowId, frameId: input.target.frameId });
		const result = await getImageInfoFromPage(tabId, selector);
		if (typeof result === "string") throw new Error(result);
		return result;
	}
	if (input.operation === "debugger") {
		const { debuggerMode } = await loadDeveloperSettings();
		if (!debuggerMode) throw new Error("Debugger tool is disabled unless developer debugger mode is enabled");
		if (input.payload.tabId !== undefined || input.payload.frameId !== undefined) {
			throw new Error("Debugger page operations cannot override the exact session target");
		}
		const action = input.payload.action;
		if (action !== "eval" && action !== "cookies") throw new Error("Debugger action must be eval or cookies");
		const code = input.payload.code;
		if (code !== undefined && typeof code !== "string") throw new Error("Debugger code must be a string");
		const tool = new DebuggerTool({ windowId: input.windowId, debuggerManager: getSharedDebuggerManager() });
		return tool.executeBridge(
			input.operationId,
			{
				action,
				...(typeof code === "string" ? { code } : {}),
				...(input.target.frameId !== undefined ? { frameId: input.target.frameId } : {}),
			},
			input.signal,
			input.trace,
		);
	}

	const executor = getAgentRuntimePageExecutor(input);
	switch (input.operation) {
		case "navigate":
			return executor.dispatch(
				"navigate",
				scopeAgentRuntimeNavigatePayload(input.payload, input.windowId),
				input.signal,
				input.trace,
			);
		case "page-snapshot":
			return executor.dispatch("page_snapshot", input.payload, input.signal, input.trace);
		case "select-element":
			return executor.dispatch("select_element", input.payload, input.signal, input.trace);
		case "screenshot":
			return executor.dispatch("screenshot", input.payload, input.signal, input.trace);
	}
}

const agentRuntimePageController = new AgentRuntimePageController({
	authorize: (input) =>
		authorizeAgentRuntimePageTarget(input, {
			async getWindowId(tabId) {
				const tab = await chrome.tabs.get(tabId);
				return tab.windowId;
			},
		}),
	createDelegate: () => ({ execute: executeAgentRuntimePageOperation }),
	reportError: (error, context) => console.warn(`[Background:AgentRuntime] ${context}:`, error),
});

const agentRuntimeSidepanelTrackingRegistry = new AgentRuntimeSidepanelTrackingRegistry();

const SIDEPANEL_WINDOW_AUTHORITY_STORAGE_KEY = "shuvgeist.sidepanelWindowAuthority.v2";

function sidepanelWindowAuthorityStorageArea(): chrome.storage.StorageArea | undefined {
	return (chrome.storage as typeof chrome.storage & { session?: chrome.storage.StorageArea }).session;
}

const sidepanelWindowAuthority = new SidepanelWindowAuthority({
	extensionId: chrome.runtime.id,
	sidepanelUrl: chrome.runtime.getURL("sidepanel.html"),
	sidePanelContextType: chrome.runtime.ContextType.SIDE_PANEL,
	getContexts: () =>
		chrome.runtime.getContexts({
			contextTypes: [chrome.runtime.ContextType.SIDE_PANEL],
		}),
	storage: {
		async load() {
			const area = sidepanelWindowAuthorityStorageArea();
			if (!area) throw new Error("chrome.storage.session is unavailable for sidepanel authority");
			return (await area.get(SIDEPANEL_WINDOW_AUTHORITY_STORAGE_KEY))[SIDEPANEL_WINDOW_AUTHORITY_STORAGE_KEY];
		},
		async save(state: SidepanelWindowAuthorityState) {
			const area = sidepanelWindowAuthorityStorageArea();
			if (!area) throw new Error("chrome.storage.session is unavailable for sidepanel authority");
			await area.set({ [SIDEPANEL_WINDOW_AUTHORITY_STORAGE_KEY]: state });
		},
	},
});

chrome.sidePanel.onOpened?.addListener((info) => {
	agentRuntimeSidepanelTrackingRegistry.revokeWindow(info.windowId);
	agentRuntimeCoordinator.revokeWindowPorts(info.windowId);
	void sidepanelWindowAuthority.observeOpened(info).catch((error: unknown) => {
		console.warn("[Background:SidepanelAuthority] Failed to bind opened sidepanel:", error);
	});
});

const agentRuntimeCoordinator = new AgentRuntimeCoordinator({
	ensureOffscreen: ensureOffscreenDocument,
	async sendToOffscreen(message) {
		const response = await sendMessageSafe<unknown>(message);
		if (response === null) throw new Error("Offscreen agent runtime did not respond");
		return response;
	},
	checkpointStorage: {
		load: () => readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.agentRuntime),
		save: (state) => writeBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.agentRuntime, state),
	},
	isSidepanelLeaseCurrent: (lease) => sidepanelWindowAuthority.isLeaseCurrent(lease),
	async loadAcceptedDescriptors() {
		const registry = (await readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.agentRuntimeConnections)) ?? {};
		return Object.values(registry);
	},
	onDescriptorBound(descriptor) {
		const persisted = updateAgentRuntimeRegistry((registry) => ({
			...registry,
			[agentRuntimeDescriptorKey(descriptor)]: structuredClone(descriptor),
		}));
		void persisted.then(sendBridgeCapabilitiesUpdate);
		return persisted;
	},
	async onDescriptorReleased(descriptor) {
		await updateAgentRuntimeRegistry((registry) => {
			const next = { ...registry };
			delete next[agentRuntimeDescriptorKey(descriptor)];
			return next;
		});
		const key = agentRuntimeExecutorKey(descriptor);
		const executor = agentRuntimePageExecutors.get(key);
		agentRuntimePageExecutors.delete(key);
		agentRuntimeShownSkillsStates.delete(key);
		await executor?.dispose();
		sendBridgeCapabilitiesUpdate();
	},
	onSessionReadinessChanged() {
		sendBridgeCapabilitiesUpdate();
	},
	handlePageControlMessage: (message) => agentRuntimePageController.handle(message),
	reportError: (error, context) => console.warn(`[Background:AgentRuntime] ${context}:`, error),
});

void agentRuntimeCoordinator
	.initialize()
	.catch((error: unknown) => console.warn("[Background:AgentRuntime] Failed to initialize coordinator:", error));

const agentRuntimeNavigationSteering = new AgentRuntimeNavigationSteering({
	getDescriptorsForWindow: (windowId) => agentRuntimeCoordinator.getReadyDescriptorsForWindow(windowId),
	getLatestSnapshot: (descriptor) =>
		agentRuntimeCoordinator.getLatestSnapshot(descriptor.clientId, descriptor.windowId),
	createMessage: createAgentRuntimeNavigationMessage,
	async steer(descriptor, message) {
		await agentRuntimeCoordinator.requestSession(descriptor, { type: "steer", message });
	},
	isProtectedUrl: isProtectedTabUrl,
	reportError: (error, context) => console.warn(`[Background:AgentRuntime] ${context}:`, error),
});

async function handleAgentRuntimeAbortIntent(
	message: Record<string, unknown>,
	sender: chrome.runtime.MessageSender,
): Promise<{ ok: true }> {
	if (!hasOnlyRecordKeys(message, ["type", "intent"]) || !isAgentRuntimeAbortIntent(message.intent)) {
		throw new Error("Malformed agent runtime abort intent");
	}
	const intent = message.intent;
	const senderTab = sender.tab;
	if (!senderTab || senderTab.windowId !== intent.windowId) {
		throw new Error("Agent runtime abort intent did not originate from its bound browser window");
	}
	if (intent.target.kind !== "chrome-tab" || intent.target.tabRef !== `window:${intent.windowId}`) {
		throw new Error("Agent runtime abort intent does not name its bound logical tab target");
	}
	if (intent.target.tabId !== undefined && senderTab.id !== intent.target.tabId) {
		throw new Error("Agent runtime abort intent did not originate from its bound browser tab");
	}
	const descriptors = await agentRuntimeCoordinator.getReadyDescriptorsForWindow(intent.windowId);
	const descriptor = descriptors.find((candidate) => candidate.clientId === intent.clientId);
	if (!descriptor || !abortIntentMatchesDescriptor(intent, descriptor)) {
		throw new Error("Agent runtime abort intent does not match an accepted session");
	}
	await agentRuntimeCoordinator.requestSession(descriptor, {
		type: "abort",
		executionId: intent.executionId,
		targetRequestId: intent.targetRequestId,
		reason: intent.reason,
	});
	return { ok: true };
}

function getCurrentBridgeSession(): BridgeWindowSession | undefined {
	if (isUsableWindowId(currentWindowId)) return bridgeWindowSessions.get(currentWindowId);
	return Array.from(bridgeWindowSessions.values()).find((session) => session.client.connectionState === "connected");
}

function getBridgeSessionForWindow(windowId: number | undefined): BridgeWindowSession | undefined {
	if (!isUsableWindowId(windowId)) return undefined;
	return bridgeWindowSessions.get(windowId);
}

async function disposeBridgeWindowResources(windowId: number): Promise<void> {
	const session = bridgeWindowSessions.get(windowId);
	const recordingTools = recordingToolsByWindowId.get(windowId);
	const pageDrivers = pageDriverRegistriesByWindowId.get(windowId);

	// Drop ownership before awaiting teardown. A later reconnect can create a
	// fresh resource set without ever receiving a disposed registry or recorder.
	bridgeWindowSessions.delete(windowId);
	recordingToolsByWindowId.delete(windowId);
	pageDriverRegistriesByWindowId.delete(windowId);

	session?.client.disconnect();

	const cleanupResults = await Promise.allSettled([
		session?.executor.dispose(),
		(async () => {
			try {
				await recordingTools?.dispose();
			} finally {
				await pageDrivers?.dispose();
			}
		})(),
	]);
	for (const result of cleanupResults) {
		if (result.status === "rejected") {
			console.warn(`[Background] Failed to fully dispose bridge resources for window ${windowId}:`, result.reason);
		}
	}
}

async function disconnectBridgeSessions(): Promise<void> {
	const windowIds = new Set([
		...bridgeWindowSessions.keys(),
		...recordingToolsByWindowId.keys(),
		...pageDriverRegistriesByWindowId.keys(),
	]);
	await Promise.all([...windowIds].map((windowId) => disposeBridgeWindowResources(windowId)));
}

function sendBridgeCapabilitiesUpdate(): void {
	for (const session of bridgeWindowSessions.values()) {
		session.client.sendCapabilitiesUpdate();
	}
}

function nudgeBridgeReconnects(): void {
	for (const session of bridgeWindowSessions.values()) {
		session.client.nudgeReconnect();
	}
}

function currentBridgeConnectionState(): { state: BridgeConnectionState; detail?: string } {
	const session = getCurrentBridgeSession();
	return {
		state: session?.client.connectionState ?? "disconnected",
		detail: session?.client.connectionDetail,
	};
}

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
	await writeBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.bridge, stateData);
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
	// The bridge advertises capabilities synchronously during connect and may
	// receive a REPL command immediately afterward. Recover persisted offscreen
	// sessions first so neither path observes an empty coordinator after a
	// service-worker restart with the sidepanel closed.
	try {
		await agentRuntimeCoordinator.initialize();
	} catch (error) {
		await disconnectBridgeSessions();
		await setBridgeState(
			"error",
			error instanceof Error ? error.message : "Failed to initialize the agent runtime coordinator",
		);
		return;
	}
	const previousSettings = currentSettings;
	const { settings } = await loadBridgeSettings(bridgeSettingsStorage);
	applyBridgeObservabilitySettings(settings);

	if (!settings.enabled) {
		await disconnectBridgeSessions();
		currentSettings = settings;
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
			await disconnectBridgeSessions();
			currentSettings = resolvedSettings;
			await setBridgeState("disconnected", error instanceof Error ? error.message : "Local bridge bootstrap failed");
			return;
		}
	}

	if (!resolvedSettings.token) {
		await disconnectBridgeSessions();
		currentSettings = resolvedSettings;
		await setBridgeState("disconnected", "Enter the remote bridge token to connect.");
		return;
	}

	const settingsChanged = settingsRequireReconnect(previousSettings, resolvedSettings);
	if (settingsChanged) {
		await disconnectBridgeSessions();
	}
	currentSettings = resolvedSettings;

	const windowId = await resolveWindowId();

	// Never register the bridge with an invalid target. Defer connection until a
	// usable focused window becomes available (chrome.windows.onFocusChanged or
	// the next keepalive alarm will retry).
	if (!isUsableWindowId(windowId)) {
		console.log("[Background] Deferring bridge connection until a usable window id is available");
		await setBridgeState("disconnected", "Waiting for a usable browser window");
		return;
	}

	let session = bridgeWindowSessions.get(windowId);
	if (!session) {
		session = {
			windowId,
			client: new BridgeClient(),
			executor: new BrowserCommandExecutor({
				windowId,
				pageDriverRegistry: getPageDriverRegistry(windowId),
				sensitiveAccessEnabled: resolvedSettings.sensitiveAccessEnabled,
				sessionBridge: createBackgroundSessionBridge(windowId),
				replRouter: createReplRouter(windowId),
				screenshotRouter,
				recordingRouter,
				telemetry: extensionTelemetry,
			}),
		};
		bridgeWindowSessions.set(windowId, session);
	}

	const stateRequiresReconnect =
		session.client.connectionState === "disabled" ||
		session.client.connectionState === "disconnected" ||
		session.client.connectionState === "error";

	if (!stateRequiresReconnect) {
		await setBridgeState(session.client.connectionState, session.client.connectionDetail);
		return;
	}

	session.client.connect({
		url: resolvedSettings.url,
		token: resolvedSettings.token,
		windowId,
		sensitiveAccessEnabled: resolvedSettings.sensitiveAccessEnabled,
		executor: session.executor,
		telemetry: extensionTelemetry,
		capabilitiesProvider: () => getCurrentCapabilities(windowId),
		onStateChange: (state, detail) => {
			if (currentWindowId === windowId) {
				void setBridgeState(state, detail);
			}
		},
		onEvent: (event, data) => {
			if (event === "electron_sessions_changed" && data?.sessions && Array.isArray(data.sessions)) {
				const state: BridgeElectronStateData = {
					sessions: data.sessions as BridgeElectronStateData["sessions"],
					updatedAt: new Date().toISOString(),
				};
				void writeBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.electron, state);
			}
		},
	});
	session.client.nudgeReconnect();
}

// ============================================================================
// KEEPALIVE (alarms)
// ============================================================================

chrome.alarms.create("bridge-keepalive", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "bridge-keepalive") {
		void ensureBridgeConnection().then(() => {
			// If a client settled into a disconnected/error state (bridge
			// server was down, extension backoff hit its cap, ...), bypass the
			// in-flight exponential backoff and retry now. Without this, the
			// extension can sit in a long wait even after the bridge has come
			// back up, which makes cold-start CLI commands look as if the
			// extension is not connected.
			nudgeBridgeReconnects();
		});
	}
});

// ============================================================================
// STORAGE CHANGE LISTENER (bridge settings)
// ============================================================================

chrome.storage.onChanged.addListener((changes, areaName) => {
	if (bridgeSettingsFromStorageChange(changes, areaName)) {
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
	try {
		const tab = await chrome.tabs.get(activeInfo.tabId);
		void agentRuntimeNavigationSteering.handleTab(tab);
		const session = getBridgeSessionForWindow(activeInfo.windowId);
		if (session?.client.connectionState !== "connected") return;
		session.client.sendEvent("active_tab_changed", {
			url: tab.url || "",
			title: tab.title || "",
			tabId: tab.id,
		});
	} catch {
		// Tab may not exist
	}
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
	if (changeInfo.url && tab.active) void agentRuntimeNavigationSteering.handleTab(tab);
	const session = getBridgeSessionForWindow(tab.windowId);
	if (session?.client.connectionState !== "connected") return;
	if (changeInfo.status !== "complete" || !tab.active) return;
	session.client.sendEvent("active_tab_changed", {
		url: tab.url || "",
		title: tab.title || "",
		tabId: tab.id,
	});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (tabId !== ttsOverlayTabId || changeInfo.status !== "complete") return;
	if (!ttsState.overlayVisible || isProtectedTabUrl(tab.url)) return;
	markOverlayDetached(tabId);
	for (const session of ttsCoordinator.getSessionsForTab(tabId)) {
		sendToOverlay(tabId, { type: "tts-session-end", sessionId: session.id });
	}
	void syncTtsOverlay().catch((error) => {
		console.warn("[Background:TTS] Failed to re-sync overlay after navigation:", error);
	});
});

chrome.tabs.onRemoved.addListener((tabId) => {
	for (const [windowId, registry] of pageDriverRegistriesByWindowId) {
		const tools = recordingToolsByWindowId.get(windowId);
		if (tools) tools.handleTabClosed(tabId);
		else void registry.release(tabId);
	}
	if (tabId === ttsOverlayTabId) {
		ttsOverlayTabId = null;
		ttsState = reduceTtsPlaybackState(ttsState, { type: "overlay-closed" });
	}
	for (const session of ttsCoordinator.getSessionsForTab(tabId)) {
		endReadingSession(session.id, false);
	}
	markOverlayDetached(tabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
	if (!isUsableWindowId(windowId)) return;
	currentWindowId = windowId;

	// Ensure the focused window has its own bridge client without disconnecting
	// clients owned by other windows.
	if (!getBridgeSessionForWindow(windowId)) {
		await ensureBridgeConnection();
	}

	const session = getBridgeSessionForWindow(windowId);
	if (session?.client.connectionState !== "connected") return;
	try {
		const [tab] = await chrome.tabs.query({ active: true, windowId });
		if (tab?.id) {
			session.client.sendEvent("active_tab_changed", {
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
		if (runtimeRecord(message) && message.type === "agent-runtime-abort-intent") {
			void handleAgentRuntimeAbortIntent(message, sender)
				.then((response) => sendResponse(response))
				.catch((error: unknown) =>
					sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
				);
			return true;
		}
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
	});
}

// Handle messages from sidepanel and offscreen
chrome.runtime.onMessage.addListener(
	(
		message: Record<string, unknown>,
		_sender: chrome.runtime.MessageSender,
		sendResponse: (response: unknown) => void,
	) => {
		const offscreenUrl = chrome.runtime.getURL("offscreen.html");
		const isOffscreenSender =
			_sender.id === chrome.runtime.id &&
			_sender.tab === undefined &&
			_sender.url === offscreenUrl &&
			_sender.origin === new URL(offscreenUrl).origin;
		if (isOffscreenSender) {
			if (message.type === "agent-runtime-get-developer-settings" && hasOnlyRecordKeys(message, ["type"])) {
				void loadDeveloperSettings()
					.then(({ debuggerMode }) =>
						sendResponse({ ok: true, debuggerMode } satisfies AgentRuntimeDeveloperSettingsResponse),
					)
					.catch((error: unknown) =>
						sendResponse({
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						} satisfies AgentRuntimeDeveloperSettingsResponse),
					);
				return true;
			}
			const runtimeResponse = agentRuntimeCoordinator.handleOffscreenMessage(message);
			if (runtimeResponse) {
				void runtimeResponse
					.then((response) => sendResponse(response))
					.catch((error: unknown) =>
						sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
					);
				return true;
			}
		}

		if (message.type === SIDEPANEL_WINDOW_PREPARE_MESSAGE_TYPE) {
			void sidepanelWindowAuthority
				.prepareWindow(message, _sender)
				.then((response) => {
					if (response.ok) {
						agentRuntimeSidepanelTrackingRegistry.revokeWindow(response.windowId);
						agentRuntimeCoordinator.revokeWindowPorts(response.windowId);
					}
					sendResponse(response);
				})
				.catch((error: unknown) => {
					console.warn("[Background:SidepanelAuthority] Failed to resolve sidepanel window:", error);
					sendResponse({ ok: false, error: "Unable to authenticate the sidepanel browser window" });
				});
			return true;
		}
		if (message.type === SIDEPANEL_WINDOW_CONFIRM_MESSAGE_TYPE) {
			void sidepanelWindowAuthority
				.confirmWindow(message, _sender)
				.then((response) => sendResponse(response))
				.catch((error: unknown) => {
					console.warn("[Background:SidepanelAuthority] Failed to confirm sidepanel window:", error);
					sendResponse({ ok: false, error: "Unable to confirm the sidepanel browser-window continuation" });
				});
			return true;
		}

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

		if (message.type === "tts-offscreen-playhead") {
			forwardPlayhead(message.sessionId as string, message.playhead as TtsPlayhead);
			sendResponse({ ok: true });
			return false;
		}

		if (message.type === "tts-offscreen-session-end") {
			endReadingSession(message.sessionId as string);
			sendResponse({ ok: true });
			return false;
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
			const connection = currentBridgeConnectionState();
			const stateData: BridgeStateData = {
				state: connection.state,
				detail: connection.detail,
			};
			sendResponse(stateData);
			return false;
		}

		return false;
	},
);

function registerTtsOverlayPort(port: chrome.runtime.Port): void {
	const tabId = port.sender?.tab?.id;
	if (!tabId) {
		return;
	}
	const existing = overlayPorts.get(tabId);
	if (existing && existing !== port) {
		try {
			existing.disconnect();
		} catch {}
	}
	overlayPorts.set(tabId, port);
	ttsCoordinator.markOverlayAttached(tabId);
	port.onMessage.addListener((message) => {
		handleTtsOverlayPortMessage(message, tabId);
	});
	port.onDisconnect.addListener(() => {
		if (overlayPorts.get(tabId) === port) {
			overlayPorts.delete(tabId);
		}
		markOverlayDetached(tabId);
	});
	sendToOverlay(tabId, {
		type: "tts-sync-state",
		state: currentTtsOverlayState(),
		settings: ttsSettingsSnapshot,
	});
	void sendKokoroProbeResult(tabId, false);
}

if (chrome.runtime.onUserScriptConnect) {
	chrome.runtime.onUserScriptConnect.addListener((port) => {
		if (port.name === "shuvgeist-tts-overlay") {
			registerTtsOverlayPort(port);
		}
	});
}

function agentRuntimePortAuthenticationOptions() {
	return {
		extensionId: chrome.runtime.id,
		sidepanelUrl: chrome.runtime.getURL("sidepanel.html"),
		sidePanelContextType: chrome.runtime.ContextType.SIDE_PANEL,
		resolveSidepanelLease: (documentNonce: string, material: SidepanelCapabilityMaterial, documentId?: string) =>
			sidepanelWindowAuthority.resolveActiveLease(documentNonce, material, documentId),
		isSidepanelLeaseCurrent: (lease: SidepanelLeaseIdentity) => sidepanelWindowAuthority.isLeaseCurrent(lease),
		reportError: (error: unknown, context: string) =>
			console.warn(`[Background:AgentRuntime] Runtime port ${context} failed:`, error),
	};
}

const sidepanelPresentationTails = new Map<number, Promise<void>>();

function serializeSidepanelPresentation(windowId: number, work: () => Promise<void>): void {
	const previous = sidepanelPresentationTails.get(windowId) ?? Promise.resolve();
	const current = previous
		.catch(() => undefined)
		.then(work)
		.catch((error: unknown) => console.warn("[Background:Sidepanel] Failed to persist presentation state:", error));
	sidepanelPresentationTails.set(windowId, current);
	void current.finally(() => {
		if (sidepanelPresentationTails.get(windowId) === current) sidepanelPresentationTails.delete(windowId);
	});
}

function acceptSidepanelTrackingPort(
	port: chrome.runtime.Port,
	lease: SidepanelLeaseIdentity,
	initialMessages: readonly unknown[] = [],
): boolean {
	const windowId = lease.windowId;
	const isCurrent = async (): Promise<boolean> =>
		agentRuntimeSidepanelTrackingRegistry.isCurrent(port, lease) &&
		(await sidepanelWindowAuthority.isLeaseCurrent(lease));
	if (!agentRuntimeSidepanelTrackingRegistry.isCurrent(port, lease)) return false;
	serializeSidepanelPresentation(windowId, async () => {
		if (!(await isCurrent())) return;
		const storedOpenWindows = await readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.openSidepanels);
		if (!(await isCurrent())) return;
		openSidepanels = markSidepanelOpen(openSidepanels, windowId);
		const openWindows = new Set<number>(storedOpenWindows ?? []);
		openWindows.add(windowId);
		await writeBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.openSidepanels, Array.from(openWindows));
		if (await isCurrent()) sendBridgeCapabilitiesUpdate();
	});

	const onMessage = (value: unknown): void => {
		if (!runtimeRecord(value)) return;
		const msg = value as unknown as SidepanelToBackgroundMessage;
		if (msg.type === "acquireLock") {
			const { sessionId, windowId: reqWindowId } = msg;
			if (
				typeof sessionId !== "string" ||
				!sessionId.trim() ||
				!Number.isSafeInteger(reqWindowId) ||
				reqWindowId !== windowId
			) {
				return;
			}
			void readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.sessionLocks).then(async (storedSessionLocks) => {
				if (!(await isCurrent())) return;
				const sessionLocks = storedSessionLocks ?? {};
				const { response, nextLocks } = buildLockResult(sessionLocks, openSidepanels, sessionId, reqWindowId);
				if (response.success) {
					await writeBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.sessionLocks, nextLocks);
				}
				if (!(await isCurrent())) return;
				port.postMessage(response);
			});
		} else if (msg.type === "getLockedSessions") {
			void readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.sessionLocks).then(async (storedLocks) => {
				if (!(await isCurrent())) return;
				const locks = storedLocks ?? {};
				port.postMessage(buildLockedSessionsMessage(locks));
			});
		}
	};
	port.onMessage.addListener(onMessage);
	for (const message of initialMessages) onMessage(message);

	port.onDisconnect.addListener(() => {
		serializeSidepanelPresentation(windowId, async () => {
			if (!(await isCurrent())) return;
			const storedOpenWindows = await readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.openSidepanels);
			if (!(await isCurrent())) return;
			agentRuntimeSidepanelTrackingRegistry.remove(port);
			openSidepanels = initializeOpenSidepanels(
				markSidepanelClosed({ sessionLocks: {}, openWindows: Array.from(openSidepanels) }, windowId).openWindows,
			);
			const openWindows = new Set<number>(storedOpenWindows ?? []);
			openWindows.delete(windowId);
			await writeBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.openSidepanels, Array.from(openWindows));
			sendBridgeCapabilitiesUpdate();
		});
	});
	return true;
}

// Authenticate both runtime and lifetime ports before they can claim a sidepanel route.
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
	const authenticationOptions = agentRuntimePortAuthenticationOptions();
	if (authenticateAndAcceptAgentRuntimePort(port, agentRuntimeCoordinator, authenticationOptions)) return;
	if (
		authenticateAndAcceptSidepanelTrackingPort(
			port,
			agentRuntimeSidepanelTrackingRegistry,
			{ acceptPort: acceptSidepanelTrackingPort },
			authenticationOptions,
		)
	) {
		return;
	}
});

// Clean up locks when entire window closes
chrome.windows.onRemoved.addListener((windowId: number) => {
	if (currentWindowId === windowId) currentWindowId = undefined;
	agentRuntimeSidepanelTrackingRegistry.revokeWindow(windowId);
	agentRuntimeCoordinator.revokeWindowPorts(windowId);
	void sidepanelWindowAuthority.releaseWindow(windowId).catch((error: unknown) => {
		console.warn("[Background:SidepanelAuthority] Failed to release browser-window authority:", error);
	});
	void agentRuntimeCoordinator
		.releaseWindow(windowId, "browser-window-removed")
		.catch((error: unknown) => console.warn("[Background:AgentRuntime] Failed to release window:", error));
	void disposeBridgeWindowResources(windowId);
	closeSidepanel(windowId, false, true);
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

function closeSidepanel(windowId: number, callCloseOnSidePanelAPI = true, releaseRuntimeOwnership = false) {
	if (callCloseOnSidePanelAPI) {
		(chrome.sidePanel as { close(options: { windowId: number }): void }).close({ windowId });
	}

	const updateWindowState = releaseRuntimeOwnership ? releaseWindowState : markSidepanelClosed;
	openSidepanels = initializeOpenSidepanels(
		updateWindowState({ sessionLocks: {}, openWindows: Array.from(openSidepanels) }, windowId).openWindows,
	);

	void Promise.all([
		readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.sessionLocks),
		readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.openSidepanels),
	]).then(([storedSessionLocks, storedOpenWindows]) => {
		const sessionLocks = storedSessionLocks ?? {};
		const openWindows = storedOpenWindows ?? [];
		const nextState = updateWindowState({ sessionLocks, openWindows }, windowId);
		return writeBridgeRuntimeStates({
			[BRIDGE_RUNTIME_STATE_KEYS.sessionLocks]: nextState.sessionLocks,
			[BRIDGE_RUNTIME_STATE_KEYS.openSidepanels]: nextState.openWindows,
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
function sendMessageSafe<T>(message: BridgeToOffscreenMessage | TtsOffscreenMessage): Promise<T | null> {
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
