import { SkillsStore, type Skill } from "../../../src/storage/stores/skills-store.js";
import { FakeStorageBackend } from "../../helpers/fake-storage-backend.js";

function makeSkill(name: string, domainPatterns: string[]): Skill {
	return {
		name,
		domainPatterns,
		shortDescription: `${name} short`,
		description: `${name} description`,
		createdAt: "2026-03-20T00:00:00.000Z",
		lastUpdated: "2026-03-22T00:00:00.000Z",
		examples: "example()",
		library: "export const x = 1;",
	};
}

describe("SkillsStore", () => {
	it("matches host and path patterns", () => {
		const store = new SkillsStore();
		expect(store.matchesAnyPattern("https://github.com/badlogic/sitegeist", ["github.com/badlogic/*"])).toBe(true);
		expect(store.matchesAnyPattern("https://www.google.com/search?q=test", ["google.com/search"])).toBe(true);
		expect(store.matchesAnyPattern("https://example.com/about", ["example.com/admin/*"])).toBe(false);
	});

	it("returns false for invalid urls", () => {
		const store = new SkillsStore();
		expect(store.matchesAnyPattern("not a url", ["example.com/*"])).toBe(false);
	});

	it("lists only matching skills for a url", async () => {
		const backend = new FakeStorageBackend();
		backend.seed("skills", "github", makeSkill("github", ["github.com/badlogic/*"]));
		backend.seed("skills", "google", makeSkill("google", ["google.com/*"]));
		backend.seed("skills", "example", makeSkill("example", ["example.com/*"]));

		const store = new SkillsStore();
		store.setBackend(backend);

		const githubSkills = await store.list("https://github.com/badlogic/sitegeist");
		expect(githubSkills.map((skill) => skill.name)).toEqual(["github"]);

		const allSkills = await store.list();
		expect(allSkills.map((skill) => skill.name).sort()).toEqual(["example", "github", "google"]);
	});
});
