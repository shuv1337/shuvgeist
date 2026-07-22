import { describe, expect, it } from "vitest";

import {
	latestNavigationUrl,
	navigationContextChanged,
	runtimeNavigationMessage,
} from "@shuvgeist/extension/agent/runtime-navigation";
import type { RuntimeAgentMessage } from "@shuvgeist/extension/agent/runtime-protocol";

const candidate: RuntimeAgentMessage = {
	role: "navigation",
	url: "https://example.test/current",
	title: "Current",
	skillsOutput: "skill context",
	snapshot: { url: "https://example.test/current", entries: [] },
};

describe("runtime navigation context", () => {
	it("accepts only complete plain navigation messages", () => {
		expect(runtimeNavigationMessage(candidate)).toEqual(candidate);
		expect(runtimeNavigationMessage({ role: "navigation", url: "https://example.test" })).toBeUndefined();
		expect(runtimeNavigationMessage({ role: "user", url: "https://example.test", title: "x", skillsOutput: "x" })).toBeUndefined();
	});

	it("uses the latest navigation or navigate-tool result to suppress duplicate prompt context", () => {
		const messages: RuntimeAgentMessage[] = [
			{ role: "navigation", url: "https://example.test/old", title: "Old", skillsOutput: "old" },
			{ role: "toolResult", toolName: "navigate", details: { finalUrl: candidate.url } },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
		];
		expect(latestNavigationUrl(messages)).toBe(candidate.url);
		expect(navigationContextChanged(messages, candidate)).toBe(false);
		expect(
			navigationContextChanged(messages, {
				...candidate,
				url: "https://example.test/next",
			}),
		).toBe(true);
	});
});
