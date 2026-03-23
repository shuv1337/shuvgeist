import type { Skill } from "../../../src/storage/stores/skills-store.js";

const shownSkills = new Map<string, string>();

vi.mock("../../../src/sidepanel.js", () => ({
	getShownSkills: () => shownSkills,
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

	it("returns full details for new skills and marks them as shown", () => {
		const alpha = makeSkill("alpha", "2026-03-22T00:00:00.000Z");
		const result = formatSkills([alpha]);

		expect(result.newOrUpdated).toEqual([alpha]);
		expect(result.unchanged).toEqual([]);
		expect(result.formattedText).toContain("New/Updated Skills");
		expect(result.formattedText).toContain("alpha description");
		expect(shownSkills.get("alpha")).toBe(alpha.lastUpdated);
	});

	it("returns compact output for previously seen skills", () => {
		const alpha = makeSkill("alpha", "2026-03-22T00:00:00.000Z");
		shownSkills.set("alpha", alpha.lastUpdated);

		const result = formatSkills([alpha]);
		expect(result.newOrUpdated).toEqual([]);
		expect(result.unchanged).toEqual([alpha]);
		expect(result.formattedText).toContain("Previously Seen Skills");
		expect(result.formattedText).toContain("- alpha: alpha short");
	});

	it("returns a sentinel string when no skills exist", () => {
		expect(formatSkills([]).formattedText).toBe("none found");
	});
});
