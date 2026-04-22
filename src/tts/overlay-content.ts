import type { TtsOverlayState } from "./types.js";

const OVERLAY_ID = "shuvgeist-tts-overlay";
const STYLE_ID = "shuvgeist-tts-overlay-style";

const OVERLAY_CSS = `
#shuvgeist-tts-overlay {
	position: fixed;
	right: 20px;
	bottom: 20px;
	z-index: 2147483647;
	width: min(360px, calc(100vw - 24px));
	background: rgba(16, 16, 16, 0.94);
	color: #f3f4f6;
	border: 1px solid rgba(255,255,255,0.12);
	border-radius: 16px;
	box-shadow: 0 18px 48px rgba(0,0,0,0.35);
	backdrop-filter: blur(14px);
	font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
}
#shuvgeist-tts-overlay * {
	box-sizing: border-box;
}
#shuvgeist-tts-overlay button,
#shuvgeist-tts-overlay select,
#shuvgeist-tts-overlay textarea {
	font: inherit;
}
#shuvgeist-tts-overlay .sg-tts-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 12px 14px 10px;
	border-bottom: 1px solid rgba(255,255,255,0.08);
}
#shuvgeist-tts-overlay .sg-tts-body {
	padding: 12px 14px 14px;
	display: grid;
	gap: 10px;
}
#shuvgeist-tts-overlay .sg-tts-row {
	display: grid;
	gap: 6px;
}
#shuvgeist-tts-overlay .sg-tts-grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 8px;
}
#shuvgeist-tts-overlay .sg-tts-actions {
	display: grid;
	grid-template-columns: repeat(4, 1fr);
	gap: 8px;
}
#shuvgeist-tts-overlay .sg-tts-button {
	border: none;
	border-radius: 10px;
	padding: 8px 10px;
	background: rgba(255,255,255,0.08);
	color: inherit;
	cursor: pointer;
}
#shuvgeist-tts-overlay .sg-tts-button[data-kind="primary"] {
	background: #f97316;
	color: #111827;
	font-weight: 600;
}
#shuvgeist-tts-overlay .sg-tts-button[data-active="true"] {
	background: #fb923c;
	color: #111827;
}
#shuvgeist-tts-overlay .sg-tts-input,
#shuvgeist-tts-overlay .sg-tts-select {
	width: 100%;
	background: rgba(255,255,255,0.06);
	border: 1px solid rgba(255,255,255,0.12);
	color: inherit;
	border-radius: 10px;
	padding: 8px 10px;
}
#shuvgeist-tts-overlay .sg-tts-status {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	font-size: 12px;
	color: rgba(243,244,246,0.8);
}
#shuvgeist-tts-overlay .sg-tts-meta {
	font-size: 11px;
	color: rgba(243,244,246,0.6);
}
`;

const OVERLAY_HTML = `
<div class="sg-tts-header">
	<div>
		<div style="font-weight:600">Text to Speech</div>
		<div class="sg-tts-meta">Top frame only in v1</div>
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
</div>
`;

export function createTtsOverlayScript(state: TtsOverlayState): string {
	return `
(function() {
	const overlayId = ${JSON.stringify(OVERLAY_ID)};
	const styleId = ${JSON.stringify(STYLE_ID)};
	const overlayCss = ${JSON.stringify(OVERLAY_CSS)};
	const overlayHtml = ${JSON.stringify(OVERLAY_HTML)};
	const initialState = ${JSON.stringify(state)};

	function ensureStyle() {
		if (document.getElementById(styleId)) return;
		const style = document.createElement("style");
		style.id = styleId;
		style.textContent = overlayCss;
		document.documentElement.appendChild(style);
	}

	function sendCommand(command) {
		chrome.runtime.sendMessage({ type: "tts-overlay-command", command });
	}

	function ensureOverlay() {
		ensureStyle();
		let root = document.getElementById(overlayId);
		if (!root) {
			root = document.createElement("div");
			root.id = overlayId;
			root.innerHTML = overlayHtml;
			document.documentElement.appendChild(root);

			const textArea = root.querySelector("#sg-tts-text");
			const providerSelect = root.querySelector("#sg-tts-provider");
			const voiceSelect = root.querySelector("#sg-tts-voice");

			root.querySelector("#sg-tts-speak").addEventListener("click", () => {
				sendCommand({
					type: "speak",
					payload: {
						source: "overlay",
						text: textArea.value || "",
					},
				});
			});
			root.querySelector("#sg-tts-pause").addEventListener("click", () => sendCommand({ type: "pause" }));
			root.querySelector("#sg-tts-resume").addEventListener("click", () => sendCommand({ type: "resume" }));
			root.querySelector("#sg-tts-stop").addEventListener("click", () => sendCommand({ type: "stop" }));
			root.querySelector("#sg-tts-click-mode").addEventListener("click", () => {
				sendCommand({
					type: "set-click-mode",
					armed: !window.__shuvgeistTtsOverlay.state.clickModeArmed,
				});
			});
			providerSelect.addEventListener("change", () => {
				sendCommand({ type: "set-provider", provider: providerSelect.value });
			});
			voiceSelect.addEventListener("change", () => {
				sendCommand({ type: "set-voice", voiceId: voiceSelect.value });
			});
			root.querySelector("#sg-tts-close").addEventListener("click", () => {
				sendCommand({ type: "close" });
			});
		}
		return root;
	}

	function resolveSpeakableText(event) {
		const selection = window.getSelection();
		if (selection && selection.toString().trim()) {
			return selection.toString().replace(/\\s+/g, " ").trim();
		}
		const target = event.target instanceof Node ? event.target : null;
		const element = target instanceof HTMLElement ? target : target && target.parentElement;
		if (!element || element.closest("#" + overlayId)) return "";
		if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable) {
			return "";
		}
		const block = element.closest("p,li,blockquote,td,th,h1,h2,h3,h4,h5,h6,article") || element;
		const text = (block.innerText || block.textContent || "").replace(/\\s+/g, " ").trim();
		return text.length >= 8 ? text : "";
	}

	function setClickMode(armed) {
		const overlay = window.__shuvgeistTtsOverlay;
		if (!overlay) return;
		if (armed && !overlay.clickHandler) {
			overlay.clickHandler = (event) => {
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
			overlay.keyHandler = (event) => {
				if (event.key === "Escape") {
					sendCommand({ type: "set-click-mode", armed: false });
				}
			};
			document.addEventListener("click", overlay.clickHandler, { capture: true });
			document.addEventListener("keydown", overlay.keyHandler, { capture: true });
		}
		if (!armed && overlay.clickHandler) {
			document.removeEventListener("click", overlay.clickHandler, { capture: true });
			document.removeEventListener("keydown", overlay.keyHandler, { capture: true });
			overlay.clickHandler = null;
			overlay.keyHandler = null;
		}
	}

	function applyState(nextState) {
		const root = ensureOverlay();
		const status = root.querySelector("#sg-tts-status");
		const extra = root.querySelector("#sg-tts-extra");
		const textArea = root.querySelector("#sg-tts-text");
		const providerSelect = root.querySelector("#sg-tts-provider");
		const voiceSelect = root.querySelector("#sg-tts-voice");
		const clickModeButton = root.querySelector("#sg-tts-click-mode");

		window.__shuvgeistTtsOverlay.state = nextState;

		if (!textArea.value && nextState.currentText) {
			textArea.value = nextState.currentText;
		}

		providerSelect.innerHTML = "";
		["kokoro", "openai", "elevenlabs"].forEach((provider) => {
			const option = document.createElement("option");
			option.value = provider;
			option.textContent = provider;
			option.selected = provider === nextState.provider;
			providerSelect.appendChild(option);
		});

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

		status.textContent = nextState.error ? "Error" : nextState.status;
		extra.textContent = nextState.error
			? nextState.error
			: nextState.truncated
				? "Truncated to 3000 chars"
				: nextState.currentTextLength
					? nextState.currentTextLength + " chars"
					: "";
		clickModeButton.dataset.active = nextState.clickModeArmed ? "true" : "false";
		clickModeButton.textContent = nextState.clickModeArmed ? "Disarm click-to-speak" : "Arm click-to-speak";
		setClickMode(Boolean(nextState.clickModeArmed));
	}

	window.__shuvgeistTtsOverlay = window.__shuvgeistTtsOverlay || {
		state: initialState,
		clickHandler: null,
		keyHandler: null,
		update: applyState,
		remove: () => {
			setClickMode(false);
			document.getElementById(overlayId)?.remove();
		},
	};

	applyState(initialState);
	chrome.runtime.sendMessage({ type: "tts-overlay-ready" });
})();
`;
}

export function createRemoveTtsOverlayScript(): string {
	return `
(function() {
	if (window.__shuvgeistTtsOverlay && typeof window.__shuvgeistTtsOverlay.remove === "function") {
		window.__shuvgeistTtsOverlay.remove();
	}
})();
`;
}

declare global {
	interface Window {
		__shuvgeistTtsOverlay?: {
			state: TtsOverlayState;
			clickHandler: ((event: MouseEvent) => void) | null;
			keyHandler: ((event: KeyboardEvent) => void) | null;
			update: (state: TtsOverlayState) => void;
			remove: () => void;
		};
	}
}
