import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type BridgeSkillSnapshot,
	type BridgeSkillSnapshotStatus,
	getBridgeSkillSnapshotStatus,
	parseBridgeSkillSnapshot,
} from "../skill-snapshot.js";
import { bridgeConfigPath } from "./config.js";

export function skillSnapshotPath(): string {
	return process.env.SHUVGEIST_SKILL_SNAPSHOT || join(dirname(bridgeConfigPath()), "skills.snapshot.json");
}

export function readSkillSnapshot(path = skillSnapshotPath()): {
	snapshot: BridgeSkillSnapshot | null;
	status: BridgeSkillSnapshotStatus;
} {
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
	path = skillSnapshotPath(),
): BridgeSkillSnapshotStatus {
	const parsed = parseBridgeSkillSnapshot(snapshot);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");
	return getBridgeSkillSnapshotStatus(parsed);
}
