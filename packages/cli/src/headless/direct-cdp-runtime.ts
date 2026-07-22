import type { AgentMessage, AgentTool } from "@shuv1337/pi-agent-core";
import { type Api, type Model, type Static, Type } from "@shuv1337/pi-ai";
import type { CdpSession } from "@shuvgeist/driver/cdp-session";
import { SNAPSHOT_INJECTED_ARTIFACT } from "@shuvgeist/driver/driver-artifacts-generated";
import type {
	SnapshotInjectionConfig,
	SnapshotInjectionEntry,
	SnapshotInjectionOmissions,
	SnapshotInjectionResult,
} from "@shuvgeist/driver/injected-contracts";
import { buildInjectedArtifactInvocation } from "@shuvgeist/driver/injected-invocation";
import { rankLocatorCandidates, type SemanticLocatorCandidate } from "@shuvgeist/driver/locator-scoring";
import type {
	PageDriver,
	PageDriverScope,
	PageSnapshotResult as PageDriverSnapshotResult,
	PageRefActionResult,
} from "@shuvgeist/driver/page-driver";
import { createWebSocketCdpPageDriver } from "@shuvgeist/driver/page-driver-bindings";
import {
	type AgentRuntimeInitialState,
	type AgentRuntimeThinkingLevel,
	type AgentSessionContext,
	type CreateAgentRuntimeOptions,
	createAgentRuntime,
	DEFAULT_AGENT_THINKING_LEVEL,
} from "@shuvgeist/driver/runtime";
import { ElectronWsCdpSession } from "@shuvgeist/driver/websocket-cdp-session";

const DEFAULT_SCREENSHOT_FORMAT: DirectCdpScreenshotFormat = "png";
const DEFAULT_DIRECT_CDP_SYSTEM_PROMPT =
	"You are controlling a no-extension headless Chromium target through direct CDP tools.";

const directCdpPageSnapshotSchema = Type.Object({
	maxEntries: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
	includeHidden: Type.Optional(Type.Boolean()),
	query: Type.Optional(Type.String()),
});

const directCdpLocateByRoleSchema = Type.Object({
	role: Type.String(),
	name: Type.Optional(Type.String()),
	minScore: Type.Optional(Type.Number()),
	limit: Type.Optional(Type.Number()),
});

const directCdpRefClickSchema = Type.Object({
	refId: Type.String(),
	waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: 30_000 })),
});

const directCdpRefFillSchema = Type.Object({
	refId: Type.String(),
	value: Type.String(),
	waitMs: Type.Optional(Type.Number({ minimum: 0, maximum: 30_000 })),
});

type DirectCdpPageSnapshotParams = Static<typeof directCdpPageSnapshotSchema>;
type DirectCdpLocateByRoleParams = Static<typeof directCdpLocateByRoleSchema>;
type DirectCdpRefClickParams = Static<typeof directCdpRefClickSchema>;
type DirectCdpRefFillParams = Static<typeof directCdpRefFillSchema>;

export interface DirectCdpTargetInfo {
	id: string;
	type?: string;
	title?: string;
	url?: string;
	webSocketDebuggerUrl: string;
}

export interface DirectCdpDiscoveryOptions {
	host?: string;
	port: number;
}

export interface DirectCdpConnectionOptions
	extends Omit<DirectCdpAgentSessionAdapterOptions, "cdp" | "target">,
		DirectCdpDiscoveryOptions {
	targetId?: string;
	urlIncludes?: string;
}

export interface DirectCdpSnapshotOptions {
	frameId?: number;
	maxEntries?: number;
	includeHidden?: boolean;
	query?: string;
	signal?: AbortSignal;
}

export type DirectCdpScreenshotFormat = "png" | "jpeg" | "webp";
export type DirectCdpVisionFallbackTrigger = "planner-validator-failure" | "ambiguous-ref";

export interface DirectCdpScreenshotOptions {
	format?: DirectCdpScreenshotFormat;
	quality?: number;
	signal?: AbortSignal;
}

export interface DirectCdpScreenshotResult {
	format: DirectCdpScreenshotFormat;
	mimeType: string;
	data: string;
	dataUrl: string;
}

export type DirectCdpSnapshotResult = PageDriverSnapshotResult;

export interface DirectCdpLocatorMatch {
	refId: string;
	score: number;
	reasons: string[];
	entry: SnapshotInjectionEntry;
}

export interface DirectCdpLocateResult {
	matches: DirectCdpLocatorMatch[];
	snapshot: DirectCdpSnapshotResult;
}

export type DirectCdpRefClickResult = PageRefActionResult;
export type DirectCdpRefFillResult = PageRefActionResult;

export interface DirectCdpVisionCandidate {
	refId: string;
	stableElementId?: string;
	tagName: string;
	role?: string;
	name?: string;
	text?: string;
	label?: string;
	boundingBox: SnapshotInjectionEntry["boundingBox"];
	interactive: boolean;
	headingLevel?: number;
	landmark?: string;
}

export interface DirectCdpVisionCandidateBaselineOptions {
	model?: Model<Api>;
	trigger: DirectCdpVisionFallbackTrigger;
	snapshot?: DirectCdpSnapshotResult | DirectCdpVisionSnapshotPayload;
	snapshotOptions?: Omit<DirectCdpSnapshotOptions, "signal">;
	screenshotOptions?: Omit<DirectCdpScreenshotOptions, "signal">;
	candidateLimit?: number;
	signal?: AbortSignal;
}

export interface DirectCdpVisionCandidateBaseline {
	ok: true;
	trigger: DirectCdpVisionFallbackTrigger;
	model: {
		provider: string;
		id: string;
		input: Model<Api>["input"];
	};
	screenshot: DirectCdpScreenshotResult;
	snapshot: {
		scope?: PageDriverScope;
		query?: string;
		url: string;
		title: string;
		generatedAt: number;
		totalCandidates: number;
		truncated: boolean;
		candidateCount: number;
	};
	candidates: DirectCdpVisionCandidate[];
}

/**
 * Compatibility input for callers that already hold a flattened snapshot.
 * New direct-CDP captures return the canonical PageDriver result instead.
 */
export interface DirectCdpVisionSnapshotPayload extends SnapshotInjectionResult {
	query?: string;
}

export interface DirectCdpAgentSessionAdapterOptions {
	cdp: CdpSession;
	target?: DirectCdpTargetInfo;
	sessionId?: string;
	systemPrompt?: string;
	model?: CreateAgentRuntimeOptions["model"];
	thinkingLevel?: AgentRuntimeThinkingLevel;
	streamFn?: CreateAgentRuntimeOptions["streamFn"];
	getApiKey?: CreateAgentRuntimeOptions["getApiKey"];
	initialMessages?: AgentRuntimeInitialState["messages"];
	tools?: AgentRuntimeInitialState["tools"];
}

interface PageCaptureScreenshotResponse {
	data?: string;
}

export function buildDirectCdpSnapshotExpression(config: SnapshotInjectionConfig): string {
	const serializedConfig = JSON.stringify(config).replace(/</g, "\\u003c");
	return buildInjectedArtifactInvocation(SNAPSHOT_INJECTED_ARTIFACT, [serializedConfig]);
}

export function modelSupportsVision(model: Model<Api> | undefined): model is Model<Api> {
	return model?.input.includes("image") === true;
}

export function buildDirectCdpVisionCandidateBaseline(params: {
	model: Model<Api>;
	trigger: DirectCdpVisionFallbackTrigger;
	screenshot: DirectCdpScreenshotResult;
	snapshot: DirectCdpSnapshotResult | DirectCdpVisionSnapshotPayload;
	query?: string;
	candidateLimit?: number;
}): DirectCdpVisionCandidateBaseline {
	const { payload, scope } = unpackVisionSnapshot(params.snapshot);
	const query = params.query ?? payload.query;
	const candidates = payload.entries.slice(0, normalizeCandidateLimit(params.candidateLimit)).map(toVisionCandidate);
	return {
		ok: true,
		trigger: params.trigger,
		model: {
			provider: params.model.provider,
			id: params.model.id,
			input: [...params.model.input],
		},
		screenshot: params.screenshot,
		snapshot: {
			...(scope ? { scope } : {}),
			...(query ? { query } : {}),
			url: payload.url,
			title: payload.title,
			generatedAt: payload.generatedAt,
			totalCandidates: payload.totalCandidates,
			truncated: payload.truncated,
			candidateCount: candidates.length,
		},
		candidates,
	};
}

export async function listDirectCdpPageTargets(options: DirectCdpDiscoveryOptions): Promise<DirectCdpTargetInfo[]> {
	const host = options.host ?? "127.0.0.1";
	const response = await fetch("http://" + host + ":" + options.port + "/json/list");
	if (!response.ok) {
		throw new Error("Could not list direct-CDP targets on port " + options.port + ": " + response.status);
	}
	const targets = (await response.json()) as unknown;
	if (!Array.isArray(targets)) {
		throw new Error("Direct-CDP target list returned a non-array payload");
	}
	return targets.map(normalizeDirectCdpTarget).filter((target) => target.type === "page");
}

export async function connectDirectCdpHeadlessRuntime(
	options: DirectCdpConnectionOptions,
): Promise<DirectCdpAgentSessionAdapter> {
	const targets = await listDirectCdpPageTargets(options);
	const target = selectDirectCdpTarget(targets, options);
	const cdp = await ElectronWsCdpSession.connect(target.webSocketDebuggerUrl, target.id);
	return new DirectCdpAgentSessionAdapter({
		...options,
		cdp,
		target,
	});
}

export function createDirectCdpAgentTools(
	adapter: DirectCdpAgentSessionAdapter,
): NonNullable<AgentRuntimeInitialState["tools"]> {
	return [
		new DirectCdpPageSnapshotTool(adapter),
		new DirectCdpLocateByRoleTool(adapter),
		new DirectCdpRefClickTool(adapter),
		new DirectCdpRefFillTool(adapter),
	] as NonNullable<AgentRuntimeInitialState["tools"]>;
}

export class DirectCdpAgentSessionAdapter {
	readonly runtime: AgentSessionContext;
	readonly #cdp: CdpSession;
	readonly #target?: DirectCdpTargetInfo;
	readonly #driverSessionId: string;
	readonly #driverWindowId: string;
	private pageDriver?: PageDriver;
	private pageDriverInitialization?: Promise<PageDriver>;
	private latestSnapshot?: DirectCdpSnapshotResult;
	private closePromise?: Promise<void>;
	private closed = false;

	constructor(options: DirectCdpAgentSessionAdapterOptions) {
		if (options.target && options.target.id !== options.cdp.target.id) {
			throw new Error(
				`Direct-CDP target identity mismatch: discovery target ${options.target.id} does not match CDP target ${options.cdp.target.id}`,
			);
		}
		this.#cdp = options.cdp;
		this.#target = options.target;
		this.#driverSessionId = options.sessionId?.trim() || `direct-cdp:${options.cdp.target.id}`;
		this.#driverWindowId = options.target?.id ?? options.cdp.target.id;
		const systemPrompt = options.systemPrompt ?? DEFAULT_DIRECT_CDP_SYSTEM_PROMPT;
		const thinkingLevel = options.thinkingLevel ?? DEFAULT_AGENT_THINKING_LEVEL;
		const tools = options.tools ?? createDirectCdpAgentTools(this);
		this.runtime = createAgentRuntime({
			initialState: {
				systemPrompt,
				model: options.model,
				thinkingLevel,
				messages: options.initialMessages ?? [],
				tools,
			},
			systemPrompt,
			model: options.model,
			thinkingLevel,
			sessionId: options.sessionId,
			streamFn: options.streamFn,
			getApiKey: options.getApiKey,
			toolExecution: "sequential",
			plannerValidator: false,
		});
	}

	get target(): DirectCdpTargetInfo | undefined {
		return this.#target;
	}

	get lastSnapshot(): DirectCdpSnapshotResult | undefined {
		return this.latestSnapshot;
	}

	async prompt(input: string | AgentMessage | AgentMessage[]): Promise<AgentSessionContext> {
		if (typeof input === "string") {
			await this.runtime.agent.prompt(input);
		} else if (Array.isArray(input)) {
			await this.runtime.agent.prompt(input);
		} else {
			await this.runtime.agent.prompt(input);
		}
		await this.runtime.agent.waitForIdle();
		return this.runtime;
	}

	async snapshot(options: DirectCdpSnapshotOptions = {}): Promise<DirectCdpSnapshotResult> {
		throwIfAborted(options.signal);
		this.latestSnapshot = await (await this.getPageDriver()).snapshot(options);
		return this.latestSnapshot;
	}

	async screenshot(options: DirectCdpScreenshotOptions = {}): Promise<DirectCdpScreenshotResult> {
		throwIfAborted(options.signal);
		const format = normalizeScreenshotFormat(options.format);
		const params: Record<string, unknown> = {
			format,
			fromSurface: true,
			captureBeyondViewport: false,
		};
		const quality = normalizeScreenshotQuality(options.quality);
		if (quality !== undefined && format !== "png") {
			params.quality = quality;
		}
		this.assertOpen();
		await this.#cdp.ensureDomain("Page");
		const response = await this.#cdp.send<PageCaptureScreenshotResponse>("Page.captureScreenshot", params);
		if (!response.data) {
			throw new Error("Direct-CDP screenshot capture returned no image data");
		}
		const mimeType = mimeTypeForScreenshotFormat(format);
		return {
			format,
			mimeType,
			data: response.data,
			dataUrl: "data:" + mimeType + ";base64," + response.data,
		};
	}

	async captureVisionCandidateBaseline(
		options: DirectCdpVisionCandidateBaselineOptions,
	): Promise<DirectCdpVisionCandidateBaseline> {
		throwIfAborted(options.signal);
		assertVisionFallbackAllowed(options.model, options.trigger);
		const snapshot =
			options.snapshot ?? (await this.snapshot({ ...(options.snapshotOptions ?? {}), signal: options.signal }));
		const screenshot = await this.screenshot({ ...(options.screenshotOptions ?? {}), signal: options.signal });
		return buildDirectCdpVisionCandidateBaseline({
			model: options.model,
			trigger: options.trigger,
			snapshot,
			screenshot,
			query: options.snapshotOptions?.query,
			candidateLimit: options.candidateLimit,
		});
	}

	async locateByRole(params: DirectCdpLocateByRoleParams, signal?: AbortSignal): Promise<DirectCdpLocateResult> {
		const snapshot = await this.snapshot({ query: params.name ?? params.role, signal });
		return {
			snapshot,
			matches: locateSnapshot(snapshot, { kind: "role", value: params.role, name: params.name }, params),
		};
	}

	async locateByText(text: string, signal?: AbortSignal): Promise<DirectCdpLocateResult> {
		const snapshot = await this.snapshot({ query: text, signal });
		return {
			snapshot,
			matches: locateSnapshot(snapshot, { kind: "text", value: text }),
		};
	}

	async locateByLabel(label: string, signal?: AbortSignal): Promise<DirectCdpLocateResult> {
		const snapshot = await this.snapshot({ query: label, signal });
		return {
			snapshot,
			matches: locateSnapshot(snapshot, { kind: "label", value: label }),
		};
	}

	async clickRef(params: DirectCdpRefClickParams, signal?: AbortSignal): Promise<DirectCdpRefClickResult> {
		throwIfAborted(signal);
		const result = await (await this.getPageDriver()).actOnRef({
			refId: params.refId,
			action: { kind: "click", mode: "cdp-trusted" },
			signal,
		});
		if (result.ok && typeof params.waitMs === "number" && params.waitMs > 0) {
			await delay(params.waitMs, signal);
		}
		return result;
	}

	async fillRef(params: DirectCdpRefFillParams, signal?: AbortSignal): Promise<DirectCdpRefFillResult> {
		throwIfAborted(signal);
		const result = await (await this.getPageDriver()).actOnRef({
			refId: params.refId,
			action: { kind: "fill", mode: "cdp-trusted", value: params.value },
			signal,
		});
		if (result.ok && typeof params.waitMs === "number" && params.waitMs > 0) {
			await delay(params.waitMs, signal);
		}
		return result;
	}

	close(): Promise<void> {
		this.closePromise ??= this.closeInternal();
		return this.closePromise;
	}

	dispose(): Promise<void> {
		return this.close();
	}

	private async getPageDriver(): Promise<PageDriver> {
		this.assertOpen();
		if (this.pageDriverInitialization) return this.pageDriverInitialization;
		if (this.pageDriver) return this.pageDriver;
		const driver = createWebSocketCdpPageDriver({
			sessionId: this.#driverSessionId,
			windowId: this.#driverWindowId,
			pageId: this.#cdp.target.id,
			cdp: this.#cdp,
			buildSnapshotExpression: buildDirectCdpSnapshotExpression,
			// A direct-CDP connection is itself an explicit privileged capability.
			authorizeCdpInput: (scope) =>
				!this.closed &&
				scope.page.sessionId === this.#driverSessionId &&
				scope.page.windowId === this.#driverWindowId &&
				scope.page.pageId === this.#cdp.target.id,
		});
		this.pageDriver = driver;
		let initialization!: Promise<PageDriver>;
		initialization = (async () => {
			try {
				await driver.ready;
				this.assertOpen();
				return driver;
			} catch (error) {
				if (this.pageDriver === driver) this.pageDriver = undefined;
				await driver.dispose().catch(() => undefined);
				throw error;
			} finally {
				if (this.pageDriverInitialization === initialization) this.pageDriverInitialization = undefined;
			}
		})();
		this.pageDriverInitialization = initialization;
		return initialization;
	}

	private async closeInternal(): Promise<void> {
		this.closed = true;
		this.latestSnapshot = undefined;
		try {
			await this.pageDriver?.dispose();
		} finally {
			this.#cdp.close?.();
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Direct-CDP adapter has been closed");
	}
}

class DirectCdpPageSnapshotTool implements AgentTool<typeof directCdpPageSnapshotSchema, DirectCdpSnapshotResult> {
	name = "page_snapshot";
	label = "Page Snapshot";
	description = "Capture a compact semantic snapshot of the direct-CDP page target.";
	parameters = directCdpPageSnapshotSchema;

	constructor(private readonly adapter: DirectCdpAgentSessionAdapter) {}

	async execute(
		_toolCallId: string,
		args: DirectCdpPageSnapshotParams,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: DirectCdpSnapshotResult }> {
		const snapshot = await this.adapter.snapshot({ ...args, signal });
		return {
			content: [
				{
					type: "text",
					text: `Snapshot captured for direct-CDP target at ${snapshot.snapshot.url}; ${formatSnapshotOmissionSummary(snapshot.snapshot)}`,
				},
			],
			details: snapshot,
		};
	}
}

class DirectCdpLocateByRoleTool implements AgentTool<typeof directCdpLocateByRoleSchema, DirectCdpLocateResult> {
	name = "locate_by_role";
	label = "Locate by Role";
	description = "Locate direct-CDP page candidates by ARIA or implicit role.";
	parameters = directCdpLocateByRoleSchema;

	constructor(private readonly adapter: DirectCdpAgentSessionAdapter) {}

	async execute(
		_toolCallId: string,
		args: DirectCdpLocateByRoleParams,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: DirectCdpLocateResult }> {
		const result = await this.adapter.locateByRole(args, signal);
		return {
			content: [
				{
					type: "text",
					text: "Located " + result.matches.length + " direct-CDP candidate(s) for role " + args.role,
				},
			],
			details: result,
		};
	}
}

class DirectCdpRefClickTool implements AgentTool<typeof directCdpRefClickSchema, DirectCdpRefClickResult> {
	name = "ref_click";
	label = "Ref Click";
	description = "Click a snapshot ref on the direct-CDP page target using trusted input coordinates.";
	parameters = directCdpRefClickSchema;

	constructor(private readonly adapter: DirectCdpAgentSessionAdapter) {}

	async execute(
		_toolCallId: string,
		args: DirectCdpRefClickParams,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: DirectCdpRefClickResult }> {
		const result = await this.adapter.clickRef(args, signal);
		if (!result.ok) throw new Error(formatRefFailure(result));
		return {
			content: [
				{
					type: "text",
					text: "Clicked direct-CDP ref " + args.refId + " using trusted CDP input",
				},
			],
			details: result,
		};
	}
}

class DirectCdpRefFillTool implements AgentTool<typeof directCdpRefFillSchema, DirectCdpRefFillResult> {
	name = "ref_fill";
	label = "Ref Fill";
	description = "Fill a snapshot ref on the direct-CDP page target using trusted CDP input.";
	parameters = directCdpRefFillSchema;

	constructor(private readonly adapter: DirectCdpAgentSessionAdapter) {}

	async execute(
		_toolCallId: string,
		args: DirectCdpRefFillParams,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: DirectCdpRefFillResult }> {
		const result = await this.adapter.fillRef(args, signal);
		if (!result.ok) throw new Error(formatRefFailure(result));
		return {
			content: [
				{
					type: "text",
					text: "Filled direct-CDP ref " + args.refId + " using trusted CDP input",
				},
			],
			details: result,
		};
	}
}

function selectDirectCdpTarget(
	targets: DirectCdpTargetInfo[],
	options: Pick<DirectCdpConnectionOptions, "targetId" | "urlIncludes">,
): DirectCdpTargetInfo {
	const target = targets.find((candidate) => {
		if (options.targetId && candidate.id !== options.targetId) return false;
		if (options.urlIncludes && !candidate.url?.includes(options.urlIncludes)) return false;
		return true;
	});
	if (!target) {
		const reason = options.targetId
			? "id '" + options.targetId + "'"
			: options.urlIncludes
				? "url containing '" + options.urlIncludes + "'"
				: "a page target";
		throw new Error("No direct-CDP page target found for " + reason);
	}
	return target;
}

function normalizeDirectCdpTarget(value: unknown): DirectCdpTargetInfo {
	if (!isRecord(value)) throw new Error("Direct-CDP target entry was not an object");
	const id = readString(value.id);
	const webSocketDebuggerUrl = readString(value.webSocketDebuggerUrl);
	if (!id || !webSocketDebuggerUrl) {
		throw new Error("Direct-CDP target entry is missing id or webSocketDebuggerUrl");
	}
	return {
		id,
		webSocketDebuggerUrl,
		type: readString(value.type),
		title: readString(value.title),
		url: readString(value.url),
	};
}

function locateSnapshot(
	snapshot: DirectCdpSnapshotResult,
	query: Parameters<typeof rankLocatorCandidates>[1],
	options: { minScore?: number; limit?: number } = {},
): DirectCdpLocatorMatch[] {
	const candidates: SemanticLocatorCandidate[] = snapshot.snapshot.entries.map((entry) => ({
		candidateId: entry.snapshotId,
		role: entry.role,
		name: entry.name,
		text: entry.text,
		label: entry.label,
		tagName: entry.tagName,
		attributes: entry.attributes,
	}));
	const byId = new Map(snapshot.snapshot.entries.map((entry) => [entry.snapshotId, entry]));
	return rankLocatorCandidates(candidates, query, options).flatMap((match) => {
		const entry = byId.get(match.candidate.candidateId);
		if (!entry) return [];
		return [
			{
				refId: entry.snapshotId,
				score: match.score,
				reasons: [...match.reasons],
				entry,
			},
		];
	});
}

function unpackVisionSnapshot(snapshot: DirectCdpSnapshotResult | DirectCdpVisionSnapshotPayload): {
	payload: DirectCdpVisionSnapshotPayload;
	scope?: PageDriverScope;
} {
	if ("scope" in snapshot && "snapshot" in snapshot) {
		return { payload: snapshot.snapshot, scope: snapshot.scope };
	}
	return { payload: snapshot };
}

function toVisionCandidate(entry: SnapshotInjectionEntry): DirectCdpVisionCandidate {
	return {
		refId: entry.snapshotId,
		...(entry.stableElementId ? { stableElementId: entry.stableElementId } : {}),
		tagName: entry.tagName,
		...(entry.role ? { role: entry.role } : {}),
		...(entry.name ? { name: entry.name } : {}),
		...(entry.text ? { text: entry.text } : {}),
		...(entry.label ? { label: entry.label } : {}),
		boundingBox: { ...entry.boundingBox },
		interactive: entry.interactive,
		...(entry.headingLevel ? { headingLevel: entry.headingLevel } : {}),
		...(entry.landmark ? { landmark: entry.landmark } : {}),
	};
}

function formatSnapshotOmissionSummary(snapshot: {
	totalCandidates: number;
	entries: SnapshotInjectionEntry[];
	omissions?: SnapshotInjectionOmissions;
}): string {
	const inferredOmitted = Math.max(0, snapshot.totalCandidates - snapshot.entries.length);
	const omittedTotal = snapshot.omissions?.total ?? inferredOmitted;
	const queryFiltered = snapshot.omissions?.queryFiltered ?? 0;
	const budgetOmitted = snapshot.omissions?.budgetOmitted ?? Math.max(0, omittedTotal - queryFiltered);
	return [
		`candidates total=${snapshot.totalCandidates}, returned=${snapshot.entries.length}, omitted=${omittedTotal}`,
		`budget-omitted=${budgetOmitted}, query-filtered=${queryFiltered}`,
		`omitted categories: ${formatOmissionCounts(snapshot.omissions?.byCategory)}`,
		`omitted regions: ${formatOmissionCounts(snapshot.omissions?.byRegion)}`,
	].join("; ");
}

function formatOmissionCounts(counts: Record<string, number> | undefined): string {
	if (!counts || Object.keys(counts).length === 0) return "none";
	return Object.entries(counts)
		.sort(([leftKey, leftCount], [rightKey, rightCount]) => rightCount - leftCount || leftKey.localeCompare(rightKey))
		.map(([key, count]) => `${key}=${count}`)
		.join(", ");
}

function formatRefFailure(result: Extract<PageRefActionResult, { ok: false }>): string {
	return `Direct-CDP ref ${result.action.kind} failed (${result.reason}): ${result.message}`;
}

function normalizeCandidateLimit(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return Number.POSITIVE_INFINITY;
	return Math.max(0, Math.trunc(value));
}

function normalizeScreenshotFormat(format: DirectCdpScreenshotFormat | undefined): DirectCdpScreenshotFormat {
	if (!format) return DEFAULT_SCREENSHOT_FORMAT;
	if (format === "png" || format === "jpeg" || format === "webp") return format;
	throw new Error("Unsupported direct-CDP screenshot format");
}

function normalizeScreenshotQuality(quality: number | undefined): number | undefined {
	if (quality === undefined) return undefined;
	if (!Number.isFinite(quality)) throw new Error("Direct-CDP screenshot quality must be finite");
	return Math.max(0, Math.min(100, Math.trunc(quality)));
}

function mimeTypeForScreenshotFormat(format: DirectCdpScreenshotFormat): string {
	if (format === "jpeg") return "image/jpeg";
	if (format === "webp") return "image/webp";
	return "image/png";
}

function assertVisionFallbackAllowed(
	model: Model<Api> | undefined,
	trigger: DirectCdpVisionFallbackTrigger | undefined,
): asserts model is Model<Api> {
	if (trigger !== "planner-validator-failure" && trigger !== "ambiguous-ref") {
		throw new Error("Direct-CDP vision candidate baseline requires an explicit fallback trigger");
	}
	if (!modelSupportsVision(model)) {
		throw new Error("Direct-CDP vision candidate baseline requires a vision-capable model");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Direct-CDP operation aborted");
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const timeout = globalThis.setTimeout(resolve, ms);
		if (!signal) return;
		const abort = () => {
			globalThis.clearTimeout(timeout);
			reject(new Error("Direct-CDP operation aborted"));
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}
