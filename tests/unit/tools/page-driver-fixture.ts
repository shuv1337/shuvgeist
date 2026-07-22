import type {
	CdpSession,
	CdpSessionCloseListener,
	CdpSessionDomain,
	CdpSessionEnsureDomainOptions,
	CdpSessionEventListener,
	CdpSessionTarget,
	CdpSessionTraceOptions,
} from "@shuvgeist/driver/cdp-session";

export interface CdpCall {
	method: string;
	params?: Record<string, unknown>;
}

export class FakePageCdpSession implements CdpSession {
	readonly calls: CdpCall[] = [];
	readonly acquisitions: string[] = [];
	readonly releases: string[] = [];
	readonly ensuredDomains: CdpSessionDomain[] = [];
	readonly target: CdpSessionTarget;
	private readonly listeners = new Map<string, Set<CdpSessionEventListener>>();
	private readonly closeListeners = new Set<CdpSessionCloseListener>();
	private generation = 0;
	responseFor: (method: string, params?: Record<string, unknown>) => unknown = () => ({});

	constructor(targetId = "page-1") {
		this.target = { kind: "electron-ws", id: targetId };
	}

	get navigationGeneration(): number {
		return this.generation;
	}

	navigate(): void {
		this.generation += 1;
	}

	async acquire(owner: string, _trace?: CdpSessionTraceOptions): Promise<void> {
		this.acquisitions.push(owner);
	}

	async release(owner: string, _trace?: CdpSessionTraceOptions): Promise<void> {
		this.releases.push(owner);
	}

	async ensureDomain(domain: CdpSessionDomain, _options?: CdpSessionEnsureDomainOptions): Promise<void> {
		this.ensuredDomains.push(domain);
	}

	async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
		this.calls.push({ method, params });
		return this.responseFor(method, params) as T;
	}

	onEvent(method: string, listener: CdpSessionEventListener): () => void {
		const listeners = this.listeners.get(method) ?? new Set<CdpSessionEventListener>();
		listeners.add(listener);
		this.listeners.set(method, listeners);
		return () => listeners.delete(listener);
	}

	onClose(listener: CdpSessionCloseListener): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	emit(method: string, params: Record<string, unknown> = {}): void {
		for (const listener of this.listeners.get(method) ?? []) listener(params);
	}

	close(reason?: unknown): void {
		for (const listener of this.closeListeners) listener(reason);
	}
}
