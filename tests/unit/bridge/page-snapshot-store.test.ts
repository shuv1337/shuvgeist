import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PageSnapshotStore } from "../../../src/bridge/page-snapshot-store.js";
import type { PageSnapshotBridgeResult } from "../../../src/bridge/protocol.js";
import type { BridgeTarget } from "../../../src/bridge/target.js";

function createSnapshot(overrides: Partial<PageSnapshotBridgeResult> = {}): PageSnapshotBridgeResult {
	return {
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
	it("persists and reloads raw page snapshot records", () => {
		const dir = mkdtempSync(join(tmpdir(), "shuvgeist-page-snapshot-store-"));
		const path = join(dir, "snapshots.json");
		const target: BridgeTarget = { kind: "chrome-tab", tabId: 7 };

		try {
			const store = new PageSnapshotStore(path);
			const snapshot = createSnapshot({ query: "button" });
			const record = store.write(target, snapshot, "2026-06-01T10:00:00.000Z");

			expect(record).toMatchObject({
				id: "chrome:7:7:frame:0:snapshot:12345",
				target,
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
			store.write({ kind: "chrome-tab", tabId: 3 }, createSnapshot({ tabId: 3, generatedAt: 1 }), "2026-06-01T10:00:00.000Z");
			const newer = store.write(
				{ kind: "chrome-tab", tabId: 3, frameId: 2 },
				createSnapshot({ tabId: 3, frameId: 2, generatedAt: 2 }),
				"2026-06-01T10:01:00.000Z",
			);
			store.write({ kind: "electron-window", sessionId: "e1", windowRef: "w1" }, createSnapshot({ tabId: 9, generatedAt: 3 }), "2026-06-01T10:02:00.000Z");

			expect(store.read({ tabId: 3, limit: 1 })).toEqual([newer]);
			expect(store.read({ tabId: 3, frameId: 2 })).toEqual([newer]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
