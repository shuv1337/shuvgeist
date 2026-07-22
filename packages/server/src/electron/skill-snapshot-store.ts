import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type BridgeSkillSnapshot,
	type BridgeSkillSnapshotStatus,
	getBridgeSkillSnapshotStatus,
	parseBridgeSkillSnapshot,
} from "@shuvgeist/protocol/skill-snapshot";
import { createNodeConfigOwner, type NodeConfigOwner } from "../node-config.js";

function snapshotPath(source?: NodeConfigOwner | string): string {
	if (typeof source === "string") return source;
	const owner = source ?? createNodeConfigOwner();
	return process.env.SHUVGEIST_SKILL_SNAPSHOT || join(dirname(owner.paths.bridge), "skills.snapshot.json");
}

export function skillSnapshotPath(owner: NodeConfigOwner = createNodeConfigOwner()): string {
	return snapshotPath(owner);
}

export function readSkillSnapshot(source?: NodeConfigOwner | string): {
	snapshot: BridgeSkillSnapshot | null;
	status: BridgeSkillSnapshotStatus;
} {
	const path = snapshotPath(source);
	if (!existsSync(path)) {
		return { snapshot: null, status: getBridgeSkillSnapshotStatus(null) };
	}
	try {
		const snapshot = parseBridgeSkillSnapshot(JSON.parse(readFileSync(path, "utf-8")) as unknown);
		return { snapshot, status: getBridgeSkillSnapshotStatus(snapshot) };
	} catch (error) {
		return {
			snapshot: null,
			status: {
				state: "invalid",
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}
}

export function writeSkillSnapshot(
	snapshot: BridgeSkillSnapshot,
	source?: NodeConfigOwner | string,
): BridgeSkillSnapshotStatus {
	const path = snapshotPath(source);
	const parsed = parseBridgeSkillSnapshot(snapshot);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");
	return getBridgeSkillSnapshotStatus(parsed);
}
