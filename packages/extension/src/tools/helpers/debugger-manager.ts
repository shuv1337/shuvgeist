import { type ChromeDebuggerSession, ChromeDebuggerSessionPool } from "@shuvgeist/driver/cdp-session";
import { bridgeLog } from "@shuvgeist/protocol/logging";
import type { BridgeTelemetry, TelemetryAttributes, TraceContext } from "@shuvgeist/protocol/telemetry";

export type DebuggerDomain = "Runtime" | "Network" | "Page" | "Performance" | "Tracing";

type DebuggerEventListener = (
	method: string,
	params: Record<string, unknown> | undefined,
	source: chrome.debugger.Debuggee,
) => void;

type DebuggerDetachListener = (event: { tabId: number; reason: chrome.debugger.DetachReason | string }) => void;

interface TabDebuggerState {
	refCount: number;
	owners: Set<string>;
	enabledDomains: Set<DebuggerDomain>;
	listeners: Set<DebuggerEventListener>;
	detachListeners: Set<DebuggerDetachListener>;
	serial: Promise<void>;
}

interface DebuggerTraceOptions {
	parent?: TraceContext;
	operationName?: string;
	attributes?: TelemetryAttributes;
}

export class DebuggerManager {
	private readonly tabStates = new Map<number, TabDebuggerState>();
	private readonly sessions = new ChromeDebuggerSessionPool(this);
	private telemetry?: BridgeTelemetry;

	constructor() {
		if (typeof chrome === "undefined" || !chrome.debugger?.onEvent || !chrome.debugger?.onDetach) {
			return;
		}

		chrome.debugger.onEvent.addListener((source, method, params) => {
			const tabId = source.tabId;
			if (typeof tabId !== "number") return;
			const state = this.tabStates.get(tabId);
			if (!state) return;
			for (const listener of state.listeners) {
				listener(method, params as Record<string, unknown> | undefined, source);
			}
		});

		chrome.debugger.onDetach.addListener((source, reason) => {
			const tabId = source.tabId;
			if (typeof tabId !== "number") return;
			const state = this.tabStates.get(tabId);
			if (!state) return;
			bridgeLog("warn", "debugger detached", {
				role: "extension",
				tabId,
				outcome: "error",
				error: String(reason),
			});
			for (const listener of state.detachListeners) {
				try {
					listener({ tabId, reason });
				} catch (error) {
					bridgeLog("warn", "debugger detach listener failed", {
						role: "extension",
						tabId,
						outcome: "error",
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			this.tabStates.delete(tabId);
		});
	}

	async acquire(tabId: number, owner: string): Promise<void> {
		await this.acquireWithTrace(tabId, owner);
	}

	async release(tabId: number, owner: string): Promise<void> {
		await this.releaseWithTrace(tabId, owner);
	}

	async acquireWithTrace(tabId: number, owner: string, trace?: DebuggerTraceOptions): Promise<void> {
		const span = this.telemetry?.startSpan(trace?.operationName ?? "debugger.acquire", {
			parent: trace?.parent,
			attributes: {
				"debugger.owner": owner,
				"debugger.tab_id": tabId,
				...trace?.attributes,
			},
		});
		try {
			await this.runSerialized(tabId, async (state) => {
				if (state.refCount === 0) {
					await chrome.debugger.attach({ tabId }, "1.3");
					bridgeLog("info", "debugger attached", {
						role: "extension",
						tabId,
						outcome: "success",
					});
				}

				state.refCount += 1;
				state.owners.add(owner);
				bridgeLog("debug", "debugger acquired", {
					role: "extension",
					tabId,
					outcome: "success",
					refCount: state.refCount,
					owner,
				});
			});
			span?.end("ok");
		} catch (error) {
			span?.recordError(error);
			span?.end("error");
			throw error;
		}
	}

	async releaseWithTrace(tabId: number, owner: string, trace?: DebuggerTraceOptions): Promise<void> {
		const span = this.telemetry?.startSpan(trace?.operationName ?? "debugger.release", {
			parent: trace?.parent,
			attributes: {
				"debugger.owner": owner,
				"debugger.tab_id": tabId,
				...trace?.attributes,
			},
		});
		await this.runSerialized(tabId, async (state) => {
			if (!state.owners.has(owner) && state.refCount === 0) {
				return;
			}

			state.owners.delete(owner);
			state.refCount = Math.max(0, state.refCount - 1);
			bridgeLog("debug", "debugger released", {
				role: "extension",
				tabId,
				outcome: "success",
				refCount: state.refCount,
				owner,
			});

			if (state.refCount === 0) {
				try {
					await chrome.debugger.detach({ tabId });
					bridgeLog("info", "debugger detached", {
						role: "extension",
						tabId,
						outcome: "success",
					});
				} finally {
					this.tabStates.delete(tabId);
				}
			}
		})
			.then(() => span?.end("ok"))
			.catch((error) => {
				span?.recordError(error);
				span?.end("error");
				throw error;
			});
	}

	async ensureDomain(tabId: number, domain: DebuggerDomain): Promise<void> {
		await this.ensureDomainWithTrace(tabId, domain);
	}

	async ensureDomainWithTrace(tabId: number, domain: DebuggerDomain, trace?: DebuggerTraceOptions): Promise<void> {
		const span = this.telemetry?.startSpan(trace?.operationName ?? "debugger.ensure_domain", {
			parent: trace?.parent,
			attributes: {
				"debugger.domain": domain,
				"debugger.tab_id": tabId,
				...trace?.attributes,
			},
		});
		const state = this.getOrCreateState(tabId);
		if (state.enabledDomains.has(domain)) {
			span?.setAttribute("debugger.domain_cached", true);
			span?.end("ok");
			return;
		}
		try {
			await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
			state.enabledDomains.add(domain);
			span?.end("ok");
		} catch (error) {
			span?.recordError(error);
			span?.end("error");
			throw error;
		}
	}

	async sendCommand<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
		return this.sendCommandWithTrace(tabId, method, params);
	}

	async sendCommandWithTrace<T = unknown>(
		tabId: number,
		method: string,
		params?: Record<string, unknown>,
		trace?: DebuggerTraceOptions,
	): Promise<T> {
		const span = this.telemetry?.startSpan(trace?.operationName ?? "debugger.send_command", {
			parent: trace?.parent,
			attributes: {
				"debugger.method": method,
				"debugger.tab_id": tabId,
				...trace?.attributes,
			},
		});
		try {
			const result = (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
			span?.end("ok");
			return result;
		} catch (error) {
			span?.recordError(error);
			span?.end("error");
			throw error;
		}
	}

	addEventListener(tabId: number, listener: DebuggerEventListener): () => void {
		const state = this.getOrCreateState(tabId);
		state.listeners.add(listener);
		return () => {
			const existing = this.tabStates.get(tabId);
			existing?.listeners.delete(listener);
		};
	}

	addDetachListener(tabId: number, listener: DebuggerDetachListener): () => void {
		const state = this.getOrCreateState(tabId);
		state.detachListeners.add(listener);
		return () => {
			const existing = this.tabStates.get(tabId);
			existing?.detachListeners.delete(listener);
		};
	}

	setTelemetry(telemetry?: BridgeTelemetry): void {
		this.telemetry = telemetry;
	}

	cdpSession(tabId: number): ChromeDebuggerSession {
		return this.sessions.get(tabId);
	}

	private async runSerialized(tabId: number, action: (state: TabDebuggerState) => Promise<void>): Promise<void> {
		const state = this.getOrCreateState(tabId);
		const previous = state.serial;
		let release: (() => void) | undefined;
		state.serial = new Promise<void>((resolve) => {
			release = resolve;
		});

		try {
			await previous.catch(() => undefined);
			await action(state);
		} finally {
			release?.();
		}
	}

	private getOrCreateState(tabId: number): TabDebuggerState {
		let state = this.tabStates.get(tabId);
		if (!state) {
			state = {
				refCount: 0,
				owners: new Set<string>(),
				enabledDomains: new Set<DebuggerDomain>(),
				listeners: new Set<DebuggerEventListener>(),
				detachListeners: new Set<DebuggerDetachListener>(),
				serial: Promise.resolve(),
			};
			this.tabStates.set(tabId, state);
		}
		return state;
	}
}

let sharedDebuggerManager: DebuggerManager | undefined;

export function getSharedDebuggerManager(): DebuggerManager {
	if (!sharedDebuggerManager) {
		sharedDebuggerManager = new DebuggerManager();
	}
	return sharedDebuggerManager;
}

export function configureSharedDebuggerManagerTelemetry(telemetry?: BridgeTelemetry): DebuggerManager {
	const manager = getSharedDebuggerManager();
	manager.setTelemetry(telemetry);
	return manager;
}
