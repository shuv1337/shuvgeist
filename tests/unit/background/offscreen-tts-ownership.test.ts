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
		const existing = this.listeners.get(type) ?? [];
		existing.push(listener);
		this.listeners.set(type, existing);
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

const executeMock = vi.fn();

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

describe("offscreen TTS ownership", () => {
	beforeEach(() => {
		vi.resetModules();
		executeMock.mockReset().mockResolvedValue({
			success: true,
			console: [],
			files: [],
			returnValue: "ok",
		});
		(globalThis as typeof globalThis & { Audio: typeof AudioMock }).Audio = AudioMock as unknown as typeof Audio;
		(globalThis as typeof globalThis & { chrome: typeof chrome }).chrome = {
			runtime: {
				onMessage: { addListener: vi.fn() },
				getURL: vi.fn((value: string) => value),
			},
		} as unknown as typeof chrome;
	});

	it("keeps the shared TTS controller alive across REPL teardown", async () => {
		const createObjectURL = vi.fn(() => "blob:tts");
		const revokeObjectURL = vi.fn();
		globalThis.URL.createObjectURL = createObjectURL;
		globalThis.URL.revokeObjectURL = revokeObjectURL;

		const offscreenModule = await import("../../../src/offscreen.js");
		await offscreenModule.handleOffscreenTtsMessage({
			type: "tts-offscreen-synthesize",
			provider: "kokoro",
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

		const controllerBefore = window.__shuvgeistTtsController;
		expect(controllerBefore).toBeDefined();

		await offscreenModule.executeRepl("return 1", "test");

		expect(window.__shuvgeistTtsController).toBe(controllerBefore);
		expect(revokeObjectURL).not.toHaveBeenCalled();
	});
});
