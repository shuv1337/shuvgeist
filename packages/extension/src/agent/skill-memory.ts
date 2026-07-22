import type { PlannerValidatorState } from "@shuvgeist/driver/planner-validator";

export interface SkillMemoryWriteInput {
	skillName: string;
	sessionId?: string;
	createdAt: string;
	noteId: string;
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
	const fromNoteIndex = options.fromNoteIndex ?? 0;
	const notes = state.validatorNotes
		.slice(fromNoteIndex)
		.map((note, index) => ({ note, noteIndex: fromNoteIndex + index }))
		.filter(({ note }) => note.message.trim().length > 0);

	return skillNames.flatMap((skillName) =>
		notes.map(({ note, noteIndex }) => ({
			skillName,
			sessionId: options.sessionId,
			createdAt,
			noteId: `validator-note:${noteIndex}`,
			note: note.message,
			toolName: note.toolName,
			turn: note.turn,
		})),
	);
}
