import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import { isUsableWindowId } from "./helpers/browser-target.js";
import type { RefLocatorBundle, SemanticLocatorCandidate } from "./helpers/ref-map.js";
import { rankLocatorCandidates } from "./helpers/ref-map.js";

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
});

export type PageSnapshotParams = Static<typeof pageSnapshotSchema>;

interface SnapshotScriptEntry {
	snapshotId: string;
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

interface SnapshotScriptResult {
	url: string;
	title: string;
	generatedAt: number;
	totalCandidates: number;
	truncated: boolean;
	entries: SnapshotScriptEntry[];
}

interface SnapshotScriptResponse {
	success: boolean;
	error?: string;
	result?: SnapshotScriptResult;
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

function buildSnapshotScript(config: { frameId: number; maxEntries: number; includeHidden: boolean }): string {
	return `(() => {
		const config = ${JSON.stringify(config)};
		const selector = [
			'a[href]',
			'button',
			'input',
			'select',
			'textarea',
			'summary',
			'[role]',
			'[tabindex]',
			'[contenteditable="true"]',
			'label',
			'h1,h2,h3,h4,h5,h6',
			'main,nav,header,footer,aside,article,section'
		].join(',');
		const landmarkRoles = new Set(['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'region', 'search']);
		const interactiveRoles = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'menuitem', 'tab', 'slider', 'spinbutton', 'option']);

		const normalize = (value, maxLen) => {
			if (typeof value !== 'string') return '';
			const text = value.replace(/\\s+/g, ' ').trim();
			if (!text) return '';
			return text.length <= maxLen ? text : text.slice(0, Math.max(0, maxLen - 1)) + '...';
		};

		const isVisible = (element) => {
			const style = window.getComputedStyle(element);
			if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
			const rect = element.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) return false;
			return true;
		};

		const safeEscape = (input) => {
			if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(input);
			return input.replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
		};

		const implicitRole = (element) => {
			const tag = element.tagName.toLowerCase();
			if (tag === 'a' && element.getAttribute('href')) return 'link';
			if (tag === 'button') return 'button';
			if (tag === 'select') return 'combobox';
			if (tag === 'textarea') return 'textbox';
			if (tag === 'summary') return 'button';
			if (tag === 'input') {
				const type = (element.getAttribute('type') || 'text').toLowerCase();
				if (type === 'checkbox') return 'checkbox';
				if (type === 'radio') return 'radio';
				if (type === 'range') return 'slider';
				if (type === 'number') return 'spinbutton';
				if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
				return 'textbox';
			}
			if (tag === 'main') return 'main';
			if (tag === 'nav') return 'navigation';
			if (tag === 'header') return 'banner';
			if (tag === 'footer') return 'contentinfo';
			if (tag === 'aside') return 'complementary';
			if (tag === 'section' && (element.getAttribute('aria-label') || element.getAttribute('aria-labelledby'))) return 'region';
			return '';
		};

		const elementName = (element) => {
			const ariaLabel = element.getAttribute('aria-label');
			if (ariaLabel) return normalize(ariaLabel, 120);
			const title = element.getAttribute('title');
			if (title) return normalize(title, 120);
			if (element instanceof HTMLInputElement && element.value) return normalize(element.value, 120);
			const alt = element.getAttribute('alt');
			if (alt) return normalize(alt, 120);
			return normalize(element.textContent || '', 120);
		};

		const elementLabel = (element) => {
			const ariaLabelledBy = element.getAttribute('aria-labelledby');
			if (ariaLabelledBy) {
				const parts = ariaLabelledBy
					.split(/\\s+/)
					.filter(Boolean)
					.map((id) => document.getElementById(id))
					.filter((node) => node)
					.map((node) => normalize(node.textContent || '', 120))
					.filter(Boolean);
				if (parts.length > 0) return parts.join(' ');
			}
			if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
				if (element.labels && element.labels.length > 0) {
					return normalize(element.labels[0].textContent || '', 120);
				}
				const id = element.getAttribute('id');
				if (id) {
					const label = document.querySelector('label[for="' + safeEscape(id) + '"]');
					if (label) return normalize(label.textContent || '', 120);
				}
			}
			return '';
		};

		const selectorCandidates = (element) => {
			const out = [];
			const tag = element.tagName.toLowerCase();
			const id = element.getAttribute('id');
			if (id) out.push('#' + safeEscape(id));
			const dataTestId = element.getAttribute('data-testid');
			if (dataTestId) out.push('[data-testid="' + safeEscape(dataTestId) + '"]');
			const name = element.getAttribute('name');
			if (name) out.push(tag + '[name="' + safeEscape(name) + '"]');
			const classes = (element.getAttribute('class') || '')
				.split(/\\s+/)
				.filter(Boolean)
				.filter((name) => !name.startsWith('shuvgeist-'))
				.slice(0, 2);
			if (classes.length > 0) out.push(tag + '.' + classes.map((item) => safeEscape(item)).join('.'));
			if (element.parentElement) {
				const sameTag = Array.from(element.parentElement.children).filter((child) => child.tagName === element.tagName);
				const index = sameTag.indexOf(element) + 1;
				if (index > 0) out.push(tag + ':nth-of-type(' + index + ')');
			}
			out.push(tag);
			return Array.from(new Set(out)).slice(0, 5);
		};

		const ordinalPath = (element) => {
			const path = [];
			let node = element;
			while (node && node !== document.body && node.parentElement) {
				path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
				node = node.parentElement;
			}
			return path;
		};

		const relevant = Array.from(document.querySelectorAll(selector));
		const seen = new Set();
		const out = [];
		let totalCandidates = 0;

		for (const element of relevant) {
			if (!(element instanceof HTMLElement)) continue;
			if (seen.has(element)) continue;
			seen.add(element);

			const visible = isVisible(element);
			if (!config.includeHidden && !visible) continue;

			const tagName = element.tagName.toLowerCase();
			const explicitRole = element.getAttribute('role') || '';
			const role = explicitRole || implicitRole(element);
			const headingLevel = /^h[1-6]$/.test(tagName) ? Number.parseInt(tagName.slice(1), 10) : undefined;
			const landmark = landmarkRoles.has(role) ? role : undefined;
			const interactive = interactiveRoles.has(role) || element.tabIndex >= 0 || element.isContentEditable;
			if (!interactive && !headingLevel && !landmark) continue;

			totalCandidates++;
			if (out.length >= config.maxEntries) continue;

			const rect = element.getBoundingClientRect();
			const label = elementLabel(element);
			const attrs = {};
			for (const key of ['id', 'name', 'type', 'href', 'placeholder', 'aria-label', 'data-testid', 'title']) {
				const value = element.getAttribute(key);
				if (value) attrs[key] = normalize(value, 120);
			}

			out.push({
				snapshotId: 'e' + (out.length + 1),
				frameId: config.frameId,
				tagName,
				role: role || undefined,
				name: elementName(element) || undefined,
				text: normalize(element.textContent || '', 180) || undefined,
				label: label || undefined,
				attributes: attrs,
				selectorCandidates: selectorCandidates(element),
				ordinalPath: ordinalPath(element),
				boundingBox: {
					x: rect.x,
					y: rect.y,
					width: rect.width,
					height: rect.height
				},
				interactive,
				headingLevel,
				landmark
			});
		}

		return {
			success: true,
			result: {
				url: location.href,
				title: document.title || '',
				generatedAt: Date.now(),
				totalCandidates,
				truncated: totalCandidates > out.length,
				entries: out
			}
		};
	})()`;
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

	try {
		await chrome.userScripts.configureWorld({
			worldId: SNAPSHOT_WORLD_ID,
			messaging: true,
		});
	} catch {
		// No-op when world already exists.
	}

	const code = buildSnapshotScript({
		frameId,
		maxEntries,
		includeHidden,
	});
	const target: {
		tabId: number;
		allFrames: false;
		frameIds?: number[];
	} = {
		tabId: options.tabId,
		allFrames: false,
	};
	if (frameId !== 0) target.frameIds = [frameId];

	const executeOptions = {
		js: [{ code }],
		target,
		world: "USER_SCRIPT",
		worldId: SNAPSHOT_WORLD_ID,
		injectImmediately: true,
	};
	const resultList = await chrome.userScripts.execute(
		executeOptions as unknown as Parameters<typeof chrome.userScripts.execute>[0],
	);
	const first = resultList[0] as { result?: SnapshotScriptResponse } | undefined;
	const response = first?.result;
	if (!response) throw new Error("Page snapshot script returned no result");
	if (!response.success || !response.result) {
		throw new Error(response.error || "Page snapshot script failed");
	}

	return {
		tabId: options.tabId,
		frameId,
		url: response.result.url,
		title: response.result.title,
		generatedAt: response.result.generatedAt,
		totalCandidates: response.result.totalCandidates,
		truncated: response.result.truncated,
		entries: response.result.entries.map((entry) => normalizeSnapshotEntry(entry, options.tabId)),
	};
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
