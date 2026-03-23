import { SkillsStore, type Skill } from "../../../src/storage/stores/skills-store.js";
import { FakeStorageBackend } from "../../helpers/fake-storage-backend.js";

function makeSkill(name: string): Skill {
	return {
		name,
		domainPatterns: ["example.com/*"],
		shortDescription: `${name} short`,
		description: `${name} description`,
		createdAt: "2026-03-20T00:00:00.000Z",
		lastUpdated: "2026-03-22T00:00:00.000Z",
		examples: "example()",
		library: "code",
	};
}

describe("SkillsStore aliases and CRUD", () => {
	it("supports save/get/delete and alias methods", async () => {
		const backend = new FakeStorageBackend();
		const store = new SkillsStore();
		store.setBackend(backend);
		const skill = makeSkill("alpha");

		await store.save(skill);
		expect(await store.get("alpha")).toEqual(skill);
		expect(await store.getSkill("alpha")).toEqual(skill);
		expect(await store.getForUrl("https://example.com/path")).toEqual([skill]);
		expect(await store.getSkillsForUrl("https://example.com/path")).toEqual([skill]);
		expect(await store.listSkills()).toEqual([skill]);

		const beta = makeSkill("beta");
		await store.saveSkill(beta);
		expect((await store.list()).map((item) => item.name).sort()).toEqual(["alpha", "beta"]);

		await store.deleteSkill("alpha");
		expect(await store.get("alpha")).toBeNull();
		await store.delete("beta");
		expect(await store.get("beta")).toBeNull();
	});

	it("returns false for root-level mismatches and bare domains", () => {
		const store = new SkillsStore();
		expect(store.matchesAnyPattern("https://example.com/path", ["example.com"])).toBe(true);
		expect(store.matchesAnyPattern("https://example.com/path", ["other.com"])).toBe(false);
		expect(store.matchesAnyPattern("https://example.com/path", ["example.com/"])).toBe(true);
	});
});
