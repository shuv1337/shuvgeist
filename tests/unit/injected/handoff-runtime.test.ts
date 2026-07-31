// @vitest-environment happy-dom

import { HandoffCoordinator } from "@shuvgeist/extension/bridge/handoff-coordinator";
import { runHandoffOverlay } from "@shuvgeist/extension/injected/handoff-runtime";

describe.each(["manual", "browser-native"] as const)("handoff overlay %s fixture", (kind) => {
	it("acknowledges before allowing the exact human completion", async () => {
		const coordinator = new HandoffCoordinator();
		const active = coordinator.start(
			{
				taskId: "task-1",
				sessionId: "session-1",
				kind,
				windowId: 7,
				tabId: 42,
				frameId: 0,
				navigationGeneration: 2,
			},
			10_000,
		);
		const sendMessage = vi.fn(async (message: Parameters<HandoffCoordinator["acceptPageEvent"]>[0]) =>
			coordinator.acceptPageEvent(message, { tabId: 42, frameId: 0 }),
		);
		vi.stubGlobal("chrome", { runtime: { sendMessage } });

		expect(runHandoffOverlay({ action: "show", binding: active.binding, message: "Complete this step" })).toEqual({
			installed: true,
		});
		const button = document.querySelector<HTMLButtonElement>("#shuvgeist-human-handoff button:last-child");
		expect(button?.textContent).toBe("Begin manual step");
		button?.click();
		await expect(active.acknowledged).resolves.toEqual(expect.any(String));
		expect(button?.disabled).toBe(true);
		runHandoffOverlay({ action: "ready", binding: active.binding });
		expect(button?.textContent).toBe("Resume automation");
		button?.click();
		await expect(active.terminal).resolves.toMatchObject({ state: "completed" });
		expect(sendMessage.mock.calls.map(([message]) => message.state)).toEqual(["acknowledged", "completed"]);
		expect(document.getElementById("shuvgeist-human-handoff")).toBeNull();
	});
});
