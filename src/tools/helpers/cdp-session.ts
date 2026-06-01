import type { TelemetryAttributes, TraceContext } from "../../bridge/telemetry.js";

export type CdpSessionDomain = "Runtime" | "Network" | "Page" | "Performance" | "Tracing";

export interface CdpSessionTraceOptions {
	parent?: TraceContext;
	operationName?: string;
	attributes?: TelemetryAttributes;
}

export interface CdpSessionEnsureDomainOptions {
	suppressRuntimeEnable?: boolean;
	trace?: CdpSessionTraceOptions;
}

export interface CdpSessionTarget {
	kind: "chrome-debugger" | "electron-ws";
	id: string;
}

export type CdpSessionEventListener = (params: Record<string, unknown>) => void;
export type CdpSessionCloseListener = (reason?: unknown) => void;

export interface CdpSession {
	readonly target: CdpSessionTarget;
	readonly navigationGeneration: number;
	acquire(owner: string, trace?: CdpSessionTraceOptions): Promise<void>;
	release(owner: string, trace?: CdpSessionTraceOptions): Promise<void>;
	ensureDomain(domain: CdpSessionDomain, options?: CdpSessionEnsureDomainOptions): Promise<void>;
	send<T = unknown>(method: string, params?: Record<string, unknown>, trace?: CdpSessionTraceOptions): Promise<T>;
	onEvent(method: string, listener: CdpSessionEventListener): () => void;
	onClose(listener: CdpSessionCloseListener): () => void;
	close?(): void;
}

export type ChromeDebuggerEventListener = (
	method: string,
	params: Record<string, unknown> | undefined,
	source: unknown,
) => void;

export type ChromeDebuggerDetachListener = (event: { tabId: number; reason: unknown }) => void;

export interface ChromeDebuggerManagerLike {
	acquireWithTrace(tabId: number, owner: string, trace?: CdpSessionTraceOptions): Promise<void>;
	releaseWithTrace(tabId: number, owner: string, trace?: CdpSessionTraceOptions): Promise<void>;
	ensureDomainWithTrace(tabId: number, domain: CdpSessionDomain, trace?: CdpSessionTraceOptions): Promise<void>;
	sendCommandWithTrace<T = unknown>(
		tabId: number,
		method: string,
		params?: Record<string, unknown>,
		trace?: CdpSessionTraceOptions,
	): Promise<T>;
	addEventListener?(tabId: number, listener: ChromeDebuggerEventListener): () => void;
	addDetachListener?(tabId: number, listener: ChromeDebuggerDetachListener): () => void;
}

export interface ChromeDebuggerSessionOptions {
	tabId: number;
	manager: ChromeDebuggerManagerLike;
	targetId?: string;
}

const NAVIGATION_EVENT_METHODS = new Set([
	"Page.frameNavigated",
	"Page.navigatedWithinDocument",
	"Page.frameStartedNavigating",
]);

export class ChromeDebuggerSession implements CdpSession {
	readonly target: CdpSessionTarget;
	private generation = 0;
	private acquisitionDepth = 0;
	private removeNavigationListener?: () => void;
	private removeDetachListener?: () => void;
	private readonly closeListeners = new Set<CdpSessionCloseListener>();

	constructor(private readonly options: ChromeDebuggerSessionOptions) {
		this.target = {
			kind: "chrome-debugger",
			id: options.targetId ?? String(options.tabId),
		};
	}

	get navigationGeneration(): number {
		return this.generation;
	}

	async acquire(owner: string, trace?: CdpSessionTraceOptions): Promise<void> {
		this.installNavigationTracking();
		try {
			await this.options.manager.acquireWithTrace(this.options.tabId, owner, trace);
			this.acquisitionDepth += 1;
		} catch (error) {
			if (this.acquisitionDepth === 0) this.uninstallNavigationTracking();
			throw error;
		}
	}

	async release(owner: string, trace?: CdpSessionTraceOptions): Promise<void> {
		try {
			await this.options.manager.releaseWithTrace(this.options.tabId, owner, trace);
		} finally {
			this.acquisitionDepth = Math.max(0, this.acquisitionDepth - 1);
			if (this.acquisitionDepth === 0) this.uninstallNavigationTracking();
		}
	}

	async ensureDomain(domain: CdpSessionDomain, options: CdpSessionEnsureDomainOptions = {}): Promise<void> {
		if (domain === "Runtime" && options.suppressRuntimeEnable === true) {
			return;
		}
		await this.options.manager.ensureDomainWithTrace(this.options.tabId, domain, options.trace);
	}

	async send<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		trace?: CdpSessionTraceOptions,
	): Promise<T> {
		return this.options.manager.sendCommandWithTrace<T>(this.options.tabId, method, params, trace);
	}

	onEvent(method: string, listener: CdpSessionEventListener): () => void {
		const remove = this.options.manager.addEventListener?.(this.options.tabId, (eventMethod, params) => {
			if (eventMethod === method) listener(params ?? {});
		});
		return remove ?? (() => {});
	}

	onClose(listener: CdpSessionCloseListener): () => void {
		this.closeListeners.add(listener);
		this.installNavigationTracking();
		return () => this.closeListeners.delete(listener);
	}

	private installNavigationTracking(): void {
		if (!this.removeNavigationListener) {
			this.removeNavigationListener = this.options.manager.addEventListener?.(this.options.tabId, (method) => {
				if (NAVIGATION_EVENT_METHODS.has(method)) this.generation += 1;
			});
		}
		if (!this.removeDetachListener) {
			this.removeDetachListener = this.options.manager.addDetachListener?.(this.options.tabId, (event) => {
				this.generation += 1;
				for (const listener of this.closeListeners) listener(event.reason);
				this.uninstallNavigationTracking();
			});
		}
	}

	private uninstallNavigationTracking(): void {
		this.removeNavigationListener?.();
		this.removeNavigationListener = undefined;
		this.removeDetachListener?.();
		this.removeDetachListener = undefined;
	}
}

export class ChromeDebuggerSessionPool {
	private readonly sessions = new Map<number, ChromeDebuggerSession>();

	constructor(private readonly manager: ChromeDebuggerManagerLike) {}

	get(tabId: number): ChromeDebuggerSession {
		let session = this.sessions.get(tabId);
		if (!session) {
			session = new ChromeDebuggerSession({ tabId, manager: this.manager });
			this.sessions.set(tabId, session);
		}
		return session;
	}

	delete(tabId: number): void {
		this.sessions.delete(tabId);
	}
}
