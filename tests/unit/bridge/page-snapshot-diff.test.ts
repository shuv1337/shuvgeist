import {
	comparePageSnapshotRecords,
	type SnapshotDiffFailureReason,
} from "@shuvgeist/server/page-snapshot-diff";
import type { PageSnapshotRecord } from "@shuvgeist/server/page-snapshot-store";
import type { PageSnapshotBridgeResult } from "@shuvgeist/protocol/protocol";

type SnapshotEntry = PageSnapshotBridgeResult["entries"][number];

function entry(stableElementId: string, snapshotId: string, overrides: Partial<SnapshotEntry> = {}): SnapshotEntry {
	return {
		snapshotId,
		stableElementId,
		frameId: 0,
		tagName: "button",
		role: "button",
		name: "Save",
		attributes: {},
		selectorCandidates: ["button"],
		ordinalPath: [0],
		boundingBox: { x: 0, y: 0, width: 100, height: 30 },
		interactive: true,
		...overrides,
	};
}

function record(overrides: Partial<PageSnapshotRecord> = {}): PageSnapshotRecord {
	const raw: PageSnapshotBridgeResult = {
		target: { kind: "chrome-tab", tabId: 7, frameId: 0 },
		navigationGeneration: 3,
		tabId: 7,
		frameId: 0,
		url: "https://example.test/settings",
		title: "Settings",
		generatedAt: 100,
		totalCandidates: 1,
		truncated: false,
		entries: [entry("save", "baseline:ref1")],
	};
	return {
		id: "baseline",
		capturedAt: "2026-07-31T12:00:00.000Z",
		target: raw.target,
		navigationGeneration: raw.navigationGeneration,
		tabId: 7,
		frameId: 0,
		url: raw.url,
		title: raw.title,
		capture: { maxEntries: 120, includeHidden: false },
		raw,
		...overrides,
	};
}

function expectFailure(
	baseline: PageSnapshotRecord,
	current: PageSnapshotRecord,
	reason: SnapshotDiffFailureReason,
): void {
	expect(comparePageSnapshotRecords(baseline, current)).toMatchObject({ ok: false, reason });
}

describe("target-safe semantic snapshot diffs", () => {
	it("returns deterministic added, changed, removed, and unchanged entries with only current refs", () => {
		const baseline = record({
			raw: {
				...record().raw,
				totalCandidates: 3,
				entries: [
					entry("unchanged", "old:ref1", { name: "Stable" }),
					entry("changed", "old:ref2", { name: "Before" }),
					entry("removed", "old:ref3", { name: "Gone" }),
				],
			},
		});
		const current = record({
			id: "current",
			raw: {
				...record().raw,
				generatedAt: 200,
				totalCandidates: 3,
				entries: [
					entry("added", "new:ref3", { name: "New" }),
					entry("changed", "new:ref2", { name: "After" }),
					entry("unchanged", "new:ref1", { name: "Stable" }),
				],
			},
		});

		const first = comparePageSnapshotRecords(baseline, current);
		const second = comparePageSnapshotRecords(baseline, current);
		expect(second).toEqual(first);
		expect(first).toMatchObject({
			ok: true,
			diff: {
				unchangedCount: 1,
				added: [{ identity: "stable:added", refId: "new:ref3" }],
				changed: [{ identity: "stable:changed", refId: "new:ref2", current: { snapshotId: "new:ref2" } }],
				removed: [{ identity: "stable:removed", previous: { name: "Gone" } }],
			},
		});
		if (!first.ok) throw new Error(first.message);
		expect(JSON.stringify(first.diff.removed)).not.toContain("snapshotId");
		expect(JSON.stringify(first.diff.changed.map((change) => change.previous))).not.toContain("snapshotId");
	});

	it("fails closed across target, frame, navigation, query, budget, and truncation changes", () => {
		const baseline = record();
		expectFailure(
			baseline,
			record({
				target: { kind: "chrome-tab", tabId: 8, frameId: 0 },
				raw: { ...record().raw, target: { kind: "chrome-tab", tabId: 8, frameId: 0 }, tabId: 8 },
			}),
			"target_mismatch",
		);
		expectFailure(
			baseline,
			record({
				frameId: 1,
				target: { kind: "chrome-tab", tabId: 7, frameId: 1 },
				raw: { ...record().raw, target: { kind: "chrome-tab", tabId: 7, frameId: 1 }, frameId: 1 },
			}),
			"frame_mismatch",
		);
		expectFailure(
			baseline,
			record({ navigationGeneration: 4, raw: { ...record().raw, navigationGeneration: 4 } }),
			"navigation_generation_mismatch",
		);
		expectFailure(
			{ ...baseline, capture: { maxEntries: 120, includeHidden: false, query: "save" } },
			record({ capture: { maxEntries: 120, includeHidden: false, query: "cancel" } }),
			"query_mismatch",
		);
		expectFailure(
			baseline,
			record({ capture: { maxEntries: 25, includeHidden: false } }),
			"budget_mismatch",
		);
		expectFailure(
			baseline,
			record({ raw: { ...record().raw, truncated: true } }),
			"truncated_snapshot",
		);
	});

	it("fails closed when stable semantic identity is ambiguous", () => {
		const duplicate = entry("duplicate", "current:ref2");
		expectFailure(
			record(),
			record({ raw: { ...record().raw, entries: [entry("duplicate", "current:ref1"), duplicate] } }),
			"ambiguous_identity",
		);
	});

	it("reports a fully unchanged snapshot without reminting baseline refs", () => {
		const baseline = record();
		const current = record({
			id: "current",
			raw: { ...record().raw, generatedAt: 200, entries: [entry("save", "current:ref1")] },
		});
		expect(comparePageSnapshotRecords(baseline, current)).toEqual({
			ok: true,
			diff: { unchangedCount: 1, added: [], changed: [], removed: [] },
		});
	});
});
