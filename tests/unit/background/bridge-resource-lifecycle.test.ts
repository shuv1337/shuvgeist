import { describe, expect, it, vi } from "vitest";

interface EventHarness<T extends (...args: never[]) => unknown> {
	listeners: T[];
	addListener: (listener: T) => void;
}

function createEventHarness<T extends (...args: never[]) => unknown>(): EventHarness<T> {
	const listeners: T[] = [];
	return {
		listeners,
		addListener(listener) {
			listeners.push(listener);
		},
	};
}

const lifecycle = vi.hoisted(() => ({
	settings: {
		enabled: true,
		url: "ws://127.0.0.1:19285/ws",
		token: "token-1",
		sensitiveAccessEnabled: false,
		observability: { enabled: false, ingestUrl: "http://localhost:3474", publicIngestKey: "" },
	},
	clients: [] as Array<{ disconnect: ReturnType<typeof vi.fn>; connectionState: string }>,
	executors: [] as Array<{
		dispose: ReturnType<typeof vi.fn>;
		options: { recordingRouter: { start: (params: object) => Promise<unknown> } };
	}>,
	recorders: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
	registries: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
	events: [] as string[],
	runtimeInitResolvers: [] as Array<() => void>,
}));

vi.mock("@shuv1337/pi-web-ui", () => ({ setAppStorage: vi.fn() }));

vi.mock("@shuvgeist/extension/bridge/background-runtime-handler", () => ({
	handleBackgroundPageRuntimeOperation: vi.fn(),
	resolveBackgroundUserScriptMessage: vi.fn(() => false),
}));

vi.mock("@shuvgeist/extension/bridge/bootstrap", () => ({
	bootstrapTokenIfNeeded: vi.fn(async (settings: object) => ({ settings })),
}));

vi.mock("@shuvgeist/extension/bridge/browser-command-executor", () => ({
	BrowserCommandExecutor: class {
		readonly dispose = vi.fn(async () => undefined);
		constructor(readonly options: { recordingRouter: { start: (params: object) => Promise<unknown> } }) {
			lifecycle.executors.push(this);
		}
	},
}));

vi.mock("@shuvgeist/extension/bridge/chrome-page-driver-registry", () => ({
	ChromePageDriverRegistry: class {
		readonly dispose = vi.fn(async () => undefined);
		constructor() {
			lifecycle.registries.push(this);
		}
	},
}));

vi.mock("@shuvgeist/extension/bridge/extension-client", () => ({
	BridgeClient: class {
		connectionState = "disconnected";
		connectionDetail: string | undefined;
		readonly disconnect = vi.fn(() => {
			this.connectionState = "disconnected";
		});
		constructor() {
			lifecycle.clients.push(this);
		}
		connect() {
			lifecycle.events.push("bridge:connect");
			this.connectionState = "connected";
		}
		nudgeReconnect() {}
		sendCapabilitiesUpdate() {}
		sendEvent() {}
	},
}));

vi.mock("@shuvgeist/protocol/protocol", () => ({
	ErrorCodes: { NO_ACTIVE_SESSION: -1 },
	getBridgeCapabilities: vi.fn(() => []),
}));

vi.mock("@shuvgeist/extension/bridge/runtime-state", () => ({
	BRIDGE_RUNTIME_STATE_KEYS: {
		bridge: "bridge",
		observability: "observability",
		openSidepanels: "openSidepanels",
		sessionLocks: "sessionLocks",
		electron: "electron",
		agentRuntime: "agentRuntime",
		agentRuntimeConnections: "agentRuntimeConnections",
	},
	readBridgeRuntimeState: vi.fn(async () => undefined),
	writeBridgeRuntimeState: vi.fn(async () => undefined),
	writeBridgeRuntimeStates: vi.fn(async () => undefined),
}));

vi.mock("@shuvgeist/extension/bridge/settings", () => ({
	bridgeSettingsFromStorageChange: vi.fn(() => lifecycle.settings),
	createChromeStorageBridgeSettingsAdapter: vi.fn(() => ({})),
	loadBridgeSettings: vi.fn(async () => ({ settings: { ...lifecycle.settings } })),
	settingsRequireReconnect: vi.fn(
		(previous: typeof lifecycle.settings | null, next: typeof lifecycle.settings) =>
			previous === null ||
			previous.enabled !== next.enabled ||
			previous.url !== next.url ||
			previous.token !== next.token ||
			previous.sensitiveAccessEnabled !== next.sensitiveAccessEnabled,
	),
}));

vi.mock("@shuvgeist/protocol/telemetry", () => ({
	BridgeTelemetry: class {
		getExportState() {
			return {};
		}
		updateConfig() {}
		startSpan() {
			return { end() {}, recordError() {}, setAttributes() {} };
		}
	},
	formatTraceparent: vi.fn(),
	parseTraceparent: vi.fn(),
}));

vi.mock("@shuvgeist/extension/storage/app-storage", () => ({
	ShuvgeistAppStorage: class {
		readonly providerKeys = { get: vi.fn(async () => undefined) };
	},
}));

vi.mock("@shuvgeist/extension/tools/helpers/browser-target", () => ({
	isProtectedTabUrl: vi.fn(() => false),
	isUsableWindowId: vi.fn((value: unknown) => typeof value === "number" && value > 0),
	resolveTabTarget: vi.fn(),
}));

vi.mock("@shuvgeist/extension/tools/helpers/debugger-manager", () => ({
	configureSharedDebuggerManagerTelemetry: vi.fn(),
	getSharedDebuggerManager: vi.fn(() => ({})),
}));

vi.mock("@shuvgeist/extension/tools/recording-tools", () => ({
	RecordingTools: class {
		readonly dispose = vi.fn(async () => undefined);
		constructor() {
			lifecycle.recorders.push(this);
		}
		start = vi.fn(async () => ({ recordingId: "recording-1" }));
		stop = vi.fn();
		status = vi.fn();
		hasRecordingForTab() {
			return false;
		}
		getActiveTabIds() {
			return [];
		}
		handleTabClosed() {}
	},
}));

vi.mock("@shuvgeist/extension/tts/kokoro-health", () => ({
	isKokoroHealthStale: vi.fn(() => false),
	probeKokoroHealth: vi.fn(),
	refreshKokoroHealth: vi.fn(),
}));

vi.mock("@shuvgeist/extension/tts/overlay-inject", () => ({
	configureTtsOverlayWorld: vi.fn(),
	injectTtsOverlay: vi.fn(),
	removeTtsOverlay: vi.fn(),
}));

vi.mock("@shuvgeist/extension/tts/playback-coordinator", () => ({
	TtsPlaybackCoordinator: class {
		markOverlayDetached() {}
		getSessionsForTab() {
			return [];
		}
		endReadingSession() {}
		forwardPlayhead() {}
	},
}));

vi.mock("@shuvgeist/extension/tts/service", () => ({
	getProviderVoiceId: vi.fn(),
	getSampleTtsPhrase: vi.fn(),
	listTtsVoices: vi.fn(async () => []),
}));

vi.mock("@shuvgeist/extension/tts/settings", () => ({
	DEFAULT_TTS_SETTINGS: { enabled: false, provider: "openai" },
	loadTtsSettings: vi.fn(async () => ({ enabled: false, provider: "openai" })),
	saveTtsSettings: vi.fn(),
}));

vi.mock("@shuvgeist/extension/tts/types", () => ({
	createInitialTtsPlaybackState: vi.fn(() => ({ overlayVisible: false })),
	reduceTtsPlaybackState: vi.fn((state: object) => state),
}));

vi.mock("@shuvgeist/protocol/version", () => ({ getShuvgeistVersion: vi.fn(() => "test") }));

const storageChanged = createEventHarness<(changes: object, areaName: string) => void>();
const windowRemoved = createEventHarness<(windowId: number) => void>();

function eventStub<T extends (...args: never[]) => unknown>() {
	return createEventHarness<T>();
}

Object.defineProperty(globalThis, "chrome", {
	configurable: true,
	value: {
		action: { onClicked: eventStub() },
		alarms: { create: vi.fn(), onAlarm: eventStub() },
		commands: { onCommand: eventStub() },
		offscreen: {
			Reason: { WORKERS: "WORKERS", AUDIO_PLAYBACK: "AUDIO_PLAYBACK", BLOBS: "BLOBS" },
			createDocument: vi.fn(),
		},
		runtime: {
			ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
			getContexts: vi.fn(async () => []),
			getURL: vi.fn((path: string) => path),
			onConnect: eventStub(),
			onInstalled: eventStub(),
			onMessage: eventStub(),
			onStartup: eventStub(),
			sendMessage: vi.fn(
				(message: { type?: string }, callback?: (response?: unknown) => void) => {
					if (message.type === "agent-runtime-init") {
						lifecycle.events.push("runtime:init:requested");
						lifecycle.runtimeInitResolvers.push(() => {
							lifecycle.events.push("runtime:init:resolved");
							callback?.({ ok: true });
						});
						return;
					}
					callback?.({ ok: true });
				},
			),
		},
		sidePanel: { open: vi.fn() },
		storage: { onChanged: storageChanged },
		tabs: {
			get: vi.fn(),
			onActivated: eventStub(),
			onRemoved: eventStub(),
			onUpdated: eventStub(),
			query: vi.fn(async () => []),
		},
		windows: {
			getLastFocused: vi.fn(async () => ({ id: 7 })),
			onFocusChanged: eventStub(),
			onRemoved: windowRemoved,
		},
	},
});

await import("@shuvgeist/extension/background");

describe("background bridge resource lifecycle", () => {
	it("disposes and recreates bridge resources across reconfiguration, auth failure, disable, and window removal", async () => {
		await vi.waitFor(() => expect(lifecycle.runtimeInitResolvers).toHaveLength(1));
		expect(lifecycle.executors).toHaveLength(0);
		lifecycle.runtimeInitResolvers.shift()?.();
		await vi.waitFor(() => expect(lifecycle.executors).toHaveLength(1));
		expect(lifecycle.events).toEqual(["runtime:init:requested", "runtime:init:resolved", "bridge:connect"]);
		await lifecycle.executors[0].options.recordingRouter.start({});
		expect(lifecycle.recorders).toHaveLength(1);

		lifecycle.settings = { ...lifecycle.settings, token: "token-2" };
		storageChanged.listeners[0]({}, "local");

		await vi.waitFor(() => expect(lifecycle.executors).toHaveLength(2));
		expect(lifecycle.clients[0].disconnect).toHaveBeenCalledOnce();
		expect(lifecycle.executors[0].dispose).toHaveBeenCalledOnce();
		expect(lifecycle.recorders[0].dispose).toHaveBeenCalledOnce();
		expect(lifecycle.registries[0].dispose).toHaveBeenCalledOnce();
		expect(lifecycle.registries[1]).not.toBe(lifecycle.registries[0]);

		await lifecycle.executors[1].options.recordingRouter.start({});
		lifecycle.settings = { ...lifecycle.settings, token: "" };
		storageChanged.listeners[0]({}, "local");

		await vi.waitFor(() => expect(lifecycle.registries[1].dispose).toHaveBeenCalledOnce());
		expect(lifecycle.recorders[1].dispose).toHaveBeenCalledOnce();

		lifecycle.settings = { ...lifecycle.settings, token: "token-3" };
		storageChanged.listeners[0]({}, "local");

		await vi.waitFor(() => expect(lifecycle.executors).toHaveLength(3));
		expect(lifecycle.registries[2]).not.toBe(lifecycle.registries[1]);
		await lifecycle.executors[2].options.recordingRouter.start({});

		lifecycle.settings = { ...lifecycle.settings, enabled: false };
		storageChanged.listeners[0]({}, "local");
		await vi.waitFor(() => expect(lifecycle.registries[2].dispose).toHaveBeenCalledOnce());
		expect(lifecycle.recorders[2].dispose).toHaveBeenCalledOnce();

		lifecycle.settings = { ...lifecycle.settings, enabled: true, token: "token-4" };
		storageChanged.listeners[0]({}, "local");
		await vi.waitFor(() => expect(lifecycle.executors).toHaveLength(4));
		expect(lifecycle.registries[3]).not.toBe(lifecycle.registries[2]);
		await lifecycle.executors[3].options.recordingRouter.start({});

		windowRemoved.listeners[0](7);
		windowRemoved.listeners[0](7);

		await vi.waitFor(() => expect(lifecycle.registries[3].dispose).toHaveBeenCalledOnce());
		expect(lifecycle.recorders[3].dispose).toHaveBeenCalledOnce();
		expect(lifecycle.executors[3].dispose).toHaveBeenCalledOnce();
	});
});
