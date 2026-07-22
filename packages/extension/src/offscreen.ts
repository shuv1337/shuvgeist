/**
 * Offscreen document entry point.
 *
 * Owns persistent Agent sessions, their REPL sandboxes, and TTS audio playback
 * so both lifecycles survive sidepanel presentation changes.
 */

import { createExtractDocumentTool, setAppStorage } from "@shuv1337/pi-web-ui";
import {
	createShuvgeistOffscreenSessionPersistence,
	OffscreenAgentSessionFactory,
} from "./agent/offscreen-agent-session.js";
import { loadOffscreenDebuggerMode } from "./agent/offscreen-developer-settings.js";
import { SandboxOffscreenHtmlArtifactExecutor } from "./agent/offscreen-html-artifact-executor.js";
import { OffscreenRuntimeController } from "./agent/offscreen-runtime-controller.js";
import { createOffscreenSkillTool } from "./agent/offscreen-skill-tool.js";
import { PureOffscreenAgentToolRuntime } from "./agent/offscreen-tool-environment.js";
import { createOffscreenProviderRuntime } from "./agent/provider-runtime.js";
import { navigationContextChanged, runtimeNavigationMessage } from "./agent/runtime-navigation.js";
import type { BridgeToOffscreenMessage } from "./bridge/internal-messages.js";
import { SYSTEM_PROMPT } from "./prompts/prompts.js";
import { ShuvgeistAppStorage } from "./storage/app-storage.js";
import { loadProxySettings } from "./storage/persistent-settings.js";
import { createReplTool } from "./tools/repl/repl.js";
import { initializeDefaultSkills } from "./tools/skill.js";
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

function isTtsOffscreenMessage(
	message: BridgeToOffscreenMessage | TtsOffscreenMessage,
): message is TtsOffscreenMessage {
	return (
		message.type === "tts-offscreen-synthesize" ||
		message.type === "tts-offscreen-synthesize-captioned" ||
		message.type === "tts-offscreen-pause" ||
		message.type === "tts-offscreen-resume" ||
		message.type === "tts-offscreen-stop" ||
		message.type === "tts-offscreen-get-state"
	);
}

let agentRuntimeController: OffscreenRuntimeController | undefined;

function getAgentRuntimeController(): OffscreenRuntimeController {
	if (agentRuntimeController) return agentRuntimeController;
	const storage = new ShuvgeistAppStorage();
	setAppStorage(storage);
	const providers = createOffscreenProviderRuntime({ storage });
	const persistence = createShuvgeistOffscreenSessionPersistence(storage);
	let defaultSkillsReady: Promise<void> | undefined;
	const ensureDefaultSkills = (): Promise<void> => {
		defaultSkillsReady ??= initializeDefaultSkills();
		return defaultSkillsReady;
	};
	let controller: OffscreenRuntimeController | undefined;
	const toolRuntime = new PureOffscreenAgentToolRuntime({
		htmlArtifacts: new SandboxOffscreenHtmlArtifactExecutor(),
		privilegedOperations: {
			execute(operation, params, context) {
				if (!controller) throw new Error("Offscreen agent runtime controller is unavailable");
				return controller.executeToolPageOperation(operation, params, context);
			},
		},
		async debuggerMode() {
			return loadOffscreenDebuggerMode(chrome.runtime);
		},
		createReplTool(_context, privilegedOperations) {
			if (!privilegedOperations) throw new Error("Offscreen REPL requires bound privileged operations");
			const tool = createReplTool();
			let visibleOverlayExecutions = 0;
			tool.overlayController = {
				async show(taskName, signal) {
					await privilegedOperations.execute(
						"repl-overlay-show",
						{ taskName },
						{
							operationId: "repl-overlay-show",
							origin: { kind: "repl", sandboxId: "repl-overlay", messageId: "show" },
							...(signal ? { signal } : {}),
						},
					);
					visibleOverlayExecutions += 1;
				},
				async hide(signal) {
					if (visibleOverlayExecutions === 0) return;
					visibleOverlayExecutions -= 1;
					if (visibleOverlayExecutions > 0) return;
					await privilegedOperations.execute(
						"repl-overlay-remove",
						{},
						{
							operationId: "repl-overlay-remove",
							origin: { kind: "repl", sandboxId: "repl-overlay", messageId: "hide" },
							...(signal ? { parentSignal: signal } : {}),
						},
					);
				},
			};
			return tool;
		},
		createSkillTool(context, privilegedOperations) {
			if (!privilegedOperations) throw new Error("Offscreen skill tool requires bound privileged operations");
			return createOffscreenSkillTool({
				scope: context,
				ensureDefaultSkills,
				executeNavigate(params, signal) {
					return privilegedOperations.execute("navigate", params, {
						operationId: "skill:resolve-current-url",
						origin: { kind: "agent-tool", toolCallId: "skill:resolve-current-url" },
						...(signal ? { signal } : {}),
					});
				},
			});
		},
		sandboxUrlProvider: () => chrome.runtime.getURL("sandbox.html"),
		createExtractDocumentTool() {
			const tool = createExtractDocumentTool();
			void loadProxySettings(storage.settings)
				.then((proxy) => {
					if (proxy.enabled && proxy.url) tool.corsProxyUrl = `${proxy.url}/?url=`;
				})
				.catch((error: unknown) => console.warn("[Offscreen:AgentRuntime] Failed to load CORS proxy:", error));
			return tool;
		},
		onTranscriptMutation(context) {
			return persistence.save(
				context.sessionId,
				{
					systemPrompt: context.agent.state.systemPrompt,
					model: context.agent.state.model,
					thinkingLevel: context.agent.state.thinkingLevel,
					messages: context.agent.state.messages.slice(),
				},
				new AbortController().signal,
			);
		},
		onError: (error, context) =>
			console.warn(`[Offscreen:AgentRuntime] Tool environment failed for ${context.sessionId}:`, error),
	});
	const sessionFactory = new OffscreenAgentSessionFactory({
		providers,
		persistence,
		defaultSystemPrompt: SYSTEM_PROMPT,
		toolRuntime,
		lifecycle: {
			onError: (error, context) =>
				console.warn(`[Offscreen:AgentRuntime] Session failed for ${context.sessionId}:`, error),
		},
	});
	controller = new OffscreenRuntimeController({
		sessionFactory,
		artifacts: toolRuntime,
		repl: toolRuntime,
		promptPreparation: {
			async prepare(context) {
				if (!controller) throw new Error("Offscreen agent runtime controller is unavailable");
				if (!context.executionId) throw new Error("Prompt preparation requires an exact executionId");
				const result = await controller.executeToolPageOperation(
					"navigation-context",
					{},
					{
						runtimeEpoch: context.runtimeEpoch,
						clientId: context.clientId,
						windowId: context.windowId,
						sessionId: context.sessionId,
						target: context.target,
						requestId: context.requestId,
						executionId: context.executionId,
						...(context.trace ? { trace: context.trace } : {}),
						signal: context.signal,
					},
				);
				const message = runtimeNavigationMessage(result);
				return message && navigationContextChanged(context.session.getState().messages, message)
					? message
					: undefined;
			},
		},
		sendToBackground: (message) => chrome.runtime.sendMessage(message),
		reportError: (error, context) => console.warn(`[Offscreen:AgentRuntime] ${context}:`, error),
	});
	agentRuntimeController = controller;
	return controller;
}

function isBackgroundRuntimeSender(sender: chrome.runtime.MessageSender): boolean {
	if (sender.id !== undefined && sender.id !== chrome.runtime.id) return false;
	if (sender.tab !== undefined) return false;
	return sender.url === undefined || sender.url === chrome.runtime.getURL("background.js");
}

chrome.runtime.onMessage.addListener(
	(
		message: BridgeToOffscreenMessage | TtsOffscreenMessage,
		_sender: chrome.runtime.MessageSender,
		sendResponse: (response: unknown) => void,
	) => {
		if (
			isBackgroundRuntimeSender(_sender) &&
			typeof message.type === "string" &&
			message.type.startsWith("agent-runtime-")
		) {
			let runtimeResponse: ReturnType<OffscreenRuntimeController["handleMessage"]>;
			try {
				runtimeResponse = getAgentRuntimeController().handleMessage(message);
			} catch (error) {
				sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
				return false;
			}
			if (runtimeResponse) {
				void runtimeResponse
					.then((response) => sendResponse(response))
					.catch((error: unknown) =>
						sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
					);
				return true;
			}
		}

		if (message.type === "bridge-keepalive-ping") {
			sendResponse({ ok: true });
			return false;
		}

		if (isTtsOffscreenMessage(message)) {
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

console.log("[Offscreen] Document loaded and ready for REPL execution");
