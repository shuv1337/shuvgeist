import type { SnapshotInjectionEntry, SnapshotInjectionResult } from "./injected/contracts.js";

const CONTENTEDITABLE_VALUES = new Set(["", "true", "plaintext-only"]);

export function isEditableSnapshotEntry(entry: SnapshotInjectionEntry): boolean {
	const value = entry.attributes.contenteditable;
	return typeof value === "string" && CONTENTEDITABLE_VALUES.has(value.trim().toLowerCase());
}

export function normalizeSnapshotEntry(entry: SnapshotInjectionEntry): SnapshotInjectionEntry {
	const editable = isEditableSnapshotEntry(entry);
	return {
		...entry,
		role: entry.role || (editable ? "textbox" : undefined),
		interactive: entry.interactive || editable,
		attributes: { ...entry.attributes },
		selectorCandidates: [...entry.selectorCandidates],
		ordinalPath: [...entry.ordinalPath],
		boundingBox: { ...entry.boundingBox },
	};
}

export function normalizeSnapshotResult(snapshot: SnapshotInjectionResult): SnapshotInjectionResult {
	return {
		...snapshot,
		...(snapshot.omissions
			? {
					omissions: {
						...snapshot.omissions,
						byCategory: { ...snapshot.omissions.byCategory },
						byRegion: { ...snapshot.omissions.byRegion },
					},
				}
			: {}),
		entries: snapshot.entries.map(normalizeSnapshotEntry),
	};
}
