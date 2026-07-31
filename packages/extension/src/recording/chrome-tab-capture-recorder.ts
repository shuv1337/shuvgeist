import { pageDriverScopeToWire } from "@shuvgeist/driver/page-driver-wire";
import type {
	RecordChunkEventData,
	RecordStartParams,
	RecordStartResult,
	RecordStatusResult,
	RecordStopResult,
} from "@shuvgeist/protocol/protocol";
import type { ChromePageDriverRegistryLike } from "../bridge/chrome-page-driver-registry.js";
import type {
	TabCaptureOffscreenEvent,
	TabCaptureOffscreenMessage,
	TabCaptureOffscreenResponse,
	TabCaptureStopReason,
} from "./tab-capture-messages.js";

interface TabCaptureState {
	windowId: number;
	tabId: number;
	recordingId: string;
	startedAt: string;
	navigationGeneration: number;
	mimeType: string;
	audio: boolean;
	sourceBytes: number;
	chunkCount: number;
	completion: Promise<RecordStopResult>;
	resolveCompletion: (summary: RecordStopResult) => void;
}

export interface ChromeTabCaptureRecorderOptions {
	windowId: number;
	pageDriverRegistry: ChromePageDriverRegistryLike;
	ensureOffscreenDocument: () => Promise<void>;
	sendOffscreenMessage: (message: TabCaptureOffscreenMessage) => Promise<TabCaptureOffscreenResponse | null>;
	emitRecordChunk: (data: RecordChunkEventData) => void;
	getMediaStreamId?: (tabId: number) => Promise<string>;
	showIndicator?: (tabId: number, recordingId: string) => Promise<void>;
	hideIndicator?: (tabId: number) => Promise<void>;
}

const DEFAULT_MAX_DURATION_MS = 30_000;
const COMPLETION_TIMEOUT_MS = 5_000;
const TAB_CAPTURE_DISALLOWED_SCHEMES = ["chrome:", "chrome-extension:", "devtools:", "view-source:", "about:"];

function chromeTarget(tabId: number) {
	return { kind: "chrome-tab" as const, tabId, frameId: 0 };
}

async function defaultGetMediaStreamId(tabId: number): Promise<string> {
	try {
		const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
		if (!streamId) throw new Error("Chrome returned an empty media stream id.");
		return streamId;
	} catch (error) {
		throw new Error(
			`Chrome did not grant tab capture for tab ${tabId}. Focus the target tab, invoke Shuvgeist from that user-owned tab, and confirm the tabCapture permission. ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function installRecordingIndicator(recordingId: string): void {
	const elementId = "__shuvgeist-tab-capture-indicator";
	document.getElementById(elementId)?.remove();
	document.getElementById("__shuvgeist-tab-capture-approval")?.remove();
	const container = document.createElement("div");
	container.id = elementId;
	container.style.cssText =
		"position:fixed;top:12px;right:12px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;background:#8b1111;color:white;font:600 12px/1.2 system-ui,sans-serif;box-shadow:0 2px 12px #0008";
	const label = document.createElement("span");
	label.textContent = "Shuvgeist recording";
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = "Stop";
	button.style.cssText =
		"border:1px solid #fff8;border-radius:5px;background:white;color:#650b0b;padding:3px 8px;font:inherit;cursor:pointer";
	button.addEventListener("click", () => {
		button.disabled = true;
		button.textContent = "Stopping…";
		void chrome.runtime.sendMessage({ type: "tab-capture-user-stop", recordingId });
	});
	container.append(label, button);
	document.documentElement.append(container);
}

function removeRecordingIndicator(): void {
	document.getElementById("__shuvgeist-tab-capture-indicator")?.remove();
}

async function defaultShowIndicator(tabId: number, recordingId: string): Promise<void> {
	await chrome.action.setBadgeBackgroundColor({ tabId, color: "#a4161a" });
	await chrome.action.setBadgeText({ tabId, text: "REC" });
	try {
		await chrome.scripting.executeScript({
			target: { tabId },
			func: installRecordingIndicator,
			args: [recordingId],
		});
	} catch {
		// Chrome's own capture badge remains visible on protected pages.
	}
}

async function defaultHideIndicator(tabId: number): Promise<void> {
	await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
	await chrome.scripting
		.executeScript({
			target: { tabId },
			func: removeRecordingIndicator,
		})
		.catch(() => undefined);
}

export class ChromeTabCaptureRecorder {
	private readonly windowId: number;
	private readonly pageDrivers: ChromePageDriverRegistryLike;
	private readonly ensureOffscreen: () => Promise<void>;
	private readonly sendOffscreen: (message: TabCaptureOffscreenMessage) => Promise<TabCaptureOffscreenResponse | null>;
	private readonly emitRecordChunk: (data: RecordChunkEventData) => void;
	private readonly getMediaStreamId: (tabId: number) => Promise<string>;
	private readonly showIndicator: (tabId: number, recordingId: string) => Promise<void>;
	private readonly hideIndicator: (tabId: number) => Promise<void>;
	private readonly byTabId = new Map<number, TabCaptureState>();
	private readonly byRecordingId = new Map<string, TabCaptureState>();

	constructor(options: ChromeTabCaptureRecorderOptions) {
		this.windowId = options.windowId;
		this.pageDrivers = options.pageDriverRegistry;
		this.ensureOffscreen = options.ensureOffscreenDocument;
		this.sendOffscreen = options.sendOffscreenMessage;
		this.emitRecordChunk = options.emitRecordChunk;
		this.getMediaStreamId = options.getMediaStreamId ?? defaultGetMediaStreamId;
		this.showIndicator = options.showIndicator ?? defaultShowIndicator;
		this.hideIndicator = options.hideIndicator ?? defaultHideIndicator;
	}

	async start(params: RecordStartParams): Promise<RecordStartResult> {
		if (params.audio && params.mode !== "tab-capture") {
			throw new Error("Tab audio requires recording mode tab-capture.");
		}
		const unsupportedOptions = [
			params.fps !== undefined ? "--fps" : undefined,
			params.quality !== undefined ? "--quality" : undefined,
			params.maxWidth !== undefined ? "--max-width" : undefined,
			params.maxHeight !== undefined ? "--max-height" : undefined,
			params.everyNthFrame !== undefined ? "everyNthFrame" : undefined,
		].filter((option): option is string => option !== undefined);
		if (unsupportedOptions.length > 0) {
			throw new Error(
				`Tab-capture mode does not support CDP frame options: ${unsupportedOptions.join(", ")}. Remove them or use --mode cdp.`,
			);
		}
		const resolved = await this.pageDrivers.resolve(params.tabId);
		let protocol = "";
		try {
			protocol = resolved.tab.url ? new URL(resolved.tab.url).protocol : "";
		} catch {}
		if (TAB_CAPTURE_DISALLOWED_SCHEMES.includes(protocol)) {
			throw new Error(`Cannot tab-capture ${resolved.tab.url}. Select a user-owned http or https tab.`);
		}
		if (resolved.tab.windowId !== this.windowId) {
			throw new Error(`Tab ${resolved.tabId} does not belong to browser window ${this.windowId}.`);
		}
		if (this.byTabId.has(resolved.tabId)) {
			throw new Error(`Recording is already active for tab ${resolved.tabId}`);
		}
		await this.ensureOffscreen();
		const streamId = await this.getMediaStreamId(resolved.tabId);
		const recordingId = crypto.randomUUID();
		const startedAt = new Date().toISOString();
		const navigationGeneration = resolved.driver.scope.navigationGeneration;
		let resolveCompletion: (summary: RecordStopResult) => void = () => undefined;
		const completion = new Promise<RecordStopResult>((resolve) => {
			resolveCompletion = resolve;
		});
		const response = await this.sendOffscreen({
			type: "tab-capture-start",
			windowId: this.windowId,
			tabId: resolved.tabId,
			recordingId,
			streamId,
			startedAt,
			navigationGeneration,
			audio: params.audio === true,
			maxDurationMs: params.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
			mimeType: params.mimeType,
			videoBitsPerSecond: params.videoBitsPerSecond,
		});
		if (!response) throw new Error("The offscreen tab-capture runtime did not respond.");
		if (!response.ok) throw new Error(response.error);
		if (!response.active) throw new Error("The offscreen tab-capture runtime did not start.");
		const state: TabCaptureState = {
			windowId: this.windowId,
			tabId: resolved.tabId,
			recordingId,
			startedAt,
			navigationGeneration,
			mimeType: response.mimeType,
			audio: response.audio,
			sourceBytes: 0,
			chunkCount: 0,
			completion,
			resolveCompletion,
		};
		this.byTabId.set(state.tabId, state);
		this.byRecordingId.set(state.recordingId, state);
		try {
			await this.showIndicator(state.tabId, state.recordingId);
		} catch (error) {
			await this.requestStop(state, "error");
			throw new Error(
				`Tab capture started but its visible recording indicator could not be shown. ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		return {
			...pageDriverScopeToWire(resolved.driver.scope, chromeTarget(resolved.tabId)),
			ok: true,
			mode: "tab-capture",
			audio: state.audio,
			indicator: "visible",
			artifactState: "streaming",
			recordingId,
			startedAt,
			mimeType: state.mimeType,
			videoBitsPerSecond: params.videoBitsPerSecond,
			maxDurationMs: params.maxDurationMs ?? DEFAULT_MAX_DURATION_MS,
		};
	}

	async stop(tabId?: number, reason: TabCaptureStopReason = "user"): Promise<RecordStopResult> {
		const state = this.resolveOptionalState(tabId) ?? (await this.recoverState(tabId));
		if (!state) {
			if (tabId !== undefined) throw new Error(`No active tab-capture recording for tab ${tabId}`);
			throw new Error("No active tab-capture recording");
		}
		await this.requestStop(state, reason);
		return Promise.race([
			state.completion,
			new Promise<never>((_resolve, reject) =>
				setTimeout(
					() => reject(new Error(`Timed out waiting for tab-capture recording ${state.recordingId} to stop.`)),
					COMPLETION_TIMEOUT_MS,
				),
			),
		]);
	}

	async status(tabId?: number): Promise<RecordStatusResult> {
		const state = this.resolveOptionalState(tabId) ?? (await this.recoverState(tabId));
		if (!state) {
			const resolved = await this.pageDrivers.resolve(tabId);
			return { ...pageDriverScopeToWire(resolved.driver.scope, chromeTarget(resolved.tabId)), active: false };
		}
		const response = await this.sendOffscreen({
			type: "tab-capture-status",
			windowId: this.windowId,
			recordingId: state.recordingId,
			tabId: state.tabId,
		});
		if (!response?.ok || !response.active) {
			return { ...this.scopeFor(state), active: false };
		}
		state.sourceBytes = response.sourceBytes;
		state.chunkCount = response.chunkCount;
		return {
			...this.scopeFor(state),
			active: true,
			mode: "tab-capture",
			audio: state.audio,
			indicator: "visible",
			artifactState: "streaming",
			recordingId: state.recordingId,
			startedAt: state.startedAt,
			mimeType: response.mimeType,
			durationMs: Math.max(0, Date.now() - Date.parse(state.startedAt)),
			sourceBytes: state.sourceBytes,
			chunkCount: state.chunkCount,
			frameCount: 0,
		};
	}

	handleOffscreenEvent(event: TabCaptureOffscreenEvent): boolean {
		const state = this.byRecordingId.get(event.recordingId);
		if (!state || state.windowId !== event.windowId || state.tabId !== event.tabId) return false;
		if (event.type === "tab-capture-chunk") {
			state.sourceBytes += Math.floor((event.chunkBase64.length * 3) / 4);
			state.chunkCount += 1;
			this.emitRecordChunk({
				...this.scopeFor(state),
				recordingId: state.recordingId,
				seq: event.seq,
				mimeType: event.mimeType,
				chunkBase64: event.chunkBase64,
			});
			return true;
		}
		this.byRecordingId.delete(state.recordingId);
		this.byTabId.delete(state.tabId);
		void this.hideIndicator(state.tabId);
		this.emitRecordChunk({
			...this.scopeFor(state),
			recordingId: state.recordingId,
			seq: event.seq,
			mimeType: event.mimeType,
			chunkBase64: "",
			final: true,
			summary: event.summary,
		});
		state.resolveCompletion(event.summary);
		return true;
	}

	hasRecording(recordingId: string): boolean {
		return this.byRecordingId.has(recordingId);
	}

	hasRecordingForTab(tabId: number): boolean {
		return this.byTabId.has(tabId);
	}

	getActiveTabIds(): number[] {
		return [...this.byTabId.keys()];
	}

	handleTabClosed(tabId: number): void {
		const state = this.byTabId.get(tabId);
		if (state) void this.requestStop(state, "target-closed");
	}

	handleTabNavigated(tabId: number): void {
		const state = this.byTabId.get(tabId);
		if (state) void this.showIndicator(tabId, state.recordingId);
	}

	async dispose(): Promise<void> {
		await Promise.all([...this.byRecordingId.values()].map((state) => this.requestStop(state, "abort")));
	}

	private resolveOptionalState(tabId?: number): TabCaptureState | undefined {
		if (tabId !== undefined) return this.byTabId.get(tabId);
		if (this.byRecordingId.size === 1) return this.byRecordingId.values().next().value;
		if (this.byRecordingId.size > 1) {
			throw new Error("Multiple tab-capture recordings are active; specify --tab-id");
		}
		return undefined;
	}

	private async recoverState(tabId?: number): Promise<TabCaptureState | undefined> {
		const response = await this.sendOffscreen({
			type: "tab-capture-status",
			windowId: this.windowId,
			tabId,
		});
		if (!response?.ok || !response.active) return undefined;
		let resolveCompletion: (summary: RecordStopResult) => void = () => undefined;
		const completion = new Promise<RecordStopResult>((resolve) => {
			resolveCompletion = resolve;
		});
		const state: TabCaptureState = {
			windowId: response.windowId,
			tabId: response.tabId,
			recordingId: response.recordingId,
			startedAt: response.startedAt,
			navigationGeneration: response.navigationGeneration,
			mimeType: response.mimeType,
			audio: response.audio,
			sourceBytes: response.sourceBytes,
			chunkCount: response.chunkCount,
			completion,
			resolveCompletion,
		};
		this.byTabId.set(state.tabId, state);
		this.byRecordingId.set(state.recordingId, state);
		await this.showIndicator(state.tabId, state.recordingId);
		return state;
	}

	private async requestStop(state: TabCaptureState, reason: TabCaptureStopReason): Promise<void> {
		const response = await this.sendOffscreen({
			type: "tab-capture-stop",
			recordingId: state.recordingId,
			reason,
		});
		if (!response?.ok) throw new Error(response?.error || "The offscreen tab-capture runtime did not stop.");
	}

	private scopeFor(state: TabCaptureState) {
		const driver = this.pageDrivers.getByTabId(state.tabId);
		const scope = {
			page:
				driver?.scope.page ??
				({
					transport: "chrome-debugger",
					sessionId: `bridge-window:${state.windowId}`,
					windowId: String(state.windowId),
					pageId: String(state.tabId),
				} as const),
			navigationGeneration: state.navigationGeneration,
		};
		return pageDriverScopeToWire(scope, chromeTarget(state.tabId));
	}
}
