import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PageSnapshotStore, pageSnapshotStorePath } from "@shuvgeist/server/page-snapshot-store";
import type { PageSnapshotBridgeResult } from "@shuvgeist/protocol/protocol";
import type { BridgeTarget } from "@shuvgeist/protocol/target";

function createSnapshot(overrides: Partial<PageSnapshotBridgeResult> = {}): PageSnapshotBridgeResult {
	return {
		target: { kind: "chrome-tab", tabId: 7, frameId: 0 },
		navigationGeneration: 1,
		tabId: 7,
		frameId: 0,
		url: "https://example.test/settings",
		title: "Settings",
		generatedAt: 12345,
		totalCandidates: 1,
		truncated: false,
		entries: [
			{
				snapshotId: "snapshot-entry-1",
				tabId: 7,
				frameId: 0,
				tagName: "button",
				role: "button",
				name: "Save",
				text: "Save",
				label: "Save changes",
				attributes: { id: "save" },
				selectorCandidates: ["#save"],
				ordinalPath: [0],
				boundingBox: { x: 1, y: 2, width: 40, height: 20 },
				interactive: true,
			},
		],
		...overrides,
	};
}

describe("PageSnapshotStore", () => {
	it("derives its default path from the injected Node config owner", () => {
		expect(
			pageSnapshotStorePath(
				{ paths: { bridge: "/custom/state/alternate.json", discovery: "/custom/state/discovery.json" } },
				{},
			),
		).toBe("/custom/state/page-snapshots.json");
		expect(
			pageSnapshotStorePath(
				{ paths: { bridge: "/ignored/bridge.json", discovery: "/ignored/config.json" } },
				{ SHUVGEIST_PAGE_SNAPSHOT_STORE: "/explicit/snapshots.json" },
			),
		).toBe("/explicit/snapshots.json");
	});

	it("persists and reloads raw page snapshot records", () => {
		const dir = mkdtempSync(join(tmpdir(), "shuvgeist-page-snapshot-store-"));
		const path = join(dir, "snapshots.json");
		const target: BridgeTarget = { kind: "chrome-tab", tabId: 7 };

		try {
			const store = new PageSnapshotStore(path);
			const snapshot = createSnapshot({ query: "button" });
			const record = store.write(target, snapshot, "2026-06-01T10:00:00.000Z");

			expect(record).toMatchObject({
				id: "chrome:7:frame:0:generation:1:snapshot:12345",
				target: { ...target, frameId: 0 },
				navigationGeneration: 1,
				tabId: 7,
				frameId: 0,
				url: "https://example.test/settings",
				title: "Settings",
				query: "button",
			});
			expect(record.raw).toBe(snapshot);

			const reloaded = new PageSnapshotStore(path);
			expect(reloaded.read({ id: record.id })).toEqual([record]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("filters records by tab, frame, and limit with newest first", () => {
		const dir = mkdtempSync(join(tmpdir(), "shuvgeist-page-snapshot-store-"));
		const path = join(dir, "snapshots.json");

		try {
			const store = new PageSnapshotStore(path);
			store.write(
				{ kind: "chrome-tab", tabId: 3 },
				createSnapshot({
					target: { kind: "chrome-tab", tabId: 3, frameId: 0 },
					tabId: 3,
					generatedAt: 1,
				}),
				"2026-06-01T10:00:00.000Z",
			);
			const newer = store.write(
				{ kind: "chrome-tab", tabId: 3, frameId: 2 },
				createSnapshot({
					target: { kind: "chrome-tab", tabId: 3, frameId: 2 },
					navigationGeneration: 2,
					tabId: 3,
					frameId: 2,
					generatedAt: 2,
				}),
				"2026-06-01T10:01:00.000Z",
			);
			store.write(
				{ kind: "electron-window", sessionId: "e1", windowRef: "w1" },
				createSnapshot({
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w1", targetId: "renderer-1" },
					navigationGeneration: 3,
					tabId: undefined,
					frameId: undefined,
					generatedAt: 3,
				}),
				"2026-06-01T10:02:00.000Z",
			);

			expect(store.read({ tabId: 3, limit: 1 })).toEqual([newer]);
			expect(store.read({ tabId: 3, frameId: 2 })).toEqual([newer]);
			expect(store.read({ snapshotId: "snapshot-entry-1" }).map((record) => record.id)).toEqual([
				"electron:e1:w1:renderer-1:frame:0:generation:3:snapshot:3",
				"chrome:3:frame:2:generation:2:snapshot:2",
				"chrome:3:frame:0:generation:1:snapshot:1",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
