import type { AgentMessage, AgentTool } from "@shuv1337/pi-agent-core";
import { type Api, type Model, type Static, Type } from "@shuv1337/pi-ai";
import {
	type AgentRuntimeInitialState,
	type AgentRuntimeThinkingLevel,
	type AgentSessionContext,
	type CreateAgentRuntimeOptions,
	createAgentRuntime,
	DEFAULT_AGENT_THINKING_LEVEL,
} from "../../agent/runtime.js";
import type { CdpSession } from "../../tools/helpers/cdp-session.js";
import { filterSnapshotByKeywords } from "../../tools/helpers/snapshot-filter.js";
import { SNAPSHOT_PAGE_SCRIPT } from "../../tools/helpers/snapshot-page-script.js";
import {
	locateByLabel,
	locateByRole,
	locateByText,
	type PageSnapshotEntry,
	type PageSnapshotResult,
	type SnapshotBoundingBox,
	type SnapshotLocatorMatch,
	type SnapshotScriptConfig,
	type SnapshotScriptEntry,
	type SnapshotScriptResponse,
} from "../../tools/page-snapshot.js";
import { ElectronWsCdpSession } from "../electron/cdp-client.js";
import { TrustedInputProvider } from "./trusted-input-provider.js";

const DIRECT_CDP_TAB_ID = 0;
const DEFAULT_MAX_ENTRIES = 120;
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

type DirectCdpPageSnapshotParams = Static<typeof directCdpPageSnapshotSchema>;
type DirectCdpLocateByRoleParams = Static<typeof directCdpLocateByRoleSchema>;
type DirectCdpRefClickParams = Static<typeof directCdpRefClickSchema>;

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

export interface DirectCdpPoint {
	x: number;
	y: number;
}

export interface DirectCdpLocatorMatch {
	refId: string;
	score: number;
	reasons: string[];
	entry: PageSnapshotEntry;
}

export interface DirectCdpLocateResult {
	matches: DirectCdpLocatorMatch[];
	snapshot: PageSnapshotResult;
}

export interface DirectCdpRefClickResult {
	ok: true;
	refId: string;
	point: DirectCdpPoint;
	entry: PageSnapshotEntry;
	trustedInput: true;
}

export interface DirectCdpVisionCandidate {
	refId: string;
	stableElementId?: string;
	tagName: string;
	role?: string;
	name?: string;
	text?: string;
	label?: string;
	boundingBox: SnapshotBoundingBox;
	interactive: boolean;
	headingLevel?: number;
	landmark?: string;
}

export interface DirectCdpVisionCandidateBaselineOptions {
	model?: Model<Api>;
	trigger: DirectCdpVisionFallbackTrigger;
	snapshot?: PageSnapshotResult;
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
		tabId: number;
		frameId: number;
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

interface RuntimeEvaluateResponse {
	result?: {
		type?: string;
		value?: unknown;
		description?: string;
	};
	exceptionDetails?: {
		text?: string;
		exception?: {
			description?: string;
			value?: unknown;
		};
	};
}

interface PageCaptureScreenshotResponse {
	data?: string;
}

export function buildDirectCdpSnapshotExpression(config: SnapshotScriptConfig): string {
	const serializedConfig = JSON.stringify(config).replace(/</g, "\\u003c");
	return (
		"(() => { const __name = (fn) => fn; const snapshot = " +
		SNAPSHOT_PAGE_SCRIPT +
		"; return snapshot(" +
		serializedConfig +
		"); })()"
	);
}

export function modelSupportsVision(model: Model<Api> | undefined): model is Model<Api> {
	return model?.input.includes("image") === true;
}

export function buildDirectCdpVisionCandidateBaseline(params: {
	model: Model<Api>;
	trigger: DirectCdpVisionFallbackTrigger;
	screenshot: DirectCdpScreenshotResult;
	snapshot: PageSnapshotResult;
	candidateLimit?: number;
}): DirectCdpVisionCandidateBaseline {
	const candidates = params.snapshot.entries
		.slice(0, normalizeCandidateLimit(params.candidateLimit))
		.map(toVisionCandidate);
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
			tabId: params.snapshot.tabId,
			frameId: params.snapshot.frameId,
			...(params.snapshot.query ? { query: params.snapshot.query } : {}),
			url: params.snapshot.url,
			title: params.snapshot.title,
			generatedAt: params.snapshot.generatedAt,
			totalCandidates: params.snapshot.totalCandidates,
			truncated: params.snapshot.truncated,
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
	] as NonNullable<AgentRuntimeInitialState["tools"]>;
}

export class DirectCdpAgentSessionAdapter {
	readonly runtime: AgentSessionContext;
	private latestSnapshot?: PageSnapshotResult;
	private trustedInput?: TrustedInputProvider;

	constructor(private readonly options: DirectCdpAgentSessionAdapterOptions) {
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

	get cdp(): CdpSession {
		return this.options.cdp;
	}

	get target(): DirectCdpTargetInfo | undefined {
		return this.options.target;
	}

	get lastSnapshot(): PageSnapshotResult | undefined {
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

	async snapshot(options: DirectCdpSnapshotOptions = {}): Promise<PageSnapshotResult> {
		throwIfAborted(options.signal);
		const frameId = options.frameId ?? 0;
		const maxEntries = clampMaxEntries(options.maxEntries);
		const config: SnapshotScriptConfig = {
			frameId,
			maxEntries,
			includeHidden: options.includeHidden === true,
		};
		await this.cdp.ensureDomain("Runtime");
		const response = await this.cdp.send<RuntimeEvaluateResponse>("Runtime.evaluate", {
			expression: buildDirectCdpSnapshotExpression(config),
			awaitPromise: true,
			returnByValue: true,
		});
		const scriptResponse = extractSnapshotScriptResponse(response);
		if (!scriptResponse.success || !scriptResponse.result) {
			throw new Error(scriptResponse.error || "Direct-CDP snapshot script failed");
		}
		const snapshot: PageSnapshotResult = {
			tabId: DIRECT_CDP_TAB_ID,
			frameId,
			...(options.query ? { query: options.query } : {}),
			url: scriptResponse.result.url,
			title: scriptResponse.result.title,
			generatedAt: scriptResponse.result.generatedAt,
			totalCandidates: scriptResponse.result.totalCandidates,
			truncated: scriptResponse.result.truncated,
			entries: scriptResponse.result.entries.map((entry) => normalizeDirectCdpSnapshotEntry(entry, frameId)),
		};
		this.latestSnapshot = filterSnapshotByKeywords(snapshot, { query: options.query, limit: maxEntries });
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
		await this.cdp.ensureDomain("Page");
		const response = await this.cdp.send<PageCaptureScreenshotResponse>("Page.captureScreenshot", params);
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
			candidateLimit: options.candidateLimit,
		});
	}

	async locateByRole(params: DirectCdpLocateByRoleParams, signal?: AbortSignal): Promise<DirectCdpLocateResult> {
		const snapshot = await this.snapshot({ query: params.name ?? params.role, signal });
		return {
			snapshot,
			matches: locateByRole(snapshot, params.role, {
				name: params.name,
				minScore: params.minScore,
				limit: params.limit,
			}).map(toDirectCdpLocatorMatch),
		};
	}

	async locateByText(text: string, signal?: AbortSignal): Promise<DirectCdpLocateResult> {
		const snapshot = await this.snapshot({ query: text, signal });
		return {
			snapshot,
			matches: locateByText(snapshot, text).map(toDirectCdpLocatorMatch),
		};
	}

	async locateByLabel(label: string, signal?: AbortSignal): Promise<DirectCdpLocateResult> {
		const snapshot = await this.snapshot({ query: label, signal });
		return {
			snapshot,
			matches: locateByLabel(snapshot, label).map(toDirectCdpLocatorMatch),
		};
	}

	async clickRef(params: DirectCdpRefClickParams, signal?: AbortSignal): Promise<DirectCdpRefClickResult> {
		throwIfAborted(signal);
		const entry =
			this.resolveSnapshotRef(params.refId) ??
			(await this.snapshot({ signal })).entries.find(
				(candidate) => candidate.snapshotId === params.refId || candidate.stableElementId === params.refId,
			);
		if (!entry) {
			throw new Error("No direct-CDP snapshot ref found for '" + params.refId + "'");
		}
		const point = centerOf(entry.boundingBox);
		await this.dispatchMouseClick(point, signal);
		if (typeof params.waitMs === "number" && params.waitMs > 0) {
			await delay(params.waitMs, signal);
		}
		return {
			ok: true,
			refId: params.refId,
			point,
			entry,
			trustedInput: true,
		};
	}

	close(): void {
		this.cdp.close?.();
	}

	private resolveSnapshotRef(refId: string): PageSnapshotEntry | undefined {
		return this.latestSnapshot?.entries.find(
			(entry) => entry.snapshotId === refId || entry.stableElementId === refId,
		);
	}

	private async dispatchMouseClick(point: DirectCdpPoint, signal?: AbortSignal): Promise<void> {
		await this.getTrustedInputProvider().click(point, { signal });
	}

	private getTrustedInputProvider(): TrustedInputProvider {
		if (!this.trustedInput) {
			this.trustedInput = new TrustedInputProvider(this.cdp);
		}
		return this.trustedInput;
	}
}

class DirectCdpPageSnapshotTool implements AgentTool<typeof directCdpPageSnapshotSchema, PageSnapshotResult> {
	name = "page_snapshot";
	label = "Page Snapshot";
	description = "Capture a compact semantic snapshot of the direct-CDP page target.";
	parameters = directCdpPageSnapshotSchema;

	constructor(private readonly adapter: DirectCdpAgentSessionAdapter) {}

	async execute(
		_toolCallId: string,
		args: DirectCdpPageSnapshotParams,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: PageSnapshotResult }> {
		const snapshot = await this.adapter.snapshot({ ...args, signal });
		return {
			content: [
				{
					type: "text",
					text:
						"Snapshot captured for direct-CDP target with " +
						snapshot.entries.length +
						" entries at " +
						snapshot.url,
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
		return {
			content: [
				{
					type: "text",
					text: "Clicked direct-CDP ref " + args.refId + " at " + result.point.x + "," + result.point.y,
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

function extractSnapshotScriptResponse(response: RuntimeEvaluateResponse): SnapshotScriptResponse {
	if (response.exceptionDetails) {
		throw new Error(
			response.exceptionDetails.exception?.description ??
				response.exceptionDetails.text ??
				"Direct-CDP snapshot evaluation threw an exception",
		);
	}
	const value = response.result?.value;
	if (!isRecord(value)) {
		throw new Error("Direct-CDP snapshot script returned a non-object payload");
	}
	if (value.success !== true) {
		return { success: false, error: readString(value.error) ?? "Direct-CDP snapshot script failed" };
	}
	if (!isRecord(value.result)) {
		throw new Error("Direct-CDP snapshot script returned no result object");
	}
	return value as unknown as SnapshotScriptResponse;
}

function normalizeDirectCdpSnapshotEntry(entry: SnapshotScriptEntry, frameId: number): PageSnapshotEntry {
	return {
		snapshotId: entry.snapshotId,
		...(entry.stableElementId ? { stableElementId: entry.stableElementId } : {}),
		tabId: DIRECT_CDP_TAB_ID,
		frameId,
		tagName: entry.tagName,
		role: entry.role,
		name: trimText(entry.name),
		text: trimText(entry.text),
		label: trimText(entry.label),
		attributes: { ...entry.attributes },
		selectorCandidates: [...entry.selectorCandidates],
		ordinalPath: [...entry.ordinalPath],
		boundingBox: { ...entry.boundingBox },
		interactive: entry.interactive,
		headingLevel: entry.headingLevel,
		landmark: entry.landmark,
	};
}

function toDirectCdpLocatorMatch(match: SnapshotLocatorMatch): DirectCdpLocatorMatch {
	return {
		refId: match.entry.snapshotId,
		score: match.score,
		reasons: [...match.reasons],
		entry: match.entry,
	};
}

function toVisionCandidate(entry: PageSnapshotEntry): DirectCdpVisionCandidate {
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

function centerOf(box: PageSnapshotEntry["boundingBox"]): DirectCdpPoint {
	return {
		x: Math.round(box.x + box.width / 2),
		y: Math.round(box.y + box.height / 2),
	};
}

function clampMaxEntries(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_ENTRIES;
	return Math.max(1, Math.min(500, Math.trunc(value)));
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

function trimText(text: string | undefined, maxLength = 180): string | undefined {
	if (!text) return undefined;
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	if (normalized.length <= maxLength) return normalized;
	return normalized.slice(0, maxLength - 1) + "...";
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
