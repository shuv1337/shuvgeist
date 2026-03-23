import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function serveSite(): Promise<{ url: string; close: () => Promise<void> }> {
	const root = path.resolve("site/src/frontend");
	const server = createServer(async (req, res) => {
		const requestPath = req.url === "/install.html" ? "install.html" : "index.html";
		const filePath = path.join(root, requestPath);
		const content = await readFile(filePath, "utf-8");
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(content);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("failed to start test server");
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
	};
}

test.describe("site smoke", () => {
	test("home and install pages expose key content", async ({ page }) => {
		const site = await serveSite();
		await page.goto(site.url);
		await expect(page).toHaveTitle(/Sitegeist/);
		await expect(page.getByText("Download from GitHub").first()).toBeVisible();
		await expect(page.getByText("Installation instructions").first()).toBeVisible();

		await page.goto(`${site.url}/install.html`);
		await expect(page.getByText("Installation Guide")).toBeVisible();
		await expect(page.getByText("Load Unpacked Extension")).toBeVisible();
		await expect(page.getByText("Connect a Provider")).toBeVisible();
		await site.close();
	});
});
