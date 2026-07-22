import { expect, type BrowserContext, type CDPSession, type Page, type Worker, test } from "@playwright/test";
import { execFile as execFileCallback } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type {
	ElementInfo,
	ElementPickerCommand,
	ReplOverlayCommand,
	SnapshotInjectionConfig,
	SnapshotInjectionResponse,
} from "@shuvgeist/driver/injected-contracts";
import type { DriverInjectedArtifactBuildSurface } from "../fixtures/driver-injected-artifact-surface.js";
import type { ExtensionInjectedArtifactBuildSurface } from "../fixtures/extension-injected-artifact-surface.js";
import type { InjectedArtifactInvocationSurface } from "../fixtures/injected-artifact-surface.js";
import {
	enableExtensionUserScripts,
	launchExtensionContext,
	openExtensionPage,
} from "../fixtures/extension.js";

const execFile = promisify(execFileCallback);
const DRIVER_SURFACE_GLOBAL = "__SHUVGEIST_DRIVER_INJECTED_ARTIFACT_SURFACE__";
const EXTENSION_SURFACE_GLOBAL = "__SHUVGEIST_EXTENSION_INJECTED_ARTIFACT_SURFACE__";

interface FixtureServer {
	url: string;
	close(): Promise<void>;
}

interface RuntimeEvaluateResponse {
	result?: { value?: unknown; description?: string };
	exceptionDetails?: { text?: string; exception?: { description?: string } };
}

async function createFixtureServer(): Promise<FixtureServer> {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		response.end(`<!doctype html>
<html>
<head>
	<title>Injected artifact fixture</title>
	<style>
		body { margin: 0; font-family: sans-serif; }
		main { padding: 40px; }
		#pick-target { display: block; width: 220px; height: 56px; margin-top: 24px; }
	</style>
</head>
<body>
	<main aria-label="Artifact fixture">
		<h1>Compiled artifact parity</h1>
		<label for="fixture-email">Email</label>
		<input id="fixture-email" name="email" aria-label="Email address" />
		<button id="pick-target" data-testid="pick-target" type="button">Pick this target</button>
	</main>
</body>
</html>`);
	});
	const port = await new Promise<number>((resolvePort, reject) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Could not resolve injected-artifact fixture port"));
				return;
			}
			resolvePort(address.port);
		});
	});
	return {
		url: `http://127.0.0.1:${port}/fixture`,
		close: () =>
			new Promise<void>((resolveClose, reject) => {
				server.close((error) => (error ? reject(error) : resolveClose()));
			}),
	};
}

async function readSnapshotSurface(
	fixturePath: string,
	config: SnapshotInjectionConfig,
	options: { sourceTsx: boolean },
): Promise<InjectedArtifactInvocationSurface> {
	const args = options.sourceTsx
		? ["--import", "tsx", resolve(fixturePath), JSON.stringify(config)]
		: [resolve(fixturePath), JSON.stringify(config)];
	const result = await execFile(process.execPath, args, {
		cwd: process.cwd(),
		maxBuffer: 2 * 1024 * 1024,
	});
	return JSON.parse(result.stdout) as InjectedArtifactInvocationSurface;
}

async function loadChromeBuildSurfaces(page: Page, extensionId: string): Promise<void> {
	await page.evaluate(
		(surfaces) =>
			Promise.all(
				surfaces.map(
					({ sourceUrl, globalName }) =>
						new Promise<void>((resolveLoad, reject) => {
							if ((globalThis as Record<string, unknown>)[globalName]) {
								resolveLoad();
								return;
							}
							const script = document.createElement("script");
							script.type = "module";
							script.src = sourceUrl;
							script.onload = () => resolveLoad();
							script.onerror = () => reject(new Error(`Could not load ${sourceUrl}`));
							document.head.appendChild(script);
						}),
				),
			),
		[
			{
				sourceUrl: `chrome-extension://${extensionId}/driver-injected-artifacts.js`,
				globalName: DRIVER_SURFACE_GLOBAL,
			},
			{
				sourceUrl: `chrome-extension://${extensionId}/extension-injected-artifacts.js`,
				globalName: EXTENSION_SURFACE_GLOBAL,
			},
		],
	);
}

async function getChromeDriverSurfaceInvocation(
	page: Page,
	argument: SnapshotInjectionConfig,
): Promise<InjectedArtifactInvocationSurface> {
	return page.evaluate(
		({ globalName, value }) => {
			const surface = (globalThis as typeof globalThis & Record<string, unknown>)[globalName] as
				| DriverInjectedArtifactBuildSurface
				| undefined;
			if (!surface) throw new Error("Driver injected-artifact Chrome build surface is unavailable");
			return surface.snapshot(value);
		},
		{ globalName: DRIVER_SURFACE_GLOBAL, value: argument },
	);
}

async function getChromeExtensionSurfaceInvocation(
	page: Page,
	kind: "overlay" | "picker",
	argument: ReplOverlayCommand | ElementPickerCommand,
): Promise<InjectedArtifactInvocationSurface> {
	return page.evaluate(
		({ globalName, surfaceKind, value }) => {
			const surface = (globalThis as typeof globalThis & Record<string, unknown>)[globalName] as
				| ExtensionInjectedArtifactBuildSurface
				| undefined;
			if (!surface) throw new Error("Extension injected-artifact Chrome build surface is unavailable");
			if (surfaceKind === "overlay") return surface.overlay(value as ReplOverlayCommand);
			return surface.picker(value as ElementPickerCommand);
		},
		{ globalName: EXTENSION_SURFACE_GLOBAL, surfaceKind: kind, value: argument },
	);
}

async function evaluateWithCdp(session: CDPSession, expression: string): Promise<unknown> {
	const response = (await session.send("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
	})) as RuntimeEvaluateResponse;
	if (response.exceptionDetails) {
		throw new Error(
			response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Runtime.evaluate failed",
		);
	}
	return response.result?.value;
}

async function executeUserScript<T>(
	serviceWorker: Worker,
	tabId: number,
	worldId: string,
	expression: string,
): Promise<T> {
	return serviceWorker.evaluate(
		async ({ targetTabId, targetWorldId, source }: { targetTabId: number; targetWorldId: string; source: string }) => {
			if (typeof chrome.userScripts?.execute !== "function") {
				throw new Error("chrome.userScripts.execute is unavailable");
			}
			try {
				await chrome.userScripts.configureWorld({
					worldId: targetWorldId,
					messaging: true,
					csp: "script-src 'unsafe-eval' 'unsafe-inline'; style-src 'unsafe-inline'; default-src 'none';",
				});
			} catch (error) {
				if (!String(error).toLowerCase().includes("already")) throw error;
			}
			const results = await chrome.userScripts.execute({
				js: [{ code: source }],
				target: { tabId: targetTabId, allFrames: false },
				world: "USER_SCRIPT",
				worldId: targetWorldId,
				injectImmediately: true,
			});
			return results[0]?.result as T;
		},
		{ targetTabId: tabId, targetWorldId: worldId, source: expression },
	);
}

function normalizeSnapshot(value: unknown): Omit<NonNullable<SnapshotInjectionResponse["result"]>, "generatedAt"> {
	const response = value as SnapshotInjectionResponse;
	expect(response.success, response.error).toBe(true);
	expect(response.result).toBeDefined();
	const { generatedAt: _generatedAt, ...normalized } = response.result!;
	return normalized;
}

test.describe("compiled injected artifacts in Chromium", () => {
	test.describe.configure({ mode: "serial" });

	let context: BrowserContext;
	let serviceWorker: Worker;
	let extensionPage: Page;
	let fixturePage: Page;
	let fixtureServer: FixtureServer;
	let tabId: number;

	test.beforeAll(async () => {
		fixtureServer = await createFixtureServer();
		const extension = await launchExtensionContext();
		context = extension.context;
		serviceWorker = await enableExtensionUserScripts(context, extension.extensionId);
		extensionPage = await openExtensionPage(context, extension.extensionId, "test.html");
		await loadChromeBuildSurfaces(extensionPage, extension.extensionId);
		fixturePage = await context.newPage();
		await fixturePage.goto(fixtureServer.url);
		tabId = await serviceWorker.evaluate(async (url: string) => {
			const tabs = await chrome.tabs.query({});
			const target = tabs.find((tab) => tab.url === url);
			if (typeof target?.id !== "number") throw new Error(`Could not find fixture tab for ${url}`);
			return target.id;
		}, fixtureServer.url);
	});

	test.afterAll(async () => {
		await context?.close();
		await fixtureServer?.close();
	});

	test("matches source-tsx, built CLI, and built Chrome snapshot hashes and browser results", async () => {
		const config: SnapshotInjectionConfig = {
			frameId: 0,
			maxEntries: 20,
			includeHidden: false,
			snapshotIdPrefix: "chromium-parity",
		};
		const sourceSurface = await readSnapshotSurface(
			"tests/e2e/fixtures/read-source-injected-surface.ts",
			config,
			{ sourceTsx: true },
		);
		const cliSurface = await readSnapshotSurface(
			"tests/e2e/fixtures/read-built-injected-surface.mjs",
			config,
			{ sourceTsx: false },
		);
		const chromeSurface = await getChromeDriverSurfaceInvocation(extensionPage, config);

		expect(cliSurface.contentHash).toBe(sourceSurface.contentHash);
		expect(chromeSurface.contentHash).toBe(sourceSurface.contentHash);
		expect(cliSurface.artifactVersion).toBe(sourceSurface.artifactVersion);
		expect(chromeSurface.artifactVersion).toBe(sourceSurface.artifactVersion);

		const cdp = await context.newCDPSession(fixturePage);
		const sourceResult = normalizeSnapshot(await evaluateWithCdp(cdp, sourceSurface.expression));
		const cliResult = normalizeSnapshot(await evaluateWithCdp(cdp, cliSurface.expression));
		const chromeResult = normalizeSnapshot(
			await executeUserScript<SnapshotInjectionResponse>(
				serviceWorker,
				tabId,
				"shuvgeist-e2e-snapshot",
				chromeSurface.expression,
			),
		);

		expect(cliResult).toEqual(sourceResult);
		expect(chromeResult).toEqual(sourceResult);
		expect(sourceResult.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ tagName: "button", name: "Pick this target", interactive: true }),
			]),
		);
	});

	test("runs overlay abort and picker selection/cancel cleanup in a real USER_SCRIPT world", async () => {
		const windowId = await serviceWorker.evaluate(
			async (targetTabId: number) => (await chrome.tabs.get(targetTabId)).windowId,
			tabId,
		);
		await extensionPage.evaluate(() => {
			const state = globalThis as typeof globalThis & { __shuvgeistAbortMessages?: unknown[] };
			state.__shuvgeistAbortMessages = [];
			chrome.runtime.onUserScriptMessage.addListener((message: unknown) => {
					if ((message as { type?: string }).type === "agent-runtime-abort-intent") {
					state.__shuvgeistAbortMessages?.push(message);
				}
			});
		});

		const overlay = await getChromeExtensionSurfaceInvocation(extensionPage, "overlay", {
			action: "show",
			taskName: "Chromium artifact task",
			abortIntent: {
				clientId: "sidepanel",
				windowId,
				sessionId: "e2e-session",
				target: { kind: "chrome-tab", tabRef: `window:${windowId}` },
				executionId: "e2e-execution",
				targetRequestId: "e2e-request",
				reason: "e2e-stop",
			},
		});
		await executeUserScript<void>(serviceWorker, tabId, "shuvgeist-e2e-overlay", overlay.expression);
		await expect(fixturePage.locator("#shuvgeist-repl-overlay")).toContainText("Chromium artifact task");
		await fixturePage.getByRole("button", { name: "Stop", exact: true }).click();
		await expect(fixturePage.locator("#shuvgeist-repl-overlay")).toHaveCount(0);
		await expect(fixturePage.locator("#shuvgeist-repl-overlay-styles")).toHaveCount(0);
		await expect
			.poll(() =>
				extensionPage.evaluate(
					() =>
						(globalThis as typeof globalThis & { __shuvgeistAbortMessages?: unknown[] })
							.__shuvgeistAbortMessages?.length ?? 0,
				),
			)
			.toBe(1);

		const picker = await getChromeExtensionSurfaceInvocation(extensionPage, "picker", {
			action: "pick",
			message: "Choose the Chromium target",
		});
		const selection = executeUserScript<ElementInfo | null>(
			serviceWorker,
			tabId,
			"shuvgeist-e2e-picker",
			picker.expression,
		);
		await expect(fixturePage.locator("#shuvgeist-element-picker")).toHaveCount(1);
		await expect(fixturePage.getByText("Choose the Chromium target", { exact: true })).toBeVisible();
		const targetBox = await fixturePage.locator("#pick-target").boundingBox();
		expect(targetBox).not.toBeNull();
		await fixturePage.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2);
		await fixturePage.mouse.click(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2);
		await expect(selection).resolves.toMatchObject({
			selector: "#pick-target",
			tagName: "button",
			text: "Pick this target",
		});
		await expect(fixturePage.locator("#shuvgeist-element-picker")).toHaveCount(0);
		await expect(fixturePage.getByText("Choose the Chromium target", { exact: true })).toHaveCount(0);

		const cancelledSelection = executeUserScript<ElementInfo | null>(
			serviceWorker,
			tabId,
			"shuvgeist-e2e-picker",
			picker.expression,
		);
		await expect(fixturePage.locator("#shuvgeist-element-picker")).toHaveCount(1);
		const cancel = await getChromeExtensionSurfaceInvocation(extensionPage, "picker", { action: "cancel" });
		await executeUserScript<void>(serviceWorker, tabId, "shuvgeist-e2e-picker", cancel.expression);
		await expect(cancelledSelection).resolves.toBeNull();
		await expect(fixturePage.locator("#shuvgeist-element-picker")).toHaveCount(0);
		await expect(fixturePage.getByText("Choose the Chromium target", { exact: true })).toHaveCount(0);

		const cleanup = await executeUserScript<{ active: boolean; overlay: boolean; banner: boolean }>(
			serviceWorker,
			tabId,
			"shuvgeist-e2e-picker",
			"({ active: window.__shuvgeistElementPicker === true, overlay: Boolean(document.getElementById('shuvgeist-element-picker')), banner: document.body.textContent.includes('Choose the Chromium target') })",
		);
		expect(cleanup).toEqual({ active: false, overlay: false, banner: false });
	});
});
