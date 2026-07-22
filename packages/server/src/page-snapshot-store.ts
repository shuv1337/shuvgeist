import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedPageTarget } from "@shuvgeist/protocol/command-schemas";
import type { PageSnapshotBridgeResult } from "@shuvgeist/protocol/protocol";
import type { BridgeTarget } from "@shuvgeist/protocol/target";
import { createNodeConfigOwner, type NodeConfigOwner } from "./node-config.js";

export interface PageSnapshotRecord {
	id: string;
	capturedAt: string;
	target: ResolvedPageTarget;
	navigationGeneration: number;
	tabId?: number;
	frameId?: number;
	url: string;
	title: string;
	query?: string;
	raw: PageSnapshotBridgeResult;
}

export interface PageSnapshotReadQuery {
	id?: string;
	snapshotId?: string;
	tabId?: number;
	frameId?: number;
	limit?: number;
}

interface PageSnapshotStoreData {
	records: PageSnapshotRecord[];
}

export function pageSnapshotStorePath(
	owner: Pick<NodeConfigOwner, "paths"> = createNodeConfigOwner(),
	environment: { SHUVGEIST_PAGE_SNAPSHOT_STORE?: string } = process.env,
): string {
	return environment.SHUVGEIST_PAGE_SNAPSHOT_STORE || join(dirname(owner.paths.bridge), "page-snapshots.json");
}

export class PageSnapshotStore {
	private records = new Map<string, PageSnapshotRecord>();

	constructor(private readonly path = pageSnapshotStorePath()) {
		this.load();
	}

	write(
		_target: BridgeTarget,
		snapshot: PageSnapshotBridgeResult,
		capturedAt = new Date().toISOString(),
	): PageSnapshotRecord {
		const record: PageSnapshotRecord = {
			id: this.recordId(snapshot),
			capturedAt,
			target: snapshot.target,
			navigationGeneration: snapshot.navigationGeneration,
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
		if (query.snapshotId) {
			records = records.filter((record) =>
				record.raw.entries.some((entry) => entry.snapshotId === query.snapshotId),
			);
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

	private recordId(snapshot: PageSnapshotBridgeResult): string {
		const target = snapshot.target;
		const targetPart =
			target.kind === "electron-window"
				? `electron:${target.sessionId}:${target.windowRef}:${target.targetId}`
				: `chrome:${target.tabId}`;
		return `${targetPart}:frame:${snapshot.frameId ?? target.frameId ?? 0}:generation:${snapshot.navigationGeneration}:snapshot:${snapshot.generatedAt}`;
	}
}
