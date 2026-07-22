import { expect, test } from "@playwright/test";
import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BridgeServerStatus } from "@shuvgeist/protocol/protocol";
import { BridgeServer } from "@shuvgeist/server/server";
import {
	enableExtensionUserScripts,
	launchExtensionContext,
	openRealExtensionSidePanel,
	waitForExtensionSidePanelRuntime,
} from "../fixtures/extension.js";

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

async function createFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
	const server = createServer((req, res) => {
		const url = req.url ?? "/";
		res.writeHead(200, { "Content-Type": "text/html" });
		if (url.startsWith("/a")) {
			res.end(`<!doctype html><html><head><title>SG-CLOSE-TEST-A</title></head><body><h1>A</h1></body></html>`);
			return;
		}
		if (url.startsWith("/b")) {
			res.end(`<!doctype html><html><head><title>SG-CLOSE-TEST-B</title></head><body><h1>B</h1></body></html>`);
			return;
		}
		if (url.startsWith("/c")) {
			res.end(`<!doctype html><html><head><title>SG-CLOSE-TEST-C</title></head><body><h1>C</h1></body></html>`);
			return;
		}
		res.end(`<!doctype html><html><head><title>SG-CLOSE-TEST</title></head><body>ok</body></html>`);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("failed to bind fixture server");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			}),
	};
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
		if (!isExecFileFailure(error)) throw error;
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

test("tabs close by id and filter leave sibling tabs alive", async () => {
	const bridgePort = await getAvailablePort();
	const bridge = new BridgeServer({ host: "127.0.0.1", port: bridgePort, token: "playwright-token" });
	const fixture = await createFixtureServer();
	await bridge.start();

	const extension = await launchExtensionContext();

	try {
		const worker = await enableExtensionUserScripts(extension.context, extension.extensionId);
		await worker.evaluate(
			async ({ port, token }: { port: number; token: string }) => {
				await chrome.storage.local.set({
					bridge_settings: {
						enabled: true,
						url: `ws://127.0.0.1:${port}/ws`,
						token,
						sensitiveAccessEnabled: false,
					},
				});
			},
			{ port: bridgePort, token: "playwright-token" },
		);
		const opened = await openRealExtensionSidePanel(extension.context, extension.extensionId, worker);
		expect(opened.descriptor).toMatchObject({
			clientId: "sidepanel",
			windowId: opened.windowId,
			target: { kind: "chrome-tab", tabRef: `window:${opened.windowId}` },
		});
		await waitForExtensionSidePanelRuntime(extension.context, opened.panel, opened.descriptor.sessionId);

		const statusResult = await runCli(bridgePort, ["status", "--json"]);
		expect(statusResult.code, statusResult.stderr).toBe(0);
		const status = parseCliJson<BridgeServerStatus>(statusResult);
		expect(status.extension.connected).toBe(true);
		if (!status.extension.connected) throw new Error(JSON.stringify(status, null, 2));
		expect(status.extension.windowId).toBe(opened.windowId);

		const openTab = async (path: string) => {
			const result = await runCli(bridgePort, ["navigate", `${fixture.baseUrl}${path}`, "--new-tab", "--json"]);
			expect(result.code, result.stderr + result.stdout).toBe(0);
			return parseCliJson<{ tabId: number }>(result).tabId;
		};

		const idA = await openTab("/a");
		const idB = await openTab("/b");
		const idC = await openTab("/c");
		expect(idA).toBeGreaterThan(0);
		expect(idB).toBeGreaterThan(0);
		expect(idC).toBeGreaterThan(0);

		const listed = await runCli(bridgePort, ["tabs", "--json"]);
		expect(listed.code, listed.stderr).toBe(0);
		const listPayload = parseCliJson<{
			tabs: Array<{ id: number; windowId: number; title: string }>;
			windows?: Array<{ id: number; tabCount: number }>;
		}>(listed);
		const listedIds = new Set(listPayload.tabs.map((t) => t.id));
		expect(listedIds.has(idA)).toBe(true);
		expect(listedIds.has(idB)).toBe(true);
		expect(listedIds.has(idC)).toBe(true);
		expect(listPayload.tabs.every((t) => typeof t.windowId === "number")).toBe(true);

		const closedMiddle = await runCli(bridgePort, ["tabs", "close", String(idB), "--json"]);
		expect(closedMiddle.code, closedMiddle.stderr + closedMiddle.stdout).toBe(0);
		const closePayload = parseCliJson<{ closedTabIds: number[]; ok?: boolean }>(closedMiddle);
		expect(closePayload.closedTabIds).toEqual([idB]);

		const afterClose = await runCli(bridgePort, ["tabs", "--json"]);
		expect(afterClose.code).toBe(0);
		const afterIds = new Set(
			parseCliJson<{ tabs: Array<{ id: number }> }>(afterClose).tabs.map((t) => t.id),
		);
		expect(afterIds.has(idA)).toBe(true);
		expect(afterIds.has(idB)).toBe(false);
		expect(afterIds.has(idC)).toBe(true);

		// Filter dry-run does not remove
		const dryRun = await runCli(bridgePort, [
			"tabs",
			"close",
			"--title-match",
			"SG-CLOSE-TEST",
			"--dry-run",
			"--json",
		]);
		expect(dryRun.code, dryRun.stderr + dryRun.stdout).toBe(0);
		const dryPayload = parseCliJson<{ closedTabIds: number[]; dryRun?: boolean }>(dryRun);
		expect(dryPayload.dryRun).toBe(true);
		expect(dryPayload.closedTabIds.length).toBeGreaterThanOrEqual(2);
		expect(dryPayload.closedTabIds).toEqual(expect.arrayContaining([idA, idC]));
		expect(dryPayload.closedTabIds).not.toContain(idB);

		const stillThere = await runCli(bridgePort, ["tabs", "--json"]);
		const stillIds = new Set(
			parseCliJson<{ tabs: Array<{ id: number }> }>(stillThere).tabs.map((t) => t.id),
		);
		expect(stillIds.has(idA)).toBe(true);
		expect(stillIds.has(idC)).toBe(true);

		// Filter apply with --yes
		const filterClose = await runCli(bridgePort, [
			"tabs",
			"close",
			"--title-match",
			"SG-CLOSE-TEST",
			"--yes",
			"--json",
		]);
		expect(filterClose.code, filterClose.stderr + filterClose.stdout).toBe(0);
		const filterPayload = parseCliJson<{ closedTabIds: number[] }>(filterClose);
		expect(filterPayload.closedTabIds).toEqual(expect.arrayContaining([idA, idC]));

		const finalList = await runCli(bridgePort, ["tabs", "--json"]);
		const finalIds = new Set(
			parseCliJson<{ tabs: Array<{ id: number }> }>(finalList).tabs.map((t) => t.id),
		);
		expect(finalIds.has(idA)).toBe(false);
		expect(finalIds.has(idC)).toBe(false);
	} finally {
		await extension.close();
		await bridge.stop();
		await fixture.close();
	}
});
