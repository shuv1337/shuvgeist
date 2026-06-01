import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bridgeConfigPath } from "./electron/config.js";
import type { PageSnapshotBridgeResult } from "./protocol.js";
import type { BridgeTarget } from "./target.js";

export interface PageSnapshotRecord {
	id: string;
	capturedAt: string;
	target: BridgeTarget;
	tabId: number;
	frameId: number;
	url: string;
	title: string;
	query?: string;
	raw: PageSnapshotBridgeResult;
}

export interface PageSnapshotReadQuery {
	id?: string;
	tabId?: number;
	frameId?: number;
	limit?: number;
}

interface PageSnapshotStoreData {
	records: PageSnapshotRecord[];
}

export function pageSnapshotStorePath(): string {
	return process.env.SHUVGEIST_PAGE_SNAPSHOT_STORE || join(dirname(bridgeConfigPath()), "page-snapshots.json");
}

export class PageSnapshotStore {
	private records = new Map<string, PageSnapshotRecord>();

	constructor(private readonly path = pageSnapshotStorePath()) {
		this.load();
	}

	write(
		target: BridgeTarget,
		snapshot: PageSnapshotBridgeResult,
		capturedAt = new Date().toISOString(),
	): PageSnapshotRecord {
		const record: PageSnapshotRecord = {
			id: this.recordId(target, snapshot),
			capturedAt,
			target,
			tabId: snapshot.tabId,
			frameId: snapshot.frameId,
			url: snapshot.url,
			title: snapshot.title,
			query: snapshot.query,
			raw: snapshot,
		};
		this.records.set(record.id, record);
		this.persist();
		return record;
	}

	read(query: PageSnapshotReadQuery = {}): PageSnapshotRecord[] {
		if (query.id) {
			const record = this.records.get(query.id);
			return record ? [record] : [];
		}
		let records = Array.from(this.records.values());
		if (typeof query.tabId === "number") {
			records = records.filter((record) => record.tabId === query.tabId);
		}
		if (typeof query.frameId === "number") {
			records = records.filter((record) => record.frameId === query.frameId);
		}
		records.sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
		return typeof query.limit === "number" ? records.slice(0, query.limit) : records;
	}

	clear(): void {
		this.records.clear();
		this.persist();
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as PageSnapshotStoreData;
		if (!Array.isArray(parsed.records)) return;
		for (const record of parsed.records) {
			this.records.set(record.id, record);
		}
	}

	private persist(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify({ records: Array.from(this.records.values()) }, null, 2) + "\n");
	}

	private recordId(target: BridgeTarget, snapshot: PageSnapshotBridgeResult): string {
		const targetPart =
			target.kind === "electron-window"
				? `electron:${target.sessionId ?? "unknown"}:${target.windowRef ?? target.targetId ?? "window"}`
				: `chrome:${target.tabRef ?? target.tabId ?? "active"}:${snapshot.tabId}`;
		return `${targetPart}:frame:${snapshot.frameId}:snapshot:${snapshot.generatedAt}`;
	}
}
