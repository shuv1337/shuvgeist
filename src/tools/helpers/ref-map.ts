export interface RefBoundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface RefSemanticLocator {
	role?: string;
	name?: string;
	text?: string;
	label?: string;
}

export interface RefLocatorBundle {
	selectorCandidates: string[];
	semantic?: RefSemanticLocator;
	tagName?: string;
	attributes?: Record<string, string>;
	ordinalPath?: number[];
	lastKnownBoundingBox?: RefBoundingBox;
}

export interface RefEntry {
	refId: string;
	tabId: number;
	frameId: number;
	locator: RefLocatorBundle;
	navigationGeneration?: number;
	createdAt: number;
	updatedAt: number;
}

export type RefResolutionFailureReason =
	| "missing_ref"
	| "frame_mismatch"
	| "not_found"
	| "ambiguous_match"
	| "low_confidence"
	| "stale_generation";

export interface RefResolutionCandidate {
	candidateId: string;
	tabId: number;
	frameId: number;
	selectorCandidates?: string[];
	role?: string;
	name?: string;
	text?: string;
	label?: string;
	tagName?: string;
	attributes?: Record<string, string>;
	ordinalPath?: number[];
	boundingBox?: RefBoundingBox;
}

export interface ScoredRefResolutionCandidate extends RefResolutionCandidate {
	score: number;
	reasons: string[];
}

export type RefResolutionResult =
	| {
			ok: true;
			ref: RefEntry;
			match: ScoredRefResolutionCandidate;
	  }
	| {
			ok: false;
			ref?: RefEntry;
			reason: RefResolutionFailureReason;
			message: string;
			candidates?: ScoredRefResolutionCandidate[];
	  };

export interface ResolveRefOptions {
	minScore?: number;
	ambiguousDelta?: number;
	currentNavigationGeneration?: number;
}

export interface CreateRefParams {
	refId?: string;
	tabId: number;
	frameId: number;
	locator: RefLocatorBundle;
	navigationGeneration?: number;
}

export interface ListRefOptions {
	tabId?: number;
	frameId?: number;
}

export type LocatorQuery =
	| {
			kind: "role";
			value: string;
			name?: string;
	  }
	| {
			kind: "text";
			value: string;
	  }
	| {
			kind: "label";
			value: string;
	  };

export interface SemanticLocatorCandidate {
	candidateId: string;
	role?: string;
	name?: string;
	text?: string;
	label?: string;
	tagName?: string;
	attributes?: Record<string, string>;
}

export interface RankedLocatorCandidate {
	candidate: SemanticLocatorCandidate;
	score: number;
	reasons: string[];
}

export interface RankLocatorOptions {
	minScore?: number;
	limit?: number;
}

const DEFAULT_MIN_SCORE = 0.62;
const DEFAULT_AMBIGUOUS_DELTA = 0.04;

function now(): number {
	return Date.now();
}

function randomRefId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return `ref_${crypto.randomUUID()}`;
	}
	return `ref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeText(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

function textMatchScore(query: string | undefined, candidate: string | undefined): number {
	const queryNorm = normalizeText(query);
	const candidateNorm = normalizeText(candidate);
	if (!queryNorm || !candidateNorm) return 0;
	if (queryNorm === candidateNorm) return 1;
	if (candidateNorm.includes(queryNorm)) return 0.78;
	const queryTokens = queryNorm.split(/\s+/).filter(Boolean);
	if (queryTokens.length === 0) return 0;
	let overlap = 0;
	for (const token of queryTokens) {
		if (candidateNorm.includes(token)) overlap++;
	}
	if (overlap === 0) return 0;
	return (overlap / queryTokens.length) * 0.62;
}

function numberListSimilarity(a: number[] | undefined, b: number[] | undefined): number {
	if (!a || !b || a.length === 0 || b.length === 0) return 0;
	const len = Math.min(a.length, b.length);
	let equalPrefix = 0;
	for (let i = 0; i < len; i++) {
		if (a[i] !== b[i]) break;
		equalPrefix++;
	}
	if (equalPrefix === 0) return 0;
	return equalPrefix / Math.max(a.length, b.length);
}

function boundingBoxSimilarity(a: RefBoundingBox | undefined, b: RefBoundingBox | undefined): number {
	if (!a || !b) return 0;
	const centerAx = a.x + a.width / 2;
	const centerAy = a.y + a.height / 2;
	const centerBx = b.x + b.width / 2;
	const centerBy = b.y + b.height / 2;
	const distance = Math.hypot(centerAx - centerBx, centerAy - centerBy);
	const sizeNorm = Math.max(1, Math.max(a.width, a.height, b.width, b.height));
	const normalizedDistance = distance / sizeNorm;
	if (normalizedDistance <= 0.5) return 1;
	if (normalizedDistance <= 1.5) return 0.6;
	if (normalizedDistance <= 3) return 0.3;
	return 0;
}

function dedupeSelectors(selectors: ReadonlyArray<string> | undefined): string[] {
	const out = new Set<string>();
	for (const selector of selectors ?? []) {
		const trimmed = selector.trim();
		if (trimmed.length > 0) out.add(trimmed);
	}
	return [...out];
}

function scoreRefCandidate(locator: RefLocatorBundle, candidate: RefResolutionCandidate): ScoredRefResolutionCandidate {
	let score = 0;
	const reasons: string[] = [];

	const locatorSelectors = dedupeSelectors(locator.selectorCandidates);
	const candidateSelectors = dedupeSelectors(candidate.selectorCandidates);
	if (locatorSelectors.length > 0 && candidateSelectors.length > 0) {
		const selectorMatch = locatorSelectors.some((selector) => candidateSelectors.includes(selector));
		if (selectorMatch) {
			score += 0.36;
			reasons.push("selector");
		}
	}

	const semantic = locator.semantic;
	if (semantic?.role && semantic.role === candidate.role) {
		score += 0.16;
		reasons.push("role");
	}

	const nameScore = textMatchScore(semantic?.name, candidate.name);
	if (nameScore > 0) {
		score += nameScore * 0.14;
		reasons.push("name");
	}

	const textScore = textMatchScore(semantic?.text, candidate.text);
	if (textScore > 0) {
		score += textScore * 0.12;
		reasons.push("text");
	}

	const labelScore = textMatchScore(semantic?.label, candidate.label);
	if (labelScore > 0) {
		score += labelScore * 0.1;
		reasons.push("label");
	}

	if (locator.tagName && normalizeText(locator.tagName) === normalizeText(candidate.tagName)) {
		score += 0.05;
		reasons.push("tag");
	}

	const ordinalScore = numberListSimilarity(locator.ordinalPath, candidate.ordinalPath);
	if (ordinalScore > 0) {
		score += ordinalScore * 0.04;
		reasons.push("ordinal");
	}

	const bboxScore = boundingBoxSimilarity(locator.lastKnownBoundingBox, candidate.boundingBox);
	if (bboxScore > 0) {
		score += bboxScore * 0.03;
		reasons.push("box");
	}

	return {
		...candidate,
		score: Math.min(1, score),
		reasons,
	};
}

function normalizeStringMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!map) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(map)) {
		const normalizedKey = key.trim();
		if (!normalizedKey) continue;
		out[normalizedKey] = String(value);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeLocator(locator: RefLocatorBundle): RefLocatorBundle {
	return {
		selectorCandidates: dedupeSelectors(locator.selectorCandidates),
		semantic: locator.semantic
			? {
					role: locator.semantic.role,
					name: locator.semantic.name,
					text: locator.semantic.text,
					label: locator.semantic.label,
				}
			: undefined,
		tagName: locator.tagName,
		attributes: normalizeStringMap(locator.attributes),
		ordinalPath: locator.ordinalPath ? [...locator.ordinalPath] : undefined,
		lastKnownBoundingBox: locator.lastKnownBoundingBox ? { ...locator.lastKnownBoundingBox } : undefined,
	};
}

function scopeKey(tabId: number, frameId: number): string {
	return `${tabId}:${frameId}`;
}

export class RefMap {
	private readonly refs = new Map<string, RefEntry>();
	private readonly refsByScope = new Map<string, Set<string>>();
	private readonly navigationGenerations = new Map<number, number>();

	createRef(params: CreateRefParams): RefEntry {
		const createdAt = now();
		const ref: RefEntry = {
			refId: params.refId ?? randomRefId(),
			tabId: params.tabId,
			frameId: params.frameId,
			locator: normalizeLocator(params.locator),
			navigationGeneration: params.navigationGeneration ?? this.navigationGenerations.get(params.tabId),
			createdAt,
			updatedAt: createdAt,
		};
		this.refs.set(ref.refId, ref);
		const key = scopeKey(ref.tabId, ref.frameId);
		let refsForScope = this.refsByScope.get(key);
		if (!refsForScope) {
			refsForScope = new Set<string>();
			this.refsByScope.set(key, refsForScope);
		}
		refsForScope.add(ref.refId);
		return { ...ref, locator: normalizeLocator(ref.locator) };
	}

	getRef(refId: string): RefEntry | undefined {
		const ref = this.refs.get(refId);
		if (!ref) return undefined;
		return { ...ref, locator: normalizeLocator(ref.locator) };
	}

	listRefs(options: ListRefOptions = {}): RefEntry[] {
		return [...this.refs.values()]
			.filter((ref) => (typeof options.tabId === "number" ? ref.tabId === options.tabId : true))
			.filter((ref) => (typeof options.frameId === "number" ? ref.frameId === options.frameId : true))
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((ref) => ({ ...ref, locator: normalizeLocator(ref.locator) }));
	}

	invalidateFrame(tabId: number, frameId: number): number {
		const key = scopeKey(tabId, frameId);
		const refsForScope = this.refsByScope.get(key);
		if (!refsForScope || refsForScope.size === 0) return 0;
		let removed = 0;
		for (const refId of refsForScope) {
			if (this.refs.delete(refId)) removed++;
		}
		this.refsByScope.delete(key);
		return removed;
	}

	invalidateTab(tabId: number): number {
		let removed = 0;
		for (const [key, refIds] of [...this.refsByScope.entries()]) {
			if (!key.startsWith(`${tabId}:`)) continue;
			for (const refId of refIds) {
				if (this.refs.delete(refId)) removed++;
			}
			this.refsByScope.delete(key);
		}
		return removed;
	}

	invalidateOnNavigation(tabId: number, frameId?: number): number {
		this.markNavigated(tabId);
		if (typeof frameId === "number" && frameId !== 0) {
			return this.invalidateFrame(tabId, frameId);
		}
		return this.invalidateTab(tabId);
	}

	markNavigated(tabId: number): number {
		const nextGeneration = (this.navigationGenerations.get(tabId) ?? 0) + 1;
		this.navigationGenerations.set(tabId, nextGeneration);
		return nextGeneration;
	}

	resolveRef(
		refId: string,
		candidates: ReadonlyArray<RefResolutionCandidate>,
		options: ResolveRefOptions = {},
	): RefResolutionResult {
		const ref = this.refs.get(refId);
		if (!ref) {
			return {
				ok: false,
				reason: "missing_ref",
				message: `Reference ${refId} does not exist`,
			};
		}

		const currentNavigationGeneration =
			options.currentNavigationGeneration ?? this.navigationGenerations.get(ref.tabId);
		if (
			typeof ref.navigationGeneration === "number" &&
			typeof currentNavigationGeneration === "number" &&
			currentNavigationGeneration > ref.navigationGeneration
		) {
			return {
				ok: false,
				ref: { ...ref, locator: normalizeLocator(ref.locator) },
				reason: "stale_generation",
				message: `Reference ${refId} is stale after navigation`,
			};
		}

		const scopedCandidates = candidates.filter((candidate) => {
			return candidate.tabId === ref.tabId && candidate.frameId === ref.frameId;
		});

		if (scopedCandidates.length === 0) {
			const hasSameTabDifferentFrame = candidates.some((candidate) => candidate.tabId === ref.tabId);
			if (hasSameTabDifferentFrame) {
				return {
					ok: false,
					ref: { ...ref, locator: normalizeLocator(ref.locator) },
					reason: "frame_mismatch",
					message: `Reference ${refId} exists, but no candidates matched tab ${ref.tabId} frame ${ref.frameId}`,
				};
			}
			return {
				ok: false,
				ref: { ...ref, locator: normalizeLocator(ref.locator) },
				reason: "not_found",
				message: `Reference ${refId} target was not found`,
			};
		}

		const scored = scopedCandidates
			.map((candidate) => scoreRefCandidate(ref.locator, candidate))
			.sort((a, b) => b.score - a.score);

		const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
		const best = scored[0];
		if (best.score < minScore) {
			return {
				ok: false,
				ref: { ...ref, locator: normalizeLocator(ref.locator) },
				reason: "low_confidence",
				message: `Reference ${refId} produced only low-confidence matches`,
				candidates: scored.slice(0, 3),
			};
		}

		const ambiguousDelta = options.ambiguousDelta ?? DEFAULT_AMBIGUOUS_DELTA;
		const second = scored[1];
		if (second && best.score - second.score <= ambiguousDelta) {
			return {
				ok: false,
				ref: { ...ref, locator: normalizeLocator(ref.locator) },
				reason: "ambiguous_match",
				message: `Reference ${refId} matched multiple candidates with similar scores`,
				candidates: scored.slice(0, 3),
			};
		}

		const updatedRef: RefEntry = {
			...ref,
			updatedAt: now(),
		};
		this.refs.set(refId, updatedRef);
		return {
			ok: true,
			ref: { ...updatedRef, locator: normalizeLocator(updatedRef.locator) },
			match: best,
		};
	}
}

export function rankLocatorCandidates(
	candidates: ReadonlyArray<SemanticLocatorCandidate>,
	query: LocatorQuery,
	options: RankLocatorOptions = {},
): RankedLocatorCandidate[] {
	const minScore = options.minScore ?? 0.4;
	const scored: RankedLocatorCandidate[] = [];
	for (const candidate of candidates) {
		let score = 0;
		const reasons: string[] = [];

		if (query.kind === "role") {
			if (normalizeText(candidate.role) === normalizeText(query.value)) {
				score += 0.72;
				reasons.push("role");
			}
			const matchName = query.name ?? query.value;
			const candidateName = candidate.name ?? candidate.text;
			const nameScore = textMatchScore(matchName, candidateName);
			if (nameScore > 0) {
				score += nameScore * 0.28;
				reasons.push("name");
			}
		}

		if (query.kind === "text") {
			const textScore = Math.max(
				textMatchScore(query.value, candidate.text),
				textMatchScore(query.value, candidate.name),
				textMatchScore(query.value, candidate.label),
			);
			if (textScore > 0) {
				score += textScore * 0.9;
				reasons.push("text");
			}
			const attrText = candidate.attributes?.["aria-label"] ?? candidate.attributes?.placeholder;
			const attrScore = textMatchScore(query.value, attrText);
			if (attrScore > 0) {
				score += attrScore * 0.1;
				reasons.push("attr");
			}
		}

		if (query.kind === "label") {
			const labelScore = Math.max(
				textMatchScore(query.value, candidate.label),
				textMatchScore(query.value, candidate.name),
			);
			if (labelScore > 0) {
				score += labelScore * 0.9;
				reasons.push("label");
			}
			const placeholderScore = textMatchScore(query.value, candidate.attributes?.placeholder);
			if (placeholderScore > 0) {
				score += placeholderScore * 0.1;
				reasons.push("placeholder");
			}
		}

		if (score >= minScore) {
			scored.push({
				candidate,
				score: Math.min(1, score),
				reasons,
			});
		}
	}

	scored.sort((a, b) => b.score - a.score || a.candidate.candidateId.localeCompare(b.candidate.candidateId));
	if (typeof options.limit === "number") {
		return scored.slice(0, Math.max(0, options.limit));
	}
	return scored;
}
