/**
 * Offscreen document entry point.
 *
 * Hosts a SandboxIframe for REPL execution when the sidepanel is not open.
 * Also owns TTS audio playback state so playback survives sidepanel and REPL
 * lifecycle changes inside the shared offscreen document.
 */

import { SandboxIframe } from "@mariozechner/pi-web-ui";
import type { BridgeReplMessageResponse, BridgeToOffscreenMessage } from "./bridge/internal-messages.js";
import { buildOffscreenRuntimeProviders } from "./bridge/offscreen-runtime-providers.js";
import type { TtsOffscreenMessage, TtsOffscreenResponse } from "./tts/internal-messages.js";
import { synthesizeTts } from "./tts/service.js";
import { DEFAULT_TTS_SETTINGS } from "./tts/settings.js";
import {
	createInitialTtsPlaybackState,
	type TtsPlaybackState,
	type TtsPlayhead,
	type TtsWordTimestamp,
} from "./tts/types.js";

let playheadInterval: ReturnType<typeof setInterval> | null = null;

function sendTtsRuntimeEvent(message: Record<string, unknown>): void {
	try {
		const response = chrome.runtime.sendMessage(message);
		if (response && typeof (response as Promise<unknown>).catch === "function") {
			void (response as Promise<unknown>).catch(() => undefined);
		}
	} catch {}
}

interface TtsController {
	audio: HTMLAudioElement;
	objectUrl?: string;
	abortController?: AbortController;
	state: TtsPlaybackState;
	captionSessionId?: string;
}

declare global {
	interface Window {
		__shuvgeistTtsController?: TtsController;
	}
}

function cloneState(state: TtsPlaybackState): TtsPlaybackState {
	return {
		...state,
		availableVoices: [...state.availableVoices],
	};
}

function clearPlayheadTracking(sessionId?: string): void {
	if (playheadInterval) {
		clearInterval(playheadInterval);
		playheadInterval = null;
	}
	if (sessionId) {
		sendTtsRuntimeEvent({ type: "tts-offscreen-session-end", sessionId });
	}
}

function resetAudioSource(controller: TtsController): void {
	if (controller.objectUrl) {
		URL.revokeObjectURL(controller.objectUrl);
		controller.objectUrl = undefined;
	}
	clearPlayheadTracking(controller.captionSessionId);
	controller.captionSessionId = undefined;
	controller.audio.removeAttribute("src");
	controller.audio.load();
}

function getOrCreateTtsController(): TtsController {
	if (window.__shuvgeistTtsController) {
		return window.__shuvgeistTtsController;
	}

	const audio = new Audio();
	audio.preload = "auto";

	const controller: TtsController = {
		audio,
		state: createInitialTtsPlaybackState(DEFAULT_TTS_SETTINGS, []),
	};

	audio.addEventListener("play", () => {
		controller.state = {
			...controller.state,
			status: "playing",
			error: undefined,
		};
	});

	audio.addEventListener("pause", () => {
		if (controller.audio.ended) return;
		controller.state = {
			...controller.state,
			status: controller.audio.currentSrc ? "paused" : "idle",
		};
	});

	audio.addEventListener("ended", () => {
		resetAudioSource(controller);
		controller.state = {
			...controller.state,
			status: "idle",
			currentText: "",
			currentTextLength: 0,
			truncated: false,
			error: undefined,
		};
	});

	audio.addEventListener("error", () => {
		controller.state = {
			...controller.state,
			status: "error",
			error: "Audio playback failed",
		};
	});

	window.__shuvgeistTtsController = controller;
	return controller;
}

export function releaseTtsControllerForTests(): void {
	const controller = window.__shuvgeistTtsController;
	if (!controller) return;
	controller.audio.pause();
	controller.abortController?.abort();
	resetAudioSource(controller);
	delete window.__shuvgeistTtsController;
}

async function synthesizeAndPlay(
	message: Extract<TtsOffscreenMessage, { type: "tts-offscreen-synthesize" }>,
): Promise<TtsOffscreenResponse> {
	const controller = getOrCreateTtsController();
	controller.abortController?.abort();
	controller.audio.pause();
	resetAudioSource(controller);
	const abortController = new AbortController();
	controller.abortController = abortController;
	controller.state = {
		...controller.state,
		status: "loading",
		provider: message.provider,
		voiceId: message.request.voiceId,
		currentText: message.request.text,
		currentTextLength: message.request.text.length,
		error: undefined,
	};

	try {
		const result = await synthesizeTts(
			message.provider,
			{
				...DEFAULT_TTS_SETTINGS,
				provider: message.provider,
				voiceId: message.request.voiceId,
				speed: message.request.speed,
				openaiModelId:
					message.provider === "openai"
						? message.request.modelId || DEFAULT_TTS_SETTINGS.openaiModelId
						: DEFAULT_TTS_SETTINGS.openaiModelId,
				kokoroModelId:
					message.provider === "kokoro"
						? message.request.modelId || DEFAULT_TTS_SETTINGS.kokoroModelId
						: DEFAULT_TTS_SETTINGS.kokoroModelId,
				elevenLabsModelId:
					message.provider === "elevenlabs"
						? message.request.modelId || DEFAULT_TTS_SETTINGS.elevenLabsModelId
						: DEFAULT_TTS_SETTINGS.elevenLabsModelId,
				kokoroBaseUrl: message.config.baseUrl || DEFAULT_TTS_SETTINGS.kokoroBaseUrl,
				elevenLabsOutputFormat: message.config.outputFormat || DEFAULT_TTS_SETTINGS.elevenLabsOutputFormat,
			},
			message.request,
			{
				openaiKey: message.provider === "openai" ? message.config.apiKey : undefined,
				elevenLabsKey: message.provider === "elevenlabs" ? message.config.apiKey : undefined,
				kokoroKey: message.provider === "kokoro" ? message.config.apiKey : undefined,
			},
			fetch,
			abortController.signal,
		);
		const blob = new Blob([result.audioData], { type: result.mimeType });
		const objectUrl = URL.createObjectURL(blob);
		controller.objectUrl = objectUrl;
		controller.audio.src = objectUrl;
		await controller.audio.play();
		controller.state = {
			...controller.state,
			status: "playing",
		};
		return { ok: true, event: "playing", requestId: result.providerRequestId };
	} catch (error) {
		if (abortController.signal.aborted) {
			controller.state = {
				...controller.state,
				status: "idle",
				error: undefined,
			};
			return { ok: true, event: "stopped" };
		}
		resetAudioSource(controller);
		controller.state = {
			...controller.state,
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		};
		return {
			ok: false,
			error: controller.state.error || "TTS synthesis failed",
		};
	}
}

async function synthesizeAndPlayCaptioned(
	message: Extract<TtsOffscreenMessage, { type: "tts-offscreen-synthesize-captioned" }>,
): Promise<TtsOffscreenResponse> {
	const controller = getOrCreateTtsController();
	controller.abortController?.abort();
	controller.audio.pause();
	resetAudioSource(controller);
	const abortController = new AbortController();
	controller.abortController = abortController;
	controller.state = {
		...controller.state,
		status: "loading",
		provider: "kokoro",
		voiceId: message.request.voiceId,
		currentText: message.request.text,
		currentTextLength: message.request.text.length,
		error: undefined,
	};

	try {
		const result = await synthesizeTts(
			"kokoro",
			{
				...DEFAULT_TTS_SETTINGS,
				provider: "kokoro",
				voiceId: message.request.voiceId,
				speed: message.request.speed,
				kokoroModelId: message.request.modelId || DEFAULT_TTS_SETTINGS.kokoroModelId,
				kokoroBaseUrl: message.config.baseUrl || DEFAULT_TTS_SETTINGS.kokoroBaseUrl,
			},
			message.request,
			{
				kokoroKey: message.config.apiKey,
			},
			fetch,
			abortController.signal,
			true, // wantReadAlong
		);

		const blob = new Blob([result.audioData], { type: result.mimeType });
		const objectUrl = URL.createObjectURL(blob);
		controller.objectUrl = objectUrl;
		controller.audio.src = objectUrl;

		controller.captionSessionId = message.sessionId;
		if (result.timings && result.timings.length > 0) {
			startPlayheadTracking(controller.audio, result.timings, message.sessionId);
		}

		await controller.audio.play();
		controller.state = {
			...controller.state,
			status: "playing",
		};
		return { ok: true, event: "playing", requestId: result.providerRequestId };
	} catch (error) {
		if (abortController.signal.aborted) {
			controller.state = {
				...controller.state,
				status: "idle",
				error: undefined,
			};
			return { ok: true, event: "stopped" };
		}
		resetAudioSource(controller);
		controller.state = {
			...controller.state,
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		};
		return {
			ok: false,
			error: controller.state.error || "TTS synthesis failed",
		};
	}
}

function startPlayheadTracking(audio: HTMLAudioElement, timings: TtsWordTimestamp[], sessionId: string): void {
	clearPlayheadTracking();

	playheadInterval = setInterval(() => {
		if (audio.paused || audio.ended) {
			return;
		}

		const currentTime = audio.currentTime;
		let charStart = 0;
		for (const timing of timings) {
			if (currentTime >= timing.startTime && currentTime < timing.endTime) {
				const playhead: TtsPlayhead = {
					charStart,
					charEnd: charStart + timing.word.length,
					tAudioSeconds: currentTime,
					word: timing.word,
				};
				sendTtsRuntimeEvent({ type: "tts-offscreen-playhead", sessionId, playhead });
				break;
			}
			charStart += timing.word.length + 1;
		}
	}, 50);

	audio.addEventListener(
		"ended",
		() => {
			clearPlayheadTracking(sessionId);
		},
		{ once: true },
	);
}

function pausePlayback(): TtsOffscreenResponse {
	const controller = getOrCreateTtsController();
	controller.audio.pause();
	controller.state = {
		...controller.state,
		status: "paused",
	};
	return { ok: true, event: "paused" };
}

async function resumePlayback(): Promise<TtsOffscreenResponse> {
	const controller = getOrCreateTtsController();
	try {
		await controller.audio.play();
		controller.state = {
			...controller.state,
			status: "playing",
		};
		return { ok: true, event: "playing" };
	} catch (error) {
		controller.state = {
			...controller.state,
			status: "error",
			error: error instanceof Error ? error.message : String(error),
		};
		return {
			ok: false,
			error: controller.state.error || "Failed to resume playback",
		};
	}
}

function stopPlayback(): TtsOffscreenResponse {
	const controller = getOrCreateTtsController();
	controller.abortController?.abort();
	controller.audio.pause();
	controller.audio.currentTime = 0;
	resetAudioSource(controller);
	controller.state = {
		...controller.state,
		status: "idle",
		currentText: "",
		currentTextLength: 0,
		truncated: false,
		error: undefined,
	};
	return { ok: true, event: "stopped" };
}

export async function handleOffscreenTtsMessage(message: TtsOffscreenMessage): Promise<TtsOffscreenResponse> {
	switch (message.type) {
		case "tts-offscreen-synthesize":
			return synthesizeAndPlay(message);
		case "tts-offscreen-synthesize-captioned":
			return synthesizeAndPlayCaptioned(message);
		case "tts-offscreen-pause":
			return pausePlayback();
		case "tts-offscreen-resume":
			return resumePlayback();
		case "tts-offscreen-stop":
			return stopPlayback();
		case "tts-offscreen-get-state":
			return {
				ok: true,
				event:
					getOrCreateTtsController().state.status === "paused"
						? "paused"
						: getOrCreateTtsController().state.status === "playing"
							? "playing"
							: "stopped",
			};
		default:
			return { ok: false, error: `Unknown message type: ${(message as { type?: string }).type}` };
	}
}

chrome.runtime.onMessage.addListener(
	(
		message: BridgeToOffscreenMessage | TtsOffscreenMessage,
		_sender: chrome.runtime.MessageSender,
		sendResponse: (response: unknown) => void,
	) => {
		if (message.type === "bridge-keepalive-ping") {
			sendResponse({ ok: true });
			return false;
		}

		if (message.type === "bridge-repl-execute") {
			executeRepl(message.params.code, message.params.title, message.windowId, {
				traceparent: message.traceparent,
				tracestate: message.tracestate,
			})
				.then((result) => {
					sendResponse({ ok: true, result } as BridgeReplMessageResponse);
				})
				.catch((err: Error) => {
					sendResponse({ ok: false, error: err.message } as BridgeReplMessageResponse);
				});
			return true;
		}

		if (message.type.startsWith("tts-offscreen-")) {
			handleOffscreenTtsMessage(message)
				.then((response) => sendResponse(response))
				.catch((error: unknown) =>
					sendResponse({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					} satisfies TtsOffscreenResponse),
				);
			return true;
		}

		return false;
	},
);

export async function executeRepl(
	code: string,
	_title: string,
	windowId?: number,
	traceHeaders: { traceparent?: string; tracestate?: string } = {},
): Promise<{
	output: string;
	files: Array<{ fileName: string; mimeType: string; size: number; contentBase64: string }>;
}> {
	const sandbox = new SandboxIframe();
	sandbox.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");
	sandbox.style.display = "none";
	if (sandbox instanceof Node) {
		document.body.appendChild(sandbox);
	}

	try {
		const sandboxId = `offscreen-repl-${Date.now()}-${Math.random().toString(36).substring(7)}`;
		const providers = buildOffscreenRuntimeProviders(windowId, traceHeaders);
		const result = await sandbox.execute(sandboxId, code, providers, []);

		let output = "";
		if (result.console && result.console.length > 0) {
			for (const entry of result.console) {
				output += entry.text + "\n";
			}
		}

		if (!result.success) {
			if (output) output += "\n";
			output += `Error: ${result.error?.message || "Unknown error"}\n${result.error?.stack || ""}`;
			throw new Error(output.trim());
		}

		if (result.returnValue !== undefined) {
			if (output) output += "\n";
			output +=
				typeof result.returnValue === "object"
					? `=> ${JSON.stringify(result.returnValue, null, 2)}`
					: `=> ${result.returnValue}`;
		}

		const files = (result.files || []).map((file) => ({
			fileName: file.fileName || "file",
			mimeType: file.mimeType || "application/octet-stream",
			size: typeof file.content === "string" ? file.content.length : (file.content?.byteLength ?? 0),
			contentBase64: "",
		}));

		return { output: output.trim(), files };
	} finally {
		// REPL owns only its SandboxIframe lifecycle. Shared TTS playback state
		// lives on window.__shuvgeistTtsController and must survive REPL teardown.
		sandbox.remove();
	}
}

console.log("[Offscreen] Document loaded and ready for REPL execution");
