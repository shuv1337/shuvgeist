import type { PlannerValidatorState } from "./planner-validator.js";

export interface SkillMemoryWriteInput {
	skillName: string;
	sessionId?: string;
	createdAt: string;
	note: string;
	toolName?: string;
	turn?: number;
}

export function buildSkillMemoryWrites(options: {
	plannerValidator: PlannerValidatorState | undefined;
	skillNames: Iterable<string>;
	sessionId?: string;
	createdAt?: string;
	fromNoteIndex?: number;
}): SkillMemoryWriteInput[] {
	const state = options.plannerValidator;
	if (!state || state.driftDetected) return [];

	const skillNames = [...new Set([...options.skillNames].filter((name) => name.trim().length > 0))];
	if (skillNames.length === 0) return [];

	const createdAt = options.createdAt ?? new Date().toISOString();
	const notes = state.validatorNotes
		.slice(options.fromNoteIndex ?? 0)
		.filter((note) => note.message.trim().length > 0);

	return skillNames.flatMap((skillName) =>
		notes.map((note) => ({
			skillName,
			sessionId: options.sessionId,
			createdAt,
			note: note.message,
			toolName: note.toolName,
			turn: note.turn,
		})),
	);
}
