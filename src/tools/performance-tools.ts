import type { BridgeTelemetry, BridgeTelemetrySpan, TraceContext } from "../bridge/telemetry.js";
import { type DebuggerManager, getSharedDebuggerManager } from "./helpers/debugger-manager.js";

interface TraceState {
	tabId: number;
	owner: string;
	startedAt: number;
	events: unknown[];
	maxEvents: number;
	categories: string[];
	timedOut: boolean;
	timeoutMs: number;
	removeListener?: () => void;
	autoStopTimer?: ReturnType<typeof setTimeout>;
	completion?: Promise<void>;
	resolveCompletion?: () => void;
	traceSpan?: BridgeTelemetrySpan;
}

export function parsePerformanceMetrics(metrics: Array<{ name: string; value: number }>): Record<string, number> {
	const parsed: Record<string, number> = {};
	for (const metric of metrics) {
		parsed[metric.name] = metric.value;
	}
	return parsed;
}

export function summarizePerformanceMetrics(metrics: Record<string, number>): {
	navigationStart?: number;
	domContentLoaded?: number;
	loadEventEnd?: number;
	domContentLoadedDeltaMs?: number;
	loadEventDeltaMs?: number;
	jsHeapUsedSize?: number;
} {
	const navigationStart = metrics.NavigationStart;
	const domContentLoaded = metrics.DomContentLoaded;
	const loadEventEnd = metrics.LoadEvent;
	return {
		navigationStart,
		domContentLoaded,
		loadEventEnd,
		domContentLoadedDeltaMs:
			typeof navigationStart === "number" && typeof domContentLoaded === "number"
				? domContentLoaded - navigationStart
				: undefined,
		loadEventDeltaMs:
			typeof navigationStart === "number" && typeof loadEventEnd === "number"
				? loadEventEnd - navigationStart
				: undefined,
		jsHeapUsedSize: metrics.JSHeapUsedSize,
	};
}

export class PerformanceTools {
	private readonly traces = new Map<number, TraceState>();
	private readonly debuggerManager: DebuggerManager;
	private readonly telemetry?: BridgeTelemetry;

	constructor(options: { debuggerManager?: DebuggerManager; telemetry?: BridgeTelemetry } = {}) {
		this.debuggerManager = options.debuggerManager ?? getSharedDebuggerManager();
		this.telemetry = options.telemetry;
	}

	private async acquireDebugger(tabId: number, owner: string, traceContext?: TraceContext): Promise<void> {
		if (typeof this.debuggerManager.acquireWithTrace === "function") {
			await this.debuggerManager.acquireWithTrace(tabId, owner, { parent: traceContext });
			return;
		}
		await this.debuggerManager.acquire(tabId, owner);
	}

	private async ensureDebuggerDomain(
		tabId: number,
		domain: "Performance" | "Tracing",
		traceContext?: TraceContext,
	): Promise<void> {
		if (typeof this.debuggerManager.ensureDomainWithTrace === "function") {
			await this.debuggerManager.ensureDomainWithTrace(tabId, domain, { parent: traceContext });
			return;
		}
		await this.debuggerManager.ensureDomain(tabId, domain);
	}

	private async releaseDebugger(tabId: number, owner: string, traceContext?: TraceContext): Promise<void> {
		if (typeof this.debuggerManager.releaseWithTrace === "function") {
			await this.debuggerManager.releaseWithTrace(tabId, owner, { parent: traceContext });
			return;
		}
		await this.debuggerManager.release(tabId, owner);
	}

	private async sendDebuggerCommand<T>(
		tabId: number,
		method: string,
		params: Record<string, unknown> | undefined,
		traceContext?: TraceContext,
	): Promise<T> {
		if (typeof this.debuggerManager.sendCommandWithTrace === "function") {
			return this.debuggerManager.sendCommandWithTrace(tabId, method, params, {
				parent: traceContext,
			}) as Promise<T>;
		}
		return this.debuggerManager.sendCommand(tabId, method, params) as Promise<T>;
	}

	async getMetrics(tabId: number, traceContext?: TraceContext): Promise<Array<{ name: string; value: number }>> {
		const owner = `perf-metrics:${tabId}:${Date.now()}`;
		await this.acquireDebugger(tabId, owner, traceContext);
		try {
			await this.ensureDebuggerDomain(tabId, "Performance", traceContext);
			const response = (await this.sendDebuggerCommand(
				tabId,
				"Performance.getMetrics",
				undefined,
				traceContext,
			)) as {
				metrics?: Array<{ name?: string; value?: number }>;
			};
			return (response.metrics ?? [])
				.filter(
					(metric): metric is { name: string; value: number } =>
						typeof metric.name === "string" && typeof metric.value === "number",
				)
				.map((metric) => ({ name: metric.name, value: metric.value }));
		} finally {
			await this.releaseDebugger(tabId, owner, traceContext);
		}
	}

	async collectMetrics(tabId: number): Promise<{
		tabId: number;
		metrics: Record<string, number>;
		summary: ReturnType<typeof summarizePerformanceMetrics>;
	}> {
		const metrics = parsePerformanceMetrics(await this.getMetrics(tabId));
		return {
			tabId,
			metrics,
			summary: summarizePerformanceMetrics(metrics),
		};
	}

	isTraceActive(tabId: number): boolean {
		return this.traces.has(tabId);
	}

	getActiveTrace(tabId: number): TraceState | undefined {
		return this.traces.get(tabId);
	}

	async startTrace(
		tabId: number,
		options: { timeoutMs?: number; maxEvents?: number; categories?: string[] } = {},
		traceContext?: TraceContext,
	): Promise<{ ok: true; tabId: number; startedAt: string; categories: string[] }> {
		if (this.traces.has(tabId)) {
			throw new Error(`Trace is already active for tab ${tabId}`);
		}
		const owner = `perf-trace:${tabId}`;
		await this.acquireDebugger(tabId, owner, traceContext);
		await this.ensureDebuggerDomain(tabId, "Tracing", traceContext);
		const state: TraceState = {
			tabId,
			owner,
			startedAt: Date.now(),
			events: [],
			maxEvents: options.maxEvents ?? 5000,
			categories: options.categories ?? [],
			timedOut: false,
			timeoutMs: options.timeoutMs ?? 0,
			traceSpan: this.telemetry?.startSpan("perf.trace.session", {
				parent: traceContext,
				attributes: {
					"perf.tab_id": tabId,
					"perf.categories": (options.categories ?? []).join(","),
					"perf.max_events": options.maxEvents ?? 5000,
					"perf.timeout_ms": options.timeoutMs ?? 0,
				},
			}),
		};
		state.completion = new Promise<void>((resolve) => {
			state.resolveCompletion = resolve;
		});
		state.removeListener = this.debuggerManager.addEventListener(tabId, (method, params) => {
			if (method === "Tracing.dataCollected") {
				const value = (params as { value?: unknown[] } | undefined)?.value;
				if (Array.isArray(value)) {
					const remaining = Math.max(0, state.maxEvents - state.events.length);
					if (remaining > 0) {
						state.events.push(...value.slice(0, remaining));
					}
				}
			} else if (method === "Tracing.tracingComplete") {
				state.resolveCompletion?.();
			}
		});
		if (options.timeoutMs && options.timeoutMs > 0) {
			state.autoStopTimer = setTimeout(() => {
				state.timedOut = true;
				state.resolveCompletion?.();
			}, options.timeoutMs);
		}
		this.traces.set(tabId, state);
		await this.sendDebuggerCommand(
			tabId,
			"Tracing.start",
			{
				transferMode: "ReportEvents",
				categories: state.categories.join(","),
			},
			traceContext,
		);
		return {
			ok: true,
			tabId,
			startedAt: new Date(state.startedAt).toISOString(),
			categories: state.categories,
		};
	}

	async stopTrace(
		tabId: number,
		traceContext?: TraceContext,
	): Promise<{
		ok: true;
		tabId: number;
		startedAt: string;
		endedAt: string;
		durationMs: number;
		eventCount: number;
		traceEvents: unknown[];
		truncated: boolean;
		timedOut: boolean;
		categories: string[];
	}> {
		const state = this.traces.get(tabId);
		if (!state) {
			throw new Error(`No active trace for tab ${tabId}`);
		}
		clearTimeout(state.autoStopTimer);
		if (!state.timedOut) {
			await this.sendDebuggerCommand(tabId, "Tracing.end", undefined, traceContext ?? state.traceSpan?.context);
		}
		if (state.timeoutMs > 0) {
			await Promise.race([
				state.completion,
				new Promise<void>((resolve) =>
					setTimeout(() => {
						state.timedOut = true;
						resolve();
					}, state.timeoutMs),
				),
			]);
		} else {
			await state.completion;
		}
		state.removeListener?.();
		this.traces.delete(tabId);
		await this.releaseDebugger(tabId, state.owner, traceContext ?? state.traceSpan?.context);
		const endedAt = Date.now();
		state.traceSpan?.setAttributes({
			"perf.event_count": state.events.length,
			"perf.truncated": state.events.length >= state.maxEvents,
			"perf.timed_out": state.timedOut,
		});
		state.traceSpan?.end("ok");
		state.traceSpan = undefined;
		return {
			ok: true,
			tabId,
			startedAt: new Date(state.startedAt).toISOString(),
			endedAt: new Date(endedAt).toISOString(),
			durationMs: endedAt - state.startedAt,
			eventCount: state.events.length,
			traceEvents: state.events,
			truncated: state.events.length >= state.maxEvents,
			timedOut: state.timedOut,
			categories: state.categories,
		};
	}

	async handleTabClosed(tabId: number): Promise<void> {
		if (this.traces.has(tabId)) {
			await this.stopTrace(tabId);
		}
	}
}
