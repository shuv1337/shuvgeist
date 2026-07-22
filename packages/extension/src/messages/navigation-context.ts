import { getShuvgeistStorage } from "../storage/app-storage.js";
import type { PageSnapshotResult } from "../tools/page-snapshot.js";
import { formatSkills } from "../utils/format-skills.js";
import type { ShownSkillsState } from "../utils/shown-skills.js";

export interface NavigationMessage {
	role: "navigation";
	url: string;
	title: string;
	favicon?: string;
	tabId?: number;
	snapshot?: PageSnapshotResult;
	/** Frozen formatted skills text shown to the model for this navigation. */
	skillsOutput: string;
}

export interface CreateNavigationMessageOptions {
	shownSkillsState?: ShownSkillsState;
}

/**
 * Builds the plain navigation message shared by sidepanel rendering and the
 * background-owned agent runtime. This module intentionally has no DOM or Lit
 * imports so it is safe to load from a service worker.
 */
export async function createNavigationMessage(
	url: string,
	title: string,
	favicon?: string,
	tabId?: number,
	snapshot?: PageSnapshotResult,
	options: CreateNavigationMessageOptions = {},
): Promise<NavigationMessage> {
	const storage = getShuvgeistStorage();
	const matchingSkills = await storage.skills.getSkillsForUrl(url);
	const { formattedText: skillsOutput } = await formatSkills(matchingSkills, {
		getMemoriesForSkill: (skill) => storage.memories.getForSkill(skill.name),
		...(options.shownSkillsState ? { shownSkillsState: options.shownSkillsState } : {}),
	});

	return {
		role: "navigation",
		url,
		title,
		...(favicon !== undefined ? { favicon } : {}),
		...(tabId !== undefined ? { tabId } : {}),
		...(snapshot !== undefined ? { snapshot } : {}),
		skillsOutput,
	};
}
