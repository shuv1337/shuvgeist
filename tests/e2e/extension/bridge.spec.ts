import { expect, test } from "@playwright/test";
import { createServer as createTcpServer } from "node:net";
import type { BridgeServerStatus } from "@shuvgeist/protocol/protocol";
import { BridgeServer } from "@shuvgeist/server/server";
import {
	enableExtensionUserScripts,
	launchExtensionContext,
	openRealExtensionSidePanel,
	waitForExtensionSidePanelRuntime,
} from "../fixtures/extension.js";

async function getAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createTcpServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("failed to resolve port"));
				return;
			}
			const { port } = address;
			server.close((err) => {
				if (err) reject(err);
				else resolve(port);
			});
		});
	});
}

test.describe("bridge runtime smoke", () => {
	test("real sidepanel exposes connected bridge runtime", async () => {
		const port = await getAvailablePort();
		const bridge = new BridgeServer({ host: "127.0.0.1", port, token: "playwright-token" });
		await bridge.start();

		const extension = await launchExtensionContext();
		try {
			const worker = await enableExtensionUserScripts(extension.context, extension.extensionId);
			await worker.evaluate(
				async ({ bridgePort, token }: { bridgePort: number; token: string }) => {
					await chrome.storage.local.set({
						bridge_settings: {
							enabled: true,
							url: `ws://127.0.0.1:${bridgePort}/ws`,
							token,
							sensitiveAccessEnabled: false,
						},
					});
				},
				{ bridgePort: port, token: "playwright-token" },
			);
			const opened = await openRealExtensionSidePanel(extension.context, extension.extensionId, worker);
			expect(opened.descriptor).toMatchObject({
				clientId: "sidepanel",
				windowId: opened.windowId,
				target: { kind: "chrome-tab", tabRef: `window:${opened.windowId}` },
			});
			await waitForExtensionSidePanelRuntime(
				extension.context,
				opened.panel,
				opened.descriptor.sessionId,
			);
			await expect
				.poll(() =>
					opened.control.page.evaluate(async () => {
						const values = await chrome.storage.session.get("bridge_state");
						const state = values.bridge_state;
						return state && typeof state === "object" && !Array.isArray(state)
							? (state as { state?: unknown }).state
							: undefined;
					}),
				)
				.toBe("connected");
			const statusResponse = await fetch(`http://127.0.0.1:${port}/status`);
			expect(statusResponse.ok).toBe(true);
			const status = (await statusResponse.json()) as BridgeServerStatus;
			expect(status.extension.connected).toBe(true);
			if (!status.extension.connected) throw new Error(JSON.stringify(status, null, 2));
			expect(status.extension.windowId).toBe(opened.windowId);
		} finally {
			await extension.close();
			await bridge.stop();
		}
	});
});
