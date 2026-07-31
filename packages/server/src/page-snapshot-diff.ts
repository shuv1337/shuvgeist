import { createHash } from "node:crypto";
import type { PageSnapshotBridgeResult } from "@shuvgeist/protocol/protocol";
import type { PageSnapshotCaptureSignature, PageSnapshotRecord } from "./page-snapshot-store.js";

type SnapshotEntry = PageSnapshotBridgeResult["entries"][number];

export type SnapshotDiffFailureReason =
	| "target_mismatch"
	| "frame_mismatch"
	| "navigation_generation_mismatch"
	| "capture_signature_missing"
	| "query_mismatch"
	| "budget_mismatch"
	| "truncated_snapshot"
	| "ambiguous_identity";

export interface SnapshotEntryState {
	stableElementId?: string;
	tagName: string;
	role?: string;
	name?: string;
	text?: string;
	label?: string;
	attributes: Record<string, string>;
	ordinalPath: number[];
	boundingBox: { x: number; y: number; width: number; height: number };
	interactive: boolean;
	headingLevel?: number;
	landmark?: string;
}

export interface SnapshotSemanticDiff {
	unchangedCount: number;
	added: Array<{ identity: string; refId: string; current: SnapshotEntry }>;
	changed: Array<{
		identity: string;
		refId: string;
		previous: SnapshotEntryState;
		current: SnapshotEntry;
	}>;
	removed: Array<{ identity: string; previous: SnapshotEntryState }>;
}

export type SnapshotDiffComparison =
	| { ok: false; reason: SnapshotDiffFailureReason; message: string }
	| { ok: true; diff: SnapshotSemanticDiff };

function targetIdentity(record: PageSnapshotRecord): string {
	const target = record.target;
	return target.kind === "chrome-tab"
		? `chrome:${target.tabId}`
		: `electron:${target.sessionId}:${target.windowRef}:${target.targetId}`;
}

function frameIdentity(record: PageSnapshotRecord): number {
	return record.frameId ?? record.target.frameId ?? 0;
}

function canonicalAttributes(attributes: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right)));
}

function entryIdentity(entry: SnapshotEntry): string {
	if (entry.stableElementId) return `stable:${entry.stableElementId}`;
	const semanticKey = JSON.stringify({
		tagName: entry.tagName,
		role: entry.role ?? "",
		name: entry.name ?? "",
		label: entry.label ?? "",
		id: entry.attributes.id ?? "",
		testId: entry.attributes["data-testid"] ?? "",
		controlName: entry.attributes.name ?? "",
		ordinalPath: entry.ordinalPath,
	});
	return `semantic:${createHash("sha256").update(semanticKey).digest("hex").slice(0, 24)}`;
}

function entryState(entry: SnapshotEntry): SnapshotEntryState {
	return {
		...(entry.stableElementId ? { stableElementId: entry.stableElementId } : {}),
		tagName: entry.tagName,
		...(entry.role ? { role: entry.role } : {}),
		...(entry.name ? { name: entry.name } : {}),
		...(entry.text ? { text: entry.text } : {}),
		...(entry.label ? { label: entry.label } : {}),
		attributes: canonicalAttributes(entry.attributes),
		ordinalPath: [...entry.ordinalPath],
		boundingBox: { ...entry.boundingBox },
		interactive: entry.interactive,
		...(typeof entry.headingLevel === "number" ? { headingLevel: entry.headingLevel } : {}),
		...(entry.landmark ? { landmark: entry.landmark } : {}),
	};
}

function captureBudget(signature: PageSnapshotCaptureSignature): string {
	return JSON.stringify({
		maxEntries: signature.maxEntries,
		includeHidden: signature.includeHidden,
	});
}

function indexEntries(entries: readonly SnapshotEntry[]): {
	entriesByIdentity: Map<string, SnapshotEntry>;
	duplicate?: string;
} {
	const entriesByIdentity = new Map<string, SnapshotEntry>();
	for (const entry of entries) {
		const identity = entryIdentity(entry);
		if (entriesByIdentity.has(identity)) return { entriesByIdentity, duplicate: identity };
		entriesByIdentity.set(identity, entry);
	}
	return { entriesByIdentity };
}

export function comparePageSnapshotRecords(
	baseline: PageSnapshotRecord,
	current: PageSnapshotRecord,
): SnapshotDiffComparison {
	if (targetIdentity(baseline) !== targetIdentity(current)) {
		return {
			ok: false,
			reason: "target_mismatch",
			message: "Snapshot baseline target does not match the current resolved target.",
		};
	}
	if (frameIdentity(baseline) !== frameIdentity(current)) {
		return {
			ok: false,
			reason: "frame_mismatch",
			message: `Snapshot baseline frame ${frameIdentity(baseline)} does not match current frame ${frameIdentity(current)}.`,
		};
	}
	if (baseline.navigationGeneration !== current.navigationGeneration) {
		return {
			ok: false,
			reason: "navigation_generation_mismatch",
			message: `Snapshot baseline generation ${baseline.navigationGeneration} does not match current generation ${current.navigationGeneration}.`,
		};
	}
	if (!baseline.capture || !current.capture) {
		return {
			ok: false,
			reason: "capture_signature_missing",
			message: "Snapshot baseline or current capture is missing its query and budget signature.",
		};
	}
	if ((baseline.capture.query ?? "") !== (current.capture.query ?? "")) {
		return {
			ok: false,
			reason: "query_mismatch",
			message: "Snapshot baseline query does not match the current query.",
		};
	}
	if (captureBudget(baseline.capture) !== captureBudget(current.capture)) {
		return {
			ok: false,
			reason: "budget_mismatch",
			message: "Snapshot baseline entry budget or hidden-element policy does not match the current capture.",
		};
	}
	if (baseline.raw.truncated || current.raw.truncated) {
		return {
			ok: false,
			reason: "truncated_snapshot",
			message: "Semantic diff requires untruncated baseline and current snapshots.",
		};
	}

	const baselineIndex = indexEntries(baseline.raw.entries);
	const currentIndex = indexEntries(current.raw.entries);
	const duplicate = baselineIndex.duplicate ?? currentIndex.duplicate;
	if (duplicate) {
		return {
			ok: false,
			reason: "ambiguous_identity",
			message: `Semantic identity '${duplicate}' occurs more than once in a snapshot.`,
		};
	}

	const identities = Array.from(
		new Set([...baselineIndex.entriesByIdentity.keys(), ...currentIndex.entriesByIdentity.keys()]),
	).sort();
	const diff: SnapshotSemanticDiff = { unchangedCount: 0, added: [], changed: [], removed: [] };
	for (const identity of identities) {
		const previous = baselineIndex.entriesByIdentity.get(identity);
		const currentEntry = currentIndex.entriesByIdentity.get(identity);
		if (!previous && currentEntry) {
			diff.added.push({ identity, refId: currentEntry.snapshotId, current: currentEntry });
			continue;
		}
		if (previous && !currentEntry) {
			diff.removed.push({ identity, previous: entryState(previous) });
			continue;
		}
		if (!previous || !currentEntry) continue;
		const previousState = entryState(previous);
		if (JSON.stringify(previousState) === JSON.stringify(entryState(currentEntry))) {
			diff.unchangedCount++;
			continue;
		}
		diff.changed.push({
			identity,
			refId: currentEntry.snapshotId,
			previous: previousState,
			current: currentEntry,
		});
	}
	return { ok: true, diff };
}
