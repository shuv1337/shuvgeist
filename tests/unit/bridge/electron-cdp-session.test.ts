import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import {
	ElectronCdpClient,
	ElectronWsCdpSession,
	type ElectronCdpTransport,
} from "@shuvgeist/driver/websocket-cdp-session";

class FakeElectronCdpTransport implements ElectronCdpTransport {
	readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
	private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
	private readonly closeListeners = new Set<() => void>();
	nextResult: unknown = { ok: true };
	closeCalls = 0;

	async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
		this.calls.push({ method, params });
		return this.nextResult as T;
	}

	on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
		const listeners = this.listeners.get(method) ?? new Set<(params: Record<string, unknown>) => void>();
		listeners.add(listener);
		this.listeners.set(method, listeners);
		return () => listeners.delete(listener);
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): void {
		this.closeCalls += 1;
		for (const listener of this.closeListeners) listener();
	}

	emit(method: string, params: Record<string, unknown> = {}): void {
		for (const listener of this.listeners.get(method) ?? []) listener(params);
	}
}

class FakeWebSocket extends EventEmitter {
	readyState = WebSocket.OPEN;
	readonly sent: string[] = [];
	closeCalls = 0;
	throwOnNextSend?: Error;
	failNextSend?: Error;

	send(data: string, callback?: (error?: Error) => void): void {
		this.sent.push(data);
		const thrown = this.throwOnNextSend;
		this.throwOnNextSend = undefined;
		if (thrown) throw thrown;
		const failure = this.failNextSend;
		this.failNextSend = undefined;
		queueMicrotask(() => callback?.(failure));
	}

	close(): void {
		if (this.readyState === WebSocket.CLOSING || this.readyState === WebSocket.CLOSED) return;
		this.closeCalls += 1;
		this.readyState = WebSocket.CLOSING;
		queueMicrotask(() => this.finishClose());
	}

	receive(message: Record<string, unknown>): void {
		this.emit("message", JSON.stringify(message));
	}

	finishClose(): void {
		if (this.readyState === WebSocket.CLOSED) return;
		this.readyState = WebSocket.CLOSED;
		this.emit("close");
	}
}

type ElectronCdpClientConstructor = new (ws: WebSocket) => ElectronCdpClient;

function createClient(ws: FakeWebSocket): ElectronCdpClient {
	const Client = ElectronCdpClient as unknown as ElectronCdpClientConstructor;
	return new Client(ws as unknown as WebSocket);
}

describe("ElectronWsCdpSession", () => {
	it("ensures domains once, suppresses Runtime.enable when requested, and sends commands", async () => {
		const transport = new FakeElectronCdpTransport();
		transport.nextResult = { value: 9 };
		const session = new ElectronWsCdpSession({ transport, targetId: "e1:w1" });

		await session.acquire("owner-a");
		await session.ensureDomain("Page");
		await session.ensureDomain("Page");
		await session.ensureDomain("Runtime", { suppressRuntimeEnable: true });
		await expect(session.send("Runtime.evaluate", { expression: "4 + 5" })).resolves.toEqual({ value: 9 });
		await session.release("owner-a");

		expect(session.target).toEqual({ kind: "electron-ws", id: "e1:w1" });
		expect(transport.calls).toEqual([
			{ method: "Page.enable", params: undefined },
			{ method: "Runtime.evaluate", params: { expression: "4 + 5" } },
		]);
	});

	it("tracks navigation generation, cleans up listeners, and closes once", async () => {
		const transport = new FakeElectronCdpTransport();
		const session = new ElectronWsCdpSession({ transport });
		const networkEvents: Record<string, unknown>[] = [];
		const closeEvents: unknown[] = [];
		session.onEvent("Network.requestWillBeSent", (params) => networkEvents.push(params));
		session.onClose((reason) => closeEvents.push(reason));

		expect(session.navigationGeneration).toBe(0);
		transport.emit("Network.requestWillBeSent", { requestId: "req-1" });
		expect(networkEvents).toEqual([{ requestId: "req-1" }]);
		expect(session.navigationGeneration).toBe(0);
		transport.emit("Page.navigatedWithinDocument");
		expect(session.navigationGeneration).toBe(1);
		session.close();
		expect(closeEvents).toEqual([undefined]);
		transport.emit("Page.navigatedWithinDocument");
		expect(session.navigationGeneration).toBe(1);
		session.close();
		expect(transport.closeCalls).toBe(1);
		await expect(session.send("Runtime.evaluate")).rejects.toThrow("CDP connection closed");
	});
});

describe("ElectronCdpClient", () => {
	it("rejects pending and future commands when the socket closes, then detaches socket listeners", async () => {
		const ws = new FakeWebSocket();
		const client = createClient(ws);
		const onEvent = vi.fn();
		const onClose = vi.fn();
		client.on("Page.frameNavigated", onEvent);
		client.onClose(onClose);
		const pending = client.send("Runtime.evaluate", { expression: "1 + 1" });

		ws.receive({ method: "Page.frameNavigated", params: { frame: { id: "main" } } });
		expect(onEvent).toHaveBeenCalledOnce();
		ws.finishClose();

		await expect(pending).rejects.toThrow("CDP connection closed");
		expect(onClose).toHaveBeenCalledOnce();
		expect(ws.listenerCount("message")).toBe(0);
		expect(ws.listenerCount("close")).toBe(0);
		expect(ws.listenerCount("error")).toBe(0);
		await expect(client.send("Runtime.evaluate")).rejects.toThrow("CDP connection closed");
		const lateCloseListener = vi.fn();
		client.onClose(lateCloseListener);
		expect(lateCloseListener).toHaveBeenCalledOnce();
	});

	it("rejects synchronous and callback send failures without leaking pending commands", async () => {
		const ws = new FakeWebSocket();
		const client = createClient(ws);
		ws.throwOnNextSend = new Error("send threw");
		await expect(client.send("Runtime.evaluate")).rejects.toThrow("send threw");

		ws.failNextSend = new Error("send callback failed");
		await expect(client.send("Runtime.evaluate")).rejects.toThrow("send callback failed");

		const successful = client.send<{ value: number }>("Runtime.evaluate");
		const lastRequest = JSON.parse(ws.sent.at(-1) ?? "{}") as { id?: number };
		ws.receive({ id: lastRequest.id, result: { value: 9 } });
		await expect(successful).resolves.toEqual({ value: 9 });
		client.close();
	});

	it("closes idempotently and rejects in-flight commands immediately", async () => {
		const ws = new FakeWebSocket();
		const client = createClient(ws);
		const onClose = vi.fn();
		client.onClose(onClose);
		const pending = client.send("Page.captureScreenshot");

		client.close();
		client.close();

		await expect(pending).rejects.toThrow("CDP connection closed");
		expect(onClose).toHaveBeenCalledOnce();
		expect(ws.closeCalls).toBe(1);
		await Promise.resolve();
		expect(ws.listenerCount("message")).toBe(0);
	});
});
