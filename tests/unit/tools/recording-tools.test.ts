import type { BridgeToOffscreenMessage } from "../../../src/bridge/internal-messages.js";
import type { RecordChunkEventData } from "../../../src/bridge/protocol.js";

const tabsGet = vi.fn();
const tabsQuery = vi.fn();
const getMediaStreamId = vi.fn();

declare global {
	var chrome: {
		tabs: { get: typeof tabsGet; query: typeof tabsQuery };
		tabCapture: { getMediaStreamId: typeof getMediaStreamId };
	};
}

globalThis.chrome = {
	tabs: {
		get: tabsGet,
		query: tabsQuery,
	},
	tabCapture: {
		getMediaStreamId,
	},
};

const { RecordingTools, assertRecordableTabUrl } = await import("../../../src/tools/recording-tools.js");

function activeTab(url = "https://example.com"): chrome.tabs.Tab {
	return { id: 9, windowId: 7, active: true, url, title: "Example" };
}

function createTools() {
	const chunks: RecordChunkEventData[] = [];
	const sendToOffscreen = vi.fn(async (message: BridgeToOffscreenMessage) => {
		if (message.type === "bridge-record-start") {
			return { ok: true, mimeType: message.mimeType ?? "video/webm", videoBitsPerSecond: message.videoBitsPerSecond };
		}
		if (message.type === "bridge-record-stop") {
			return { ok: true };
		}
		return { ok: true };
	});
	const tools = new RecordingTools({
		windowId: 7,
		ensureOffscreenDocument: vi.fn(async () => undefined),
		getOffscreenTabId: vi.fn(async () => 100),
		sendToOffscreen,
		emitRecordChunk: (data) => chunks.push(data),
	});
	return { tools, sendToOffscreen, chunks };
}

describe("RecordingTools", () => {
	beforeEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		const tab = activeTab();
		tabsGet.mockResolvedValue(tab);
		tabsQuery.mockResolvedValue([tab]);
		getMediaStreamId.mockResolvedValue("stream-id");
	});

	it("rejects a second active recording on the same tab", async () => {
		const { tools } = createTools();
		await expect(tools.start({ tabId: 9 })).resolves.toMatchObject({ recordingId: expect.any(String), tabId: 9 });
		await expect(tools.start({ tabId: 9 })).rejects.toThrow("Recording is already active for tab 9");
	});

	it("rejects stop with no active recording", async () => {
		const { tools } = createTools();
		await expect(tools.stop({ tabId: 9 })).rejects.toThrow("No active recording for tab 9");
	});

	it("record_status never includes chunk bytes", async () => {
		const { tools } = createTools();
		const started = await tools.start({ tabId: 9 });
		tools.handleOffscreenMessage({
			type: "record-chunk",
			recordingId: started.recordingId,
			seq: 0,
			mimeType: "video/webm",
			chunkBase64: "YWJj",
		});
		const status = await tools.status({ tabId: 9 });
		expect(status).toMatchObject({ active: true, sizeBytes: 3, durationMs: expect.any(Number) });
		expect(status).not.toHaveProperty("chunkBase64");
	});

	it("auto-stops with stopped_max_duration", async () => {
		vi.useFakeTimers();
		const { tools, sendToOffscreen, chunks } = createTools();
		const started = await tools.start({ tabId: 9, maxDurationMs: 1 });
		await vi.advanceTimersByTimeAsync(1);
		expect(sendToOffscreen).toHaveBeenCalledWith(
			expect.objectContaining({ type: "bridge-record-stop", recordingId: started.recordingId, outcome: "stopped_max_duration" }),
		);
		tools.handleOffscreenMessage({
			type: "record-stopped",
			recordingId: started.recordingId,
			outcome: "stopped_user",
			sizeBytes: 0,
			chunkCount: 0,
			endedAt: Date.now(),
		});
		expect(chunks.at(-1)?.summary?.outcome).toBe("stopped_max_duration");
	});

	it("auto-stops with stopped_tab_closed", async () => {
		const { tools, chunks } = createTools();
		const started = await tools.start({ tabId: 9 });
		tools.handleTabClosed(9);
		tools.handleOffscreenMessage({
			type: "record-stopped",
			recordingId: started.recordingId,
			outcome: "stopped_user",
			sizeBytes: 0,
			chunkCount: 0,
			endedAt: Date.now(),
		});
		expect(chunks.at(-1)?.summary?.outcome).toBe("stopped_tab_closed");
	});

	it("rejects disallowed tabCapture schemes", async () => {
		expect(() => assertRecordableTabUrl("chrome://settings")).toThrow("Cannot record chrome://settings");
		expect(() => assertRecordableTabUrl("chrome-extension://abc/page.html")).toThrow("Cannot record");
		expect(() => assertRecordableTabUrl("about:blank")).toThrow("Cannot record about:blank");
	});

	it("requires the target tab to be focused", async () => {
		const tab = activeTab();
		tabsGet.mockResolvedValue(tab);
		tabsQuery.mockResolvedValue([{ ...tab, id: 10 }]);
		const { tools } = createTools();
		await expect(tools.start({ tabId: 9 })).rejects.toThrow("tabCapture requires the target tab to be active");
	});
});
