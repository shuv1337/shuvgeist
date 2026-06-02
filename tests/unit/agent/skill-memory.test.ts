import { buildSkillMemoryWrites } from "../../../src/agent/skill-memory.js";
import type { PlannerValidatorState } from "../../../src/agent/planner-validator.js";

function makeState(overrides: Partial<PlannerValidatorState> = {}): PlannerValidatorState {
	return {
		turns: 1,
		toolCalls: 1,
		driftDetected: false,
		validatorNotes: [
			{
				kind: "tool-result",
				message: "Clicked the compose button successfully.",
				toolName: "browserjs",
				turn: 1,
			},
		],
		...overrides,
	};
}

describe("buildSkillMemoryWrites", () => {
	it("creates writes for successful validator notes keyed to shown skills", () => {
		expect(
			buildSkillMemoryWrites({
				plannerValidator: makeState(),
				skillNames: ["gmail", "gmail"],
				sessionId: "session-1",
				createdAt: "2026-06-01T10:00:00.000Z",
			}),
		).toEqual([
			{
				skillName: "gmail",
				sessionId: "session-1",
				createdAt: "2026-06-01T10:00:00.000Z",
				note: "Clicked the compose button successfully.",
				toolName: "browserjs",
				turn: 1,
			},
		]);
	});

	it("does not store drifted trajectories", () => {
		expect(
			buildSkillMemoryWrites({
				plannerValidator: makeState({ driftDetected: true }),
				skillNames: ["gmail"],
			}),
		).toEqual([]);
	});

	it("can resume after already persisted notes", () => {
		expect(
			buildSkillMemoryWrites({
				plannerValidator: makeState(),
				skillNames: ["gmail"],
				fromNoteIndex: 1,
			}),
		).toEqual([]);
	});
});
