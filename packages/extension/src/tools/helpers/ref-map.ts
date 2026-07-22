import {
	type LocatorQuery,
	type LocatorResolutionCandidate,
	type LocatorResolutionResult,
	type RankedLocatorCandidate,
	type RankLocatorOptions,
	type RefBoundingBox,
	type RefLocatorBundle,
	type RefSemanticLocator,
	type ResolveLocatorCandidatesOptions,
	rankLocatorCandidates,
	resolveLocatorCandidates,
	type ScoredLocatorResolutionCandidate,
	type SemanticLocatorCandidate,
} from "@shuvgeist/driver/locator-scoring";

export { rankLocatorCandidates, resolveLocatorCandidates };
export type {
	LocatorQuery,
	LocatorResolutionCandidate,
	LocatorResolutionResult,
	RankedLocatorCandidate,
	RankLocatorOptions,
	RefBoundingBox,
	RefLocatorBundle,
	RefSemanticLocator,
	ResolveLocatorCandidatesOptions,
	ScoredLocatorResolutionCandidate,
	SemanticLocatorCandidate,
};

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

export interface RefResolutionCandidate extends LocatorResolutionCandidate {
	tabId: number;
	frameId: number;
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

function now(): number {
	return Date.now();
}

function randomRefId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return `ref_${crypto.randomUUID()}`;
	}
	return `ref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function dedupeSelectors(selectors: ReadonlyArray<string> | undefined): string[] {
	const out = new Set<string>();
	for (const selector of selectors ?? []) {
		const trimmed = selector.trim();
		if (trimmed.length > 0) out.add(trimmed);
	}
	return [...out];
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

		const resolution = resolveLocatorCandidates(ref.locator, scopedCandidates, {
			minScore: options.minScore,
			ambiguousDelta: options.ambiguousDelta,
			subject: `Reference ${refId}`,
		});
		if (!resolution.ok) {
			return {
				ref: { ...ref, locator: normalizeLocator(ref.locator) },
				...resolution,
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
			match: resolution.match,
		};
	}
}
