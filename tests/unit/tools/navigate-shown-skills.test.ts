import type { Skill } from "@shuvgeist/extension/storage/stores/skills-store";
import { NavigateTool } from "@shuvgeist/extension/tools/navigate";
import { ShownSkillsState } from "@shuvgeist/extension/utils/shown-skills";

const storageMocks = vi.hoisted(() => ({
	getSkillsForUrl: vi.fn(),
	getForSkill: vi.fn(),
}));

vi.mock("@shuvgeist/extension/storage/app-storage", () => ({
	getShuvgeistStorage: () => ({
		skills: { getSkillsForUrl: storageMocks.getSkillsForUrl },
		memories: { getForSkill: storageMocks.getForSkill },
	}),
}));

function makeSkill(): Skill {
	return {
		name: "example-browser",
		domainPatterns: ["example.com/*"],
		shortDescription: "Interact with Example",
		description: "Use the Example browser helpers.",
		createdAt: "2026-03-20T00:00:00.000Z",
		lastUpdated: "2026-07-22T00:00:00.000Z",
		examples: "example.open()",
		library: "window.example = {};",
	};
}

function createChromeMock() {
	return {
		tabs: {
			query: vi.fn().mockResolvedValue([
				{
					id: 7,
					windowId: 12,
					url: "https://example.com/inbox",
					title: "Example Inbox",
				},
			]),
			update: vi.fn().mockResolvedValue(undefined),
		},
		windows: {
			update: vi.fn().mockResolvedValue(undefined),
		},
	};
}

describe("NavigateTool shown skill scope", () => {
	beforeEach(() => {
		storageMocks.getSkillsForUrl.mockReset().mockResolvedValue([makeSkill()]);
		storageMocks.getForSkill.mockReset().mockResolvedValue([]);
		vi.stubGlobal("chrome", createChromeMock());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps repeated navigation compact within one tool instance", async () => {
		const tool = new NavigateTool({ windowId: 12 });

		const first = await tool.execute("first", { switchToTab: 7 });
		const second = await tool.execute("second", { switchToTab: 7 });

		expect(first.content[0]?.text).toContain("New/Updated Skills (full details)");
		expect(second.content[0]?.text).toContain("Previously Seen Skills");
		expect(second.content[0]?.text).not.toContain("New/Updated Skills (full details)");
	});

	it("does not suppress full details in another tool session", async () => {
		const firstSession = new NavigateTool({ windowId: 12 });
		const secondSession = new NavigateTool({ windowId: 12 });

		await firstSession.execute("first", { switchToTab: 7 });
		const secondSessionResult = await secondSession.execute("second", { switchToTab: 7 });

		expect(secondSessionResult.content[0]?.text).toContain("New/Updated Skills (full details)");
	});

	it("honors an explicitly shared state", async () => {
		const shownSkillsState = new ShownSkillsState();
		const firstTool = new NavigateTool({ windowId: 12, shownSkillsState });
		const secondTool = new NavigateTool({ windowId: 12, shownSkillsState });

		await firstTool.execute("first", { switchToTab: 7 });
		const secondResult = await secondTool.execute("second", { switchToTab: 7 });

		expect(secondResult.content[0]?.text).toContain("Previously Seen Skills");
	});
});
