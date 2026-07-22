import { chromium, type BrowserContext, type CDPSession, type Page, type Worker } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sidepanelDocumentNonce } from "@shuvgeist/extension/agent/sidepanel-context-identity";
import {
	AGENT_RUNTIME_CONNECTIONS_KEY,
	type AgentRuntimeConnectionDescriptor,
} from "@shuvgeist/extension/bridge/internal-messages";

export interface LaunchedExtensionContext {
	context: BrowserContext;
	extensionId: string;
	serviceWorker: Worker;
	close(): Promise<void>;
}

export type ExtensionApiEvaluator = Page | Worker;

export async function launchExtensionContext(): Promise<LaunchedExtensionContext> {
	const extensionPath = path.resolve("dist-chrome");
	const userDataDir = await mkdtemp(path.join(tmpdir(), "shuvgeist-e2e-"));
	let context: BrowserContext | undefined;
	let profileCleanup: Promise<void> | undefined;
	const cleanupProfile = (): Promise<void> => {
		profileCleanup ??= rm(userDataDir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
		return profileCleanup;
	};
	try {
		context = await chromium.launchPersistentContext(userDataDir, {
			channel: "chromium",
			headless: true,
			args: [
				`--disable-extensions-except=${extensionPath}`,
				`--load-extension=${extensionPath}`,
			],
		});
		context.once("close", () => void cleanupProfile().catch(() => undefined));
		let serviceWorker = context.serviceWorkers()[0];
		if (!serviceWorker) {
			serviceWorker = await context.waitForEvent("serviceworker");
		}
		const extensionId = new URL(serviceWorker.url()).host;
		return {
			context,
			extensionId,
			serviceWorker,
			async close() {
				await context?.close();
				await cleanupProfile();
			},
		};
	} catch (error) {
		await context?.close().catch(() => undefined);
		await cleanupProfile().catch(() => undefined);
		throw error;
	}
}

export async function openExtensionPage(context: BrowserContext, extensionId: string, pagePath: string): Promise<Page> {
	if (new URL(pagePath, "https://extension.invalid/").pathname === "/sidepanel.html") {
		throw new Error("E2E tests must open sidepanel.html through openRealExtensionSidePanel()");
	}
	const page = await context.newPage();
	await page.goto(`chrome-extension://${extensionId}/${pagePath}`);
	return page;
}

export async function enableExtensionUserScripts(
	context: BrowserContext,
	extensionId: string,
): Promise<Worker> {
	const settingsPage = await context.newPage();
	try {
		await settingsPage.goto(`chrome://extensions/?id=${extensionId}`);
		const toggle = settingsPage.locator("extensions-toggle-row#allow-user-scripts cr-toggle");
		await toggle.waitFor({ state: "visible" });
		const enabled = await toggle.evaluate((element) => (element as HTMLElement & { checked: boolean }).checked);
		if (!enabled) {
			await toggle.click();
			await settingsPage.waitForFunction(
				() =>
					(document.querySelector("extensions-manager")?.shadowRoot
						?.querySelector("extensions-detail-view")
						?.shadowRoot?.querySelector("extensions-toggle-row#allow-user-scripts")
						?.shadowRoot?.querySelector("cr-toggle") as (HTMLElement & { checked?: boolean }) | null)?.checked === true,
			);
		}
	} finally {
		await settingsPage.close();
	}

	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const workers = context
			.serviceWorkers()
			.filter((worker) => worker.url().startsWith(`chrome-extension://${extensionId}/`))
			.reverse();
		for (const worker of workers) {
			try {
				if (await worker.evaluate(() => typeof chrome.userScripts?.execute === "function")) return worker;
			} catch {
				// Toggling the permission replaces the extension service worker.
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Chrome did not expose userScripts.execute after enabling the extension toggle");
}

export interface ExtensionSidePanelContext {
	contextId: string;
	documentId: string;
	documentOrigin: string;
	documentUrl: string;
	windowId: number;
	tabId: number;
}

export interface ExtensionSidePanelControl {
	readonly page: Page;
	readonly windowId: number;
	open(): Promise<ExtensionSidePanelContext>;
	close(contextId: string): Promise<void>;
}

export interface OpenedExtensionSidePanel {
	control: ExtensionSidePanelControl;
	panel: ExtensionSidePanelContext;
	descriptor: AgentRuntimeConnectionDescriptor;
	windowId: number;
}

export interface ExtensionSidePanelRuntimeProbe {
	artifactsListed: boolean;
	readyState: string;
	sessionId: string;
	title: string;
}

async function waitForValue<T>(
	read: () => Promise<T | undefined>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(message);
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function currentExtensionServiceWorker(
	context: BrowserContext,
	extensionId: string,
): Promise<Worker> {
	return waitForValue(
		async () => {
			for (const worker of context.serviceWorkers().slice().reverse()) {
				if (!worker.url().startsWith(`chrome-extension://${extensionId}/`)) continue;
				try {
					if (await worker.evaluate(() => chrome.runtime.id)) return worker;
				} catch {
					// A replaced service worker can remain in Playwright's context list briefly.
				}
			}
			return undefined;
		},
		10_000,
		"Chrome did not expose a live extension service worker",
	);
}

export async function extensionSidePanelContexts(
	context: BrowserContext,
	extensionId: string,
	evaluator?: ExtensionApiEvaluator,
): Promise<ExtensionSidePanelContext[]> {
	const extensionContext = evaluator ?? (await currentExtensionServiceWorker(context, extensionId));
	const contexts = await extensionContext.evaluate(async () => {
		const expectedUrl = new URL(chrome.runtime.getURL("sidepanel.html"));
		const contexts = await chrome.runtime.getContexts({
			contextTypes: [chrome.runtime.ContextType.SIDE_PANEL],
		});
		return contexts.flatMap((entry) => {
			if (!entry.contextId || !entry.documentId || !entry.documentUrl || !entry.documentOrigin) return [];
			try {
				const actualUrl = new URL(entry.documentUrl);
				if (actualUrl.origin !== expectedUrl.origin || actualUrl.pathname !== expectedUrl.pathname) return [];
			} catch {
				return [];
			}
			return [
				{
					contextId: entry.contextId,
					documentId: entry.documentId,
					documentOrigin: entry.documentOrigin,
					documentUrl: entry.documentUrl,
					windowId: entry.windowId,
					tabId: entry.tabId,
				},
			];
		});
	});
	return contexts;
}

export async function acceptedAgentRuntimeDescriptor(
	evaluator: ExtensionApiEvaluator,
	windowId: number,
): Promise<AgentRuntimeConnectionDescriptor> {
	return waitForValue(
		() =>
			evaluator.evaluate(
				async ({ registryKey, targetWindowId }: { registryKey: string; targetWindowId: number }) => {
					const values = await chrome.storage.session.get(registryKey);
					const registry = values[registryKey];
					if (!registry || typeof registry !== "object" || Array.isArray(registry)) return undefined;
					const entry = (registry as Record<string, unknown>)[JSON.stringify(["sidepanel", targetWindowId])];
					if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
					const descriptor = entry as Partial<AgentRuntimeConnectionDescriptor>;
					if (
						descriptor.clientId !== "sidepanel" ||
						descriptor.windowId !== targetWindowId ||
						typeof descriptor.sessionId !== "string" ||
						!descriptor.target ||
						descriptor.target.kind !== "chrome-tab"
					) {
						return undefined;
					}
					return entry as AgentRuntimeConnectionDescriptor;
				},
				{ registryKey: AGENT_RUNTIME_CONNECTIONS_KEY, targetWindowId: windowId },
			),
		20_000,
		`No accepted agent-runtime descriptor appeared for window ${windowId}`,
	);
}

export async function extensionWindowId(evaluator: ExtensionApiEvaluator): Promise<number> {
	const windowId = await evaluator.evaluate(async () => (await chrome.windows.getLastFocused()).id);
	if (typeof windowId !== "number") throw new Error("Chrome did not expose the focused extension window id");
	return windowId;
}

interface ExtensionCdpTargetInfo {
	targetId: string;
	type: string;
	url: string;
}

function findExtensionSidePanelTarget(
	targets: readonly ExtensionCdpTargetInfo[],
	panel: ExtensionSidePanelContext,
): ExtensionCdpTargetInfo | undefined {
	const expectedUrl = new URL(panel.documentUrl);
	const expectedNonce = sidepanelDocumentNonce(expectedUrl.href);
	if (!expectedNonce) throw new Error(`SIDE_PANEL context URL has no document nonce: ${panel.documentUrl}`);
	return targets.find((candidate) => {
		try {
			const url = new URL(candidate.url);
			return (
				url.origin === expectedUrl.origin &&
				url.pathname === expectedUrl.pathname &&
				sidepanelDocumentNonce(url.href) === expectedNonce
			);
		} catch {
			return false;
		}
	});
}

async function sendAttachedTargetCommand(
	cdp: CDPSession,
	sessionId: string,
	method: string,
	params: Record<string, unknown>,
	timeoutMessage: string,
): Promise<Record<string, unknown>> {
	const commandId = 1;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let onMessage: ((event: { sessionId: string; message: string }) => void) | undefined;
	try {
		return await new Promise<Record<string, unknown>>((resolve, reject) => {
			onMessage = (event): void => {
				if (event.sessionId !== sessionId) return;
				let message: unknown;
				try {
					message = JSON.parse(event.message) as unknown;
				} catch {
					return;
				}
				if (!record(message) || message.id !== commandId) return;
				if (record(message.error)) {
					reject(new Error(String(message.error.message ?? "SIDE_PANEL CDP command failed")));
					return;
				}
				resolve(message);
			};
			cdp.on("Target.receivedMessageFromTarget", onMessage);
			timeout = setTimeout(() => reject(new Error(timeoutMessage)), 5_000);
			void cdp
				.send("Target.sendMessageToTarget", {
					sessionId,
					message: JSON.stringify({ id: commandId, method, params }),
				})
				.catch(reject);
		});
	} finally {
		if (timeout) clearTimeout(timeout);
		if (onMessage) cdp.off("Target.receivedMessageFromTarget", onMessage);
	}
}

export async function evaluateExtensionSidePanel<T>(
	context: BrowserContext,
	panel: ExtensionSidePanelContext,
	expression: string,
): Promise<T> {
	const browser = context.browser();
	if (!browser) throw new Error("Persistent Chromium context has no owning browser");
	const cdp = await browser.newBrowserCDPSession();
	let attachedSessionId: string | undefined;
	try {
		const targets = (await cdp.send("Target.getTargets")) as { targetInfos: ExtensionCdpTargetInfo[] };
		const target = findExtensionSidePanelTarget(targets.targetInfos, panel);
		if (!target) throw new Error(`Could not find the CDP target for SIDE_PANEL ${panel.documentUrl}`);
		const attached = (await cdp.send("Target.attachToTarget", {
			targetId: target.targetId,
			flatten: false,
		})) as { sessionId: string };
		attachedSessionId = attached.sessionId;
		const command = await sendAttachedTargetCommand(
			cdp,
			attachedSessionId,
			"Runtime.evaluate",
			{ expression, awaitPromise: true, returnByValue: true },
			"Timed out evaluating the SIDE_PANEL document",
		);
		const result = record(command.result) ? command.result : undefined;
		if (!result) throw new Error("SIDE_PANEL Runtime.evaluate returned no result");
		if (record(result.exceptionDetails)) {
			const exception = record(result.exceptionDetails.exception) ? result.exceptionDetails.exception : undefined;
			const detail =
				(typeof exception?.description === "string" && exception.description) ||
				(typeof result.exceptionDetails.text === "string" && result.exceptionDetails.text) ||
				"unknown exception";
			throw new Error(`SIDE_PANEL Runtime.evaluate raised an exception: ${detail}`);
		}
		const remote = record(result.result) ? result.result : undefined;
		return remote?.value as T;
	} finally {
		if (attachedSessionId) {
			await cdp.send("Target.detachFromTarget", { sessionId: attachedSessionId }).catch(() => undefined);
		}
		await cdp.detach();
	}
}

export async function waitForExtensionSidePanelRuntime(
	context: BrowserContext,
	panel: ExtensionSidePanelContext,
	expectedSessionId: string,
): Promise<ExtensionSidePanelRuntimeProbe> {
	let lastFailure = "no runtime probe completed";
	try {
		return await waitForValue(
			async () => {
				try {
					const probe = await evaluateExtensionSidePanel<ExtensionSidePanelRuntimeProbe>(
						context,
						panel,
						`(async () => {
							const panel = document.querySelector("pi-chat-panel, shuvpi-chat-panel");
							const client = panel?.agent?.client;
							if (!client) throw new Error("SIDE_PANEL remote runtime client is unavailable");
							const result = await client.executeArtifacts({ action: "list" });
							return {
								artifactsListed: Array.isArray(result?.artifacts),
								readyState: document.readyState,
								sessionId: new URL(location.href).searchParams.get("session"),
								title: document.title,
							};
						})()`,
					);
					if (
						probe.sessionId !== expectedSessionId ||
						!probe.artifactsListed ||
						probe.readyState !== "complete"
					) {
						lastFailure = `unexpected probe ${JSON.stringify(probe)}`;
						return undefined;
					}
					return probe;
				} catch (error) {
					lastFailure = error instanceof Error ? error.message : String(error);
					return undefined;
				}
			},
			20_000,
			`SIDE_PANEL runtime ${expectedSessionId} did not become ready`,
		);
	} catch (error) {
		throw new Error(`SIDE_PANEL runtime ${expectedSessionId} did not become ready: ${lastFailure}`, { cause: error });
	}
}

export async function waitForNoExtensionSidePanels(
	context: BrowserContext,
	extensionId: string,
	stabilityMs = 500,
	evaluator?: ExtensionApiEvaluator,
): Promise<void> {
	const deadline = Date.now() + 15_000;
	let emptySince: number | undefined;
	let lastContexts: ExtensionSidePanelContext[] = [];
	while (Date.now() < deadline) {
		lastContexts = await extensionSidePanelContexts(context, extensionId, evaluator);
		if (lastContexts.length === 0) {
			emptySince ??= Date.now();
			if (Date.now() - emptySince >= stabilityMs) return;
		} else {
			emptySince = undefined;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`SIDE_PANEL contexts remained after close: ${JSON.stringify(lastContexts)}`);
}

/**
 * Creates a trusted extension-page click surface for opening a real Chrome
 * SIDE_PANEL. Calling chrome.sidePanel.open() from serviceWorker.evaluate()
 * is correctly rejected because it lacks a user gesture, while Playwright's
 * trusted click retains the activation required by Chrome.
 */
export async function createExtensionSidePanelControl(
	context: BrowserContext,
	extensionId: string,
	windowId: number,
	evaluator?: ExtensionApiEvaluator,
): Promise<ExtensionSidePanelControl> {
	const extensionContext = evaluator ?? (await currentExtensionServiceWorker(context, extensionId));
	const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const controlUrl = `chrome-extension://${extensionId}/debug.html?sidepanel-control=${nonce}`;
	await extensionContext.evaluate(
		async ({ targetWindowId, url }: { targetWindowId: number; url: string }) => {
			await chrome.tabs.create({ windowId: targetWindowId, url, active: true });
		},
		{ targetWindowId: windowId, url: controlUrl },
	);
	const page = await waitForValue(
		async () => context.pages().find((candidate) => candidate.url() === controlUrl),
		10_000,
		`Chrome did not create the side-panel control page for window ${windowId}`,
	);
	await page.evaluate((targetWindowId) => {
		const sidePanel = chrome.sidePanel as typeof chrome.sidePanel & {
			close(options: { windowId: number }): Promise<void>;
		};
		const addButton = (id: string, action: () => Promise<void>): void => {
			const button = document.createElement("button");
			button.id = id;
			button.textContent = id;
			button.style.position = "fixed";
			button.style.inset = id.endsWith("open") ? "8px auto auto 8px" : "8px auto auto 160px";
			button.style.zIndex = "2147483647";
			button.addEventListener("click", () => void action());
			document.body.appendChild(button);
		};
		addButton("shuvgeist-e2e-sidepanel-open", () => chrome.sidePanel.open({ windowId: targetWindowId }));
		addButton("shuvgeist-e2e-sidepanel-close", () => sidePanel.close({ windowId: targetWindowId }));
	}, windowId);

	return {
		page,
		windowId,
		async open() {
			const previousContextIds = new Set(
				(await extensionSidePanelContexts(context, extensionId, page)).map((entry) => entry.contextId),
			);
			const eventKey = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
			await page.evaluate((key) => {
				const state = globalThis as typeof globalThis & {
					__shuvgeistE2eSidePanelOpened?: Record<string, Array<{ path: string; windowId: number }>>;
				};
				state.__shuvgeistE2eSidePanelOpened ??= {};
				state.__shuvgeistE2eSidePanelOpened[key] = [];
				const listener = (info: chrome.sidePanel.PanelOpenedInfo): void => {
					state.__shuvgeistE2eSidePanelOpened?.[key]?.push({ path: info.path, windowId: info.windowId });
					chrome.sidePanel.onOpened.removeListener(listener);
				};
				chrome.sidePanel.onOpened.addListener(listener);
			}, eventKey);
			await page.bringToFront();
			await page.locator("#shuvgeist-e2e-sidepanel-open").click();
			const openedContext = await waitForValue(
				async () => {
					const matches = (await extensionSidePanelContexts(context, extensionId, page)).filter(
						(entry) =>
							!previousContextIds.has(entry.contextId) &&
							sidepanelDocumentNonce(entry.documentUrl) !== undefined,
					);
					if (matches.length > 1) {
						throw new Error(`Multiple SIDE_PANEL contexts appeared for window ${windowId}`);
					}
					return matches[0];
				},
				15_000,
				`Chrome did not create a real SIDE_PANEL context for window ${windowId}`,
			);
			const openedInfo = await waitForValue(
				() =>
					page.evaluate((key) => {
						const state = globalThis as typeof globalThis & {
							__shuvgeistE2eSidePanelOpened?: Record<string, Array<{ path: string; windowId: number }>>;
						};
						return state.__shuvgeistE2eSidePanelOpened?.[key]?.[0];
					}, eventKey),
				5_000,
				`Chrome did not emit sidePanel.onOpened for window ${windowId}`,
			);
			await page.evaluate((key) => {
				const state = globalThis as typeof globalThis & {
					__shuvgeistE2eSidePanelOpened?: Record<string, Array<{ path: string; windowId: number }>>;
				};
				if (state.__shuvgeistE2eSidePanelOpened) delete state.__shuvgeistE2eSidePanelOpened[key];
			}, eventKey);
			if (openedInfo.path !== "/sidepanel.html" || openedInfo.windowId !== windowId) {
				throw new Error(
					`sidePanel.onOpened identity mismatch: ${JSON.stringify(openedInfo)}; expected window ${windowId}`,
				);
			}
			return openedContext;
		},
		async close(contextId) {
			await page.bringToFront();
			await page.locator("#shuvgeist-e2e-sidepanel-close").click();
			await waitForValue(
				async () =>
					(await extensionSidePanelContexts(context, extensionId, page)).some(
						(entry) => entry.contextId === contextId,
					)
						? undefined
						: true,
				15_000,
				`Chrome did not close SIDE_PANEL context ${contextId}`,
			);
		},
	};
}

export async function openRealExtensionSidePanel(
	context: BrowserContext,
	extensionId: string,
	evaluator?: ExtensionApiEvaluator,
): Promise<OpenedExtensionSidePanel> {
	const extensionContext = evaluator ?? (await currentExtensionServiceWorker(context, extensionId));
	const windowId = await extensionWindowId(extensionContext);
	const control = await createExtensionSidePanelControl(context, extensionId, windowId, extensionContext);
	const panel = await control.open();
	const descriptor = await acceptedAgentRuntimeDescriptor(control.page, windowId);
	return { control, panel, descriptor, windowId };
}
