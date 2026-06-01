import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@mariozechner/pi-ai";
import { isUsableWindowId } from "./helpers/browser-target.js";
import { executePageFunction } from "./helpers/page-execution.js";
import type { RefLocatorBundle, SemanticLocatorCandidate } from "./helpers/ref-map.js";
import { rankLocatorCandidates } from "./helpers/ref-map.js";
import { filterSnapshotByKeywords } from "./helpers/snapshot-filter.js";
import { SNAPSHOT_PAGE_SCRIPT, shuvgeistSnapshotPageScript } from "./helpers/snapshot-page-script.js";

export { SNAPSHOT_PAGE_SCRIPT };

const SNAPSHOT_WORLD_ID = "shuvgeist-page-snapshot";
const DEFAULT_MAX_ENTRIES = 120;

export interface SnapshotBoundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PageSnapshotEntry {
	snapshotId: string;
	stableElementId?: string;
	tabId: number;
	frameId: number;
	tagName: string;
	role?: string;
	name?: string;
	text?: string;
	label?: string;
	attributes: Record<string, string>;
	selectorCandidates: string[];
	ordinalPath: number[];
	boundingBox: SnapshotBoundingBox;
	interactive: boolean;
	headingLevel?: number;
	landmark?: string;
}

export interface PageSnapshotResult {
	tabId: number;
	frameId: number;
	query?: string;
	url: string;
	title: string;
	generatedAt: number;
	totalCandidates: number;
	truncated: boolean;
	entries: PageSnapshotEntry[];
}

export interface CapturePageSnapshotOptions {
	tabId: number;
	frameId?: number;
	maxEntries?: number;
	includeHidden?: boolean;
	query?: string;
}

const pageSnapshotSchema = Type.Object({
	tabId: Type.Optional(Type.Number({ description: "Optional tab ID to snapshot. Defaults to active tab." })),
	frameId: Type.Optional(Type.Number({ description: "Optional frame ID to snapshot. Defaults to main frame." })),
	maxEntries: Type.Optional(
		Type.Number({
			description: "Max entries to return. Lower values keep payload compact.",
			minimum: 1,
			maximum: 500,
		}),
	),
	includeHidden: Type.Optional(Type.Boolean({ description: "Include hidden elements if true." })),
	query: Type.Optional(Type.String({ description: "Optional keyword query reserved for snapshot filtering." })),
});

export type PageSnapshotParams = Static<typeof pageSnapshotSchema>;

export interface SnapshotScriptEntry {
	snapshotId: string;
	stableElementId?: string;
	frameId: number;
	tagName: string;
	role?: string;
	name?: string;
	text?: string;
	label?: string;
	attributes: Record<string, string>;
	selectorCandidates: string[];
	ordinalPath: number[];
	boundingBox: SnapshotBoundingBox;
	interactive: boolean;
	headingLevel?: number;
	landmark?: string;
}

export interface SnapshotScriptResult {
	url: string;
	title: string;
	generatedAt: number;
	totalCandidates: number;
	truncated: boolean;
	entries: SnapshotScriptEntry[];
}

export interface SnapshotScriptResponse {
	success: boolean;
	error?: string;
	result?: SnapshotScriptResult;
}

export interface SnapshotScriptConfig {
	frameId: number;
	maxEntries: number;
	includeHidden: boolean;
	snapshotIdPrefix?: string;
	stableElementIdAttribute?: string;
}

export interface LocateByRoleOptions {
	name?: string;
	minScore?: number;
	limit?: number;
}

export interface LocateByTextOptions {
	minScore?: number;
	limit?: number;
}

export interface LocateByLabelOptions {
	minScore?: number;
	limit?: number;
}

export interface SnapshotLocatorMatch {
	entry: PageSnapshotEntry;
	score: number;
	reasons: string[];
}

function trimText(text: string | undefined, maxLength = 180): string | undefined {
	if (!text) return undefined;
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, maxLength - 1)}...`;
}

function normalizeSnapshotEntry(entry: SnapshotScriptEntry, tabId: number): PageSnapshotEntry {
	return {
		snapshotId: entry.snapshotId,
		...(entry.stableElementId ? { stableElementId: entry.stableElementId } : {}),
		tabId,
		frameId: entry.frameId,
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

function toSemanticLocatorCandidate(entry: PageSnapshotEntry): SemanticLocatorCandidate {
	return {
		candidateId: entry.snapshotId,
		role: entry.role,
		name: entry.name,
		text: entry.text,
		label: entry.label,
		tagName: entry.tagName,
		attributes: entry.attributes,
	};
}

function mapRankedResults(
	snapshot: PageSnapshotResult,
	options: { minScore?: number; limit?: number },
	query: Parameters<typeof rankLocatorCandidates>[1],
): SnapshotLocatorMatch[] {
	const candidates = snapshot.entries.map(toSemanticLocatorCandidate);
	const ranked = rankLocatorCandidates(candidates, query, options);
	const byId = new Map(snapshot.entries.map((entry) => [entry.snapshotId, entry]));
	return ranked
		.map((match) => {
			const entry = byId.get(match.candidate.candidateId);
			if (!entry) return null;
			return {
				entry,
				score: match.score,
				reasons: match.reasons,
			};
		})
		.filter((match): match is SnapshotLocatorMatch => match !== null);
}

export function locateByRole(
	snapshot: PageSnapshotResult,
	role: string,
	options: LocateByRoleOptions = {},
): SnapshotLocatorMatch[] {
	return mapRankedResults(snapshot, options, { kind: "role", value: role, name: options.name });
}

export function locateByText(
	snapshot: PageSnapshotResult,
	text: string,
	options: LocateByTextOptions = {},
): SnapshotLocatorMatch[] {
	return mapRankedResults(snapshot, options, { kind: "text", value: text });
}

export function locateByLabel(
	snapshot: PageSnapshotResult,
	label: string,
	options: LocateByLabelOptions = {},
): SnapshotLocatorMatch[] {
	return mapRankedResults(snapshot, options, { kind: "label", value: label });
}

export function buildRefLocatorBundle(entry: PageSnapshotEntry): RefLocatorBundle {
	return {
		selectorCandidates: [...entry.selectorCandidates],
		semantic: {
			role: entry.role,
			name: entry.name,
			text: entry.text,
			label: entry.label,
		},
		tagName: entry.tagName,
		attributes: { ...entry.attributes },
		ordinalPath: [...entry.ordinalPath],
		lastKnownBoundingBox: { ...entry.boundingBox },
	};
}

async function resolveSnapshotTabId(tabId: number | undefined, windowId: number | undefined): Promise<number> {
	if (typeof tabId === "number") return tabId;
	const query: chrome.tabs.QueryInfo = isUsableWindowId(windowId)
		? { active: true, windowId }
		: { active: true, currentWindow: true };
	const [activeTab] = await chrome.tabs.query(query);
	if (!activeTab?.id) throw new Error("No active tab found for page snapshot");
	return activeTab.id;
}

export async function capturePageSnapshot(options: CapturePageSnapshotOptions): Promise<PageSnapshotResult> {
	const frameId = options.frameId ?? 0;
	const maxEntries = Math.max(1, Math.min(500, options.maxEntries ?? DEFAULT_MAX_ENTRIES));
	const includeHidden = Boolean(options.includeHidden);

	const config = {
		frameId,
		maxEntries,
		includeHidden,
	};
	const execution = await executePageFunction<SnapshotScriptResponse>(
		{ tabId: options.tabId, frameId },
		shuvgeistSnapshotPageScript,
		{ worldId: SNAPSHOT_WORLD_ID, args: [config] },
	);
	if (!execution.success) {
		throw new Error(execution.error || "Page snapshot script failed");
	}
	const response = execution.value;
	if (!response) throw new Error("Page snapshot script returned no result");
	if (!response.success || !response.result) {
		throw new Error(response.error || "Page snapshot script failed");
	}

	const snapshot = {
		tabId: options.tabId,
		frameId,
		...(options.query ? { query: options.query } : {}),
		url: response.result.url,
		title: response.result.title,
		generatedAt: response.result.generatedAt,
		totalCandidates: response.result.totalCandidates,
		truncated: response.result.truncated,
		entries: response.result.entries.map((entry) => normalizeSnapshotEntry(entry, options.tabId)),
	};
	return filterSnapshotByKeywords(snapshot, { query: options.query, limit: maxEntries });
}

export class PageSnapshotTool implements AgentTool<typeof pageSnapshotSchema, PageSnapshotResult> {
	name = "page_snapshot";
	label = "Page Snapshot";
	description =
		"Capture a compact, semantic snapshot of the current page for robust element targeting and ref-based actions.";
	parameters = pageSnapshotSchema;
	windowId?: number;

	async execute(
		_toolCallId: string,
		args: PageSnapshotParams,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: PageSnapshotResult }> {
		if (signal?.aborted) {
			throw new Error("Page snapshot aborted");
		}
		const tabId = await resolveSnapshotTabId(args.tabId, this.windowId);
		const result = await capturePageSnapshot({
			tabId,
			frameId: args.frameId,
			maxEntries: args.maxEntries,
			includeHidden: args.includeHidden,
			query: args.query,
		});
		return {
			content: [
				{
					type: "text",
					text: `Snapshot captured for tab ${result.tabId}, frame ${result.frameId} with ${result.entries.length} entries`,
				},
			],
			details: result,
		};
	}
}
