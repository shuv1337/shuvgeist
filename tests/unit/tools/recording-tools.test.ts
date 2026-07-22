import type {
	ChromePageDriverRegistryLike,
	ResolvedChromePageDriver,
} from "@shuvgeist/extension/bridge/chrome-page-driver-registry";
import type { PageDriverScope } from "@shuvgeist/driver/page-driver-identity";
import type { PageDriver } from "@shuvgeist/driver/page-driver";
import type {
	PageScreencastEngine,
	PageScreencastFrame,
	PageScreencastHandlers,
	PageScreencastStartOptions,
	PageScreencastStartResult,
	PageScreencastStatus,
	PageScreencastStopReason,
	PageScreencastSummary,
} from "@shuvgeist/driver/page-screencast-engine";
import { assertRecordableTabUrl, RecordingTools } from "@shuvgeist/extension/tools/recording-tools";
import type { RecordFrameEventData } from "@shuvgeist/protocol/protocol";

const STARTED_AT = "2026-07-21T12:00:00.000Z";
const ENDED_AT = "2026-07-21T12:00:01.250Z";

function scopeFor(tabId = 9, navigationGeneration = 4): PageDriverScope {
	return {
		page: {
			transport: "chrome-debugger",
			sessionId: "bridge-window:7",
			windowId: "7",
			pageId: String(tabId),
		},
		navigationGeneration,
	};
}

class FakeScreencastEngine implements PageScreencastEngine {
	readonly startCalls: PageScreencastStartOptions[] = [];
	readonly stopCalls: Array<{ recordingId?: string; reason: PageScreencastStopReason }> = [];
	readonly recordingId: string;
	private handlers?: PageScreencastHandlers;
	private active = false;
	private currentScope: PageDriverScope;
	private sourceBytes = 0;
	private frameCount = 0;
	private fps = 12;
	private mimeType = "video/webm";

	constructor(tabId = 9) {
		this.recordingId = `recording-${tabId}`;
		this.currentScope = scopeFor(tabId);
	}

	setScope(navigationGeneration: number): void {
		this.currentScope = scopeFor(Number(this.currentScope.page.pageId), navigationGeneration);
	}

	setStats(sourceBytes: number, frameCount: number): void {
		this.sourceBytes = sourceBytes;
		this.frameCount = frameCount;
	}

	async start(
		options: PageScreencastStartOptions,
		handlers: PageScreencastHandlers,
	): Promise<PageScreencastStartResult> {
		this.startCalls.push(options);
		this.handlers = handlers;
		this.active = true;
		this.fps = options.fps ?? 12;
		this.mimeType = options.mimeType ?? "video/webm";
		return {
			scope: this.currentScope,
			ok: true,
			recordingId: this.recordingId,
			startedAt: STARTED_AT,
			mimeType: this.mimeType,
			videoBitsPerSecond: options.videoBitsPerSecond,
			maxDurationMs: options.maxDurationMs ?? 30_000,
		};
	}

	async stop(recordingId?: string, reason: PageScreencastStopReason = "user"): Promise<PageScreencastSummary> {
		this.stopCalls.push({ recordingId, reason });
		return this.complete(reason);
	}

	status(): PageScreencastStatus {
		if (!this.active) return { scope: this.currentScope, active: false };
		return {
			scope: this.currentScope,
			active: true,
			recordingId: this.recordingId,
			startedAt: STARTED_AT,
			mimeType: this.mimeType,
			durationMs: 625,
			sourceBytes: this.sourceBytes,
			frameCount: this.frameCount,
			fps: this.fps,
		};
	}

	async dispose(): Promise<void> {
		this.active = false;
	}

	emitFrame(overrides: Partial<PageScreencastFrame> = {}): void {
		this.handlers?.onFrame({
			scope: this.currentScope,
			recordingId: this.recordingId,
			seq: 0,
			format: "jpeg",
			dataBase64: "YWJj",
			capturedAtMs: Date.parse(STARTED_AT) + 500,
			metadata: { deviceWidth: 800 },
			...overrides,
		});
	}

	complete(reason: PageScreencastStopReason, lastError?: string): PageScreencastSummary {
		this.active = false;
		const summary: PageScreencastSummary = {
			scope: this.currentScope,
			ok: true,
			recordingId: this.recordingId,
			startedAt: STARTED_AT,
			endedAt: ENDED_AT,
			durationMs: 1_250,
			mimeType: this.mimeType,
			sourceBytes: this.sourceBytes,
			frameCount: this.frameCount,
			reason,
			lastError,
		};
		this.handlers?.onComplete(summary);
		return summary;
	}
}

class FakePageDriverRegistry implements ChromePageDriverRegistryLike {
	readonly releaseCalls: number[] = [];
	readonly engine: FakeScreencastEngine;
	readonly driver: PageDriver;
	private readonly tab: chrome.tabs.Tab;

	constructor(
		private readonly tabId = 9,
		url = "https://example.com",
	) {
		this.engine = new FakeScreencastEngine(tabId);
		this.driver = { screencast: this.engine } as unknown as PageDriver;
		this.tab = { id: tabId, windowId: 7, active: true, url, title: "Example" };
	}

	async resolve(tabId?: number): Promise<ResolvedChromePageDriver> {
		if (tabId !== undefined && tabId !== this.tabId) throw new Error(`Unexpected tab ${tabId}`);
		return {
			tabId: this.tabId,
			tab: this.tab,
			source: tabId === undefined ? "active" : "explicit",
			driver: this.driver,
		};
	}

	getByTabId(tabId: number): PageDriver | undefined {
		return tabId === this.tabId ? this.driver : undefined;
	}

	async release(tabId: number): Promise<void> {
		this.releaseCalls.push(tabId);
	}

	async dispose(): Promise<void> {}
}

function createFixture(options: { tabId?: number; url?: string } = {}) {
	const registry = new FakePageDriverRegistry(options.tabId, options.url);
	const frames: RecordFrameEventData[] = [];
	const tools = new RecordingTools({
		windowId: 7,
		pageDriverRegistry: registry,
		emitRecordFrame: (frame) => frames.push(frame),
	});
	return { tools, registry, engine: registry.engine, frames };
}

describe("RecordingTools", () => {
	it("adapts driver start, status, frame, and final results with concrete target scope", async () => {
		const { tools, engine, frames } = createFixture();
		const controller = new AbortController();
		const started = await tools.start(
			{
				tabId: 9,
				frameId: 0,
				maxDurationMs: 2_500,
				videoBitsPerSecond: 800_000,
				mimeType: "video/webm;codecs=vp8",
				fps: 15,
				quality: 80,
				maxWidth: 1_024,
				maxHeight: 768,
				everyNthFrame: 2,
			},
			controller.signal,
		);

		expect(engine.startCalls).toEqual([
			{
				maxDurationMs: 2_500,
				videoBitsPerSecond: 800_000,
				mimeType: "video/webm;codecs=vp8",
				fps: 15,
				quality: 80,
				maxWidth: 1_024,
				maxHeight: 768,
				everyNthFrame: 2,
				signal: controller.signal,
			},
		]);
		expect(started).toMatchObject({
			target: { kind: "chrome-tab", tabId: 9, frameId: 0 },
			navigationGeneration: 4,
			tabId: 9,
			frameId: 0,
			recordingId: "recording-9",
		});

		engine.setScope(5);
		engine.setStats(11, 2);
		const status = await tools.status({ tabId: 9, frameId: 0 });
		expect(status).toMatchObject({
			target: { kind: "chrome-tab", tabId: 9, frameId: 0 },
			navigationGeneration: 5,
			tabId: 9,
			frameId: 0,
			active: true,
			sourceBytes: 11,
			frameCount: 2,
		});
		expect(status).not.toHaveProperty("sizeBytes");

		engine.setScope(6);
		engine.emitFrame();
		expect(frames[0]).toMatchObject({
			target: { kind: "chrome-tab", tabId: 9, frameId: 0 },
			navigationGeneration: 6,
			tabId: 9,
			frameId: 0,
			recordingId: "recording-9",
			seq: 0,
			dataBase64: "YWJj",
			metadata: { deviceWidth: 800 },
		});

		engine.setScope(7);
		engine.complete("max-duration");
		const finalFrame = frames.at(-1);
		expect(finalFrame).toMatchObject({
			target: { kind: "chrome-tab", tabId: 9, frameId: 0 },
			navigationGeneration: 7,
			tabId: 9,
			frameId: 0,
			final: true,
			summary: {
				target: { kind: "chrome-tab", tabId: 9, frameId: 0 },
				navigationGeneration: 7,
				sourceBytes: 11,
				frameCount: 2,
				outcome: "stopped_max_duration",
			},
		});
		expect(finalFrame?.summary).not.toHaveProperty("sizeBytes");
		expect(tools.hasRecording("recording-9")).toBe(false);
	});

	it.each([
		["max-duration", "stopped_max_duration", undefined],
		["target-closed", "stopped_target_closed", "target disappeared"],
		["error", "stopped_error", "frame ACK failed"],
	] as const)("maps %s completion to %s", async (reason, outcome, lastError) => {
		const { tools, engine, frames } = createFixture();
		await tools.start({ tabId: 9 });
		engine.setStats(3, 1);
		engine.complete(reason, lastError);

		expect(frames.at(-1)?.summary).toMatchObject({ outcome, sourceBytes: 3, frameCount: 1 });
		if (lastError) expect(frames.at(-1)?.summary).toMatchObject({ lastError });
		expect(frames.at(-1)?.summary).not.toHaveProperty("sizeBytes");
	});

	it("stops a closed target through the engine and releases its driver", async () => {
		const { tools, registry, engine, frames } = createFixture();
		await tools.start({ tabId: 9 });

		tools.handleTabClosed(9);

		await vi.waitFor(() => expect(registry.releaseCalls).toEqual([9]));
		expect(engine.stopCalls).toEqual([{ recordingId: "recording-9", reason: "target-closed" }]);
		expect(frames.at(-1)?.summary?.outcome).toBe("stopped_target_closed");
	});

	it("rejects a second active recording on the same tab", async () => {
		const { tools, engine } = createFixture();
		await tools.start({ tabId: 9 });

		await expect(tools.start({ tabId: 9 })).rejects.toThrow("Recording is already active for tab 9");
		expect(engine.startCalls).toHaveLength(1);
	});

	it("rejects non-top-frame start, status, and stop requests", async () => {
		const { tools, engine } = createFixture();
		await expect(tools.start({ tabId: 9, frameId: 2 })).rejects.toThrow(
			"Chrome recording supports only the top frame; received frameId 2",
		);
		await expect(tools.status({ tabId: 9, frameId: 3 })).rejects.toThrow(
			"Chrome recording supports only the top frame; received frameId 3",
		);
		await tools.start({ tabId: 9 });
		await expect(tools.stop({ tabId: 9, frameId: 4 })).rejects.toThrow(
			"Chrome recording supports only the top frame; received frameId 4",
		);
		expect(engine.stopCalls).toEqual([]);
	});

	it("rejects stop without an active recording", async () => {
		const { tools } = createFixture();
		await expect(tools.stop({ tabId: 9 })).rejects.toThrow("No active recording for tab 9");
	});

	it("accepts recordable web URLs and rejects debugger-inaccessible schemes", async () => {
		expect(() => assertRecordableTabUrl("https://example.com/path")).not.toThrow();
		expect(() => assertRecordableTabUrl("http://localhost:3000")).not.toThrow();
		for (const url of [
			"chrome://settings",
			"chrome-extension://abc/page.html",
			"devtools://devtools/bundled/inspector.html",
			"view-source:https://example.com",
			"about:blank",
		]) {
			expect(() => assertRecordableTabUrl(url)).toThrow(`Cannot record ${url}`);
		}

		const { tools, engine } = createFixture({ url: "chrome://settings" });
		await expect(tools.start({ tabId: 9 })).rejects.toThrow("Cannot record chrome://settings");
		expect(engine.startCalls).toEqual([]);
	});
});
