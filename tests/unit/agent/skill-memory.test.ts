import { buildSkillMemoryWrites } from "@shuvgeist/extension/agent/skill-memory";
import type { PlannerValidatorState } from "@shuvgeist/driver/planner-validator";

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
				noteId: "validator-note:0",
				note: "Clicked the compose button successfully.",
				toolName: "browserjs",
				turn: 1,
			},
		]);
	});

	it("assigns distinct stable IDs to notes created in the same batch", () => {
		const state = makeState({
			validatorNotes: [
				{ kind: "tool-result", message: "First result.", toolName: "navigate", turn: 1 },
				{ kind: "tool-result", message: "Second result.", toolName: "browserjs", turn: 1 },
			],
		});
		const options = {
			plannerValidator: state,
			skillNames: ["gmail"],
			sessionId: "session-1",
			createdAt: "2026-06-01T10:00:00.000Z",
		};

		const firstBuild = buildSkillMemoryWrites(options);
		const retryBuild = buildSkillMemoryWrites(options);

		expect(firstBuild.map((write) => write.noteId)).toEqual(["validator-note:0", "validator-note:1"]);
		expect(retryBuild).toEqual(firstBuild);
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
