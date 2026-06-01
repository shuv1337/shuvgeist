import { expect, type Page, test } from "@playwright/test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WebSocket } from "ws";
import type { BridgeServerStatus, BridgeScreenshotResult, PageAssertResult } from "../../../src/bridge/protocol.js";
import { BridgeServer } from "../../../src/bridge/server.js";
import { openRegisteredClient, readMessage } from "../../helpers/ws-client.js";
import { launchExtensionContext, openExtensionPage } from "../fixtures/extension.js";

const execFile = promisify(execFileCallback);

interface CliRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface ExecFileFailure extends Error {
	code?: number | string | null;
	stdout?: string;
	stderr?: string;
}

function isExecFileFailure(error: unknown): error is ExecFileFailure {
	return error instanceof Error;
}

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

async function openBridgeSettings(page: Page): Promise<void> {
	const continueAnyway = page.getByRole("button", { name: "Continue Anyway" });
	if (await continueAnyway.isVisible().catch(() => false)) {
		await continueAnyway.click();
	}
	await page.waitForTimeout(1500);
	const setupProvider = page.getByRole("button", { name: "Bring API key" });
	if (await setupProvider.isVisible().catch(() => false)) {
		await setupProvider.click();
	} else {
		await expect(page.locator("button[title='Settings']")).toBeVisible({ timeout: 15_000 });
		await page.click("button[title='Settings']");
	}
	await page.getByRole("button", { name: "Bridge" }).click();
}

async function createFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	const server = createServer((req, res) => {
		if (req.url === "/techmart") {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(`<!doctype html>
<html><head><title>TechMart</title></head>
<body>
  <h1>TechMart</h1>
  <a href="/techmart/catalog">Browse Catalog</a>
</body></html>`);
			return;
		}
		if (req.url === "/techmart/catalog") {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(`<!doctype html>
<html>
<head><title>TechMart Catalog</title></head>
<body>
  <h1>Catalog</h1>
  <label for="category">Category</label>
  <select id="category">
    <option value="all">All Categories</option>
    <option value="electronics">Electronics</option>
    <option value="home">Home</option>
  </select>
  <label for="sort">Sort</label>
  <select id="sort">
    <option value="featured">Featured</option>
    <option value="price-asc">Low to High</option>
  </select>
  <p id="count">Products: 8</p>
  <p id="first">First product: Laptop Stand</p>
  <button id="select-usb" type="button">Select USB-C Hub</button>
  <script>
    function updateCatalog() {
      const category = document.querySelector("#category").value;
      const sort = document.querySelector("#sort").value;
      document.querySelector("#count").textContent = category === "electronics" ? "Products: 4" : "Products: 8";
      document.querySelector("#first").textContent = sort === "price-asc" ? "First product: USB-C Hub" : "First product: Laptop Stand";
    }
    document.querySelector("#category").addEventListener("change", updateCatalog);
    document.querySelector("#sort").addEventListener("change", updateCatalog);
    document.querySelector("#select-usb").addEventListener("click", () => {
      setTimeout(() => { window.location.href = "/techmart/checkout"; }, 100);
    });
  </script>
</body>
</html>`);
			return;
		}
		if (req.url === "/techmart/checkout") {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(`<!doctype html>
<html><head><title>TechMart Checkout</title></head>
<body>
  <h1>Checkout</h1>
  <label for="name">Name</label>
  <input id="name" />
  <label for="email">Email</label>
  <input id="email" />
  <button id="place-order" type="button">Place Order</button>
  <p id="confirmation"></p>
  <script>
    document.querySelector("#place-order").addEventListener("click", () => {
      setTimeout(() => { document.querySelector("#confirmation").textContent = "Order TM-57F23A8F"; }, 100);
    });
  </script>
</body></html>`);
			return;
		}
		if (req.url === "/frame") {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(`<!doctype html>
<html>
<head><title>Frame Fixture</title></head>
<body>
  <p id="frame-status">Frame count: 0</p>
  <button id="frame-counter" type="button">Increment frame counter</button>
  <script>
    let count = 0;
    document.querySelector("#frame-counter").addEventListener("click", () => {
      count += 1;
      document.querySelector("#frame-status").textContent = "Frame count: " + count;
    });
  </script>
</body>
</html>`);
			return;
		}
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(`<!doctype html>
<html>
<head><title>Shuvgeist CI Fixture</title></head>
<body>
	<h1>Welcome to Shuvgeist CI</h1>
	<p id="delayed" hidden>Delayed ready</p>
	<button id="continue" type="button">Continue</button>
	<form>
		<label for="email">Email</label>
		<input id="email" name="email" aria-label="Email" />
		<input id="hidden-code" value="hidden-value" hidden />
		<button id="disabled-submit" type="submit" disabled>Disabled submit</button>
		<button type="submit">Submit</button>
	</form>
	<iframe title="Nested fixture" src="/frame"></iframe>
	<script>
		setTimeout(() => {
			const delayed = document.querySelector("#delayed");
			delayed.hidden = false;
		}, 250);
	</script>
</body>
</html>`);
	});

	const port = await new Promise<number>((resolve, reject) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("failed to resolve fixture port"));
				return;
			}
			resolve(address.port);
		});
	});

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
}

async function readResponseById<T>(ws: WebSocket, request: Record<string, unknown>): Promise<T> {
	ws.send(JSON.stringify(request));
	for (;;) {
		const message = await readMessage<Record<string, unknown>>(ws);
		if (message.id === request.id) {
			return message as T;
		}
	}
}

async function runCli(bridgePort: number, args: string[]): Promise<CliRunResult> {
	const cliPath = join(process.cwd(), "dist-cli", "shuvgeist.mjs");
	const env = {
		...process.env,
		SHUVGEIST_BRIDGE_URL: `ws://127.0.0.1:${bridgePort}/ws`,
		SHUVGEIST_BRIDGE_TOKEN: "playwright-token",
	};
	try {
		const result = await execFile(process.execPath, [cliPath, ...args], {
			env,
			maxBuffer: 1024 * 1024,
		});
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		if (!isExecFileFailure(error)) {
			throw error;
		}
		return {
			code: typeof error.code === "number" ? error.code : 1,
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? "",
		};
	}
}

function parseCliJson<T>(result: CliRunResult): T {
	return JSON.parse(result.stdout) as T;
}

test("bridge supports deterministic assertions, workflow pinning, and native iframe refs", async () => {
	const bridgePort = await getAvailablePort();
	const bridge = new BridgeServer({ host: "127.0.0.1", port: bridgePort, token: "playwright-token" });
	const fixture = await createFixtureServer();
	await bridge.start();

	const { context, extensionId } = await launchExtensionContext();
	const page = await openExtensionPage(context, extensionId, "sidepanel.html?new=true");

	try {
		await openBridgeSettings(page);
		const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
		await worker.evaluate(async ({ port }) => {
			await chrome.storage.local.set({
					bridge_settings: {
						enabled: true,
						url: `ws://127.0.0.1:${port}/ws`,
						token: "",
						sensitiveAccessEnabled: true,
					},
				});
			}, { port: bridgePort });
		await expect(page.locator("bridge-tab").getByText("Connected")).toBeVisible({ timeout: 15_000 });

		const statusResult = await runCli(bridgePort, ["status", "--json"]);
		expect(statusResult.code, statusResult.stderr).toBe(0);
		const status = parseCliJson<BridgeServerStatus>(statusResult);
		expect(status.extension.connected).toBe(true);
		if (!status.extension.connected) {
			throw new Error(JSON.stringify(status, null, 2));
		}
		expect(status.extension.capabilities).toContain("page_assert");

		const cliNavigate = await runCli(bridgePort, ["navigate", fixture.baseUrl, "--new-tab", "--json"]);
		expect(cliNavigate.code, cliNavigate.stderr).toBe(0);
		const cliTabId = parseCliJson<{ tabId: number }>(cliNavigate).tabId;
		expect(cliTabId).toBeGreaterThan(0);

		for (const args of [
			["assert", "text", "Welcome to Shuvgeist CI", "--tab-id", String(cliTabId), "--timeout", "2s", "--json"],
			[
				"assert",
				"role",
				"button",
				"--name",
				"Continue",
				"--visible",
				"--tab-id",
				String(cliTabId),
				"--timeout",
				"2s",
				"--json",
			],
			[
				"assert",
				"expr",
				"true",
				"--world",
				"main",
				"--tab-id",
				String(cliTabId),
				"--timeout",
				"2s",
				"--json",
			],
			[
				"assert",
				"selector",
				"#delayed",
				"--visible",
				"--tab-id",
				String(cliTabId),
				"--timeout",
				"2s",
				"--json",
			],
		]) {
			const result = await runCli(bridgePort, args);
			expect(result.code, `${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
			expect(parseCliJson<PageAssertResult>(result).ok).toBe(true);
		}

		const failedAssert = await runCli(bridgePort, [
			"assert",
			"text",
			"Missing deterministic text",
			"--tab-id",
			String(cliTabId),
			"--timeout",
			"250ms",
			"--interval",
			"50ms",
			"--json",
		]);
		expect(failedAssert.code).toBe(1);
		const failedAssertJson = parseCliJson<PageAssertResult>(failedAssert);
		expect(failedAssertJson.ok).toBe(false);
		expect(failedAssertJson.attempts).toBeGreaterThan(0);
		expect(failedAssertJson.timeoutMs).toBe(250);

		const screenshotDir = await mkdtemp(join(tmpdir(), "shuvgeist-deterministic-"));
		const screenshotPath = join(screenshotDir, "page.webp");
		const screenshot = await runCli(bridgePort, [
			"screenshot",
			"--tab-id",
			String(cliTabId),
			"--out",
			screenshotPath,
			"--json",
		]);
		expect(screenshot.code, screenshot.stderr).toBe(0);
		expect(parseCliJson<BridgeScreenshotResult>(screenshot).imageWidth).toBeGreaterThan(0);
		expect((await stat(screenshotPath)).size).toBeGreaterThan(0);
		expect((await stat(join(screenshotDir, "viewport.json"))).size).toBeGreaterThan(0);
		await rm(screenshotDir, { recursive: true, force: true });

		const cli = await openRegisteredClient(`ws://127.0.0.1:${bridgePort}/ws`, "playwright-token", "cli", {
			name: "deterministic-ci-playwright",
		});
		try {
			const workflow = await readResponseById<{
				result?: { ok: boolean; steps: Array<{ type: string; method?: string; status: string }> };
			}>(cli.ws, {
				id: 201,
				method: "workflow_run",
				params: {
					workflow: {
						target: { mode: "new-tab" },
						steps: [
							{ method: "navigate", params: { url: fixture.baseUrl } },
							{ assert: { kind: "text", text: "Welcome to Shuvgeist CI" }, as: "welcome" },
						],
					},
				},
			});
			expect(workflow.result?.ok, JSON.stringify(workflow, null, 2)).toBe(true);
			expect(workflow.result?.steps).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "assert", method: "page_assert", status: "ok" }),
				]),
			);

			const navigate = await readResponseById<{ result?: { tabId: number } }>(cli.ws, {
				id: 202,
				method: "navigate",
				params: { url: fixture.baseUrl, newTab: true },
			});
			const tabId = navigate.result?.tabId;
			expect(tabId).toBeDefined();

			const textAssert = await readResponseById<{ result?: { ok: boolean; kind: string } }>(cli.ws, {
				id: 203,
				method: "page_assert",
				params: { tabId, kind: "text", text: "Welcome to Shuvgeist CI", timeoutMs: 2_000 },
			});
			expect(textAssert.result).toMatchObject({ ok: true, kind: "text" });

			const roleAssert = await readResponseById<{ result?: { ok: boolean; kind: string } }>(cli.ws, {
				id: 204,
				method: "page_assert",
				params: { tabId, kind: "role", role: "button", name: "Continue", visible: true, timeoutMs: 2_000 },
			});
			expect(roleAssert.result).toMatchObject({ ok: true, kind: "role" });

			const frameList = await readResponseById<{ result?: Array<{ frameId: number; parentFrameId: number; url: string }> }>(
				cli.ws,
				{
					id: 205,
					method: "frame_list",
					params: { tabId },
				},
			);
			const childFrame = frameList.result?.find((frame) => frame.parentFrameId === 0 && frame.url.endsWith("/frame"));
			expect(childFrame?.frameId).toBeDefined();

			const located = await readResponseById<{ result?: Array<{ refId: string }> }>(cli.ws, {
				id: 206,
				method: "locate_by_role",
				params: { tabId, frameId: childFrame?.frameId, role: "button", name: "Increment frame counter" },
			});
			const refId = located.result?.[0]?.refId;
			if (!refId) {
				throw new Error(JSON.stringify(located, null, 2));
			}

			const clicked = await readResponseById<{ result?: { ok: boolean; native?: boolean } }>(cli.ws, {
				id: 207,
				method: "ref_click",
				params: { tabId, frameId: childFrame?.frameId, refId, native: true },
			});
			if (!clicked.result) {
				throw new Error(JSON.stringify(clicked, null, 2));
			}
			expect(clicked.result, JSON.stringify(clicked, null, 2)).toMatchObject({ ok: true, native: true });

			const frameAssert = await readResponseById<{ result?: { ok: boolean; kind: string } }>(cli.ws, {
				id: 208,
				method: "page_assert",
				params: { tabId, frameId: childFrame?.frameId, kind: "text", text: "Frame count: 1", timeoutMs: 2_000 },
			});
			expect(frameAssert.result).toMatchObject({ ok: true, kind: "text" });

			const getFirstRef = async (id: number, method: string, params: Record<string, unknown>): Promise<string> => {
				const response = await readResponseById<{ result?: Array<{ refId: string }> }>(cli.ws, { id, method, params });
				const match = response.result?.[0]?.refId;
				expect(match, JSON.stringify(response, null, 2)).toBeDefined();
				return match ?? "";
			};

			const techmart = await readResponseById<{ result?: { tabId: number; finalUrl: string } }>(cli.ws, {
				id: 220,
				method: "navigate",
				params: { url: `${fixture.baseUrl}/techmart`, newTab: true },
			});
			const techmartTabId = techmart.result?.tabId;
			expect(techmartTabId).toBeDefined();

			const browseRef = await getFirstRef(221, "locate_by_role", {
				tabId: techmartTabId,
				role: "link",
				name: "Browse Catalog",
			});
			await expect(
				readResponseById<{ result?: { ok: boolean; wait?: { finalUrl?: string; timedOut: boolean } } }>(cli.ws, {
					id: 222,
					method: "ref_click",
					params: { tabId: techmartTabId, refId: browseRef, waitMs: 2_000 },
				}),
			).resolves.toMatchObject({ result: { ok: true, wait: { timedOut: false } } });

			const categoryRef = await getFirstRef(223, "locate_by_label", { tabId: techmartTabId, label: "Category" });
			await expect(
				readResponseById(cli.ws, {
					id: 224,
					method: "ref_fill",
					params: { tabId: techmartTabId, refId: categoryRef, value: "Electronics" },
				}),
			).resolves.toMatchObject({ result: { ok: true } });
			await expect(
				readResponseById(cli.ws, {
					id: 225,
					method: "page_assert",
					params: { tabId: techmartTabId, kind: "text", text: "Products: 4", timeoutMs: 2_000 },
				}),
			).resolves.toMatchObject({ result: { ok: true } });

			const sortRef = await getFirstRef(226, "locate_by_label", { tabId: techmartTabId, label: "Sort" });
			await readResponseById(cli.ws, {
				id: 227,
				method: "ref_fill",
				params: { tabId: techmartTabId, refId: sortRef, value: "Low to High" },
			});
			await expect(
				readResponseById(cli.ws, {
					id: 228,
					method: "page_assert",
					params: { tabId: techmartTabId, kind: "text", text: "First product: USB-C Hub", timeoutMs: 2_000 },
				}),
			).resolves.toMatchObject({ result: { ok: true } });

			const selectRef = await getFirstRef(229, "locate_by_role", {
				tabId: techmartTabId,
				role: "button",
				name: "Select USB-C Hub",
			});
			await expect(
				readResponseById<{ result?: { ok: boolean; wait?: { finalUrl?: string; timedOut: boolean } } }>(cli.ws, {
					id: 230,
					method: "ref_click",
					params: { tabId: techmartTabId, refId: selectRef, waitMs: 2_000 },
				}),
			).resolves.toMatchObject({ result: { ok: true, wait: { timedOut: false } } });

			const nameRef = await getFirstRef(231, "locate_by_label", { tabId: techmartTabId, label: "Name" });
			await readResponseById(cli.ws, {
				id: 232,
				method: "ref_fill",
				params: { tabId: techmartTabId, refId: nameRef, value: "Ada Lovelace" },
			});
			const emailRef = await getFirstRef(233, "locate_by_label", { tabId: techmartTabId, label: "Email" });
			await readResponseById(cli.ws, {
				id: 234,
				method: "ref_fill",
				params: { tabId: techmartTabId, refId: emailRef, value: "ada@example.com" },
			});
			const orderRef = await getFirstRef(235, "locate_by_role", { tabId: techmartTabId, role: "button", name: "Place Order" });
			await readResponseById(cli.ws, {
				id: 236,
				method: "ref_click",
				params: { tabId: techmartTabId, refId: orderRef, waitMs: 500 },
			});
			await expect(
				readResponseById(cli.ws, {
					id: 237,
					method: "page_assert",
					params: { tabId: techmartTabId, kind: "text", text: "TM-57F23A8F", timeoutMs: 2_000 },
				}),
			).resolves.toMatchObject({ result: { ok: true } });
		} finally {
			cli.ws.close();
		}
	} finally {
		await context.close();
		await bridge.stop();
		await fixture.close();
	}
});
