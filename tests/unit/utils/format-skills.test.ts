import type { Skill } from "@shuvgeist/extension/storage/stores/skills-store";
import { formatSkills } from "@shuvgeist/extension/utils/format-skills";
import { ShownSkillsState } from "@shuvgeist/extension/utils/shown-skills";

function makeSkill(name: string, lastUpdated: string): Skill {
	return {
		name,
		domainPatterns: ["example.com/*"],
		shortDescription: `${name} short`,
		description: `${name} description`,
		createdAt: "2026-03-20T00:00:00.000Z",
		lastUpdated,
		examples: `${name}Example()`,
		library: `${name}Library`,
	};
}

describe("formatSkills", () => {
	let shownSkillsState: ShownSkillsState;

	beforeEach(() => {
		shownSkillsState = new ShownSkillsState();
	});

	it("returns full details for new skills and marks them as shown", async () => {
		const alpha = makeSkill("alpha", "2026-03-22T00:00:00.000Z");
		const result = await formatSkills([alpha], { shownSkillsState });

		expect(result.newOrUpdated).toEqual([alpha]);
		expect(result.unchanged).toEqual([]);
		expect(result.formattedText).toContain("New/Updated Skills");
		expect(result.formattedText).toContain("alpha description");
		expect(shownSkillsState.get("alpha")).toBe(alpha.lastUpdated);
	});

	it("returns compact output for previously seen skills", async () => {
		const alpha = makeSkill("alpha", "2026-03-22T00:00:00.000Z");
		shownSkillsState.set("alpha", alpha.lastUpdated);

		const result = await formatSkills([alpha], { shownSkillsState });
		expect(result.newOrUpdated).toEqual([]);
		expect(result.unchanged).toEqual([alpha]);
		expect(result.formattedText).toContain("Previously Seen Skills");
		expect(result.formattedText).toContain("- alpha: alpha short");
	});

	it("returns a sentinel string when no skills exist", async () => {
		await expect(formatSkills([], { shownSkillsState }).then((result) => result.formattedText)).resolves.toBe(
			"none found",
		);
	});

	it("does not share shown skills between independent states", async () => {
		const alpha = makeSkill("alpha", "2026-03-22T00:00:00.000Z");
		const otherState = new ShownSkillsState();

		await formatSkills([alpha], { shownSkillsState });
		const sameSession = await formatSkills([alpha], { shownSkillsState });
		const otherSession = await formatSkills([alpha], { shownSkillsState: otherState });

		expect(sameSession.unchanged).toEqual([alpha]);
		expect(otherSession.newOrUpdated).toEqual([alpha]);
	});

	it("uses fresh isolated state when callers do not provide one", async () => {
		const alpha = makeSkill("alpha", "2026-03-22T00:00:00.000Z");

		const first = await formatSkills([alpha]);
		const second = await formatSkills([alpha]);

		expect(first.newOrUpdated).toEqual([alpha]);
		expect(second.newOrUpdated).toEqual([alpha]);
	});

	it("includes cross-session memories with full skill details", async () => {
		const alpha = makeSkill("alpha", "2026-03-22T00:00:00.000Z");
		const result = await formatSkills([alpha], {
			shownSkillsState,
			getMemoriesForSkill: async () => [
				{
					note: "Prefer the semantic compose button before fallback selectors.",
					createdAt: "2026-06-01T10:00:00.000Z",
				},
			],
		});

		expect(result.formattedText).toContain("Cross-session memory");
		expect(result.formattedText).toContain("Prefer the semantic compose button before fallback selectors.");
	});
});
