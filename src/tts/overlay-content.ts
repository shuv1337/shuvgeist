/**
 * TTS Overlay content - generates the script injected into pages.
 *
 * Uses Shadow DOM for isolation and persistent port for communication.
 */

import type { TtsOverlayState } from "./types.js";

export const OVERLAY_TAG = "shuvgeist-tts-root";

export const OVERLAY_CSS = `
:host {
	position: fixed;
	right: 20px;
	bottom: 20px;
	z-index: 2147483647;
	width: min(360px, calc(100vw - 24px));
	contain: layout paint style;
}
.overlay-container {
	background: rgba(16, 16, 16, 0.94);
	color: #f3f4f6;
	border: 1px solid rgba(255,255,255,0.12);
	border-radius: 16px;
	box-shadow: 0 18px 48px rgba(0,0,0,0.35);
	backdrop-filter: blur(14px);
	font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
}
.overlay-container * {
	box-sizing: border-box;
}
.overlay-container button,
.overlay-container select,
.overlay-container textarea {
	font: inherit;
}
.sg-tts-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 12px 14px 10px;
	border-bottom: 1px solid rgba(255,255,255,0.08);
}
.sg-tts-body {
	padding: 12px 14px 14px;
	display: grid;
	gap: 10px;
}
.sg-tts-row {
	display: grid;
	gap: 6px;
}
.sg-tts-grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 8px;
}
.sg-tts-actions {
	display: grid;
	grid-template-columns: repeat(4, 1fr);
	gap: 8px;
}
.sg-tts-button {
	border: none;
	border-radius: 10px;
	padding: 8px 10px;
	background: rgba(255,255,255,0.08);
	color: inherit;
	cursor: pointer;
}
.sg-tts-button[data-kind="primary"] {
	background: #f97316;
	color: #111827;
	font-weight: 600;
}
.sg-tts-button[data-active="true"] {
	background: #fb923c;
	color: #111827;
}
.sg-tts-button:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
.sg-tts-input,
.sg-tts-select {
	width: 100%;
	background: rgba(255,255,255,0.06);
	border: 1px solid rgba(255,255,255,0.12);
	color: inherit;
	border-radius: 10px;
	padding: 8px 10px;
}
.sg-tts-select {
	color-scheme: dark;
	background-color: #1f1f1f;
	color: #f3f4f6;
}
.sg-tts-select option {
	background-color: #1f1f1f;
	color: #f3f4f6;
}
.sg-tts-status {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	font-size: 12px;
	color: rgba(243,244,246,0.8);
}
.sg-tts-meta {
	font-size: 11px;
	color: rgba(243,244,246,0.6);
}
.sg-tts-status-banner {
	font-size: 11px;
	padding: 8px 10px;
	border-radius: 8px;
	display: grid;
	gap: 8px;
}
.sg-tts-status-banner.info {
	background: rgba(59, 130, 246, 0.18);
	color: rgba(191, 219, 254, 0.95);
}
.sg-tts-status-banner.warning {
	background: rgba(234, 179, 8, 0.18);
	color: rgba(254, 240, 138, 0.95);
}
.sg-tts-status-banner.error {
	background: rgba(239, 68, 68, 0.18);
	color: rgba(254, 202, 202, 0.95);
}
.sg-tts-inline-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}
.sg-tts-inline-actions .sg-tts-button {
	flex: 1 0 auto;
	padding: 6px 8px;
	font-size: 11px;
}
.sg-tts-link {
	color: #fdba74;
	text-decoration: none;
}
.sg-tts-link:hover {
	text-decoration: underline;
}
`;

export const OVERLAY_HTML = `
<div class="overlay-container">
	<div class="sg-tts-header">
		<div>
			<div style="font-weight:600">Text to Speech</div>
			<div class="sg-tts-meta" id="sg-tts-subtitle">Top frame only in v1</div>
		</div>
		<button id="sg-tts-close" class="sg-tts-button" aria-label="Close overlay">Close</button>
	</div>
	<div class="sg-tts-body">
		<div class="sg-tts-row">
			<label>Text</label>
			<textarea class="sg-tts-input" id="sg-tts-text" rows="4" placeholder="Type text here or arm click-to-speak."></textarea>
		</div>
		<div class="sg-tts-grid">
			<div class="sg-tts-row">
				<label>Provider</label>
				<select class="sg-tts-select" id="sg-tts-provider"></select>
			</div>
			<div class="sg-tts-row">
				<label>Voice</label>
				<select class="sg-tts-select" id="sg-tts-voice"></select>
			</div>
		</div>
		<div class="sg-tts-row">
			<div class="sg-tts-status">
				<span id="sg-tts-kokoro-status">Checking Kokoro…</span>
				<button class="sg-tts-button" id="sg-tts-retry-kokoro" type="button">Retry Kokoro</button>
			</div>
			<div class="sg-tts-meta">
				Kokoro-first read-along works for page text in the top frame. <a class="sg-tts-link" id="sg-tts-kokoro-link" href="https://github.com/remsky/Kokoro-FastAPI" target="_blank" rel="noreferrer">Setup docs</a>
			</div>
		</div>
		<div class="sg-tts-actions">
			<button class="sg-tts-button" data-kind="primary" id="sg-tts-speak">Speak</button>
			<button class="sg-tts-button" id="sg-tts-pause">Pause</button>
			<button class="sg-tts-button" id="sg-tts-resume">Resume</button>
			<button class="sg-tts-button" id="sg-tts-stop">Stop</button>
		</div>
		<div class="sg-tts-row">
			<button class="sg-tts-button" id="sg-tts-click-mode">Arm click-to-speak</button>
		</div>
		<div class="sg-tts-status">
			<span id="sg-tts-status"></span>
			<span id="sg-tts-extra" class="sg-tts-meta"></span>
		</div>
		<div id="sg-tts-status-banner" class="sg-tts-status-banner" style="display:none">
			<div id="sg-tts-status-banner-text"></div>
			<div id="sg-tts-status-banner-actions" class="sg-tts-inline-actions" style="display:none">
				<button class="sg-tts-button" id="sg-tts-fallback-openai" type="button">Use OpenAI once</button>
				<button class="sg-tts-button" id="sg-tts-fallback-elevenlabs" type="button">Use ElevenLabs once</button>
			</div>
		</div>
	</div>
</div>
`;

export function createTtsOverlayScript(state: TtsOverlayState): string {
	return `
(function() {
	const OVERLAY_TAG = ${JSON.stringify(OVERLAY_TAG)};
	const OVERLAY_CSS = ${JSON.stringify(OVERLAY_CSS)};
	const OVERLAY_HTML = ${JSON.stringify(OVERLAY_HTML)};
	const initialState = ${JSON.stringify(state)};

	// State management
	let currentState = initialState;
	let port = null;
	let clickHandler = null;
	let keyHandler = null;
	let root = null;
	let shadow = null;

	function sendCommand(command) {
		if (port) {
			port.postMessage({ type: "tts-overlay-command", command });
		} else {
			chrome.runtime.sendMessage({ type: "tts-overlay-command", command });
		}
	}

	function connectPort() {
		if (port) return;
		try {
			port = chrome.runtime.connect({ name: "shuvgeist-tts-overlay" });
			port.onMessage.addListener((message) => {
				if (message && message.type === "tts-sync-state" && message.state) {
					applyState(message.state);
				}
			});
			port.onDisconnect.addListener(() => {
				port = null;
			});
		} catch (e) {
			console.warn("[TTS Overlay] Failed to connect port:", e);
		}
	}

	function disconnectPort() {
		if (port) {
			port.disconnect();
			port = null;
		}
	}

	function createOverlay() {
		// Remove existing
		const existing = document.querySelector(OVERLAY_TAG);
		if (existing) existing.remove();

		// Create host element
		root = document.createElement(OVERLAY_TAG);
		document.documentElement.appendChild(root);

		// Create shadow DOM
		shadow = root.attachShadow({ mode: "open" });

		// Add styles
		const style = document.createElement("style");
		style.textContent = OVERLAY_CSS;
		shadow.appendChild(style);

		// Add content
		const container = document.createElement("div");
		container.innerHTML = OVERLAY_HTML;
		shadow.appendChild(container);

		// Bind events
		const textArea = shadow.querySelector("#sg-tts-text");
		const providerSelect = shadow.querySelector("#sg-tts-provider");
		const voiceSelect = shadow.querySelector("#sg-tts-voice");

		shadow.querySelector("#sg-tts-speak").addEventListener("click", () => {
			sendCommand({
				type: "speak",
				payload: {
					source: "overlay",
					text: textArea.value || "",
				},
			});
		});

		shadow.querySelector("#sg-tts-pause").addEventListener("click", () => sendCommand({ type: "pause" }));
		shadow.querySelector("#sg-tts-resume").addEventListener("click", () => sendCommand({ type: "resume" }));
		shadow.querySelector("#sg-tts-stop").addEventListener("click", () => sendCommand({ type: "stop" }));

		shadow.querySelector("#sg-tts-click-mode").addEventListener("click", () => {
			sendCommand({
				type: "set-click-mode",
				armed: !currentState.clickModeArmed,
			});
		});

		providerSelect.addEventListener("change", () => {
			sendCommand({ type: "set-provider", provider: providerSelect.value });
		});

		voiceSelect.addEventListener("change", () => {
			sendCommand({ type: "set-voice", voiceId: voiceSelect.value });
		});

		shadow.querySelector("#sg-tts-close").addEventListener("click", () => {
			sendCommand({ type: "close" });
		});

		return shadow;
	}

	function resolveSpeakableText(event) {
		const selection = window.getSelection();
		if (selection && selection.toString().trim()) {
			return selection.toString().replace(/\\s+/g, " ").trim();
		}
		const target = event.target instanceof Node ? event.target : null;
		const element = target instanceof HTMLElement ? target : target && target.parentElement;
		if (!element || element.closest(OVERLAY_TAG)) return "";
		if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable) {
			return "";
		}
		const block = element.closest("p,li,blockquote,td,th,h1,h2,h3,h4,h5,h6,article") || element;
		const text = (block.innerText || block.textContent || "").replace(/\\s+/g, " ").trim();
		return text.length >= 8 ? text : "";
	}

	function setClickMode(armed) {
		if (armed && !clickHandler) {
			clickHandler = (event) => {
				const text = resolveSpeakableText(event);
				if (!text) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				sendCommand({
					type: "speak",
					payload: {
						source: "click",
						text,
					},
				});
			};
			keyHandler = (event) => {
				if (event.key === "Escape") {
					sendCommand({ type: "set-click-mode", armed: false });
				}
			};
			document.addEventListener("click", clickHandler, { capture: true });
			document.addEventListener("keydown", keyHandler, { capture: true });
		}
		if (!armed && clickHandler) {
			document.removeEventListener("click", clickHandler, { capture: true });
			document.removeEventListener("keydown", keyHandler, { capture: true });
			clickHandler = null;
			keyHandler = null;
		}
	}

	function applyState(nextState) {
		currentState = nextState;

		if (!shadow) {
			createOverlay();
		}

		const status = shadow.querySelector("#sg-tts-status");
		const extra = shadow.querySelector("#sg-tts-extra");
		const textArea = shadow.querySelector("#sg-tts-text");
		const providerSelect = shadow.querySelector("#sg-tts-provider");
		const voiceSelect = shadow.querySelector("#sg-tts-voice");
		const clickModeButton = shadow.querySelector("#sg-tts-click-mode");
		const statusBanner = shadow.querySelector("#sg-tts-status-banner");

		// Update text area if empty and we have current text
		if (!textArea.value && nextState.currentText) {
			textArea.value = nextState.currentText;
		}

		// Update provider options
		const currentProvider = providerSelect.value;
		providerSelect.innerHTML = "";
		["kokoro", "openai", "elevenlabs"].forEach((provider) => {
			const option = document.createElement("option");
			option.value = provider;
			option.textContent = provider;
			option.selected = provider === nextState.provider;
			providerSelect.appendChild(option);
		});

		// Update voice options
		voiceSelect.innerHTML = "";
		(nextState.availableVoices || []).forEach((voice) => {
			const option = document.createElement("option");
			option.value = voice.id;
			option.textContent = voice.label;
			option.selected = voice.id === nextState.voiceId;
			voiceSelect.appendChild(option);
		});
		if (!voiceSelect.value && nextState.voiceId) {
			const option = document.createElement("option");
			option.value = nextState.voiceId;
			option.textContent = nextState.voiceId;
			option.selected = true;
			voiceSelect.appendChild(option);
		}

		// Update status
		status.textContent = nextState.error ? "Error" : nextState.status;
		extra.textContent = nextState.error
			? nextState.error
			: nextState.truncated
				? "Truncated to 3000 chars"
				: nextState.currentTextLength
					? nextState.currentTextLength + " chars"
					: "";

		// Update click mode button
		clickModeButton.dataset.active = nextState.clickModeArmed ? "true" : "false";
		clickModeButton.textContent = nextState.clickModeArmed ? "Disarm click-to-speak" : "Arm click-to-speak";

		// Update status banner for read-along mode
		if (nextState.status === "playing" && nextState.hasReadAlong) {
			statusBanner.style.display = "block";
			statusBanner.className = "sg-tts-status-banner info";
			statusBanner.textContent = "Read-along active";
		} else if (nextState.status === "playing" && nextState.provider === "kokoro") {
			statusBanner.style.display = "block";
			statusBanner.className = "sg-tts-status-banner warning";
			statusBanner.textContent = "Audio only - caption support unavailable";
		} else {
			statusBanner.style.display = "none";
		}

		// Apply click mode
		setClickMode(Boolean(nextState.clickModeArmed));
	}

	function remove() {
		setClickMode(false);
		disconnectPort();
		if (root) {
			root.remove();
			root = null;
			shadow = null;
		}
	}

	// Initialize
	connectPort();
	applyState(initialState);

	// Register global for external access
	window.__shuvgeistTtsOverlay = {
		state: initialState,
		update: applyState,
		remove,
	};

	// Notify background that overlay is ready
	chrome.runtime.sendMessage({ type: "tts-overlay-ready" });
})();
`;
}

export function createRemoveTtsOverlayScript(): string {
	return `
(function() {
	if (window.__shuvgeistTtsOverlayRuntime && typeof window.__shuvgeistTtsOverlayRuntime.remove === "function") {
		window.__shuvgeistTtsOverlayRuntime.remove();
	}
	if (window.__shuvgeistTtsOverlay && typeof window.__shuvgeistTtsOverlay.remove === "function") {
		window.__shuvgeistTtsOverlay.remove();
	}
	const root = document.querySelector("shuvgeist-tts-root");
	if (root) root.remove();
})();
`;
}

declare global {
	interface Window {
		__shuvgeistTtsOverlay?: {
			state: TtsOverlayState;
			update: (state: TtsOverlayState) => void;
			remove: () => void;
		};
		__shuvgeistTtsOverlayRuntime?: {
			reconnect: () => void;
			remove: () => void;
		};
	}
}
