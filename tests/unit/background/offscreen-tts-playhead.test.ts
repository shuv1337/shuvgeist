// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

class AudioMock {
	src = "";
	currentSrc = "";
	currentTime = 0;
	preload = "auto";
	ended = false;
	private listeners = new Map<string, Array<() => void>>();

	addEventListener(type: string, listener: () => void) {
		const current = this.listeners.get(type) ?? [];
		current.push(listener);
		this.listeners.set(type, current);
	}

	removeAttribute(name: string) {
		if (name === "src") {
			this.src = "";
			this.currentSrc = "";
		}
	}

	load() {}

	async play() {
		this.currentSrc = this.src;
		for (const listener of this.listeners.get("play") ?? []) listener();
	}

	pause() {
		for (const listener of this.listeners.get("pause") ?? []) listener();
	}
}

const synthesizeTtsMock = vi.fn();
const executeMock = vi.fn();

vi.mock("../../../src/tts/service.js", () => ({
	synthesizeTts: synthesizeTtsMock,
}));

vi.mock("@mariozechner/pi-web-ui", () => ({
	SandboxIframe: class {
		style = { display: "" };
		sandboxUrlProvider = () => "";
		execute = executeMock;
		remove = vi.fn();
	},
}));

vi.mock("../../../src/bridge/offscreen-runtime-providers.js", () => ({
	buildOffscreenRuntimeProviders: () => [],
}));

describe("offscreen TTS playhead forwarding", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
		synthesizeTtsMock.mockReset().mockResolvedValue({
			audioData: new ArrayBuffer(4),
			mimeType: "audio/mpeg",
			timings: [{ word: "hello", startTime: 0, endTime: 0.5 }],
		});
		executeMock.mockReset().mockResolvedValue({ success: true, console: [], files: [], returnValue: "ok" });
		globalThis.URL.createObjectURL = vi.fn(() => "blob:tts");
		globalThis.URL.revokeObjectURL = vi.fn();
		(globalThis as typeof globalThis & { Audio: typeof AudioMock }).Audio = AudioMock as unknown as typeof Audio;
		(globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = {
			runtime: {
				onMessage: { addListener: vi.fn() },
				getURL: vi.fn((value: string) => value),
				sendMessage: vi.fn().mockResolvedValue({ ok: true }),
			},
		} as unknown as typeof chrome;
	});

	it("forwards playhead updates while captioned audio is playing", async () => {
		const offscreenModule = await import("../../../src/offscreen.js");
		await offscreenModule.handleOffscreenTtsMessage({
			type: "tts-offscreen-synthesize-captioned",
			sessionId: "session-1",
			request: {
				text: "hello",
				voiceId: "af_heart",
				speed: 1,
				modelId: "kokoro",
			},
			config: {
				baseUrl: "http://127.0.0.1:8880/v1",
				modelId: "kokoro",
			},
		});

		const controller = window.__shuvgeistTtsController;
		if (!controller) {
			throw new Error("expected shared TTS controller");
		}
		controller.audio.currentTime = 0.1;
		vi.advanceTimersByTime(60);

		expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "tts-offscreen-playhead", sessionId: "session-1" }),
		);
	});
});
