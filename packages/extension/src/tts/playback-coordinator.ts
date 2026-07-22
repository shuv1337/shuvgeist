import type { TtsOffscreenMessage, TtsPortMessage, TtsSpeakPayload } from "./internal-messages.js";
import { buildProviderConfig, getProviderVoiceId, prepareTtsText, type TtsProviderSecrets } from "./service.js";
import type {
	KokoroHealthStatus,
	TtsFallbackReason,
	TtsOverlayState,
	TtsPlaybackState,
	TtsPlayhead,
	TtsProviderId,
	TtsReadingSession,
	TtsSettingsSnapshot,
} from "./types.js";

export interface TtsProviderSelection {
	provider: TtsProviderId;
	hasReadAlong: boolean;
	fallbackReason?: TtsFallbackReason;
	error?: string;
}

export interface TtsPlaybackCoordinatorDeps {
	sendToOverlay(tabId: number, message: TtsPortMessage): void;
	logEvent(event: string, attributes?: Record<string, string | number | boolean | undefined>): void;
	now(): number;
	createSessionId(): string;
}

export interface TtsSpeakPlan {
	sessionId: string;
	preparedText: string;
	truncated: boolean;
	provider: TtsProviderId;
	voiceId: string;
	modelId?: string;
	hasReadAlong: boolean;
	fallbackReason?: TtsFallbackReason;
}

export function selectTtsProviderForSpeak(options: {
	commandKind: TtsSpeakPayload["command"]["kind"];
	requestedProvider: TtsProviderId;
	fallbackProvider?: Exclude<TtsProviderId, "kokoro">;
	readAlongEnabled: boolean;
	tabId?: number;
	kokoroStatus?: KokoroHealthStatus | null;
}): TtsProviderSelection {
	if (options.commandKind !== "page-target") {
		return {
			provider: options.fallbackProvider ?? options.requestedProvider,
			hasReadAlong: false,
			fallbackReason: options.fallbackProvider ? "kokoro-unreachable" : undefined,
		};
	}

	if (options.requestedProvider !== "kokoro") {
		return {
			provider: options.requestedProvider,
			hasReadAlong: false,
			fallbackReason: "legacy-provider-mode",
		};
	}

	const status = options.kokoroStatus;
	if (status?.status === "ok") {
		return {
			provider: "kokoro",
			hasReadAlong: Boolean(options.readAlongEnabled && options.tabId),
		};
	}

	if (status?.status === "captioned-unsupported") {
		return {
			provider: "kokoro",
			hasReadAlong: false,
			fallbackReason: "captioned-unsupported",
		};
	}

	if (options.fallbackProvider) {
		return {
			provider: options.fallbackProvider,
			hasReadAlong: false,
			fallbackReason: "kokoro-unreachable",
		};
	}

	return {
		provider: "kokoro",
		hasReadAlong: false,
		error: status?.message || "Kokoro is unavailable. Choose a one-shot fallback.",
	};
}

export function getTtsModelIdForProvider(settings: TtsSettingsSnapshot, provider: TtsProviderId): string | undefined {
	switch (provider) {
		case "kokoro":
			return settings.kokoroModelId;
		case "openai":
			return settings.openaiModelId;
		case "elevenlabs":
			return settings.elevenLabsModelId;
	}
}

export class TtsPlaybackCoordinator {
	private activeReadingSessions = new Map<string, TtsReadingSession>();
	private sessionFallbackOverrides = new Map<string, Exclude<TtsProviderId, "kokoro">>();

	constructor(private readonly deps: TtsPlaybackCoordinatorDeps) {}

	createSessionId(payload: TtsSpeakPayload): string {
		return payload.sessionId ?? this.deps.createSessionId();
	}

	rememberFallbackProvider(
		sessionId: string,
		provider?: Exclude<TtsProviderId, "kokoro">,
	): Exclude<TtsProviderId, "kokoro"> | undefined {
		const resolvedProvider = provider ?? this.sessionFallbackOverrides.get(sessionId);
		if (resolvedProvider) {
			this.sessionFallbackOverrides.set(sessionId, resolvedProvider);
		}
		return resolvedProvider;
	}

	clearFallbackProvider(sessionId: string): void {
		this.sessionFallbackOverrides.delete(sessionId);
	}

	planSpeak(options: {
		payload: TtsSpeakPayload;
		sessionId: string;
		settings: TtsSettingsSnapshot;
		tabId?: number;
		fallbackProvider?: Exclude<TtsProviderId, "kokoro">;
		kokoroStatus?: KokoroHealthStatus | null;
	}): TtsSpeakPlan | { error: string } {
		const prepared = prepareTtsText(options.payload.command.text, options.settings.maxTextChars);
		if (!prepared.text) {
			return { error: "No readable text to speak" };
		}
		const selection = selectTtsProviderForSpeak({
			commandKind: options.payload.command.kind,
			requestedProvider: options.settings.provider,
			fallbackProvider: options.fallbackProvider,
			readAlongEnabled: options.settings.readAlongEnabled,
			tabId: options.tabId,
			kokoroStatus: options.kokoroStatus,
		});
		if (selection.error) {
			return { error: selection.error };
		}
		return {
			sessionId: options.sessionId,
			preparedText: prepared.text,
			truncated:
				prepared.truncated || (options.payload.command.kind === "page-target" && options.payload.command.truncated),
			provider: selection.provider,
			voiceId: getProviderVoiceId(options.settings, selection.provider) || options.settings.voiceId,
			modelId: getTtsModelIdForProvider(options.settings, selection.provider),
			hasReadAlong: selection.hasReadAlong,
			fallbackReason: selection.fallbackReason,
		};
	}

	createOffscreenMessage(
		plan: TtsSpeakPlan,
		settings: TtsSettingsSnapshot,
		providerSecrets: TtsProviderSecrets,
	): TtsOffscreenMessage {
		return plan.hasReadAlong
			? {
					type: "tts-offscreen-synthesize-captioned",
					sessionId: plan.sessionId,
					request: {
						text: plan.preparedText,
						voiceId: plan.voiceId,
						speed: settings.speed,
						modelId: settings.kokoroModelId,
					},
					config: buildProviderConfig(settings, "kokoro", providerSecrets),
				}
			: {
					type: "tts-offscreen-synthesize",
					provider: plan.provider,
					request: {
						text: plan.preparedText,
						voiceId: plan.voiceId,
						speed: settings.speed,
						modelId: plan.modelId,
					},
					config: buildProviderConfig(settings, plan.provider, providerSecrets),
				};
	}

	currentOverlayState(options: {
		overlayTabId: number | null;
		playbackState: TtsPlaybackState;
		settings: TtsSettingsSnapshot;
	}): TtsOverlayState {
		const activeSession = options.overlayTabId
			? Array.from(this.activeReadingSessions.values()).find(
					(session) => session.tabId === options.overlayTabId && session.hasReadAlong,
				)
			: undefined;
		return {
			...options.playbackState,
			enabled: options.settings.enabled,
			hasReadAlong: Boolean(activeSession?.hasReadAlong),
		};
	}

	markOverlayDetached(tabId: number): void {
		for (const session of this.activeReadingSessions.values()) {
			if (session.tabId === tabId) {
				session.overlayAttached = false;
			}
		}
	}

	markOverlayAttached(tabId: number): void {
		for (const session of this.activeReadingSessions.values()) {
			if (session.tabId === tabId) {
				session.overlayAttached = true;
			}
		}
	}

	getSessionsForTab(tabId: number): TtsReadingSession[] {
		return Array.from(this.activeReadingSessions.values()).filter((session) => session.tabId === tabId);
	}

	startReadingSession(options: {
		sessionId: string;
		tabId: number;
		provider: TtsProviderId;
		sourceKind: TtsReadingSession["sourceKind"];
		text: string;
		hasReadAlong: boolean;
		fallbackReason?: TtsFallbackReason;
	}): void {
		this.activeReadingSessions.set(options.sessionId, {
			id: options.sessionId,
			tabId: options.tabId,
			provider: options.provider,
			sourceKind: options.sourceKind,
			text: options.text,
			startedAt: this.deps.now(),
			hasReadAlong: options.hasReadAlong,
			overlayAttached: true,
			fallbackReason: options.fallbackReason,
		});
	}

	endReadingSession(sessionId: string, notifyOverlay = true): void {
		const session = this.activeReadingSessions.get(sessionId);
		if (!session) {
			return;
		}
		this.activeReadingSessions.delete(sessionId);
		this.clearFallbackProvider(sessionId);
		if (notifyOverlay && session.overlayAttached) {
			this.deps.sendToOverlay(session.tabId, { type: "tts-session-end", sessionId });
		}
		this.deps.logEvent("session.end", {
			sessionId,
			provider: session.provider,
			hasReadAlong: session.hasReadAlong,
			fallbackReason: session.fallbackReason,
		});
	}

	forwardPlayhead(sessionId: string, playhead: TtsPlayhead): void {
		const session = this.activeReadingSessions.get(sessionId);
		if (!session || !session.overlayAttached) {
			return;
		}
		this.deps.sendToOverlay(session.tabId, { type: "tts-playhead", sessionId, playhead });
	}
}
