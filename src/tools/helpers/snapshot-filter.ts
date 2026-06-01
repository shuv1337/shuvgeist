import { rankLocatorCandidates, type SemanticLocatorCandidate } from "./ref-map.js";

export interface SnapshotFilterEntry {
	snapshotId: string;
	stableElementId?: string;
	role?: string;
	name?: string;
	text?: string;
	label?: string;
	tagName?: string;
	attributes?: Record<string, string>;
}

export interface SnapshotFilterOptions {
	query?: string;
	limit?: number;
	minScore?: number;
}

export function filterSnapshotByKeywords<TEntry extends SnapshotFilterEntry, TSnapshot extends { entries: TEntry[] }>(
	snapshot: TSnapshot,
	options: SnapshotFilterOptions = {},
): TSnapshot {
	const query = options.query?.trim();
	if (!query) {
		return { ...snapshot, entries: [...snapshot.entries] };
	}

	const candidates: SemanticLocatorCandidate[] = snapshot.entries.map((entry) => ({
		candidateId: entry.snapshotId,
		role: entry.role,
		name: entry.name,
		text: entry.text,
		label: entry.label,
		tagName: entry.tagName,
		attributes: entry.attributes,
	}));
	const ranked = rankLocatorCandidates(
		candidates,
		{ kind: "text", value: query },
		{
			limit: options.limit,
			minScore: options.minScore,
		},
	);
	const selectedIds = new Set(ranked.map((match) => match.candidate.candidateId));
	return {
		...snapshot,
		entries: snapshot.entries.filter((entry) => selectedIds.has(entry.snapshotId)),
	};
}
