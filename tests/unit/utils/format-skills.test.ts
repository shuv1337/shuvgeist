import type { Skill } from "../../../src/storage/stores/skills-store.js";

const shownSkills = new Map<string, string>();

vi.mock("../../../src/utils/shown-skills.js", () => ({
	getShownSkills: () => shownSkills,
	clearShownSkills: () => shownSkills.clear(),
}));

const { formatSkills } = await import("../../../src/utils/format-skills.js");

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
	beforeEach(() => {
		shownSkills.clear();
	});

	it("returns full details for new skills and marks them as shown", async () => {
		const alpha = makeSkill("alpha", "2026-03-22T00:00:00.000Z");
		const result = await formatSkills([alpha]);

		expect(result.newOrUpdated).toEqual([alpha]);
		expect(result.unchanged).toEqual([]);
		expect(result.formattedText).toContain("New/Updated Skills");
		expect(result.formattedText).toContain("alpha description");
		expect(shownSkills.get("alpha")).toBe(alpha.lastUpdated);
	});

	it("returns compact output for previously seen skills", async () => {
		const alpha = makeSkill("alpha", "2026-03-22T00:00:00.000Z");
		shownSkills.set("alpha", alpha.lastUpdated);

		const result = await formatSkills([alpha]);
		expect(result.newOrUpdated).toEqual([]);
		expect(result.unchanged).toEqual([alpha]);
		expect(result.formattedText).toContain("Previously Seen Skills");
		expect(result.formattedText).toContain("- alpha: alpha short");
	});

	it("returns a sentinel string when no skills exist", async () => {
		await expect(formatSkills([]).then((result) => result.formattedText)).resolves.toBe("none found");
	});

	it("includes cross-session memories with full skill details", async () => {
		const alpha = makeSkill("alpha", "2026-03-22T00:00:00.000Z");
		const result = await formatSkills([alpha], {
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
