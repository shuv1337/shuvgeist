import { describe, expect, it, vi } from "vitest";

import { loadOffscreenDebuggerMode } from "@shuvgeist/extension/agent/offscreen-developer-settings";

describe("offscreen developer settings bridge", () => {
	it("requests the background-owned debugger setting without reading chrome.storage", async () => {
		const sendMessage = vi.fn(async () => ({ ok: true, debuggerMode: true }));

		await expect(loadOffscreenDebuggerMode({ sendMessage })).resolves.toBe(true);
		expect(sendMessage).toHaveBeenCalledOnce();
		expect(sendMessage).toHaveBeenCalledWith({ type: "agent-runtime-get-developer-settings" });
	});

	it("rejects negative and malformed background responses", async () => {
		await expect(
			loadOffscreenDebuggerMode({ sendMessage: async () => ({ ok: false, error: "settings unavailable" }) }),
		).rejects.toThrow("settings unavailable");
		await expect(
			loadOffscreenDebuggerMode({ sendMessage: async () => ({ ok: true, debuggerMode: "yes" }) }),
		).rejects.toThrow("malformed offscreen developer settings");
	});
});
