import { expect, test } from "@playwright/test";
import { launchExtensionContext, openExtensionPage } from "../fixtures/extension.js";

test.describe("extension smoke", () => {
	test("service worker and sidepanel boot", async () => {
		const { context, extensionId, serviceWorker } = await launchExtensionContext();
		expect(serviceWorker.url()).toContain(extensionId);

		const errors: string[] = [];
		const page = await openExtensionPage(context, extensionId, "sidepanel.html");
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("console", (msg) => {
			if (msg.type() === "error") errors.push(msg.text());
		});

		await expect(page).toHaveTitle("Shuvgeist");
		const continueAnyway = page.getByRole("button", { name: "Continue Anyway" });
		if (await continueAnyway.isVisible().catch(() => false)) {
			await continueAnyway.click();
		}
		await expect(page.locator("text=Loading...")).toHaveCount(0, { timeout: 15_000 });
		await expect(page.locator("button[title='Settings']")).toBeVisible({ timeout: 15_000 });
		expect(errors).toEqual([]);

		await context.close();
	});
});
