import { filterSnapshotByKeywords } from "@shuvgeist/extension/tools/helpers/snapshot-filter";
import type { PageSnapshotResult } from "@shuvgeist/extension/tools/page-snapshot";

describe("snapshot-filter", () => {
	it("selects top keyword matches while preserving snapshot entry order", () => {
		const snapshot: PageSnapshotResult = {
			tabId: 1,
			frameId: 0,
			url: "https://example.test",
			title: "Example",
			generatedAt: 1,
			totalCandidates: 3,
			truncated: false,
			entries: [
				{
					snapshotId: "e1",
					tabId: 1,
					frameId: 0,
					tagName: "button",
					role: "button",
					name: "Save settings",
					text: "Save",
					attributes: {},
					selectorCandidates: ["#save"],
					ordinalPath: [0],
					boundingBox: { x: 0, y: 0, width: 10, height: 10 },
					interactive: true,
				},
				{
					snapshotId: "e2",
					tabId: 1,
					frameId: 0,
					tagName: "a",
					role: "link",
					name: "Advanced settings",
					text: "Advanced settings",
					attributes: {},
					selectorCandidates: ["a"],
					ordinalPath: [1],
					boundingBox: { x: 0, y: 20, width: 10, height: 10 },
					interactive: true,
				},
				{
					snapshotId: "e3",
					tabId: 1,
					frameId: 0,
					tagName: "button",
					role: "button",
					name: "Cancel",
					text: "Cancel",
					attributes: {},
					selectorCandidates: ["#cancel"],
					ordinalPath: [2],
					boundingBox: { x: 0, y: 40, width: 10, height: 10 },
					interactive: true,
				},
			],
		};

		const filtered = filterSnapshotByKeywords(snapshot, { query: "settings", limit: 2 });

		expect(filtered).not.toBe(snapshot);
		expect(filtered.entries.map((entry) => entry.snapshotId)).toEqual(["e1", "e2"]);
		expect(snapshot.entries.map((entry) => entry.snapshotId)).toEqual(["e1", "e2", "e3"]);
	});

	it("keeps ancestor entries for selected descendants", () => {
		const snapshot: PageSnapshotResult = {
			tabId: 1,
			frameId: 0,
			url: "https://example.test",
			title: "Example",
			generatedAt: 1,
			totalCandidates: 4,
			truncated: false,
			entries: [
				{
					snapshotId: "section",
					tabId: 1,
					frameId: 0,
					tagName: "section",
					role: "region",
					name: "Account",
					attributes: {},
					selectorCandidates: ["section"],
					ordinalPath: [0],
					boundingBox: { x: 0, y: 0, width: 300, height: 200 },
					interactive: false,
					landmark: "region",
				},
				{
					snapshotId: "save",
					tabId: 1,
					frameId: 0,
					tagName: "button",
					role: "button",
					name: "Save billing settings",
					text: "Save",
					attributes: {},
					selectorCandidates: ["#save"],
					ordinalPath: [0, 1],
					boundingBox: { x: 10, y: 20, width: 80, height: 30 },
					interactive: true,
				},
				{
					snapshotId: "cancel",
					tabId: 1,
					frameId: 0,
					tagName: "button",
					role: "button",
					name: "Cancel",
					text: "Cancel",
					attributes: {},
					selectorCandidates: ["#cancel"],
					ordinalPath: [1],
					boundingBox: { x: 10, y: 80, width: 80, height: 30 },
					interactive: true,
				},
			],
		};

		const filtered = filterSnapshotByKeywords(snapshot, { query: "billing", limit: 1 });

		expect(filtered.entries.map((entry) => entry.snapshotId)).toEqual(["section", "save"]);
	});

	it("preserves producer-accounted omission metadata after pre-cap query filtering", () => {
		const snapshot = {
			totalCandidates: 3,
			truncated: false,
			omissions: {
				total: 2,
				budgetOmitted: 0,
				queryFiltered: 2,
				byCategory: { "role:button": 2 },
				byRegion: { unscoped: 2 },
			},
			entries: [{ snapshotId: "e2", name: "Billing settings", ordinalPath: [1] }],
		};

		const filtered = filterSnapshotByKeywords(snapshot, { query: "billing", limit: 1 });

		expect(filtered.entries).toEqual(snapshot.entries);
		expect(filtered.omissions).toEqual(snapshot.omissions);
		expect(filtered.totalCandidates - filtered.entries.length).toBe(filtered.omissions.total);
	});
});
