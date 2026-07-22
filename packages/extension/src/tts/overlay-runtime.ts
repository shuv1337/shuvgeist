import type { TtsOverlayCommand, TtsPortMessage, TtsSpeakPayload } from "./internal-messages.js";
import { OVERLAY_CSS, OVERLAY_HTML, OVERLAY_TAG } from "./overlay-content.js";
import {
	endReadAlongSession,
	getActiveSessionId,
	handlePlayheadUpdate,
	startReadAlongSession,
} from "./page-runtime.js";
import { buildReadingSurface, disposeReadingSurface, type PreparedReadingSurface } from "./reading-surface.js";
import { resolveTtsPageTarget } from "./text-targeting.js";
import type { KokoroHealthStatus, TtsOverlayState, TtsSettingsSnapshot } from "./types.js";

interface PendingSurface {
	sessionId: string;
	surface: PreparedReadingSurface;
}

interface OverlayRuntimeController {
	reconnect(): void;
	remove(): void;
}

interface OverlayElements {
	root: HTMLElement;
	shadow: ShadowRoot;
	textArea: HTMLTextAreaElement;
	providerSelect: HTMLSelectElement;
	voiceSelect: HTMLSelectElement;
	clickModeButton: HTMLButtonElement;
	statusText: HTMLElement;
	extraText: HTMLElement;
	kokoroStatusText: HTMLElement;
	retryKokoroButton: HTMLButtonElement;
	statusBanner: HTMLElement;
	statusBannerText: HTMLElement;
	statusBannerActions: HTMLElement;
	fallbackOpenAiButton: HTMLButtonElement;
	fallbackElevenLabsButton: HTMLButtonElement;
}

const PORT_NAME = "shuvgeist-tts-overlay";
const SETUP_DOCS_URL = "https://github.com/remsky/Kokoro-FastAPI";

let elements: OverlayElements | null = null;
let port: chrome.runtime.Port | null = null;
let currentState: TtsOverlayState | null = null;
let currentSettings: TtsSettingsSnapshot | null = null;
let kokoroStatus: KokoroHealthStatus | null = null;
let pendingSurface: PendingSurface | null = null;
let clickHandler: ((event: MouseEvent) => void) | null = null;
let keyHandler: ((event: KeyboardEvent) => void) | null = null;

function generateSessionId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `tts-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureOverlay(): OverlayElements {
	if (elements) {
		return elements;
	}

	const existingRoot = document.querySelector<HTMLElement>(OVERLAY_TAG);
	existingRoot?.remove();

	const root = document.createElement(OVERLAY_TAG);
	document.documentElement.appendChild(root);
	const shadow = root.attachShadow({ mode: "open" });

	const style = document.createElement("style");
	style.textContent = OVERLAY_CSS;
	shadow.appendChild(style);

	const container = document.createElement("div");
	container.innerHTML = OVERLAY_HTML;
	shadow.appendChild(container);

	const nextElements: OverlayElements = {
		root,
		shadow,
		textArea: getRequiredElement(shadow, "#sg-tts-text", HTMLTextAreaElement),
		providerSelect: getRequiredElement(shadow, "#sg-tts-provider", HTMLSelectElement),
		voiceSelect: getRequiredElement(shadow, "#sg-tts-voice", HTMLSelectElement),
		clickModeButton: getRequiredElement(shadow, "#sg-tts-click-mode", HTMLButtonElement),
		statusText: getRequiredElement(shadow, "#sg-tts-status", HTMLElement),
		extraText: getRequiredElement(shadow, "#sg-tts-extra", HTMLElement),
		kokoroStatusText: getRequiredElement(shadow, "#sg-tts-kokoro-status", HTMLElement),
		retryKokoroButton: getRequiredElement(shadow, "#sg-tts-retry-kokoro", HTMLButtonElement),
		statusBanner: getRequiredElement(shadow, "#sg-tts-status-banner", HTMLElement),
		statusBannerText: getRequiredElement(shadow, "#sg-tts-status-banner-text", HTMLElement),
		statusBannerActions: getRequiredElement(shadow, "#sg-tts-status-banner-actions", HTMLElement),
		fallbackOpenAiButton: getRequiredElement(shadow, "#sg-tts-fallback-openai", HTMLButtonElement),
		fallbackElevenLabsButton: getRequiredElement(shadow, "#sg-tts-fallback-elevenlabs", HTMLButtonElement),
	};

	wireUi(nextElements);
	const setupLink = shadow.querySelector<HTMLAnchorElement>("#sg-tts-kokoro-link");
	if (setupLink) {
		setupLink.href = SETUP_DOCS_URL;
	}
	elements = nextElements;
	return nextElements;
}

function getRequiredElement<T extends typeof HTMLElement>(
	root: ParentNode,
	selector: string,
	ctor: T,
): InstanceType<T> {
	const element = root.querySelector(selector);
	if (!(element instanceof ctor)) {
		throw new Error(`Missing overlay element: ${selector}`);
	}
	return element as InstanceType<T>;
}

function wireUi(nextElements: OverlayElements): void {
	const { shadow } = nextElements;
	getRequiredElement(shadow, "#sg-tts-speak", HTMLButtonElement).addEventListener("click", () => {
		void speakFromOverlay();
	});
	getRequiredElement(shadow, "#sg-tts-pause", HTMLButtonElement).addEventListener("click", () => {
		sendCommand({ type: "pause" });
	});
	getRequiredElement(shadow, "#sg-tts-resume", HTMLButtonElement).addEventListener("click", () => {
		sendCommand({ type: "resume" });
	});
	getRequiredElement(shadow, "#sg-tts-stop", HTMLButtonElement).addEventListener("click", () => {
		sendCommand({ type: "stop" });
	});
	nextElements.clickModeButton.addEventListener("click", () => {
		sendCommand({ type: "set-click-mode", armed: !currentState?.clickModeArmed });
	});
	nextElements.providerSelect.addEventListener("change", () => {
		sendCommand({ type: "set-provider", provider: nextElements.providerSelect.value as TtsOverlayState["provider"] });
	});
	nextElements.voiceSelect.addEventListener("change", () => {
		sendCommand({ type: "set-voice", voiceId: nextElements.voiceSelect.value });
	});
	getRequiredElement(shadow, "#sg-tts-close", HTMLButtonElement).addEventListener("click", () => {
		sendCommand({ type: "close" });
		removeOverlay();
	});
	nextElements.retryKokoroButton.addEventListener("click", () => {
		sendCommand({ type: "probe-kokoro" });
	});
	nextElements.fallbackOpenAiButton.addEventListener("click", () => {
		void retryPendingSurface("openai");
	});
	nextElements.fallbackElevenLabsButton.addEventListener("click", () => {
		void retryPendingSurface("elevenlabs");
	});
}

function connectPort(): void {
	if (port) {
		return;
	}
	port = chrome.runtime.connect({ name: PORT_NAME });
	port.onMessage.addListener((message: TtsPortMessage) => {
		handlePortMessage(message);
	});
	port.onDisconnect.addListener(() => {
		port = null;
		setClickMode(false);
		showBanner("error", "The TTS overlay disconnected from the background runtime.");
	});
}

function sendCommand(command: TtsOverlayCommand): void {
	connectPort();
	port?.postMessage({ type: "tts-overlay-command", command });
}

function speakPayloadForText(text: string): TtsSpeakPayload {
	return {
		command: {
			kind: "raw-text",
			text,
			source: "overlay",
		},
	};
}

function clearPendingSurface(): void {
	if (pendingSurface) {
		disposeReadingSurface(pendingSurface.surface);
		pendingSurface = null;
	}
}

function buildPageTargetPayload(
	target: EventTarget | null,
	fallbackProvider?: "openai" | "elevenlabs",
): TtsSpeakPayload | null {
	if (!currentSettings) {
		showBanner("error", "TTS settings are not loaded yet. Retry in a moment.");
		return null;
	}

	const candidate = resolveTtsPageTarget(target, {
		selection: window.getSelection(),
		maxChars: currentSettings.maxTextChars,
	});
	if (!candidate) {
		showBanner("warning", "Select page text or use click-to-speak to start read-along.");
		return null;
	}

	const sessionId = pendingSurface?.sessionId ?? generateSessionId();
	const surface = buildReadingSurface({
		sessionId,
		blocks: candidate.blocks,
		selection: candidate.selection,
		maxChars: currentSettings.maxTextChars,
	});
	if (!surface || !surface.text) {
		clearPendingSurface();
		showBanner("warning", "No readable page text was found for this target.");
		return null;
	}

	clearPendingSurface();
	pendingSurface = { sessionId, surface };
	return {
		sessionId,
		fallbackProvider,
		command: {
			kind: "page-target",
			text: surface.text,
			source: candidate.source,
			truncated: surface.truncated,
			targetSummary: {
				blockCount: surface.blocks.length,
				textLength: surface.text.length,
			},
		},
	};
}

async function speakFromOverlay(): Promise<void> {
	const overlay = ensureOverlay();
	const typedText = overlay.textArea.value.trim();
	if (typedText.length > 0) {
		clearPendingSurface();
		sendCommand({ type: "speak", payload: speakPayloadForText(typedText) });
		return;
	}

	const payload = buildPageTargetPayload(document.activeElement ?? document.body);
	if (!payload) {
		return;
	}
	showBanner("info", "Preparing Kokoro read-along…");
	sendCommand({ type: "speak", payload });
}

async function retryPendingSurface(provider: "openai" | "elevenlabs"): Promise<void> {
	if (pendingSurface) {
		showBanner("warning", `Retrying the same passage with ${provider === "openai" ? "OpenAI" : "ElevenLabs"} once…`);
		sendCommand({
			type: "speak",
			payload: {
				sessionId: pendingSurface.sessionId,
				fallbackProvider: provider,
				command: {
					kind: "page-target",
					text: pendingSurface.surface.text,
					source: "selection",
					truncated: pendingSurface.surface.truncated,
					targetSummary: {
						blockCount: pendingSurface.surface.blocks.length,
						textLength: pendingSurface.surface.text.length,
					},
				},
			},
		});
		return;
	}

	const payload = buildPageTargetPayload(document.activeElement ?? document.body, provider);
	if (!payload) {
		return;
	}
	showBanner("warning", `Retrying with ${provider === "openai" ? "OpenAI" : "ElevenLabs"} once…`);
	sendCommand({ type: "speak", payload });
}

function setClickMode(armed: boolean): void {
	if (armed && !clickHandler) {
		clickHandler = (event: MouseEvent) => {
			const target = event.target;
			const payload = buildPageTargetPayload(target);
			if (!payload) {
				return;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			showBanner("info", "Preparing Kokoro read-along…");
			sendCommand({ type: "speak", payload });
		};
		keyHandler = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				sendCommand({ type: "set-click-mode", armed: false });
			}
		};
		document.addEventListener("click", clickHandler, { capture: true });
		document.addEventListener("keydown", keyHandler, { capture: true });
	}

	if (!armed && clickHandler && keyHandler) {
		document.removeEventListener("click", clickHandler, { capture: true });
		document.removeEventListener("keydown", keyHandler, { capture: true });
		clickHandler = null;
		keyHandler = null;
	}
}

function handlePortMessage(message: TtsPortMessage): void {
	switch (message.type) {
		case "tts-sync-state":
			currentState = { ...message.state, enabled: currentState?.enabled ?? true };
			currentSettings = message.settings;
			render();
			return;
		case "tts-kokoro-probe-result":
			kokoroStatus = message.status;
			render();
			return;
		case "tts-session-ack":
			handleSessionAck(message.sessionId, message.hasReadAlong, message.fallbackReason);
			return;
		case "tts-playhead":
			if (message.sessionId === getActiveSessionId()) {
				handlePlayheadUpdate(message.playhead);
			}
			return;
		case "tts-session-end":
			if (message.sessionId === getActiveSessionId()) {
				endReadAlongSession();
			}
			if (pendingSurface?.sessionId === message.sessionId) {
				clearPendingSurface();
			}
			render();
			return;
	}
}

function handleSessionAck(
	sessionId: string,
	hasReadAlong: boolean,
	fallbackReason?: "kokoro-unreachable" | "captioned-unsupported" | "legacy-provider-mode",
): void {
	if (pendingSurface?.sessionId !== sessionId) {
		return;
	}

	if (hasReadAlong) {
		const started = startReadAlongSession(sessionId, { surface: pendingSurface.surface });
		pendingSurface = null;
		if (started.success) {
			showBanner("info", "Read-along active on this page.");
		} else {
			showBanner("warning", started.error || "Read-along could not be attached. Audio will continue.");
		}
		render();
		return;
	}

	clearPendingSurface();
	if (fallbackReason === "captioned-unsupported") {
		showBanner("warning", "Kokoro is reachable, but caption timing is unavailable. Playing audio only.");
	} else if (fallbackReason === "legacy-provider-mode") {
		showBanner("warning", "Compatibility mode is active. This provider plays audio only.");
	} else if (fallbackReason === "kokoro-unreachable") {
		showBanner("warning", "Kokoro is offline. Retry or pick a one-shot fallback.", true);
	} else {
		showBanner("warning", "Audio is playing without page highlights.");
	}
	render();
}

function kokoroStatusLabel(status: KokoroHealthStatus | null): string {
	if (!status) {
		return currentState?.provider === "kokoro" ? "Checking Kokoro…" : "Legacy provider mode";
	}
	switch (status.status) {
		case "ok":
			return status.latencyMs ? `Kokoro ready (${status.latencyMs}ms)` : "Kokoro ready";
		case "captioned-unsupported":
			return "Kokoro online, captions unavailable";
		case "auth-required":
			return "Kokoro auth required";
		case "unreachable":
			return "Kokoro unreachable";
		default:
			return status.message || "Kokoro error";
	}
}

function statusText(): string {
	if (!currentState) {
		return "Loading";
	}
	if (currentState.error) {
		return "Error";
	}
	return currentState.status.charAt(0).toUpperCase() + currentState.status.slice(1);
}

function extraText(): string {
	if (!currentState) {
		return "";
	}
	if (currentState.error) {
		return currentState.error;
	}
	if (pendingSurface) {
		return `${pendingSurface.surface.text.length} chars`;
	}
	if (currentState.truncated) {
		return `Truncated to ${currentSettings?.maxTextChars ?? 3000} chars`;
	}
	if (currentState.currentTextLength) {
		return `${currentState.currentTextLength} chars`;
	}
	return "";
}

function showBanner(kind: "info" | "warning" | "error", text: string, showFallbackActions = false): void {
	const overlay = ensureOverlay();
	overlay.statusBanner.style.display = "grid";
	overlay.statusBanner.className = `sg-tts-status-banner ${kind}`;
	overlay.statusBannerText.textContent = text;
	overlay.statusBannerActions.style.display = showFallbackActions ? "flex" : "none";
}

function hideBanner(): void {
	if (!elements) {
		return;
	}
	elements.statusBanner.style.display = "none";
	elements.statusBannerActions.style.display = "none";
}

function render(): void {
	const overlay = ensureOverlay();
	overlay.statusText.textContent = statusText();
	overlay.extraText.textContent = extraText();
	overlay.kokoroStatusText.textContent = kokoroStatusLabel(kokoroStatus);
	overlay.providerSelect.innerHTML = "";
	for (const provider of ["kokoro", "openai", "elevenlabs"] as const) {
		const option = document.createElement("option");
		option.value = provider;
		option.textContent = provider === "kokoro" ? "kokoro (local)" : provider;
		option.selected = provider === currentState?.provider;
		overlay.providerSelect.appendChild(option);
	}
	overlay.voiceSelect.innerHTML = "";
	for (const voice of currentState?.availableVoices || []) {
		const option = document.createElement("option");
		option.value = voice.id;
		option.textContent = voice.label;
		option.selected = voice.id === currentState?.voiceId;
		overlay.voiceSelect.appendChild(option);
	}
	overlay.clickModeButton.dataset.active = currentState?.clickModeArmed ? "true" : "false";
	overlay.clickModeButton.textContent = currentState?.clickModeArmed ? "Disarm click-to-speak" : "Arm click-to-speak";
	setClickMode(Boolean(currentState?.clickModeArmed));

	if (!currentState?.error && !pendingSurface && currentState?.status !== "loading" && getActiveSessionId() === null) {
		hideBanner();
	}

	if (currentState?.provider !== "kokoro") {
		showBanner("warning", "Compatibility mode is active. Cloud providers are audio-only.");
	}
	if (kokoroStatus?.status === "captioned-unsupported" && currentState?.provider === "kokoro") {
		showBanner("warning", "Kokoro is online, but caption timing is unavailable. Page highlights are disabled.");
	}
	if (
		(kokoroStatus?.status === "unreachable" ||
			kokoroStatus?.status === "auth-required" ||
			kokoroStatus?.status === "error") &&
		currentState?.provider === "kokoro"
	) {
		showBanner("warning", "Kokoro is unavailable. Retry or choose a one-shot fallback.", true);
	}
}

function removeOverlay(): void {
	setClickMode(false);
	clearPendingSurface();
	endReadAlongSession();
	cleanupPort();
	elements?.root.remove();
	elements = null;
}

function cleanupPort(): void {
	try {
		port?.disconnect();
	} catch {}
	port = null;
}

function bootstrap(): void {
	if ((window as Window & { __shuvgeistTtsOverlayRuntime?: OverlayRuntimeController }).__shuvgeistTtsOverlayRuntime) {
		(
			window as Window & { __shuvgeistTtsOverlayRuntime?: OverlayRuntimeController }
		).__shuvgeistTtsOverlayRuntime?.reconnect();
		return;
	}

	ensureOverlay();
	connectPort();
	sendCommand({ type: "probe-kokoro" });
	(window as Window & { __shuvgeistTtsOverlayRuntime?: OverlayRuntimeController }).__shuvgeistTtsOverlayRuntime = {
		reconnect() {
			ensureOverlay();
			connectPort();
			render();
			sendCommand({ type: "probe-kokoro" });
		},
		remove() {
			removeOverlay();
		},
	};
}

bootstrap();

declare global {
	interface Window {
		__shuvgeistTtsOverlayRuntime?: OverlayRuntimeController;
	}
}
