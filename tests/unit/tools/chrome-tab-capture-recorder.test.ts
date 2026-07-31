import type { PageDriver } from "@shuvgeist/driver/page-driver";
import type {
	ChromePageDriverRegistryLike,
	ResolvedChromePageDriver,
} from "@shuvgeist/extension/bridge/chrome-page-driver-registry";
import { ChromeTabCaptureRecorder } from "@shuvgeist/extension/recording/chrome-tab-capture-recorder";
import type {
	TabCaptureOffscreenMessage,
	TabCaptureOffscreenResponse,
} from "@shuvgeist/extension/recording/tab-capture-messages";
import type { RecordChunkEventData, RecordStopResult } from "@shuvgeist/protocol/protocol";

const STARTED_AT = "2026-07-31T12:00:00.000Z";

class FakeRegistry implements ChromePageDriverRegistryLike {
	readonly driver = {
		scope: {
			page: {
				transport: "chrome-debugger",
				sessionId: "bridge-window:7",
				windowId: "7",
				pageId: "9",
			},
			navigationGeneration: 3,
		},
	} as unknown as PageDriver;

	async resolve(tabId?: number): Promise<ResolvedChromePageDriver> {
		if (tabId !== undefined && tabId !== 9) throw new Error(`Unexpected tab ${tabId}`);
		return {
			tabId: 9,
			tab: { id: 9, windowId: 7, active: true, url: "https://example.com" },
			source: tabId === undefined ? "active" : "explicit",
			driver: this.driver,
		};
	}

	getByTabId(tabId: number): PageDriver | undefined {
		return tabId === 9 ? this.driver : undefined;
	}

	async release(): Promise<void> {}
	async dispose(): Promise<void> {}
}

function summary(recordingId: string): RecordStopResult {
	return {
		target: { kind: "chrome-tab", tabId: 9, frameId: 0 },
		navigationGeneration: 3,
		tabId: 9,
		frameId: 0,
		ok: true,
		mode: "tab-capture",
		audio: true,
		artifactState: "complete",
		recordingId,
		startedAt: STARTED_AT,
		endedAt: "2026-07-31T12:00:01.000Z",
		durationMs: 1_000,
		mimeType: "video/webm;codecs=vp8,opus",
		sourceBytes: 3,
		encodedSizeBytes: 3,
		chunkCount: 1,
		frameCount: 0,
		outcome: "stopped_user",
	};
}

function createFixture() {
	const messages: TabCaptureOffscreenMessage[] = [];
	const chunks: RecordChunkEventData[] = [];
	const indicators: string[] = [];
	let recorder: ChromeTabCaptureRecorder;
	const sendOffscreenMessage = vi.fn(
		async (message: TabCaptureOffscreenMessage): Promise<TabCaptureOffscreenResponse> => {
			messages.push(message);
			if (message.type === "tab-capture-start") {
				return {
					ok: true,
					active: true,
					windowId: message.windowId,
					tabId: message.tabId,
					navigationGeneration: message.navigationGeneration,
					recordingId: message.recordingId,
					startedAt: STARTED_AT,
					mimeType: "video/webm;codecs=vp8,opus",
					audio: message.audio,
					sourceBytes: 0,
					chunkCount: 0,
				};
			}
			if (message.type === "tab-capture-status") {
				return {
					ok: true,
					active: true,
					windowId: 7,
					tabId: 9,
					navigationGeneration: 3,
					recordingId: message.recordingId || "",
					startedAt: STARTED_AT,
					mimeType: "video/webm;codecs=vp8,opus",
					audio: true,
					sourceBytes: 3,
					chunkCount: 1,
				};
			}
			queueMicrotask(() => {
				recorder.handleOffscreenEvent({
					type: "tab-capture-complete",
					windowId: 7,
					tabId: 9,
					recordingId: message.recordingId,
					navigationGeneration: 3,
					seq: 1,
					mimeType: "video/webm;codecs=vp8,opus",
					summary: summary(message.recordingId),
				});
			});
			return { ok: true, active: false };
		},
	);
	recorder = new ChromeTabCaptureRecorder({
		windowId: 7,
		pageDriverRegistry: new FakeRegistry(),
		ensureOffscreenDocument: vi.fn(async () => undefined),
		sendOffscreenMessage,
		emitRecordChunk: (chunk) => chunks.push(chunk),
		getMediaStreamId: vi.fn(async () => "stream-9"),
		showIndicator: vi.fn(async (_tabId, recordingId) => {
			indicators.push(`show:${recordingId}`);
		}),
		hideIndicator: vi.fn(async (tabId) => {
			indicators.push(`hide:${tabId}`);
		}),
	});
	return { recorder, messages, chunks, indicators, sendOffscreenMessage };
}

describe("ChromeTabCaptureRecorder", () => {
	it("starts explicit audio capture, reports state, streams chunks, and completes", async () => {
		const { recorder, messages, chunks, indicators } = createFixture();
		const started = await recorder.start({
			tabId: 9,
			mode: "tab-capture",
			audio: true,
			maxDurationMs: 5_000,
		});
		expect(started).toMatchObject({
			target: { kind: "chrome-tab", tabId: 9, frameId: 0 },
			navigationGeneration: 3,
			mode: "tab-capture",
			audio: true,
			indicator: "visible",
			artifactState: "streaming",
			mimeType: "video/webm;codecs=vp8,opus",
		});
		expect(messages[0]).toMatchObject({
			type: "tab-capture-start",
			tabId: 9,
			streamId: "stream-9",
			audio: true,
			maxDurationMs: 5_000,
		});
		expect(indicators).toEqual([`show:${started.recordingId}`]);

		recorder.handleOffscreenEvent({
			type: "tab-capture-chunk",
			windowId: 7,
			tabId: 9,
			recordingId: started.recordingId,
			navigationGeneration: 3,
			seq: 0,
			mimeType: started.mimeType,
			chunkBase64: "YWJj",
		});
		expect(chunks[0]).toMatchObject({ seq: 0, chunkBase64: "YWJj", target: { tabId: 9 } });

		const status = await recorder.status(9);
		expect(status).toMatchObject({
			active: true,
			mode: "tab-capture",
			audio: true,
			sourceBytes: 3,
			chunkCount: 1,
		});

		await expect(recorder.stop(9)).resolves.toMatchObject({
			mode: "tab-capture",
			artifactState: "complete",
			outcome: "stopped_user",
		});
		expect(chunks.at(-1)).toMatchObject({ final: true, summary: { outcome: "stopped_user" } });
		expect(indicators.at(-1)).toBe("hide:9");
	});

	it("restores the visible indicator after navigation", async () => {
		const { recorder, indicators } = createFixture();
		const started = await recorder.start({ tabId: 9, mode: "tab-capture" });
		recorder.handleTabNavigated(9);
		await vi.waitFor(() => expect(indicators).toEqual([`show:${started.recordingId}`, `show:${started.recordingId}`]));
	});

	it("surfaces Chrome permission denial without falling back to CDP", async () => {
		const recorder = new ChromeTabCaptureRecorder({
			windowId: 7,
			pageDriverRegistry: new FakeRegistry(),
			ensureOffscreenDocument: vi.fn(async () => undefined),
			sendOffscreenMessage: vi.fn(),
			emitRecordChunk: vi.fn(),
			getMediaStreamId: vi.fn(async () => {
				throw new Error("Focus the target tab and confirm tabCapture permission.");
			}),
			showIndicator: vi.fn(),
			hideIndicator: vi.fn(),
		});
		await expect(recorder.start({ tabId: 9, mode: "tab-capture" })).rejects.toThrow("tabCapture permission");
	});
});
