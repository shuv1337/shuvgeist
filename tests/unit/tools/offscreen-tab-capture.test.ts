import {
	handleOffscreenTabCaptureMessage,
	releaseOffscreenTabCapturesForTests,
} from "@shuvgeist/extension/recording/offscreen-tab-capture";

class FakeTrack extends EventTarget {
	readonly stop = vi.fn();
}

class FakeStream {
	readonly tracks = [new FakeTrack(), new FakeTrack()];
	getTracks(): FakeTrack[] {
		return this.tracks;
	}
	getAudioTracks(): FakeTrack[] {
		return [this.tracks[0] as FakeTrack];
	}
}

class FakeAudioContext {
	readonly destination = {};
	readonly connect = vi.fn();
	createMediaStreamSource(): { connect: typeof this.connect } {
		return { connect: this.connect };
	}
	async close(): Promise<void> {}
}

class FakeMediaRecorder extends EventTarget {
	static readonly instances: FakeMediaRecorder[] = [];
	static isTypeSupported(type: string): boolean {
		return type.startsWith("video/webm");
	}

	readonly mimeType: string;
	state: RecordingState = "inactive";

	constructor(
		readonly stream: MediaStream,
		options?: MediaRecorderOptions,
	) {
		super();
		this.mimeType = options?.mimeType || "video/webm";
		FakeMediaRecorder.instances.push(this);
	}

	start(): void {
		this.state = "recording";
	}

	stop(): void {
		if (this.state === "inactive") return;
		this.state = "inactive";
		const dataEvent = new Event("dataavailable") as Event & { data: Blob };
		Object.defineProperty(dataEvent, "data", { value: new Blob(["webm"], { type: this.mimeType }) });
		this.dispatchEvent(dataEvent);
		this.dispatchEvent(new Event("stop"));
	}
}

describe("offscreen tab capture", () => {
	const sendMessage = vi.fn(async () => ({ ok: true }));
	const getUserMedia = vi.fn(async () => new FakeStream() as unknown as MediaStream);

	beforeEach(() => {
		FakeMediaRecorder.instances.length = 0;
		sendMessage.mockClear();
		getUserMedia.mockClear();
		vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
		vi.stubGlobal("AudioContext", FakeAudioContext);
		vi.stubGlobal("chrome", { runtime: { sendMessage } });
		vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
	});

	afterEach(() => {
		releaseOffscreenTabCapturesForTests();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("negotiates WebM, captures opt-in audio, emits chunks, and flushes a complete summary", async () => {
		const response = await handleOffscreenTabCaptureMessage({
			type: "tab-capture-start",
			windowId: 7,
			tabId: 9,
			recordingId: "capture-1",
			streamId: "stream-1",
			startedAt: "2026-07-31T12:00:00.000Z",
			navigationGeneration: 4,
			audio: true,
			maxDurationMs: 30_000,
			mimeType: "video/webm;codecs=vp8,opus",
		});
		expect(response).toMatchObject({
			ok: true,
			active: true,
			recordingId: "capture-1",
			audio: true,
			mimeType: "video/webm;codecs=vp8,opus",
		});
		expect(getUserMedia).toHaveBeenCalledWith({
			audio: {
				mandatory: {
					chromeMediaSource: "tab",
					chromeMediaSourceId: "stream-1",
				},
			},
			video: {
				mandatory: {
					chromeMediaSource: "tab",
					chromeMediaSourceId: "stream-1",
				},
			},
		});

		await handleOffscreenTabCaptureMessage({
			type: "tab-capture-stop",
			recordingId: "capture-1",
			reason: "user",
		});
		await vi.waitFor(() =>
			expect(sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "tab-capture-complete",
					recordingId: "capture-1",
					summary: expect.objectContaining({
						mode: "tab-capture",
						audio: true,
						artifactState: "complete",
						chunkCount: 1,
						sourceBytes: 4,
						outcome: "stopped_user",
					}),
				}),
			),
		);
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "tab-capture-chunk",
				recordingId: "capture-1",
				chunkBase64: "d2VibQ==",
			}),
		);
	});

	it("keeps audio disabled unless explicitly requested", async () => {
		await handleOffscreenTabCaptureMessage({
			type: "tab-capture-start",
			windowId: 7,
			tabId: 9,
			recordingId: "capture-silent",
			streamId: "stream-silent",
			startedAt: "2026-07-31T12:00:00.000Z",
			navigationGeneration: 4,
			audio: false,
			maxDurationMs: 30_000,
		});
		expect(getUserMedia.mock.calls[0]?.[0]).toMatchObject({ audio: false });
	});

	it("flushes the final WebM chunk at the hard duration limit", async () => {
		vi.useFakeTimers();
		await handleOffscreenTabCaptureMessage({
			type: "tab-capture-start",
			windowId: 7,
			tabId: 9,
			recordingId: "capture-timeout",
			streamId: "stream-timeout",
			startedAt: "2026-07-31T12:00:00.000Z",
			navigationGeneration: 4,
			audio: false,
			maxDurationMs: 25,
		});
		await vi.advanceTimersByTimeAsync(25);
		await Promise.resolve();
		await Promise.resolve();
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "tab-capture-complete",
				summary: expect.objectContaining({
					artifactState: "complete",
					outcome: "stopped_max_duration",
				}),
			}),
		);
	});
});
