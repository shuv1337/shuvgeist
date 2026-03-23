import { expect, test } from "@playwright/test";
import { openRegisteredClient, readMessage } from "../../helpers/ws-client.js";
import { BridgeServer } from "../../../src/bridge/server.js";
import { launchExtensionContext, openExtensionPage } from "../fixtures/extension.js";

async function getAvailablePort(): Promise<number> {
	const net = await import("node:net");
	return new Promise((resolve, reject) => {
		const server = net.createServer();
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

async function openBridgeSettings(page: import("@playwright/test").Page): Promise<void> {
	const continueAnyway = page.getByRole("button", { name: "Continue Anyway" });
	if (await continueAnyway.isVisible().catch(() => false)) {
		await continueAnyway.click();
	}
	await page.waitForTimeout(1500);
	const setupProvider = page.getByRole("button", { name: "Set up provider" });
	if (await setupProvider.isVisible().catch(() => false)) {
		await setupProvider.click();
	} else {
		await expect(page.locator("button[title='Settings']")).toBeVisible({ timeout: 15_000 });
		await page.click("button[title='Settings']");
	}
	await page.getByRole("button", { name: "Bridge" }).click();
}

test("bridge happy path responds to CLI status", async () => {
	const port = await getAvailablePort();
	const bridge = new BridgeServer({ host: "127.0.0.1", port, token: "playwright-token" });
	await bridge.start();

	const { context, extensionId } = await launchExtensionContext();
	const page = await openExtensionPage(context, extensionId, "sidepanel.html?new=true");
	await openBridgeSettings(page);

	await page.locator('input[type="checkbox"]').check();
	const urlInput = page.locator('input[type="text"]').last();
	await urlInput.fill(`ws://127.0.0.1:${port}/ws`);
	await urlInput.blur();
	const tokenInput = page.locator('bridge-tab input[type="password"]');
	await tokenInput.fill("playwright-token");
	await tokenInput.blur();

	await expect(page.locator("bridge-tab").getByText("Connected")).toBeVisible({ timeout: 15_000 });

	const cli = await openRegisteredClient(`ws://127.0.0.1:${port}/ws`, "playwright-token", "cli", {
		name: "playwright-cli",
	});
	cli.ws.send(JSON.stringify({ id: 101, method: "status" }));

	let response = await readMessage<{ id?: number; type?: string; result?: { ready?: boolean; windowId?: number } }>(cli.ws);
	if (response.type === "event") {
		response = await readMessage<{ id?: number; result?: { ready?: boolean; windowId?: number } }>(cli.ws);
	}

	expect(response.id).toBe(101);
	expect(response.result?.ready).toBe(true);
	expect(response.result?.windowId).toBeDefined();

	cli.ws.close();
	await context.close();
	await bridge.stop();
});
