import type { AgentTool } from "@shuv1337/pi-agent-core";
import { createSkillTool } from "../tools/skill.js";
import type { RuntimeValue } from "./runtime-protocol.js";

export interface OffscreenSkillToolScope {
	windowId: number;
}

export interface OffscreenSkillToolOptions {
	scope: OffscreenSkillToolScope;
	ensureDefaultSkills(): Promise<void>;
	executeNavigate(params: { listTabs: true }, signal?: AbortSignal): Promise<RuntimeValue>;
}

function currentWindowUrl(value: RuntimeValue, windowId: number): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "";
	const tabs = Array.isArray(value.tabs) ? value.tabs : [];
	for (const tab of tabs) {
		if (
			tab &&
			typeof tab === "object" &&
			!Array.isArray(tab) &&
			tab.active === true &&
			tab.windowId === windowId &&
			typeof tab.url === "string"
		) {
			return tab.url;
		}
	}
	return "";
}

/** Builds the real skill tool with a canonical logical-tab URL resolver. */
export function createOffscreenSkillTool(options: OffscreenSkillToolOptions): AgentTool {
	return createSkillTool({
		async resolveCurrentUrl(signal) {
			await options.ensureDefaultSkills();
			const result = await options.executeNavigate({ listTabs: true }, signal);
			return currentWindowUrl(result, options.scope.windowId);
		},
	}) as unknown as AgentTool;
}
