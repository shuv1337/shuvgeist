import { WebSocket } from "ws";
import type {
	CdpSession,
	CdpSessionCloseListener,
	CdpSessionDomain,
	CdpSessionEnsureDomainOptions,
	CdpSessionEventListener,
	CdpSessionTarget,
	CdpSessionTraceOptions,
} from "../../tools/helpers/cdp-session.js";

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

	private constructor(private readonly ws: WebSocket) {
		ws.on("message", (data: Buffer | string) => {
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
		});
		ws.on("close", () => {
			for (const pending of this.pending.values()) pending.reject(new Error("CDP connection closed"));
			this.pending.clear();
			for (const listener of this.closeListeners) listener();
			this.closeListeners.clear();
		});
	}

	static async connect(url: string): Promise<ElectronCdpClient> {
		const ws = new WebSocket(url);
		await new Promise<void>((resolve, reject) => {
			ws.once("open", resolve);
			ws.once("error", reject);
		});
		return new ElectronCdpClient(ws);
	}

	async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
		const id = this.nextId++;
		const promise = new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
		});
		this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
		return promise;
	}

	on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
		let listeners = this.listeners.get(method);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(method, listeners);
		}
		listeners.add(listener);
		return () => listeners?.delete(listener);
	}

	onClose(listener: () => void): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): void {
		this.ws.close();
	}
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
	private generation = 0;

	constructor(private readonly options: ElectronWsCdpSessionOptions) {
		this.target = {
			kind: "electron-ws",
			id: options.targetId ?? "electron",
		};
		for (const method of ["Page.frameNavigated", "Page.navigatedWithinDocument", "Page.frameStartedNavigating"]) {
			options.transport.on(method, () => {
				this.generation += 1;
			});
		}
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
		return this.options.transport.send<T>(method, params);
	}

	onEvent(method: string, listener: CdpSessionEventListener): () => void {
		return this.options.transport.on(method, listener);
	}

	onClose(listener: CdpSessionCloseListener): () => void {
		return this.options.transport.onClose(() => listener());
	}

	on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
		return this.options.transport.on(method, listener);
	}

	close(): void {
		this.options.transport.close();
	}
}
