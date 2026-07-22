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

export interface LocatorResolutionCandidate {
	candidateId: string;
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

export type ScoredLocatorResolutionCandidate<
	TCandidate extends LocatorResolutionCandidate = LocatorResolutionCandidate,
> = TCandidate & {
	score: number;
	reasons: string[];
};

export type LocatorResolutionResult<TCandidate extends LocatorResolutionCandidate = LocatorResolutionCandidate> =
	| {
			ok: true;
			match: ScoredLocatorResolutionCandidate<TCandidate>;
	  }
	| {
			ok: false;
			reason: "not_found" | "ambiguous_match" | "low_confidence";
			message: string;
			candidates?: ScoredLocatorResolutionCandidate<TCandidate>[];
	  };

export interface ResolveLocatorCandidatesOptions {
	minScore?: number;
	ambiguousDelta?: number;
	subject?: string;
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

function isStrongSelectorSignal(selector: string): boolean {
	const stablePrefix = "shuvgeist-stable-id:";
	return (
		(selector.startsWith(stablePrefix) && !selector.slice(stablePrefix.length).startsWith("sg-")) ||
		selector.startsWith("#") ||
		selector.includes("[data-testid=") ||
		selector.includes("[name=")
	);
}

function scoreRefCandidate<TCandidate extends LocatorResolutionCandidate>(
	locator: RefLocatorBundle,
	candidate: TCandidate,
): ScoredLocatorResolutionCandidate<TCandidate> {
	let score = 0;
	const reasons: string[] = [];

	const locatorSelectors = dedupeSelectors(locator.selectorCandidates);
	const candidateSelectors = dedupeSelectors(candidate.selectorCandidates);
	if (locatorSelectors.length > 0 && candidateSelectors.length > 0) {
		const matchingSelectors = locatorSelectors.filter((selector) => candidateSelectors.includes(selector));
		if (matchingSelectors.length > 0) {
			// Generic tag/class/nth selectors are useful corroboration, but cannot
			// outweigh a complete semantic mismatch on their own. Stable ids and
			// explicit id/test/name selectors retain the stronger anchor weight.
			score += matchingSelectors.some(isStrongSelectorSignal) ? 0.36 : 0.28;
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

/** Target-neutral fail-closed matching shared by browser and host drivers. */
export function resolveLocatorCandidates<TCandidate extends LocatorResolutionCandidate>(
	locator: RefLocatorBundle,
	candidates: ReadonlyArray<TCandidate>,
	options: ResolveLocatorCandidatesOptions = {},
): LocatorResolutionResult<TCandidate> {
	const subject = options.subject ?? "Reference";
	if (candidates.length === 0) {
		return { ok: false, reason: "not_found", message: `${subject} target was not found` };
	}

	const scored = candidates
		.map((candidate) => scoreRefCandidate(locator, candidate))
		.sort((a, b) => b.score - a.score);
	const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
	const best = scored[0];
	if (best.score < minScore) {
		return {
			ok: false,
			reason: "low_confidence",
			message: `${subject} produced only low-confidence matches`,
			candidates: scored.slice(0, 3),
		};
	}

	const ambiguousDelta = options.ambiguousDelta ?? DEFAULT_AMBIGUOUS_DELTA;
	const second = scored[1];
	if (second && best.score - second.score <= ambiguousDelta) {
		return {
			ok: false,
			reason: "ambiguous_match",
			message: `${subject} matched multiple candidates with similar scores`,
			candidates: scored.slice(0, 3),
		};
	}

	return { ok: true, match: best };
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
