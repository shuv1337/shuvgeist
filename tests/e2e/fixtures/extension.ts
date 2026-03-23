import { chromium, type BrowserContext, type Page, type ServiceWorker } from "@playwright/test";
import path from "node:path";

export async function launchExtensionContext(): Promise<{ context: BrowserContext; extensionId: string; serviceWorker: ServiceWorker }> {
	const extensionPath = path.resolve("dist-chrome");
	const context = await chromium.launchPersistentContext("", {
		channel: "chromium",
		headless: true,
		args: [
			`--disable-extensions-except=${extensionPath}`,
			`--load-extension=${extensionPath}`,
		],
	});
	let serviceWorker = context.serviceWorkers()[0];
	if (!serviceWorker) {
		serviceWorker = await context.waitForEvent("serviceworker");
	}
	const extensionId = new URL(serviceWorker.url()).host;
	return { context, extensionId, serviceWorker };
}

export async function openExtensionPage(context: BrowserContext, extensionId: string, pagePath: string): Promise<Page> {
	const page = await context.newPage();
	await page.goto(`chrome-extension://${extensionId}/${pagePath}`);
	return page;
}
