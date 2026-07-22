import { describe, expect, it, vi } from "vitest";

import type { RuntimeRecord } from "@shuvgeist/extension/agent/runtime-protocol";
import {
	authorizeAgentRuntimePageTarget,
	scopeAgentRuntimeNavigatePayload,
} from "@shuvgeist/extension/bridge/agent-runtime-page-authorization";
import type { AgentRuntimePageOperationMessage } from "@shuvgeist/extension/bridge/internal-messages";

function input(
	operation: AgentRuntimePageOperationMessage["operation"],
	payload: RuntimeRecord,
	windowId = 7,
) {
	return { operation, payload, windowId };
}

describe("agent runtime page authorization", () => {
	it.each(["browser-js", "native-input", "page-snapshot", "screenshot"] as const)(
		"rejects a foreign-window tabId for %s before execution",
		async (operation) => {
			const getWindowId = vi.fn(async () => 8);
			await expect(
				authorizeAgentRuntimePageTarget(input(operation, { tabId: 81 }), { getWindowId }),
			).rejects.toThrow("Tab 81 belongs to window 8, not authorized window 7");
			expect(getWindowId).toHaveBeenCalledWith(81);
		},
	);

	it.each([
		{ label: "tabId", payload: { tabId: 81 } },
		{ label: "nested tabId", payload: { args: { tabId: 81 } } },
		{ label: "switchToTab", payload: { switchToTab: 81 } },
		{ label: "closeTab", payload: { closeTab: 81 } },
		{ label: "closeTabs", payload: { closeTabs: [71, 81] } },
	])("rejects a foreign navigate $label target", async ({ payload }) => {
		await expect(
			authorizeAgentRuntimePageTarget(input("navigate", payload), {
				getWindowId: async (tabId) => (tabId === 71 ? 7 : 8),
			}),
		).rejects.toThrow("not authorized window 7");
	});

	it("rejects foreign window mutation and accepts exact-window tab targets", async () => {
		await expect(
			authorizeAgentRuntimePageTarget(input("navigate", { closeWindow: 8 }), {
				getWindowId: async () => 7,
			}),
		).rejects.toThrow("Window 8 is outside authorized window 7");
		await expect(
			authorizeAgentRuntimePageTarget(input("navigate", { closeTabFilter: { windowId: 8, titleIncludes: "x" } }), {
				getWindowId: async () => 7,
			}),
		).rejects.toThrow("Window 8 is outside authorized window 7");
		await expect(
			authorizeAgentRuntimePageTarget(input("navigate", { closeTabs: [71, 72] }), {
				getWindowId: async () => 7,
			}),
		).resolves.toBeUndefined();
	});

	it("forces filter-based tab mutation into the descriptor window", () => {
		expect(
			scopeAgentRuntimeNavigatePayload(
				{ closeTabFilter: { titleIncludes: "temporary", includePinned: true } },
				7,
			),
		).toEqual({ closeTabFilter: { titleIncludes: "temporary", includePinned: true, windowId: 7 } });
		expect(
			scopeAgentRuntimeNavigatePayload(
				{ args: { closeTabFilter: { urlIncludes: "example" } }, correlation: "keep" },
				7,
			),
		).toEqual({ args: { closeTabFilter: { urlIncludes: "example", windowId: 7 } }, correlation: "keep" });
	});
});
