import { describe, expect, it, vi } from "vitest";

import type { RuntimeAgentMessage, RuntimeSessionSnapshot } from "@shuvgeist/extension/agent/runtime-protocol";
import { AgentRuntimeNavigationSteering } from "@shuvgeist/extension/bridge/agent-runtime-navigation";
import type { AgentRuntimeConnectionDescriptor } from "@shuvgeist/extension/bridge/internal-messages";

function descriptor(windowId: number, sessionId = `session-${windowId}`): AgentRuntimeConnectionDescriptor {
	return {
		clientId: "sidepanel",
		windowId,
		sessionId,
		target: { kind: "chrome-tab", tabRef: `window:${windowId}` },
		mode: "load",
		systemPrompt: "System",
	};
}

function snapshot(value: AgentRuntimeConnectionDescriptor, isStreaming = true): RuntimeSessionSnapshot {
	return {
		sessionId: value.sessionId,
		target: value.target,
		revision: 3,
		systemPrompt: "System",
		model: null,
		thinkingLevel: "off",
		messages: [],
		tools: [],
		pendingToolCallIds: [],
		isStreaming,
		activeExecutions: [],
		artifacts: [],
	};
}

function navigation(url: string): RuntimeAgentMessage {
	return {
		role: "navigation",
		url,
		title: "Page",
		skillsOutput: "full skill context",
		snapshot: { url, entries: [{ snapshotId: "e1" }] },
	};
}

describe("AgentRuntimeNavigationSteering", () => {
	it("steers an accepted streaming session without depending on a sidepanel port", async () => {
		const accepted = descriptor(7);
		const steer = vi.fn(async () => undefined);
		const createMessage = vi.fn(async () => navigation("https://example.test/next"));
		const controller = new AgentRuntimeNavigationSteering({
			getDescriptorsForWindow: async (windowId) => (windowId === 7 ? [accepted] : []),
			getLatestSnapshot: () => snapshot(accepted),
			createMessage,
			steer,
			isProtectedUrl: (url) => url.startsWith("chrome:"),
		});

		await expect(
			controller.handleTab({
				id: 71,
				windowId: 7,
				active: true,
				url: "https://example.test/next",
				title: "Next",
			}),
		).resolves.toBe(true);
		expect(steer).toHaveBeenCalledWith(accepted, {
			role: "navigation",
			url: "https://example.test/next",
			title: "Page",
			skillsOutput: "full skill context",
			snapshot: { url: "https://example.test/next", entries: [{ snapshotId: "e1" }] },
		});
	});

	it("isolates windows and rechecks session ownership after asynchronous snapshot construction", async () => {
		let window7 = descriptor(7);
		const window8 = descriptor(8);
		const steered: Array<{ windowId: number; sessionId: string }> = [];
		let releaseWindow7: (() => void) | undefined;
		const window7Build = new Promise<void>((resolve) => {
			releaseWindow7 = resolve;
		});
		const controller = new AgentRuntimeNavigationSteering({
			getDescriptorsForWindow: async (windowId) => (windowId === 7 ? [window7] : windowId === 8 ? [window8] : []),
			getLatestSnapshot: (value) => snapshot(value),
			async createMessage(value, tab) {
				if (value.windowId === 7) await window7Build;
				return navigation(tab.url ?? "");
			},
			async steer(value) {
				steered.push({ windowId: value.windowId, sessionId: value.sessionId });
			},
			isProtectedUrl: () => false,
		});

		const first = controller.handleTab({ windowId: 7, active: true, url: "https://seven.test" });
		const second = controller.handleTab({ windowId: 8, active: true, url: "https://eight.test" });
		await expect(second).resolves.toBe(true);
		window7 = descriptor(7, "replacement-session");
		releaseWindow7?.();
		await expect(first).resolves.toBe(false);
		expect(steered).toEqual([{ windowId: 8, sessionId: "session-8" }]);
	});

	it("ignores idle, inactive, protected, and ambiguous windows", async () => {
		const accepted = descriptor(7);
		const createMessage = vi.fn(async () => navigation("https://example.test"));
		const steer = vi.fn(async () => undefined);
		let streaming = false;
		let descriptors = [accepted];
		const controller = new AgentRuntimeNavigationSteering({
			getDescriptorsForWindow: async () => descriptors,
			getLatestSnapshot: (value) => snapshot(value, streaming),
			createMessage,
			steer,
			isProtectedUrl: (url) => url.startsWith("chrome:"),
		});

		await expect(controller.handleTab({ windowId: 7, active: false, url: "https://example.test" })).resolves.toBe(false);
		await expect(controller.handleTab({ windowId: 7, active: true, url: "chrome://settings" })).resolves.toBe(false);
		await expect(controller.handleTab({ windowId: 7, active: true, url: "https://example.test" })).resolves.toBe(false);
		streaming = true;
		descriptors = [accepted, descriptor(7, "other")];
		await expect(controller.handleTab({ windowId: 7, active: true, url: "https://example.test" })).resolves.toBe(false);
		expect(createMessage).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
	});
});
