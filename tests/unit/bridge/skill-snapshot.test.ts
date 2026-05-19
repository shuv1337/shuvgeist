import {
	createBridgeSkillSnapshot,
	getBridgeSkillSnapshotStatus,
	matchSnapshotSkillsForApp,
	parseBridgeSkillSnapshot,
} from "../../../src/bridge/skill-snapshot.js";
import type { Skill } from "../../../src/storage/stores/skills-store.js";

const skill: Skill = {
	name: "vscode-helper",
	domainPatterns: [],
	appPatterns: ["vscode"],
	shortDescription: "short",
	description: "description",
	createdAt: "2026-05-19T00:00:00.000Z",
	lastUpdated: "2026-05-19T00:00:00.000Z",
	examples: "",
	library: "globalThis.__skill = true;",
};

describe("bridge skill snapshot", () => {
	it("creates and validates bridge-readable snapshots", () => {
		const snapshot = createBridgeSkillSnapshot([skill], new Date("2026-05-19T01:00:00.000Z"));
		expect(parseBridgeSkillSnapshot(snapshot)).toEqual(snapshot);
		expect(matchSnapshotSkillsForApp(snapshot, ["com.microsoft.VSCode"]).map((match) => match.name)).toEqual([
			"vscode-helper",
		]);
	});

	it("reports stale snapshots", () => {
		const snapshot = createBridgeSkillSnapshot([skill], new Date("2026-05-17T01:00:00.000Z"));
		expect(getBridgeSkillSnapshotStatus(snapshot, Date.parse("2026-05-19T02:00:00.000Z"))).toMatchObject({
			state: "stale",
			skillCount: 1,
		});
	});
});
