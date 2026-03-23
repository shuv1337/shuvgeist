const executorDispatch = vi.fn();
const executorStatus = vi.fn();

vi.mock("../../../src/bridge/browser-command-executor.js", () => ({
	BrowserCommandExecutor: class {
		constructor(_options: unknown) {}
		dispatch = executorDispatch;
		status = executorStatus;
	},
}));

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
		executorStatus.mockReset();
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
			debuggerEnabled: false,
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
			debuggerEnabled: true,
		});
		const socket = FakeWebSocket.instances.at(-1)!;
		socket.emitOpen();
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
			debuggerEnabled: true,
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
			debuggerEnabled: false,
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
			debuggerEnabled: false,
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

	it("sends manual events only when connected", () => {
		const client = new BridgeClient();
		client.connect({
			url: "ws://127.0.0.1:19285/ws",
			token: "secret",
			windowId: 5,
			debuggerEnabled: false,
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
