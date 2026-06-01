import {
	ElectronWsCdpSession,
	type ElectronCdpTransport,
} from "../../../src/bridge/electron/cdp-client.js";

class FakeElectronCdpTransport implements ElectronCdpTransport {
	readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
	private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
	private readonly closeListeners = new Set<() => void>();
	nextResult: unknown = { ok: true };

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
		for (const listener of this.closeListeners) listener();
	}

	emit(method: string, params: Record<string, unknown> = {}): void {
		for (const listener of this.listeners.get(method) ?? []) listener(params);
	}
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

	it("tracks navigation generation and forwards events", () => {
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
	});
});
