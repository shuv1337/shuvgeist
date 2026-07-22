import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	type BridgeSkillSnapshotSource,
	createBridgeSkillSnapshot,
	getBridgeSkillSnapshotStatus,
	matchSnapshotSkillsForApp,
	parseBridgeSkillSnapshot,
} from "@shuvgeist/protocol/skill-snapshot";

const skill: BridgeSkillSnapshotSource = {
	name: "vscode-helper",
	domainPatterns: [],
	appPatterns: ["vscode"],
	shortDescription: "short",
	description: "description",
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

	it("depends only on its structural source DTO", () => {
		const source = readFileSync(resolve(process.cwd(), "packages/protocol/src/skill-snapshot.ts"), "utf8");
		expect(source).not.toContain("storage/stores/skills-store");
		expect(createBridgeSkillSnapshot([{ ...skill, domainPatterns: undefined }]).skills[0]?.domainPatterns).toEqual(
			[],
		);
	});

	it("reports stale snapshots", () => {
		const snapshot = createBridgeSkillSnapshot([skill], new Date("2026-05-17T01:00:00.000Z"));
		expect(getBridgeSkillSnapshotStatus(snapshot, Date.parse("2026-05-19T02:00:00.000Z"))).toMatchObject({
			state: "stale",
			skillCount: 1,
		});
	});
});
