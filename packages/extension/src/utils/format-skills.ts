import type { Skill } from "../storage/stores/skills-store.js";
import { ShownSkillsState } from "./shown-skills.js";

export interface SkillMemoryContext {
	note: string;
	createdAt: string;
	source?: string;
}

export type SkillMemoryLookup = (skill: Skill) => Promise<SkillMemoryContext[]> | SkillMemoryContext[];

export interface FormatSkillsOptions {
	getMemoriesForSkill?: SkillMemoryLookup;
	shownSkillsState?: ShownSkillsState;
}

export interface FormattedSkills {
	newOrUpdated: Skill[];
	unchanged: Skill[];
	formattedText: string;
}

/**
 * Formats skills for display, tracking which have been shown before.
 * Returns full details for new/updated skills, short form for previously seen skills.
 */
export async function formatSkills(skills: Skill[], options: FormatSkillsOptions = {}): Promise<FormattedSkills> {
	const shownSkillsState = options.shownSkillsState ?? new ShownSkillsState();

	// Separate into new/updated vs already shown
	const newOrUpdated = skills.filter((s) => {
		const lastShown = shownSkillsState.get(s.name);
		return !lastShown || s.lastUpdated > lastShown;
	});

	const unchanged = skills.filter((s) => {
		const lastShown = shownSkillsState.get(s.name);
		return lastShown && s.lastUpdated <= lastShown;
	});

	// Mark new/updated as shown
	newOrUpdated.forEach((s) => {
		shownSkillsState.set(s.name, s.lastUpdated);
	});

	// Build formatted text
	let formattedText = "";

	if (newOrUpdated.length > 0) {
		formattedText += "New/Updated Skills (full details):\n";
		const skillBlocks = await Promise.all(
			newOrUpdated.map(async (s) => {
				const memories = await options.getMemoriesForSkill?.(s);
				return `
<skill>
${s.name}
Domain Patterns: ${s.domainPatterns.join(", ")}
${s.description}
${formatSkillMemories(memories)}
## Examples
\`\`\`javascript
${s.examples}
\`\`\`
</skill>
`;
			}),
		);
		formattedText += skillBlocks.join("\n---\n");
	}

	if (unchanged.length > 0) {
		if (newOrUpdated.length > 0) formattedText += "\n\n";
		formattedText += "\n\nPreviously Seen Skills:\n";
		formattedText += unchanged.map((s) => `- ${s.name}: ${s.shortDescription}`).join("\n");
	}

	if (skills.length === 0) {
		formattedText = "none found";
	}

	return {
		newOrUpdated,
		unchanged,
		formattedText,
	};
}

function formatSkillMemories(memories: SkillMemoryContext[] | undefined): string {
	if (!memories || memories.length === 0) return "";
	return ["\n## Cross-session memory", ...memories.map((memory) => `- ${memory.note} (${memory.createdAt})`), ""].join(
		"\n",
	);
}
