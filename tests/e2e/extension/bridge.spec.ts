import { expect, test } from "@playwright/test";
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

test.describe("bridge ui smoke", () => {
	test("settings renders bridge tab content", async () => {
		const port = await getAvailablePort();
		const bridge = new BridgeServer({ host: "127.0.0.1", port, token: "playwright-token" });
		await bridge.start();

		const { context, extensionId } = await launchExtensionContext();
		const page = await openExtensionPage(context, extensionId, "sidepanel.html?new=true");
		await openBridgeSettings(page);
		await expect(page.getByText("CLI Bridge")).toBeVisible();
		await expect(page.getByText("Enable bridge")).toBeVisible();
		await expect(page.getByText("Start the bridge server with:")).toBeVisible();

		await context.close();
		await bridge.stop();
	});
});
