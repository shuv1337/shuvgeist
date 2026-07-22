import { expect, test } from "@playwright/test";
import { createServer as createTcpServer } from "node:net";
import { BridgeResponseInbox, openRegisteredClient } from "../../helpers/ws-client.js";
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

test("bridge happy path responds to CLI status", async () => {
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
		await waitForExtensionSidePanelRuntime(extension.context, opened.panel, opened.descriptor.sessionId);

		const cli = await openRegisteredClient(`ws://127.0.0.1:${port}/ws`, "playwright-token", "cli", {
			name: "playwright-cli",
		});
		const inbox = new BridgeResponseInbox(cli.ws);
		try {
			const response = await inbox.send<{ id?: number; result?: { ready?: boolean; windowId?: number } }>({
				id: 101,
				method: "status",
			});

			expect(response.id).toBe(101);
			expect(response.result?.ready).toBe(true);
			expect(response.result?.windowId).toBe(opened.windowId);
		} finally {
			inbox.dispose();
			cli.ws.close();
		}
	} finally {
		await extension.close();
		await bridge.stop();
	}
});
