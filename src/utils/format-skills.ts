import type { Skill } from "../storage/stores/skills-store.js";
import { getShownSkills } from "./shown-skills.js";

export interface FormattedSkills {
	newOrUpdated: Skill[];
	unchanged: Skill[];
	formattedText: string;
}

/**
 * Formats skills for display, tracking which have been shown before.
 * Returns full details for new/updated skills, short form for previously seen skills.
 */
export function formatSkills(skills: Skill[]): FormattedSkills {
	const shownSkills = getShownSkills();

	// Separate into new/updated vs already shown
	const newOrUpdated = skills.filter((s) => {
		const lastShown = shownSkills.get(s.name);
		return !lastShown || s.lastUpdated > lastShown;
	});

	const unchanged = skills.filter((s) => {
		const lastShown = shownSkills.get(s.name);
		return lastShown && s.lastUpdated <= lastShown;
	});

	// Mark new/updated as shown
	newOrUpdated.forEach((s) => {
		shownSkills.set(s.name, s.lastUpdated);
	});

	// Build formatted text
	let formattedText = "";

	if (newOrUpdated.length > 0) {
		formattedText += "New/Updated Skills (full details):\n";
		formattedText += newOrUpdated
			.map(
				(s) => `
<skill>
${s.name}
Domain Patterns: ${s.domainPatterns.join(", ")}
${s.description}
## Examples
\`\`\`javascript
${s.examples}
\`\`\`
</skill>
`,
			)
			.join("\n---\n");
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
