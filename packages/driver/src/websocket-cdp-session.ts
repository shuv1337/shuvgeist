import { WebSocket } from "ws";
import type {
	CdpSession,
	CdpSessionCloseListener,
	CdpSessionDomain,
	CdpSessionEnsureDomainOptions,
	CdpSessionEventListener,
	CdpSessionTarget,
	CdpSessionTraceOptions,
} from "./cdp-session.js";

interface CdpResponse<T = unknown> {
	id: number;
	method?: string;
	params?: Record<string, unknown>;
	result?: T;
	error?: { message: string; code?: number };
}

export class ElectronCdpClient {
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
	private readonly closeListeners = new Set<() => void>();
	private closed = false;
	private socketListenersAttached = true;

	private constructor(private readonly ws: WebSocket) {
		ws.on("message", this.handleMessage);
		ws.on("close", this.handleSocketClose);
		ws.on("error", this.handleSocketError);
	}

	static async connect(url: string): Promise<ElectronCdpClient> {
		const ws = new WebSocket(url);
		const client = new ElectronCdpClient(ws);
		await new Promise<void>((resolve, reject) => {
			const cleanup = (): void => {
				ws.off("open", handleOpen);
				ws.off("error", handleError);
				ws.off("close", handleClose);
			};
			const handleOpen = (): void => {
				cleanup();
				resolve();
			};
			const handleError = (error: Error): void => {
				cleanup();
				reject(error);
			};
			const handleClose = (): void => {
				cleanup();
				reject(new Error("CDP connection closed before opening"));
			};
			ws.once("open", handleOpen);
			ws.once("error", handleError);
			ws.once("close", handleClose);
		});
		return client;
	}

	async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
		if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error("CDP connection closed");
		}
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			try {
				this.ws.send(JSON.stringify({ id, method, params: params ?? {} }), (error) => {
					if (error) this.rejectPending(id, error);
				});
			} catch (error) {
				this.rejectPending(id, toError(error, "CDP command send failed"));
			}
		});
	}

	on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
		if (this.closed) return () => {};
		let listeners = this.listeners.get(method);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(method, listeners);
		}
		listeners.add(listener);
		return () => listeners?.delete(listener);
	}

	onClose(listener: () => void): () => void {
		if (this.closed) {
			listener();
			return () => {};
		}
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): void {
		if (this.closed) return;
		this.settleClosed(new Error("CDP connection closed"));
		if (this.ws.readyState === WebSocket.CLOSED) {
			this.detachSocketListeners();
			return;
		}
		if (this.ws.readyState !== WebSocket.CLOSING) this.ws.close();
	}

	private readonly handleMessage = (data: Buffer | string): void => {
		if (this.closed) return;
		const message = JSON.parse(typeof data === "string" ? data : data.toString("utf-8")) as CdpResponse;
		if (typeof message.id !== "number" && "method" in message && typeof message.method === "string") {
			const params =
				"params" in message && typeof message.params === "object" && message.params
					? (message.params as Record<string, unknown>)
					: {};
			for (const listener of this.listeners.get(message.method) ?? []) listener(params);
			return;
		}
		if (typeof message.id !== "number") return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (message.error) {
			pending.reject(new Error(message.error.message));
		} else {
			pending.resolve(message.result);
		}
	};

	private readonly handleSocketClose = (): void => {
		try {
			this.settleClosed(new Error("CDP connection closed"));
		} finally {
			this.detachSocketListeners();
		}
	};

	private readonly handleSocketError = (error: Error): void => {
		this.settleClosed(error);
		if (this.ws.readyState !== WebSocket.CLOSED && this.ws.readyState !== WebSocket.CLOSING) {
			this.ws.close();
		}
	};

	private rejectPending(id: number, error: Error): void {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		pending.reject(error);
	}

	private settleClosed(error: Error): void {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		this.listeners.clear();
		const closeListeners = [...this.closeListeners];
		this.closeListeners.clear();
		for (const listener of closeListeners) listener();
	}

	private detachSocketListeners(): void {
		if (!this.socketListenersAttached) return;
		this.socketListenersAttached = false;
		this.ws.off("message", this.handleMessage);
		this.ws.off("close", this.handleSocketClose);
		this.ws.off("error", this.handleSocketError);
	}
}

function toError(error: unknown, fallbackMessage: string): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	return new Error(fallbackMessage);
}

export interface ElectronCdpTransport {
	send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
	on(method: string, listener: (params: Record<string, unknown>) => void): () => void;
	onClose(listener: () => void): () => void;
	close(): void;
}

export interface ElectronWsCdpSessionOptions {
	transport: ElectronCdpTransport;
	targetId?: string;
}

export class ElectronWsCdpSession implements CdpSession {
	readonly target: CdpSessionTarget;
	private readonly enabledDomains = new Set<CdpSessionDomain>();
	private readonly removeNavigationListeners: Array<() => void> = [];
	private removeTransportCloseListener?: () => void;
	private generation = 0;
	private closed = false;

	constructor(private readonly options: ElectronWsCdpSessionOptions) {
		this.target = {
			kind: "electron-ws",
			id: options.targetId ?? "electron",
		};
		for (const method of ["Page.frameNavigated", "Page.navigatedWithinDocument", "Page.frameStartedNavigating"]) {
			this.removeNavigationListeners.push(
				options.transport.on(method, () => {
					this.generation += 1;
				}),
			);
		}
		this.removeTransportCloseListener = options.transport.onClose(() => this.markClosed());
	}

	static async connect(url: string, targetId?: string): Promise<ElectronWsCdpSession> {
		return new ElectronWsCdpSession({
			transport: await ElectronCdpClient.connect(url),
			targetId,
		});
	}

	get navigationGeneration(): number {
		return this.generation;
	}

	async acquire(_owner: string, _trace?: CdpSessionTraceOptions): Promise<void> {}

	async release(_owner: string, _trace?: CdpSessionTraceOptions): Promise<void> {}

	async ensureDomain(domain: CdpSessionDomain, options: CdpSessionEnsureDomainOptions = {}): Promise<void> {
		this.assertOpen();
		if (domain === "Runtime" && options.suppressRuntimeEnable === true) {
			return;
		}
		if (this.enabledDomains.has(domain)) {
			return;
		}
		await this.options.transport.send(domain + ".enable");
		this.enabledDomains.add(domain);
	}

	async send<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		_trace?: CdpSessionTraceOptions,
	): Promise<T> {
		this.assertOpen();
		return this.options.transport.send<T>(method, params);
	}

	onEvent(method: string, listener: CdpSessionEventListener): () => void {
		if (this.closed) return () => {};
		return this.options.transport.on(method, listener);
	}

	onClose(listener: CdpSessionCloseListener): () => void {
		if (this.closed) {
			listener();
			return () => {};
		}
		return this.options.transport.onClose(() => listener());
	}

	on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
		if (this.closed) return () => {};
		return this.options.transport.on(method, listener);
	}

	close(): void {
		if (this.closed) return;
		this.markClosed();
		this.options.transport.close();
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("CDP connection closed");
	}

	private markClosed(): void {
		if (this.closed) return;
		this.closed = true;
		for (const remove of this.removeNavigationListeners.splice(0)) remove();
		this.removeTransportCloseListener?.();
		this.removeTransportCloseListener = undefined;
	}
}
