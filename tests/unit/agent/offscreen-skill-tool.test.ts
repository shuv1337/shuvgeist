import { describe, expect, it, vi } from "vitest";

const listSkills = vi.hoisted(() => vi.fn());

vi.mock("@shuvgeist/extension/storage/app-storage", () => ({
	getShuvgeistStorage: () => ({
		skills: {
			listSkills,
		},
	}),
}));

import { createOffscreenSkillTool } from "@shuvgeist/extension/agent/offscreen-skill-tool";

describe("createOffscreenSkillTool", () => {
	it("executes the real skill tool after resolving the current URL with canonical listTabs navigation", async () => {
		listSkills.mockResolvedValue([
			{
				name: "example",
				domainPatterns: ["example.test/*"],
				appPatterns: [],
				shortDescription: "Example skill",
				description: "Example",
				createdAt: "2026-01-01T00:00:00.000Z",
				lastUpdated: "2026-01-01T00:00:00.000Z",
				examples: "example()",
				library: "const example = true;",
			},
		]);
		const executeNavigate = vi.fn(async () => ({
			tabs: [
				{ id: 1, windowId: 6, active: true, url: "https://other.test" },
				{ id: 2, windowId: 7, active: true, url: "https://example.test/page" },
			],
		}));
		const ensureDefaultSkills = vi.fn(async () => undefined);
		const tool = createOffscreenSkillTool({
			scope: { windowId: 7 },
			ensureDefaultSkills,
			executeNavigate,
		});

		await expect(tool.execute("skill-call", { action: "list" })).resolves.toMatchObject({
			content: [{ type: "text", text: "example: Example skill" }],
			details: { skills: [{ name: "example" }] },
		});
		expect(ensureDefaultSkills).toHaveBeenCalledTimes(1);
		expect(executeNavigate).toHaveBeenCalledWith({ listTabs: true }, undefined);
		expect(listSkills).toHaveBeenCalledWith("https://example.test/page");
	});
});
