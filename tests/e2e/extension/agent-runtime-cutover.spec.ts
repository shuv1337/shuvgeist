import { expect, test, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { WebSocket, type RawData } from "ws";
import { BridgeServer } from "@shuvgeist/server/server";
import {
	BRIDGE_PROTOCOL_MIN_VERSION,
	BRIDGE_PROTOCOL_VERSION,
	type BridgeRequest,
} from "@shuvgeist/protocol/protocol";
import {
	createExtensionSidePanelControl,
	enableExtensionUserScripts,
	extensionSidePanelContexts,
	launchExtensionContext,
	type ExtensionApiEvaluator,
	type ExtensionSidePanelContext,
	type LaunchedExtensionContext,
	waitForNoExtensionSidePanels,
} from "../fixtures/extension.js";

interface CutoverFixture {
	baseUrl: string;
	telemetryPayloads: unknown[];
	close(): Promise<void>;
}

interface ChromePageIdentity {
	tabId: number;
	windowId: number;
}

interface AcceptedRuntimeDescriptor {
	clientId: string;
	windowId: number;
	sessionId: string;
	target: Record<string, unknown>;
}

interface RawBridgeResponse<T> {
	id: number;
	result?: T;
	error?: { code: number; message: string };
}

interface ReplResult {
	output: string;
	files: Array<{ fileName: string; mimeType: string; size: number; contentBase64: string }>;
}

interface SessionHistoryResult {
	sessionId?: string;
	messages: Array<{ role: string; text: string }>;
}

interface SessionInjectResult {
	ok: true;
	sessionId: string;
	messageIndex: number;
}

interface SidePanelRuntimeProbe {
	sessionId: string;
	artifactsListed: boolean;
}

interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	attributes: Array<{ key: string; value: Record<string, unknown> }>;
}

interface PendingInboxRead {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

class WebSocketInbox {
	private readonly queue: unknown[] = [];
	private pending: PendingInboxRead | undefined;
	private terminalError: Error | undefined;

	constructor(readonly ws: WebSocket) {
		ws.on("message", this.handleMessage);
		ws.on("error", this.handleError);
		ws.on("close", this.handleClose);
	}

	private readonly handleMessage = (data: RawData): void => {
		let message: unknown;
		try {
			const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
			message = JSON.parse(bytes.toString("utf-8")) as unknown;
		} catch (error) {
			this.fail(new Error(`Bridge WebSocket emitted malformed JSON: ${error instanceof Error ? error.message : String(error)}`));
			return;
		}
		if (!this.pending) {
			this.queue.push(message);
			return;
		}
		const pending = this.pending;
		this.pending = undefined;
		clearTimeout(pending.timer);
		pending.resolve(message);
	};

	private readonly handleError = (error: Error): void => this.fail(error);

	private readonly handleClose = (code: number, reason: Buffer): void => {
		this.fail(new Error(`Bridge WebSocket closed (${code}): ${reason.toString("utf-8") || "no reason"}`));
	};

	private fail(error: Error): void {
		this.terminalError ??= error;
		if (!this.pending) return;
		const pending = this.pending;
		this.pending = undefined;
		clearTimeout(pending.timer);
		pending.reject(this.terminalError);
	}

	private read(timeoutMs: number, timeoutMessage: string): Promise<unknown> {
		const queued = this.queue.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		if (this.terminalError) return Promise.reject(this.terminalError);
		if (this.pending) return Promise.reject(new Error("Bridge WebSocket inbox already has a pending reader"));
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending?.timer !== timer) return;
				this.pending = undefined;
				reject(new Error(timeoutMessage));
			}, timeoutMs);
			this.pending = { resolve, reject, timer };
		});
	}

	async waitFor(
		predicate: (message: unknown) => boolean,
		timeoutMs: number,
		timeoutMessage: string,
	): Promise<unknown> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(timeoutMessage);
			const message = await this.read(remaining, timeoutMessage);
			if (predicate(message)) return message;
		}
	}

	dispose(): void {
		this.ws.off("message", this.handleMessage);
		this.ws.off("error", this.handleError);
		this.ws.off("close", this.handleClose);
		this.fail(new Error("Bridge WebSocket inbox was disposed"));
	}
}

interface RegisteredCutoverClient {
	ws: WebSocket;
	inbox: WebSocketInbox;
	registerResult: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function waitForValue<T>(
	read: () => Promise<T | undefined> | T | undefined,
	timeoutMs: number,
	message: string | (() => string),
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(typeof message === "string" ? message : message());
}

async function getAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createNetServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("failed to resolve fixture port"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});
}

async function requestBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf-8");
}

function writeHtml(response: ServerResponse, title: string): void {
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	response.end(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>`);
}

async function createCutoverFixture(): Promise<CutoverFixture> {
	const telemetryPayloads: unknown[] = [];
	const server = createHttpServer((request, response) => {
		response.setHeader("access-control-allow-origin", "*");
		response.setHeader("access-control-allow-headers", "authorization, content-type");
		if (request.method === "OPTIONS") {
			response.writeHead(204);
			response.end();
			return;
		}
		const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
		if (request.method === "POST" && pathname === "/v1/traces") {
			void (async () => {
				try {
					const body = await requestBody(request);
					telemetryPayloads.push(JSON.parse(body) as unknown);
					response.writeHead(200, { "content-type": "application/json" });
					response.end("{}");
				} catch (error) {
					response.writeHead(400, { "content-type": "text/plain" });
					response.end(error instanceof Error ? error.message : String(error));
				}
			})();
			return;
		}
		if (pathname === "/window-a") {
			writeHtml(response, "Cutover window A");
			return;
		}
		if (pathname === "/window-b") {
			writeHtml(response, "Cutover window B");
			return;
		}
		if (pathname === "/foreign-attempt") {
			writeHtml(response, "Foreign navigation should not happen");
			return;
		}
		response.writeHead(404);
		response.end("not found");
	});
	const port = await new Promise<number>((resolve, reject) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("failed to resolve cutover fixture port"));
				return;
			}
			resolve(address.port);
		});
	});
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		telemetryPayloads,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}

async function pageIdentity(evaluator: ExtensionApiEvaluator, url: string): Promise<ChromePageIdentity> {
	return waitForValue(
		async () =>
			evaluator.evaluate(async (expectedUrl) => {
				const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === expectedUrl);
				return typeof tab?.id === "number" && typeof tab.windowId === "number"
					? { tabId: tab.id, windowId: tab.windowId }
					: undefined;
			}, url),
		10_000,
		`Chrome did not expose a tab for ${url}`,
	);
}

async function activatePage(evaluator: ExtensionApiEvaluator, page: Page, identity: ChromePageIdentity): Promise<void> {
	await evaluator.evaluate(async ({ tabId, windowId }) => {
		await chrome.windows.update(windowId, { focused: true });
		await chrome.tabs.update(tabId, { active: true });
	}, identity);
	await page.bringToFront();
}

async function acceptedDescriptor(
	evaluator: ExtensionApiEvaluator,
	windowId: number,
): Promise<AcceptedRuntimeDescriptor> {
	return waitForValue(
		() =>
			evaluator.evaluate(async (targetWindowId) => {
				const values = await chrome.storage.session.get("agent_runtime_connections");
				const registry = values.agent_runtime_connections;
				if (!registry || typeof registry !== "object" || Array.isArray(registry)) return undefined;
				const descriptor = (registry as Record<string, unknown>)[JSON.stringify(["sidepanel", targetWindowId])];
				if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return undefined;
				const value = descriptor as Record<string, unknown>;
				if (
					value.clientId !== "sidepanel" ||
					value.windowId !== targetWindowId ||
					typeof value.sessionId !== "string" ||
					!value.target ||
					typeof value.target !== "object" ||
					Array.isArray(value.target)
				) {
					return undefined;
				}
				return {
					clientId: value.clientId,
					windowId: value.windowId,
					sessionId: value.sessionId,
					target: value.target as Record<string, unknown>,
				};
			}, windowId),
		20_000,
		`No accepted agent-runtime descriptor appeared for window ${windowId}`,
	);
}

async function waitForBridgeWindow(
	bridgePort: number,
	windowId: number,
	minimumExtensionCount: number,
): Promise<void> {
	let lastStatus: unknown;
	try {
		await waitForValue(
			async () => {
				const response = await fetch(`http://127.0.0.1:${bridgePort}/status`);
				if (!response.ok) return undefined;
				const value = (await response.json()) as unknown;
				lastStatus = value;
				if (!record(value) || !record(value.extension) || !record(value.clients)) return undefined;
				const capabilities = value.extension.capabilities;
				return value.extension.connected === true &&
					value.extension.windowId === windowId &&
					Array.isArray(capabilities) &&
					capabilities.includes("repl") &&
					typeof value.clients.extension === "number" &&
					value.clients.extension >= minimumExtensionCount
					? true
					: undefined;
			},
			20_000,
			`Bridge did not expose the REPL-capable extension for window ${windowId}`,
		);
	} catch (error) {
		throw new Error(
			`Bridge did not expose the REPL-capable extension for window ${windowId}; last status: ${JSON.stringify(lastStatus)}`,
			{ cause: error },
		);
	}
}

async function openCutoverClient(url: string, token: string): Promise<RegisteredCutoverClient> {
	const ws = new WebSocket(url);
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			ws.terminate();
			reject(new Error("Timed out opening the cutover CLI WebSocket"));
		}, 10_000);
		const cleanup = (): void => {
			clearTimeout(timeout);
			ws.off("open", handleOpen);
			ws.off("error", handleError);
			ws.off("close", handleClose);
		};
		const handleOpen = (): void => {
			cleanup();
			resolve();
		};
		const handleError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const handleClose = (code: number, reason: Buffer): void => {
			cleanup();
			reject(new Error(`Bridge WebSocket closed before registration (${code}): ${reason.toString("utf-8")}`));
		};
		ws.on("open", handleOpen);
		ws.on("error", handleError);
		ws.on("close", handleClose);
	});
	const inbox = new WebSocketInbox(ws);
	try {
		ws.send(
			JSON.stringify({
				type: "register",
				role: "cli",
				token,
				protocolVersion: BRIDGE_PROTOCOL_VERSION,
				minProtocolVersion: BRIDGE_PROTOCOL_MIN_VERSION,
				appVersion: "test",
				name: "agent-runtime-cutover",
			}),
		);
		const registerResult = await inbox.waitFor(
			(message) => record(message) && message.type === "register_result",
			10_000,
			"Bridge did not acknowledge the cutover CLI registration",
		);
		return { ws, inbox, registerResult };
	} catch (error) {
		inbox.dispose();
		ws.close();
		throw error;
	}
}

async function sendBridgeRequest<T>(
	client: RegisteredCutoverClient,
	request: BridgeRequest,
): Promise<RawBridgeResponse<T>> {
	client.ws.send(JSON.stringify(request));
	return (await client.inbox.waitFor(
		(message) => record(message) && message.id === request.id,
		20_000,
		`Bridge did not respond to ${request.method} request ${request.id}`,
	)) as RawBridgeResponse<T>;
}

function otlpSpans(payloads: readonly unknown[]): OtlpSpan[] {
	const spans: OtlpSpan[] = [];
	for (const payload of payloads) {
		if (!record(payload) || !Array.isArray(payload.resourceSpans)) continue;
		for (const resourceSpan of payload.resourceSpans) {
			if (!record(resourceSpan) || !Array.isArray(resourceSpan.scopeSpans)) continue;
			for (const scopeSpan of resourceSpan.scopeSpans) {
				if (!record(scopeSpan) || !Array.isArray(scopeSpan.spans)) continue;
				for (const span of scopeSpan.spans) {
					if (
						!record(span) ||
						typeof span.traceId !== "string" ||
						typeof span.spanId !== "string" ||
						typeof span.name !== "string" ||
						!Array.isArray(span.attributes)
					) {
						continue;
					}
					const attributes = span.attributes.filter(
						(entry): entry is { key: string; value: Record<string, unknown> } =>
							record(entry) && typeof entry.key === "string" && record(entry.value),
					);
					spans.push({
						traceId: span.traceId,
						spanId: span.spanId,
						...(typeof span.parentSpanId === "string" ? { parentSpanId: span.parentSpanId } : {}),
						name: span.name,
						attributes,
					});
				}
			}
		}
	}
	return spans;
}

function spanAttribute(span: OtlpSpan, key: string): Record<string, unknown> | undefined {
	return span.attributes.find((attribute) => attribute.key === key)?.value;
}

async function stopExtensionServiceWorker(context: BrowserContext, extensionId: string): Promise<void> {
	const browser = context.browser();
	if (!browser) throw new Error("Persistent Chromium context has no owning browser");
	const cdp = await browser.newBrowserCDPSession();
	try {
		const targets = (await cdp.send("Target.getTargets")) as {
			targetInfos: Array<{ targetId: string; type: string; url: string }>;
		};
		const target = targets.targetInfos.find(
			(candidate) =>
				candidate.type === "service_worker" && candidate.url.startsWith(`chrome-extension://${extensionId}/`),
		);
		if (!target) throw new Error("Could not find the extension service-worker CDP target");
		const result = (await cdp.send("Target.closeTarget", { targetId: target.targetId })) as { success: boolean };
		if (!result.success) throw new Error(`Chrome refused to close service-worker target ${target.targetId}`);
	} finally {
		await cdp.detach();
	}
}

interface CdpTargetInfo {
	targetId: string;
	type: string;
	url: string;
}

function findSidePanelTarget(targets: readonly CdpTargetInfo[], panel: { documentUrl: string }): CdpTargetInfo | undefined {
	const expectedUrl = new URL(panel.documentUrl);
	const expectedNonce = expectedUrl.searchParams.get("shuvgeistContext");
	if (!expectedNonce) throw new Error("SIDE_PANEL context URL has no document nonce");
	return targets.find((candidate) => {
		try {
			const url = new URL(candidate.url);
			return (
				url.origin === expectedUrl.origin &&
				url.pathname === expectedUrl.pathname &&
				url.searchParams.get("shuvgeistContext") === expectedNonce
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
			timeout = setTimeout(() => reject(new Error(timeoutMessage)), 2_000);
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

async function probeSidePanelRuntime(
	context: BrowserContext,
	panel: { documentUrl: string },
): Promise<SidePanelRuntimeProbe> {
	const browser = context.browser();
	if (!browser) throw new Error("Persistent Chromium context has no owning browser");
	const cdp = await browser.newBrowserCDPSession();
	let attachedSessionId: string | undefined;
	try {
		const targets = (await cdp.send("Target.getTargets")) as {
			targetInfos: CdpTargetInfo[];
		};
		const target = findSidePanelTarget(targets.targetInfos, panel);
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
			{
				expression: `(async () => {
						const panel = document.querySelector("pi-chat-panel, shuvpi-chat-panel");
						const client = panel?.agent?.client;
						if (!client) {
							throw new Error("SIDE_PANEL remote runtime client is unavailable: " + JSON.stringify({
								href: location.href,
								readyState: document.readyState,
								panelExists: Boolean(panel),
								agentExists: Boolean(panel?.agent),
								bodyText: document.body.innerText.slice(0, 300),
							}));
						}
						const result = await client.executeArtifacts({ action: "list" });
						return {
							sessionId: new URL(location.href).searchParams.get("session"),
							artifactsListed: Array.isArray(result?.artifacts),
						};
					})()`,
				awaitPromise: true,
				returnByValue: true,
			},
			"Timed out probing the SIDE_PANEL runtime client",
		);
		const result = record(command.result) ? command.result : undefined;
		if (!result) throw new Error("SIDE_PANEL runtime probe returned no result");
		if (record(result.exceptionDetails)) {
			const exception = record(result.exceptionDetails.exception) ? result.exceptionDetails.exception : undefined;
			const detail =
				(typeof exception?.description === "string" && exception.description) ||
				(typeof result.exceptionDetails.text === "string" && result.exceptionDetails.text) ||
				"unknown exception";
			throw new Error(`SIDE_PANEL runtime probe raised an exception: ${detail}`);
		}
		const remote = record(result.result) ? result.result : undefined;
		const value = remote && record(remote.value) ? remote.value : undefined;
		if (!value || typeof value.sessionId !== "string" || typeof value.artifactsListed !== "boolean") {
			throw new Error("SIDE_PANEL runtime probe returned a malformed result");
		}
		return { sessionId: value.sessionId, artifactsListed: value.artifactsListed };
	} finally {
		if (attachedSessionId) {
			await cdp.send("Target.detachFromTarget", { sessionId: attachedSessionId }).catch(() => undefined);
		}
		await cdp.detach();
	}
}

async function reloadSidePanelDocument(
	context: BrowserContext,
	extensionId: string,
	evaluator: ExtensionApiEvaluator,
	panel: ExtensionSidePanelContext,
): Promise<ExtensionSidePanelContext> {
	const browser = context.browser();
	if (!browser) throw new Error("Persistent Chromium context has no owning browser");
	const previousContexts = await extensionSidePanelContexts(context, extensionId, evaluator);
	const previousDocumentIds = new Set(previousContexts.map((entry) => entry.documentId));
	const currentPanel = previousContexts.find((entry) => entry.contextId === panel.contextId);
	if (!currentPanel) throw new Error(`Chrome no longer exposes SIDE_PANEL context ${panel.contextId} before reload`);
	const previousUrl = new URL(currentPanel.documentUrl);
	const previousNonce = previousUrl.searchParams.get("shuvgeistContext");
	if (!previousNonce) throw new Error("SIDE_PANEL context URL has no document nonce before reload");
	const previousSessionId = previousUrl.searchParams.get("session");
	if (!previousSessionId) throw new Error("SIDE_PANEL context URL has no session before reload");
	const cdp = await browser.newBrowserCDPSession();
	let attachedSessionId: string | undefined;
	try {
		const targets = (await cdp.send("Target.getTargets")) as { targetInfos: CdpTargetInfo[] };
		const target = findSidePanelTarget(targets.targetInfos, currentPanel);
		if (!target) throw new Error(`Could not find the CDP target for SIDE_PANEL ${currentPanel.documentUrl}`);
		const attached = (await cdp.send("Target.attachToTarget", {
			targetId: target.targetId,
			flatten: false,
		})) as { sessionId: string };
		attachedSessionId = attached.sessionId;
		await sendAttachedTargetCommand(
			cdp,
			attachedSessionId,
			"Page.reload",
			{ ignoreCache: true },
			"Timed out reloading the SIDE_PANEL document",
		);
	} finally {
		if (attachedSessionId) {
			await cdp.send("Target.detachFromTarget", { sessionId: attachedSessionId }).catch(() => undefined);
		}
		await cdp.detach();
	}
	let lastContexts = previousContexts;
	return waitForValue(
		async () => {
			lastContexts = await extensionSidePanelContexts(context, extensionId, evaluator);
			const candidates = lastContexts.filter((entry) => {
				if (entry.contextId === panel.contextId || previousDocumentIds.has(entry.documentId)) return false;
				try {
					const url = new URL(entry.documentUrl);
					const nonce = url.searchParams.get("shuvgeistContext");
					return (
						url.searchParams.get("session") === previousSessionId &&
						typeof nonce === "string" &&
						nonce.length > 0 &&
						nonce !== previousNonce
					);
				} catch {
					return false;
				}
			});
			if (candidates.length > 1) {
				throw new Error(`Multiple reloaded SIDE_PANEL documents appeared: ${JSON.stringify(candidates)}`);
			}
			return candidates[0];
		},
		15_000,
		() =>
			`Chrome did not expose a reloaded SIDE_PANEL document for session ${previousSessionId}; last contexts: ${JSON.stringify(lastContexts)}`,
	);
}

async function waitForSidePanelRuntime(
	context: BrowserContext,
	panel: { documentUrl: string },
	sessionId: string,
): Promise<SidePanelRuntimeProbe> {
	let lastFailure = "no matching runtime response";
	try {
		return await waitForValue(
			async () => {
				try {
					const probe = await probeSidePanelRuntime(context, panel);
					if (probe.sessionId !== sessionId || !probe.artifactsListed) {
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
			`SIDE_PANEL did not execute through runtime session ${sessionId}`,
		);
	} catch {
		throw new Error(`SIDE_PANEL did not execute through runtime session ${sessionId}: ${lastFailure}`);
	}
}

async function waitForExtensionReconnect(inbox: WebSocketInbox, windowId: number): Promise<void> {
	let disconnected = false;
	await inbox.waitFor(
		(message) => {
			if (!record(message) || message.type !== "event") return false;
			if (message.event === "extension_disconnected") {
				disconnected = true;
				return false;
			}
			return (
				disconnected &&
				message.event === "extension_connected" &&
				record(message.data) &&
				message.data.windowId === windowId
			);
		},
		20_000,
		`Bridge extension for window ${windowId} did not disconnect and reconnect`,
	);
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
	if (ws.readyState === WebSocket.CLOSED) return;
	await new Promise<void>((resolve, reject) => {
		const cleanup = (): void => {
			clearTimeout(timeout);
			ws.off("close", handleClose);
			ws.off("error", handleError);
		};
		const handleClose = (): void => {
			cleanup();
			resolve();
		};
		const handleError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const timeout = setTimeout(() => {
			cleanup();
			ws.terminate();
			reject(new Error("Timed out closing the cutover CLI WebSocket"));
		}, 5_000);
		ws.on("close", handleClose);
		ws.on("error", handleError);
		ws.close();
	});
}

async function createSecondWindow(
	context: BrowserContext,
	evaluator: ExtensionApiEvaluator,
	url: string,
): Promise<{ page: Page; identity: ChromePageIdentity }> {
	const identity = await evaluator.evaluate(async (targetUrl) => {
		const created = await chrome.windows.create({ url: targetUrl, focused: true });
		const tab = created.tabs?.[0];
		if (typeof created.id !== "number" || typeof tab?.id !== "number") {
			throw new Error("Chrome did not return the created window and tab ids");
		}
		return { windowId: created.id, tabId: tab.id };
	}, url);
	const page = await waitForValue(
		async () => context.pages().find((candidate) => candidate.url() === url),
		10_000,
		`Playwright did not observe the second window page ${url}`,
	);
	return { page, identity };
}

test("offscreen agent runtime survives panel and worker lifecycles and isolates browser windows", async () => {
	test.setTimeout(120_000);
	const bridgePort = await getAvailablePort();
	const bridge = new BridgeServer({ host: "127.0.0.1", port: bridgePort, token: "playwright-token" });
	let fixtureToClose: CutoverFixture | undefined;
	let extensionToClose: LaunchedExtensionContext | undefined;
	let bridgeStarted = false;
	let cli: RegisteredCutoverClient | undefined;
	let primaryFailure: unknown;

	try {
		const fixture = await createCutoverFixture();
		fixtureToClose = fixture;
		await bridge.start();
		bridgeStarted = true;
		const extension = await launchExtensionContext();
		extensionToClose = extension;
		const worker = await enableExtensionUserScripts(extension.context, extension.extensionId);
		await worker.evaluate(
			async ({ port, ingestUrl }) => {
				await chrome.storage.local.set({
					bridge_settings: {
						enabled: true,
						url: `ws://127.0.0.1:${port}/ws`,
						token: "playwright-token",
						sensitiveAccessEnabled: true,
						observability: {
							enabled: true,
							ingestUrl,
							publicIngestKey: "e2e-public-key",
						},
					},
				});
			},
			{ port: bridgePort, ingestUrl: fixture.baseUrl },
		);
		const pageAUrl = `${fixture.baseUrl}/window-a?case=cutover-a`;
		const pageA = await extension.context.newPage();
		await pageA.goto(pageAUrl);
		const pageAIdentity = await pageIdentity(worker, pageAUrl);
		const panelAControl = await createExtensionSidePanelControl(
			extension.context,
			extension.extensionId,
			pageAIdentity.windowId,
		);
		const openedPanelA = await panelAControl.open();
		const descriptorA = await acceptedDescriptor(panelAControl.page, pageAIdentity.windowId);
		expect(descriptorA.target).toEqual({ kind: "chrome-tab", tabRef: `window:${pageAIdentity.windowId}` });
		const panelA = openedPanelA;
		expect(await waitForSidePanelRuntime(extension.context, panelA, descriptorA.sessionId)).toEqual({
			sessionId: descriptorA.sessionId,
			artifactsListed: true,
		});
		await activatePage(panelAControl.page, pageA, pageAIdentity);

		await waitForBridgeWindow(bridgePort, pageAIdentity.windowId, 1);
		cli = await openCutoverClient(`ws://127.0.0.1:${bridgePort}/ws`, "playwright-token");
		expect(cli.registerResult).toEqual({ type: "register_result", ok: true });

		const sessionMarker = `cutover-session-marker-${descriptorA.sessionId}`;
		const injected = await sendBridgeRequest<SessionInjectResult>(cli, {
			id: 500,
			method: "session_inject",
			params: {
				expectedSessionId: descriptorA.sessionId,
				role: "assistant",
				content: sessionMarker,
			},
			target: { kind: "chrome-tab", tabRef: `window:${pageAIdentity.windowId}` },
		});
		expect(injected.error, JSON.stringify(injected, null, 2)).toBeUndefined();
		expect(injected.result).toMatchObject({ ok: true, sessionId: descriptorA.sessionId });

		const initialRoundTrip = await sendBridgeRequest<ReplResult>(cli, {
			id: 501,
			method: "repl",
			params: {
				title: "Initialize the cutover target page",
				code: `return await browserjs(() => {
					document.documentElement.dataset.shuvgeistCutover = "round-trip";
					return document.documentElement.dataset.shuvgeistCutover;
				});`,
			},
			target: { kind: "chrome-tab", tabRef: `window:${pageAIdentity.windowId}` },
		});
		expect(initialRoundTrip.error, JSON.stringify(initialRoundTrip, null, 2)).toBeUndefined();
		expect(initialRoundTrip.result?.output).toContain("round-trip");
		expect(await pageA.evaluate(() => document.documentElement.dataset.shuvgeistCutover)).toBe("round-trip");

		await panelAControl.close(panelA.contextId);
		await waitForNoExtensionSidePanels(extension.context, extension.extensionId, 500, panelAControl.page);
		const descriptorWhileClosed = await acceptedDescriptor(panelAControl.page, pageAIdentity.windowId);
		expect(descriptorWhileClosed.sessionId).toBe(descriptorA.sessionId);
		await activatePage(panelAControl.page, pageA, pageAIdentity);

		const historyWhileClosed = await sendBridgeRequest<SessionHistoryResult>(cli, {
			id: 502,
			method: "session_history",
			params: {},
			target: { kind: "chrome-tab", tabRef: `window:${pageAIdentity.windowId}` },
		});
		expect(historyWhileClosed.error, JSON.stringify(historyWhileClosed, null, 2)).toBeUndefined();
		expect(historyWhileClosed.result?.sessionId).toBe(descriptorA.sessionId);
		expect(historyWhileClosed.result?.messages).toContainEqual(
			expect.objectContaining({ role: "assistant", text: sessionMarker }),
		);

		const traceId = "11111111111111111111111111111111";
		const parentSpanId = "2222222222222222";
		const continuedWhileClosed = await sendBridgeRequest<ReplResult>(cli, {
			id: 503,
			method: "repl",
			params: {
				title: "Full REPL contract with side panel closed",
				code: `await returnDownloadableFile("closed-panel.txt", "closed-panel-file\\n", "text/plain");
				return await browserjs(() => document.documentElement.dataset.shuvgeistCutover);`,
			},
			target: { kind: "chrome-tab", tabRef: `window:${pageAIdentity.windowId}` },
			traceparent: `00-${traceId}-${parentSpanId}-01`,
			tracestate: "cutover=e2e",
		});
		expect(continuedWhileClosed.error, JSON.stringify(continuedWhileClosed, null, 2)).toBeUndefined();
		expect(continuedWhileClosed.result?.output).toContain("round-trip");
		expect(continuedWhileClosed.result?.output).toContain("[Files returned: 1]");
		expect(continuedWhileClosed.result?.files).toEqual([
			{
				fileName: "closed-panel.txt",
				mimeType: "text/plain",
				size: 18,
				contentBase64: "Y2xvc2VkLXBhbmVsLWZpbGUK",
			},
		]);

		const correlatedSpans = await waitForValue(
			async () => {
				const spans = otlpSpans(fixture.telemetryPayloads);
				const extensionSpan = spans.find(
					(span) =>
						span.name === "bridge.extension.request.repl" &&
						span.traceId === traceId &&
						span.parentSpanId === parentSpanId,
				);
				const runtimeSpan = spans.find(
					(span) => span.name === "background.runtime.browser-js" && span.traceId === traceId,
				);
				return extensionSpan && runtimeSpan ? { extensionSpan, runtimeSpan } : undefined;
			},
			10_000,
			"Extension telemetry did not preserve the raw bridge trace correlation",
		);
		expect(correlatedSpans.runtimeSpan.parentSpanId).toBe(correlatedSpans.extensionSpan.spanId);
		expect(spanAttribute(correlatedSpans.runtimeSpan, "runtime.window_id")).toEqual({
			intValue: String(pageAIdentity.windowId),
		});

		const reconnectEvents = waitForExtensionReconnect(cli.inbox, pageAIdentity.windowId);
		await stopExtensionServiceWorker(extension.context, extension.extensionId);
		await reconnectEvents;
		await waitForNoExtensionSidePanels(extension.context, extension.extensionId, 500, panelAControl.page);
		const descriptorAfterWorkerRestart = await acceptedDescriptor(panelAControl.page, pageAIdentity.windowId);
		expect(descriptorAfterWorkerRestart.sessionId).toBe(descriptorA.sessionId);
		await activatePage(panelAControl.page, pageA, pageAIdentity);
		await waitForBridgeWindow(bridgePort, pageAIdentity.windowId, 1);
		const historyAfterRestart = await sendBridgeRequest<SessionHistoryResult>(cli, {
			id: 504,
			method: "session_history",
			params: {},
			target: { kind: "chrome-tab", tabRef: `window:${pageAIdentity.windowId}` },
		});
		expect(historyAfterRestart.error, JSON.stringify(historyAfterRestart, null, 2)).toBeUndefined();
		expect(historyAfterRestart.result?.sessionId).toBe(descriptorA.sessionId);
		expect(historyAfterRestart.result?.messages).toContainEqual(
			expect.objectContaining({ role: "assistant", text: sessionMarker }),
		);

		const continuedAfterRestart = await sendBridgeRequest<ReplResult>(cli, {
			id: 505,
			method: "repl",
			params: {
				title: "Full REPL contract after service-worker restart",
				code: `await returnDownloadableFile("worker-restart.txt", "worker-restart-file\\n", "text/plain");
				return await browserjs(() => document.documentElement.dataset.shuvgeistCutover);`,
			},
			target: { kind: "chrome-tab", tabRef: `window:${pageAIdentity.windowId}` },
		});
		expect(continuedAfterRestart.error, JSON.stringify(continuedAfterRestart, null, 2)).toBeUndefined();
		expect(continuedAfterRestart.result?.output).toContain("round-trip");
		expect(continuedAfterRestart.result?.output).toContain("[Files returned: 1]");
		expect(continuedAfterRestart.result?.files).toEqual([
			{
				fileName: "worker-restart.txt",
				mimeType: "text/plain",
				size: 20,
				contentBase64: "d29ya2VyLXJlc3RhcnQtZmlsZQo=",
			},
		]);

		const reopenedPanelA = await panelAControl.open();
		expect(reopenedPanelA.contextId).not.toBe(panelA.contextId);
		const descriptorAfterReopen = await acceptedDescriptor(panelAControl.page, pageAIdentity.windowId);
		expect(descriptorAfterReopen.sessionId).toBe(descriptorA.sessionId);
		expect(await waitForSidePanelRuntime(extension.context, reopenedPanelA, descriptorA.sessionId)).toEqual({
			sessionId: descriptorA.sessionId,
			artifactsListed: true,
		});
		const historyAfterReopen = await sendBridgeRequest<SessionHistoryResult>(cli, {
			id: 506,
			method: "session_history",
			params: {},
			target: { kind: "chrome-tab", tabRef: `window:${pageAIdentity.windowId}` },
		});
		expect(historyAfterReopen.error, JSON.stringify(historyAfterReopen, null, 2)).toBeUndefined();
		expect(historyAfterReopen.result?.sessionId).toBe(descriptorA.sessionId);
		expect(historyAfterReopen.result?.messages).toContainEqual(
			expect.objectContaining({ role: "assistant", text: sessionMarker }),
		);

		const pageBUrl = `${fixture.baseUrl}/window-b?case=cutover-b`;
		const { page: pageB, identity: pageBIdentity } = await createSecondWindow(
			extension.context,
			panelAControl.page,
			pageBUrl,
		);
		const panelBControl = await createExtensionSidePanelControl(
			extension.context,
			extension.extensionId,
			pageBIdentity.windowId,
			panelAControl.page,
		);
		const panelB = await panelBControl.open();
		const descriptorB = await acceptedDescriptor(panelBControl.page, pageBIdentity.windowId);
		expect(descriptorB.target).toEqual({ kind: "chrome-tab", tabRef: `window:${pageBIdentity.windowId}` });
		expect(descriptorB.sessionId).not.toBe(descriptorA.sessionId);
		expect(await waitForSidePanelRuntime(extension.context, panelB, descriptorB.sessionId)).toEqual({
			sessionId: descriptorB.sessionId,
			artifactsListed: true,
		});
		await activatePage(panelBControl.page, pageB, pageBIdentity);
		await waitForBridgeWindow(bridgePort, pageBIdentity.windowId, 2);

		const windowBHistory = await sendBridgeRequest<SessionHistoryResult>(cli, {
			id: 507,
			method: "session_history",
			params: {},
			target: { kind: "chrome-tab", tabRef: `window:${pageBIdentity.windowId}` },
		});
		expect(windowBHistory.error, JSON.stringify(windowBHistory, null, 2)).toBeUndefined();
		expect(windowBHistory.result?.sessionId).toBe(descriptorB.sessionId);
		expect(windowBHistory.result?.messages.some((message) => message.text === sessionMarker)).toBe(false);

		const focusedWindowBeforeReload = await panelBControl.page.evaluate(
			async () => (await chrome.windows.getLastFocused()).id,
		);
		expect(focusedWindowBeforeReload).toBe(pageBIdentity.windowId);
		const reloadedPanelA = await reloadSidePanelDocument(
			extension.context,
			extension.extensionId,
			panelAControl.page,
			reopenedPanelA,
		);
		expect(reloadedPanelA.contextId).not.toBe(reopenedPanelA.contextId);
		expect(reloadedPanelA.documentId).not.toBe(reopenedPanelA.documentId);
		const focusedWindowAfterReload = await panelBControl.page.evaluate(
			async () => (await chrome.windows.getLastFocused()).id,
		);
		expect(focusedWindowAfterReload).toBe(pageBIdentity.windowId);
		const descriptorAfterPanelReload = await acceptedDescriptor(panelAControl.page, pageAIdentity.windowId);
		expect(descriptorAfterPanelReload.sessionId).toBe(descriptorA.sessionId);
		expect(await waitForSidePanelRuntime(extension.context, reloadedPanelA, descriptorA.sessionId)).toEqual({
			sessionId: descriptorA.sessionId,
			artifactsListed: true,
		});
		const descriptorBAfterPanelReload = await acceptedDescriptor(panelBControl.page, pageBIdentity.windowId);
		expect(descriptorBAfterPanelReload.sessionId).toBe(descriptorB.sessionId);

		const windowAHistory = await sendBridgeRequest<SessionHistoryResult>(cli, {
			id: 508,
			method: "session_history",
			params: {},
			target: { kind: "chrome-tab", tabRef: `window:${pageAIdentity.windowId}` },
		});
		expect(windowAHistory.error, JSON.stringify(windowAHistory, null, 2)).toBeUndefined();
		expect(windowAHistory.result?.sessionId).toBe(descriptorA.sessionId);
		expect(windowAHistory.result?.messages).toContainEqual(
			expect.objectContaining({ role: "assistant", text: sessionMarker }),
		);
		const focusedWindowBeforeTargetedRepl = await panelBControl.page.evaluate(
			async ({ tabId, windowId }) => {
				await chrome.tabs.update(tabId, { active: true });
				const [activeTab] = await chrome.tabs.query({ active: true, windowId });
				return { activeTabId: activeTab?.id, focusedWindowId: (await chrome.windows.getLastFocused()).id };
			},
			pageAIdentity,
		);
		expect(focusedWindowBeforeTargetedRepl).toEqual({
			activeTabId: pageAIdentity.tabId,
			focusedWindowId: pageBIdentity.windowId,
		});

		const focusedBTargetA = await sendBridgeRequest<ReplResult>(cli, {
			id: 509,
			method: "repl",
			params: {
				title: "Route target A while window B remains focused",
				code: `return await browserjs(() => {
					document.documentElement.dataset.shuvgeistTargetRoute = "window-a";
					return document.documentElement.dataset.shuvgeistTargetRoute;
				});`,
			},
			target: { kind: "chrome-tab", tabRef: `window:${pageAIdentity.windowId}` },
		});
		expect(focusedBTargetA.error, JSON.stringify(focusedBTargetA, null, 2)).toBeUndefined();
		expect(focusedBTargetA.result?.output).toContain("window-a");
		expect(await pageA.evaluate(() => document.documentElement.dataset.shuvgeistTargetRoute)).toBe("window-a");
		expect(await pageB.evaluate(() => document.documentElement.dataset.shuvgeistTargetRoute)).toBeUndefined();
		expect(await panelBControl.page.evaluate(async () => (await chrome.windows.getLastFocused()).id)).toBe(
			pageBIdentity.windowId,
		);

		const foreignAttemptUrl = `${fixture.baseUrl}/foreign-attempt`;
		const foreignAttempt = await sendBridgeRequest<ReplResult>(cli, {
			id: 510,
			method: "repl",
			params: {
				title: "Reject cross-window tab control",
				code: `return await navigate({ url: ${JSON.stringify(foreignAttemptUrl)}, tabId: ${pageBIdentity.tabId} });`,
			},
			target: { kind: "chrome-tab", tabRef: `window:${pageAIdentity.windowId}` },
		});
		expect(foreignAttempt.result).toBeUndefined();
		expect(foreignAttempt.error?.code).toBe(-32003);
		expect(foreignAttempt.error?.message).toContain(
			`Tab ${pageBIdentity.tabId} belongs to window ${pageBIdentity.windowId}, not authorized window ${pageAIdentity.windowId}`,
		);
		expect(pageB.url()).toBe(pageBUrl);
	} catch (error) {
		primaryFailure = error;
		throw error;
	} finally {
		cli?.inbox.dispose();
		const cleanupSteps: Array<{ name: string; run: () => Promise<unknown> }> = [];
		if (cli) cleanupSteps.push({ name: "CLI WebSocket", run: () => closeWebSocket(cli.ws) });
		if (extensionToClose) {
			cleanupSteps.push({ name: "extension context", run: () => extensionToClose.close() });
		}
		if (bridgeStarted) cleanupSteps.push({ name: "bridge server", run: () => bridge.stop() });
		if (fixtureToClose) cleanupSteps.push({ name: "HTTP fixture", run: () => fixtureToClose.close() });

		const cleanupErrors: Error[] = [];
		for (const cleanup of cleanupSteps) {
			try {
				await cleanup.run();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				cleanupErrors.push(new Error(`${cleanup.name}: ${message}`));
			}
		}
		if (primaryFailure === undefined && cleanupErrors.length > 0) {
			throw new AggregateError(
				cleanupErrors,
				`Agent runtime cutover cleanup failed: ${cleanupErrors.map((error) => error.message).join("; ")}`,
			);
		}
	}
});
