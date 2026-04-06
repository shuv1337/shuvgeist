const executorDispatch = vi.fn();

const mockExecutor = { dispatch: executorDispatch };

const bridgeLog = vi.fn();
vi.mock("../../../src/bridge/logging.js", () => ({
	bridgeLog,
}));

type MessageHandler = (event: { data: string }) => void;

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSED = 3;
	readyState = FakeWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onmessage: MessageHandler | null = null;
	onerror: (() => void) | null = null;
	sent: string[] = [];
	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.readyState = FakeWebSocket.CLOSED;
	}
	emitOpen() {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
	}
	emitMessage(data: unknown) {
		this.onmessage?.({ data: JSON.stringify(data) });
	}
	emitClose() {
		this.onclose?.();
	}
	emitError() {
		this.onerror?.();
	}
}

declare global {
	var WebSocket: typeof FakeWebSocket;
	var chrome: {
		tabs: { query: ReturnType<typeof vi.fn> };
	};
}

globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
globalThis.chrome = {
	tabs: {
		query: vi.fn(),
	},
};

const { BridgeClient } = await import("../../../src/bridge/extension-client.js");

describe("BridgeClient", () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		executorDispatch.mockReset();
		bridgeLog.mockReset();
		chrome.tabs.query.mockReset();
		vi.useRealTimers();
	});

	it("registers with the server and emits an initial tab snapshot", async () => {
		chrome.tabs.query.mockResolvedValue([{ id: 12, url: "https://example.com", title: "Example" }]);
		const onStateChange = vi.fn();
		const client = new BridgeClient();
		client.connect({
			url: "ws://127.0.0.1:19285/ws",
			token: "secret",
			windowId: 4,
			sessionId: "session-4",
			sensitiveAccessEnabled: false,
			executor: mockExecutor,
			onStateChange,
		});

		const socket = FakeWebSocket.instances.at(-1)!;
		expect(client.connectionState).toBe("connecting");
		socket.emitOpen();
		expect(JSON.parse(socket.sent[0])).toMatchObject({
			type: "register",
			role: "extension",
			token: "secret",
			windowId: 4,
			sessionId: "session-4",
			capabilities: expect.not.arrayContaining(["eval", "cookies"]),
		});

		socket.emitMessage({ type: "register_result", ok: true });
		await Promise.resolve();
		expect(client.connectionState).toBe("connected");
		expect(onStateChange).toHaveBeenCalledWith("connected", undefined);
		expect(JSON.parse(socket.sent[1])).toEqual({
			type: "event",
			event: "active_tab_changed",
			data: {
				url: "https://example.com",
				title: "Example",
				tabId: 12,
			},
		});
	});

	it("dispatches bridge requests and sends structured responses", async () => {
		executorDispatch.mockResolvedValue({ ok: true, title: "done" });
		const client = new BridgeClient();
		client.connect({
			url: "ws://127.0.0.1:19285/ws",
			token: "secret",
			windowId: 1,
			sensitiveAccessEnabled: true,
			executor: mockExecutor,
		});
		const socket = FakeWebSocket.instances.at(-1)!;
		socket.emitOpen();
		expect(JSON.parse(socket.sent[0])).toMatchObject({
			capabilities: expect.arrayContaining(["eval", "cookies"]),
		});
		socket.emitMessage({ type: "register_result", ok: true });

		socket.emitMessage({ id: 7, method: "status", params: { verbose: true } });
		await Promise.resolve();
		expect(executorDispatch).toHaveBeenCalledWith("status", { verbose: true }, expect.any(AbortSignal));
		expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ id: 7, result: { ok: true, title: "done" } });
	});

	it("maps executor failures and aborts to bridge error responses", async () => {
		const client = new BridgeClient();
		client.connect({
			url: "ws://127.0.0.1:19285/ws",
			token: "secret",
			windowId: 1,
			sensitiveAccessEnabled: true,
			executor: mockExecutor,
		});
		const socket = FakeWebSocket.instances.at(-1)!;
		socket.emitOpen();
		socket.emitMessage({ type: "register_result", ok: true });

		executorDispatch.mockRejectedValueOnce(Object.assign(new Error("boom"), { code: -32008 }));
		socket.emitMessage({ id: 8, method: "eval", params: { code: "document.title" } });
		await Promise.resolve();
		expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
			id: 8,
			error: { code: -32008, message: "boom" },
		});

		executorDispatch.mockImplementationOnce(
			(_method: string, _params: Record<string, unknown>, signal?: AbortSignal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: -32005 })));
				}),
		);
		socket.emitMessage({ id: 9, method: "session_inject", params: { content: "hello" } });
		socket.emitMessage({ type: "abort", id: 9 });
		await Promise.resolve();
		await Promise.resolve();
		expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
			id: 9,
			error: { code: -32005, message: "aborted" },
		});
	});

	it("handles rejected registration and reconnect scheduling", async () => {
		vi.useFakeTimers();
		const onStateChange = vi.fn();
		const client = new BridgeClient();
		client.connect({
			url: "ws://127.0.0.1:19285/ws",
			token: "secret",
			windowId: 2,
			sensitiveAccessEnabled: false,
			executor: mockExecutor,
			onStateChange,
		});
		const socket = FakeWebSocket.instances.at(-1)!;
		socket.emitOpen();
		socket.emitMessage({ type: "register_result", ok: false, error: "Invalid token" });
		expect(client.connectionState).toBe("error");
		expect(client.connectionDetail).toBe("Invalid token");

		client.connect({
			url: "ws://127.0.0.1:19285/ws",
			token: "secret",
			windowId: 2,
			sensitiveAccessEnabled: false,
			executor: mockExecutor,
			onStateChange,
		});
		const retrySocket = FakeWebSocket.instances.at(-1)!;
		retrySocket.emitOpen();
		retrySocket.emitClose();
		expect(client.connectionState).toBe("disconnected");
		await vi.advanceTimersByTimeAsync(1000);
		expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
		client.disconnect();
		expect(client.connectionState).toBe("disabled");
		expect(onStateChange).toHaveBeenCalledWith("disabled", undefined);
	});

	it("falls back to currentWindow query when registered windowId is 0", async () => {
		chrome.tabs.query.mockResolvedValue([{ id: 21, url: "https://fallback.test", title: "Fallback" }]);
		const client = new BridgeClient();
		client.connect({
			url: "ws://127.0.0.1:19285/ws",
			token: "secret",
			windowId: 0,
			sensitiveAccessEnabled: false,
			executor: mockExecutor,
		});
		const socket = FakeWebSocket.instances.at(-1)!;
		socket.emitOpen();
		socket.emitMessage({ type: "register_result", ok: true });
		await Promise.resolve();
		await Promise.resolve();

		// Must NOT have queried with `windowId: 0` directly. Must use the
		// `currentWindow: true` fallback so the snapshot still produces a tab.
		expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
		expect(chrome.tabs.query).not.toHaveBeenCalledWith(expect.objectContaining({ windowId: 0 }));

		const lastSent = JSON.parse(socket.sent.at(-1)!);
		expect(lastSent).toEqual({
			type: "event",
			event: "active_tab_changed",
			data: {
				url: "https://fallback.test",
				title: "Fallback",
				tabId: 21,
			},
		});
	});

	it("reconnects when windowId transitions from unusable (0) to a valid id", async () => {
		chrome.tabs.query.mockResolvedValue([{ id: 30, url: "https://x.test", title: "X" }]);
		const client = new BridgeClient();
		client.connect({
			url: "ws://127.0.0.1:19285/ws",
			token: "secret",
			windowId: 0,
			sensitiveAccessEnabled: false,
			executor: mockExecutor,
		});
		const initialCount = FakeWebSocket.instances.length;
		const initialSocket = FakeWebSocket.instances.at(-1)!;
		initialSocket.emitOpen();
		initialSocket.emitMessage({ type: "register_result", ok: true });

		// Reconnect with a usable window id. areOptionsEquivalent must report
		// non-equivalent so a new socket is created instead of being skipped.
		client.connect({
			url: "ws://127.0.0.1:19285/ws",
			token: "secret",
			windowId: 5,
			sensitiveAccessEnabled: false,
			executor: mockExecutor,
		});
		expect(FakeWebSocket.instances.length).toBeGreaterThan(initialCount);
		const newSocket = FakeWebSocket.instances.at(-1)!;
		expect(newSocket).not.toBe(initialSocket);
		newSocket.emitOpen();
		expect(JSON.parse(newSocket.sent[0])).toMatchObject({
			type: "register",
			windowId: 5,
		});
	});

	it("reuses existing socket when both connect calls share the same usable windowId", async () => {
		chrome.tabs.query.mockResolvedValue([{ id: 40, url: "https://y.test", title: "Y" }]);
		const client = new BridgeClient();
		client.connect({
			url: "ws://127.0.0.1:19285/ws",
			token: "secret",
			windowId: 9,
			sensitiveAccessEnabled: false,
			executor: mockExecutor,
		});
		const socket = FakeWebSocket.instances.at(-1)!;
		socket.emitOpen();
		socket.emitMessage({ type: "register_result", ok: true });
		const countBefore = FakeWebSocket.instances.length;

		client.connect({
			url: "ws://127.0.0.1:19285/ws",
			token: "secret",
			windowId: 9,
			sensitiveAccessEnabled: false,
			executor: mockExecutor,
		});
		expect(FakeWebSocket.instances.length).toBe(countBefore);
	});

	it("sends manual events only when connected", () => {
		const client = new BridgeClient();
		client.connect({
			url: "ws://127.0.0.1:19285/ws",
			token: "secret",
			windowId: 5,
			sensitiveAccessEnabled: false,
			executor: mockExecutor,
		});
		const socket = FakeWebSocket.instances.at(-1)!;
		client.sendEvent("active_tab_changed", { tabId: 1 });
		expect(socket.sent).toHaveLength(0);
		socket.emitOpen();
		socket.emitMessage({ type: "register_result", ok: true });
		client.sendEvent("active_tab_changed", { tabId: 1 });
		expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
			type: "event",
			event: "active_tab_changed",
			data: { tabId: 1 },
		});
	});
});
