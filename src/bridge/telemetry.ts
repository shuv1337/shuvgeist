import { getShuvgeistVersion } from "../version.js";

export type TelemetryAttributeValue = string | number | boolean;
export type TelemetryAttributes = Record<string, TelemetryAttributeValue | undefined>;
export type TelemetrySpanKind = "internal" | "server" | "client";
export type TelemetrySpanStatus = "unset" | "ok" | "error";

export interface BridgeTelemetryConfig {
	enabled: boolean;
	ingestUrl: string;
	ingestKey: string;
	serviceName: string;
	serviceVersion?: string;
	scopeName?: string;
	scopeVersion?: string;
	resourceAttributes?: TelemetryAttributes;
}

export interface TelemetryExportState {
	state: "disabled" | "idle" | "ok" | "error";
	lastExportedAt?: string;
	lastErrorAt?: string;
	lastError?: string;
}

export interface TraceContext {
	traceId: string;
	spanId: string;
	traceFlags: string;
	tracestate?: string;
}

interface SpanRecord {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: Array<{ key: string; value: Record<string, unknown> }>;
	status: { code: number; message?: string };
}

function randomHex(bytes: number): string {
	const buffer = new Uint8Array(bytes);
	globalThis.crypto.getRandomValues(buffer);
	return Array.from(buffer, (value) => value.toString(16).padStart(2, "0")).join("");
}

function nowUnixNano(): string {
	return (BigInt(Date.now()) * 1_000_000n).toString();
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function sanitizeAttributeValue(value: TelemetryAttributeValue): Record<string, unknown> {
	if (typeof value === "boolean") {
		return { boolValue: value };
	}
	if (typeof value === "number") {
		if (Number.isInteger(value)) {
			return { intValue: String(value) };
		}
		return { doubleValue: value };
	}
	return { stringValue: value };
}

function attributesToOtlp(
	attributes: TelemetryAttributes = {},
): Array<{ key: string; value: Record<string, unknown> }> {
	return Object.entries(attributes)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => ({
			key,
			value: sanitizeAttributeValue(value as TelemetryAttributeValue),
		}));
}

function spanKindToOtlp(kind: TelemetrySpanKind): number {
	switch (kind) {
		case "server":
			return 2;
		case "client":
			return 3;
		default:
			return 1;
	}
}

function spanStatusToOtlp(status: TelemetrySpanStatus): number {
	switch (status) {
		case "ok":
			return 1;
		case "error":
			return 2;
		default:
			return 0;
	}
}

export function parseTraceparent(traceparent?: string | null, tracestate?: string | null): TraceContext | undefined {
	if (!traceparent) return undefined;
	const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/iu.exec(traceparent.trim());
	if (!match) return undefined;
	return {
		traceId: match[1].toLowerCase(),
		spanId: match[2].toLowerCase(),
		traceFlags: match[3].toLowerCase(),
		tracestate: tracestate?.trim() || undefined,
	};
}

export function formatTraceparent(context: TraceContext): string {
	return `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export class BridgeTelemetrySpan {
	private readonly startTimeUnixNano = nowUnixNano();
	private readonly attributes: TelemetryAttributes;
	private status: TelemetrySpanStatus = "unset";
	private statusMessage?: string;
	private ended = false;

	constructor(
		private readonly telemetry: BridgeTelemetry,
		private readonly name: string,
		private readonly kind: TelemetrySpanKind,
		readonly context: TraceContext,
		private readonly parentSpanId?: string,
		attributes: TelemetryAttributes = {},
	) {
		this.attributes = { ...attributes };
	}

	setAttribute(key: string, value: TelemetryAttributeValue | undefined): void {
		if (value === undefined) return;
		this.attributes[key] = value;
	}

	setAttributes(attributes: TelemetryAttributes): void {
		for (const [key, value] of Object.entries(attributes)) {
			if (value !== undefined) {
				this.attributes[key] = value;
			}
		}
	}

	recordError(error: unknown): void {
		this.status = "error";
		if (error instanceof Error) {
			this.statusMessage = error.message;
			this.setAttribute("error.type", error.name || "Error");
			this.setAttribute("error.message", error.message);
		} else {
			const message = String(error);
			this.statusMessage = message;
			this.setAttribute("error.message", message);
		}
	}

	end(status: TelemetrySpanStatus = this.status): void {
		if (this.ended) return;
		this.ended = true;
		if (status !== "unset") {
			this.status = status;
		}
		this.telemetry.enqueue({
			traceId: this.context.traceId,
			spanId: this.context.spanId,
			parentSpanId: this.parentSpanId,
			name: this.name,
			kind: spanKindToOtlp(this.kind),
			startTimeUnixNano: this.startTimeUnixNano,
			endTimeUnixNano: nowUnixNano(),
			attributes: attributesToOtlp(this.attributes),
			status: {
				code: spanStatusToOtlp(this.status),
				message: this.statusMessage,
			},
		});
	}

	toTraceHeaders(): { traceparent: string; tracestate?: string } {
		return {
			traceparent: formatTraceparent(this.context),
			tracestate: this.context.tracestate,
		};
	}
}

export class BridgeTelemetry {
	private config: BridgeTelemetryConfig;
	private readonly queue: SpanRecord[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private flushPromise: Promise<void> = Promise.resolve();
	private exportState: TelemetryExportState = { state: "disabled" };
	private readonly onExportStateChange?: (state: TelemetryExportState) => void;

	constructor(
		config: Partial<BridgeTelemetryConfig> & Pick<BridgeTelemetryConfig, "serviceName">,
		options: { onExportStateChange?: (state: TelemetryExportState) => void } = {},
	) {
		this.config = this.normalizeConfig(config);
		this.onExportStateChange = options.onExportStateChange;
		this.exportState = this.config.enabled ? { state: "idle" } : { state: "disabled" };
	}

	updateConfig(config: Partial<BridgeTelemetryConfig>): void {
		this.config = this.normalizeConfig({ ...this.config, ...config });
		if (!this.config.enabled) {
			this.queue.length = 0;
			if (this.flushTimer) {
				clearTimeout(this.flushTimer);
				this.flushTimer = null;
			}
			this.setExportState({ state: "disabled" });
			return;
		}
		if (this.exportState.state === "disabled") {
			this.setExportState({ state: "idle" });
		}
	}

	startSpan(
		name: string,
		options: {
			parent?: TraceContext | string;
			tracestate?: string;
			kind?: TelemetrySpanKind;
			attributes?: TelemetryAttributes;
		} = {},
	): BridgeTelemetrySpan {
		const parent =
			typeof options.parent === "string" ? parseTraceparent(options.parent, options.tracestate) : options.parent;
		const context: TraceContext = parent
			? {
					traceId: parent.traceId,
					spanId: randomHex(8),
					traceFlags: parent.traceFlags || "01",
					tracestate: parent.tracestate || options.tracestate,
				}
			: {
					traceId: randomHex(16),
					spanId: randomHex(8),
					traceFlags: "01",
					tracestate: options.tracestate,
				};
		return new BridgeTelemetrySpan(
			this,
			name,
			options.kind ?? "internal",
			context,
			parent?.spanId,
			options.attributes,
		);
	}

	async flush(): Promise<void> {
		if (!this.config.enabled) {
			this.queue.length = 0;
			return;
		}
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.queue.length === 0) return;

		const spans = this.queue.splice(0, this.queue.length);
		this.flushPromise = this.flushPromise.then(() => this.flushBatch(spans));
		await this.flushPromise;
	}

	enqueue(span: SpanRecord): void {
		if (!this.config.enabled) return;
		this.queue.push(span);
		this.scheduleFlush();
	}

	getExportState(): TelemetryExportState {
		return this.exportState;
	}

	private normalizeConfig(
		config: Partial<BridgeTelemetryConfig> & Pick<BridgeTelemetryConfig, "serviceName">,
	): BridgeTelemetryConfig {
		return {
			enabled: config.enabled ?? false,
			ingestUrl: trimTrailingSlash(config.ingestUrl ?? "http://localhost:3474"),
			ingestKey: config.ingestKey ?? "",
			serviceName: config.serviceName,
			serviceVersion: config.serviceVersion ?? getShuvgeistVersion(),
			scopeName: config.scopeName ?? "shuvgeist.bridge",
			scopeVersion: config.scopeVersion ?? getShuvgeistVersion(),
			resourceAttributes: config.resourceAttributes ?? {},
		};
	}

	private scheduleFlush(): void {
		if (this.flushTimer || !this.config.enabled) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, 250);
	}

	private async flushBatch(spans: SpanRecord[]): Promise<void> {
		if (spans.length === 0) return;
		if (!this.config.ingestKey.trim()) {
			this.setExportState({
				state: "error",
				lastErrorAt: new Date().toISOString(),
				lastError: "Maple ingest key is missing",
			});
			return;
		}

		const body = {
			resourceSpans: [
				{
					resource: {
						attributes: attributesToOtlp({
							"service.name": this.config.serviceName,
							"service.version": this.config.serviceVersion,
							...this.config.resourceAttributes,
						}),
					},
					scopeSpans: [
						{
							scope: {
								name: this.config.scopeName,
								version: this.config.scopeVersion,
							},
							spans,
						},
					],
				},
			],
		};

		let lastError: Error | undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const response = await fetch(`${this.config.ingestUrl}/v1/traces`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${this.config.ingestKey}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				});
				if (!response.ok) {
					throw new Error(`Maple OTEL export failed: ${response.status} ${await response.text()}`);
				}
				this.setExportState({
					state: "ok",
					lastExportedAt: new Date().toISOString(),
					lastError: undefined,
					lastErrorAt: undefined,
				});
				return;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				if (attempt === 0) {
					await delay(100);
				}
			}
		}

		this.setExportState({
			state: "error",
			lastErrorAt: new Date().toISOString(),
			lastError: lastError?.message ?? "Maple OTEL export failed",
		});
	}

	private setExportState(state: TelemetryExportState): void {
		this.exportState = state;
		this.onExportStateChange?.(state);
	}
}
