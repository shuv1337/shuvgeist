import { expect, type Page, test } from "@playwright/test";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { WebSocket } from "ws";
import { BridgeServer } from "../../../src/bridge/server.js";
import { openRegisteredClient, readMessage } from "../../helpers/ws-client.js";
import { launchExtensionContext, openExtensionPage } from "../fixtures/extension.js";

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
	const setupProvider = page.getByRole("button", { name: "Set up provider" });
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
  <button id="continue" type="button">Continue</button>
  <form>
    <label for="email">Email</label>
    <input id="email" name="email" aria-label="Email" />
    <button type="submit">Submit</button>
  </form>
  <iframe title="Nested fixture" src="/frame"></iframe>
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
					sensitiveAccessEnabled: false,
				},
			});
		}, { port: bridgePort });
		await expect(page.locator("bridge-tab").getByText("Connected")).toBeVisible({ timeout: 15_000 });

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
			expect(refId).toBeDefined();

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
		} finally {
			cli.ws.close();
		}
	} finally {
		await context.close();
		await bridge.stop();
		await fixture.close();
	}
});
