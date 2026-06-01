import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { BridgeServer } from "../../../src/bridge/server.js";
import { BridgeDefaults, ErrorCodes } from "../../../src/bridge/protocol.js";
import { createBridgeSkillSnapshot } from "../../../src/bridge/skill-snapshot.js";
import { openRegisteredClient, readMessage, sendRequestAndReadResponse } from "../../helpers/ws-client.js";

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

async function sendAndReadResponseAndEvent(
	ws: WebSocket,
	request: unknown,
	responseId: number,
	eventName: string,
): Promise<{ response: unknown; event: unknown }> {
	return new Promise((resolve, reject) => {
		let response: unknown;
		let event: unknown;
		const cleanup = () => {
			ws.off("message", handleMessage);
			ws.off("error", handleError);
		};
		const handleError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const handleMessage = (data: Buffer | string) => {
			const message = JSON.parse(typeof data === "string" ? data : data.toString("utf-8")) as Record<string, unknown>;
			if (message.id === responseId) response = message;
			if (message.type === "event" && message.event === eventName) event = message;
			if (response && event) {
				cleanup();
				resolve({ response, event });
			}
		};
		ws.on("message", handleMessage);
		ws.on("error", handleError);
		ws.send(JSON.stringify(request));
	});
}

async function waitForTelemetryPayloads(payloads: unknown[], count: number): Promise<void> {
	for (let attempt = 0; attempt < 20 && payloads.length < count; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	expect(payloads.length).toBeGreaterThanOrEqual(count);
}

function spanAttributes(payload: unknown, spanName: string): Record<string, unknown> {
	const resourceSpans = (payload as { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: unknown[] }> }> })
		.resourceSpans;
	const spans = resourceSpans?.flatMap((resource) => resource.scopeSpans?.flatMap((scope) => scope.spans ?? []) ?? []) ?? [];
	const span = spans.find((candidate) => (candidate as { name?: string }).name === spanName) as
		| { attributes?: Array<{ key: string; value: Record<string, unknown> }> }
		| undefined;
	if (!span) throw new Error(`Span '${spanName}' not found`);
	return Object.fromEntries(
		(span.attributes ?? []).map((attribute) => [
			attribute.key,
			attribute.value.stringValue ?? attribute.value.intValue ?? attribute.value.doubleValue ?? attribute.value.boolValue,
		]),
	);
}

interface FakeCdpTarget {
	id: string;
	type: string;
	title?: string;
	url?: string;
	webSocketDebuggerUrl: string;
}

async function createFakeCdpServer(port: number): Promise<{
	close: () => Promise<void>;
	setTargets: (nextTargets: FakeCdpTarget[]) => void;
}> {
	let targets: FakeCdpTarget[] = [
		{
			id: "page-1",
			type: "page",
			title: "Primary",
			url: "app://primary",
			webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1`,
		},
		];
		const sockets = new Set<WebSocket>();
		const httpServer = createServer((req, res) => {
		if (req.url === "/json/version") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					Browser: "FakeElectron/1.0",
					webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser`,
				}),
			);
			return;
		}
		if (req.url === "/json/list") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(targets));
			return;
		}
		res.writeHead(404);
		res.end();
	});
		const wss = new WebSocketServer({ server: httpServer as Server });
		wss.on("connection", (ws) => {
			sockets.add(ws);
			ws.on("close", () => sockets.delete(ws));
			ws.on("message", (data: Buffer | string) => {
			const msg = JSON.parse(typeof data === "string" ? data : data.toString("utf-8")) as {
				id: number;
				method: string;
				params?: { expression?: string };
			};
			if (msg.method === "Runtime.evaluate") {
				if (msg.params?.expression?.includes("shuvgeistSnapshotPageScript")) {
					ws.send(
						JSON.stringify({
							id: msg.id,
							result: {
								result: {
									value: {
										success: true,
										result: {
											url: "app://fixture",
											title: "Fixture",
											generatedAt: 1,
											totalCandidates: 2,
											truncated: false,
											entries: [
												{
													snapshotId: "e1:w1:ref1",
													stableElementId: "stable-save",
													tagName: "button",
													role: "button",
													name: "Save",
													text: "Save",
													label: "Save changes",
													attributes: { id: "save" },
													selectorCandidates: ["#save"],
													ordinalPath: [0],
													boundingBox: { x: 1, y: 2, width: 30, height: 20 },
													interactive: true,
												},
											],
										},
									},
								},
							},
						}),
					);
					} else if (msg.params?.expression?.includes("electronRefActionScript")) {
						ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { ok: true } } } }));
					} else if (msg.params?.expression?.includes("electronPageAssertScript")) {
						ws.send(
							JSON.stringify({
								id: msg.id,
								result: { result: { value: { ok: true, message: "Text assertion passed", actual: "Save" } } },
							}),
						);
					} else if (msg.params?.expression?.includes("electronMainInfoScript")) {
					ws.send(
						JSON.stringify({
							id: msg.id,
							result: {
								result: {
									value: {
										windows: [{ id: 1, title: "Main", url: "app://main" }],
										paths: {
											appPath: "/fixture/app",
											userData: "/fixture/userData",
											exe: "/fixture/exe",
											temp: "/tmp",
										},
										app: {
											name: "Fixture",
											version: "1.2.3",
											electronVersion: "30.0.0",
											chromeVersion: "124.0.0",
											nodeVersion: "20.0.0",
										},
										crashDumps: { directory: "/fixture/crashes", files: ["a.dmp"] },
									},
								},
							},
						}),
					);
				} else if (msg.params?.expression?.includes("electronIpcTapScript")) {
					ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { ok: true, source: "main" } } } }));
				} else if (msg.params?.expression?.includes("electronIpcUntapScript")) {
					ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { ok: true } } } }));
				} else if (msg.params?.expression?.includes("electronMainNetworkTapScript")) {
					ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { ok: true, source: "main" } } } }));
				} else if (msg.params?.expression?.includes("electronMainNetworkUntapScript")) {
					ws.send(JSON.stringify({ id: msg.id, result: { result: { value: { ok: true, source: "main" } } } }));
				} else if (msg.params?.expression?.includes("__electronSkillValue = 9")) {
					ws.send(JSON.stringify({ id: msg.id, result: { result: { type: "number", value: 9 } } }));
				} else {
					ws.send(JSON.stringify({ id: msg.id, result: { result: { type: "number", value: 4 } } }));
				}
			} else if (msg.method === "Page.captureScreenshot") {
				ws.send(JSON.stringify({ id: msg.id, result: { data: "iVBORw0KGgo=" } }));
			} else if (msg.method === "Page.startScreencast") {
				ws.send(JSON.stringify({ id: msg.id, result: {} }));
				ws.send(
					JSON.stringify({
						method: "Page.screencastFrame",
						params: {
							data: "iVBORw0KGgo=",
							sessionId: 1,
							metadata: { timestamp: 1 },
						},
					}),
				);
				} else if (msg.method === "Network.enable") {
					ws.send(JSON.stringify({ id: msg.id, result: {} }));
					ws.send(
						JSON.stringify({
							method: "Network.requestWillBeSent",
							params: {
								requestId: "req-1",
								type: "Fetch",
								request: { method: "GET", url: "https://example.test/data", headers: { Accept: "application/json" } },
							},
						}),
					);
					ws.send(
						JSON.stringify({
							method: "Network.responseReceived",
							params: {
								requestId: "req-1",
								response: { status: 200, mimeType: "application/json", headers: { "Content-Type": "application/json" } },
							},
						}),
					);
					ws.send(JSON.stringify({ method: "Network.loadingFinished", params: { requestId: "req-1" } }));
				} else if (msg.method === "Network.getResponseBody") {
					ws.send(JSON.stringify({ id: msg.id, result: { body: "{\"ok\":true}", base64Encoded: false } }));
				} else if (msg.method === "Network.disable") {
					ws.send(JSON.stringify({ id: msg.id, result: {} }));
				} else if (msg.method === "Performance.enable") {
					ws.send(JSON.stringify({ id: msg.id, result: {} }));
				} else if (msg.method === "Performance.getMetrics") {
					ws.send(
						JSON.stringify({
							id: msg.id,
							result: { metrics: [{ name: "JSHeapUsedSize", value: 1234 }, { name: "Nodes", value: 42 }] },
						}),
					);
				} else if (msg.method === "Page.stopScreencast" || msg.method === "Page.screencastFrameAck") {
				ws.send(JSON.stringify({ id: msg.id, result: {} }));
			} else {
				ws.send(JSON.stringify({ id: msg.id, result: {} }));
			}
		});
	});
	await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
	return {
		setTargets: (nextTargets: FakeCdpTarget[]) => {
			targets = nextTargets;
		},
			close: async () => {
				for (const socket of sockets) socket.close();
				await new Promise<void>((resolve) => wss.close(() => resolve()));
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		},
	};
}

describe("BridgeServer", () => {
	let server: BridgeServer;
	let port: number;
	let baseUrl: string;

	beforeEach(async () => {
		port = await getAvailablePort();
		baseUrl = `ws://127.0.0.1:${port}/ws`;
		server = new BridgeServer({ host: "127.0.0.1", port, token: "secret-token" });
		await server.start();
	});

	afterEach(async () => {
		await server.stop();
	});

	it("returns a bootstrap token only for hardened loopback requests", async () => {
		const success = await fetch(`http://127.0.0.1:${port}/bootstrap`, {
			headers: {
				Host: `127.0.0.1:${port}`,
				"X-Shuvgeist-Bootstrap": "1",
			},
		});
		expect(success.status).toBe(200);
		await expect(success.json()).resolves.toEqual({ version: 1, token: "secret-token" });

		const missingHeader = await fetch(`http://127.0.0.1:${port}/bootstrap`, {
			headers: { Host: `127.0.0.1:${port}` },
		});
		expect(missingHeader.status).toBe(403);

		const fakeReq = {
			socket: { remoteAddress: "127.0.0.1" },
			headers: {
				host: `evil.example:${port}`,
				"x-shuvgeist-bootstrap": "1",
			},
		} as unknown as Parameters<BridgeServer["handleBootstrapRequest"]>[0];
		const writeHead = vi.fn();
		const end = vi.fn();
		const fakeRes = { writeHead, end } as unknown as Parameters<BridgeServer["handleBootstrapRequest"]>[1];
		(server as unknown as { handleBootstrapRequest: (req: unknown, res: unknown) => void }).handleBootstrapRequest(
			fakeReq,
			fakeRes,
		);
		expect(writeHead).toHaveBeenCalledWith(403, { "Content-Type": "application/json" });
		expect(end).toHaveBeenCalledWith(JSON.stringify({ error: "Bootstrap rejected due to invalid Host header" }));

		const badOrigin = await fetch(`http://127.0.0.1:${port}/bootstrap`, {
			headers: {
				Host: `127.0.0.1:${port}`,
				Origin: "https://evil.example",
				"X-Shuvgeist-Bootstrap": "1",
			},
		});
		expect(badOrigin.status).toBe(403);
		expect(badOrigin.headers.get("access-control-allow-origin")).toBeNull();

		const options = await fetch(`http://127.0.0.1:${port}/bootstrap`, {
			method: "OPTIONS",
			headers: {
				Host: `127.0.0.1:${port}`,
				Origin: "https://evil.example",
				"Access-Control-Request-Method": "GET",
				"Access-Control-Request-Headers": "x-shuvgeist-bootstrap",
			},
		});
		expect(options.status).toBe(404);
		expect(options.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("rejects bootstrap for non-loopback callers", async () => {
		const fakeReq = {
			socket: { remoteAddress: "10.0.0.8" },
			headers: {
				host: `127.0.0.1:${port}`,
				"x-shuvgeist-bootstrap": "1",
			},
		} as unknown as Parameters<BridgeServer["handleBootstrapRequest"]>[0];
		const writeHead = vi.fn();
		const end = vi.fn();
		const fakeRes = { writeHead, end } as unknown as Parameters<BridgeServer["handleBootstrapRequest"]>[1];

		(server as unknown as { handleBootstrapRequest: (req: unknown, res: unknown) => void }).handleBootstrapRequest(
			fakeReq,
			fakeRes,
		);

		expect(writeHead).toHaveBeenCalledWith(403, { "Content-Type": "application/json" });
		expect(end).toHaveBeenCalledWith(JSON.stringify({ error: "Bootstrap is only available from loopback callers" }));
	});

	it("registers CLI and extension clients and exposes status", async () => {
		const extension = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 7,
			sessionId: "session-7",
			capabilities: ["status", "navigate"],
		});
		expect(extension.registerResult.ok).toBe(true);

		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "test-cli" });
		expect(cli.registerResult.ok).toBe(true);

		const status = await fetch(`http://127.0.0.1:${port}/status`).then((response) => response.json());
		expect(status.extension).toMatchObject({ connected: true, windowId: 7, sessionId: "session-7" });
		expect(status.clients).toMatchObject({ cli: 1, extension: 1, total: 2 });

		extension.ws.close();
		cli.ws.close();
	});

	it("rejects invalid tokens and multiple active extension windows", async () => {
		const bad = new WebSocket(baseUrl);
		await new Promise<void>((resolve) => bad.once("open", resolve));
		bad.send(JSON.stringify({ type: "register", role: "cli", token: "wrong-token" }));
		await expect(readMessage(bad)).resolves.toEqual({ type: "register_result", ok: false, error: "Invalid token" });
		bad.close();

		const first = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 11,
			capabilities: ["status"],
		});
		const second = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 12,
			capabilities: ["status"],
		});
		expect(second.registerResult).toEqual({
			type: "register_result",
			ok: false,
			error: "Another extension target is already connected",
		});
		first.ws.close();
		second.ws.close();
	});

	it("replaces same-window reconnects and relays request responses", async () => {
		const extension = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 21,
			capabilities: ["status", "navigate"],
		});
		const reconnect = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 21,
			capabilities: ["status", "navigate"],
		});
		expect(reconnect.registerResult.ok).toBe(true);

		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "relay-cli" });
		const responsePromise = sendRequestAndReadResponse(cli.ws, { id: 99, method: "status" });
		const relayed = await readMessage<{ id: number; method: string }>(reconnect.ws);
		expect(relayed).toMatchObject({ id: 1, method: "status" });
		reconnect.ws.send(JSON.stringify({ id: relayed.id, result: { ok: true, ready: true } }));
		await expect(responsePromise).resolves.toEqual({ id: 99, result: { ok: true, ready: true } });

		extension.ws.close();
		reconnect.ws.close();
		cli.ws.close();
	});

	it("rejects invalid methods and disabled capabilities", async () => {
		const extension = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 31,
			capabilities: ["status"],
		});
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "cap-cli" });

		await expect(sendRequestAndReadResponse(cli.ws, { id: 1, method: "bogus", params: {} })).resolves.toEqual({
			id: 1,
			error: { code: ErrorCodes.INVALID_METHOD, message: "Unknown method: bogus" },
		});
		await expect(sendRequestAndReadResponse(cli.ws, { id: 2, method: "navigate", params: { url: "https://example.com" } })).resolves.toEqual({
			id: 2,
			error: {
				code: ErrorCodes.CAPABILITY_DISABLED,
				message: "Method 'navigate' is disabled on the active extension target",
			},
		});
		await expect(sendRequestAndReadResponse(cli.ws, { id: 3, method: "cookies", params: {} })).resolves.toEqual({
			id: 3,
			error: {
				code: ErrorCodes.CAPABILITY_DISABLED,
				message: "Method 'cookies' is disabled on the active extension target",
			},
		});

		extension.ws.close();
		cli.ws.close();
	});

	it("routes electron namespace requests locally without an extension", async () => {
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "electron-cli" });

		const response = await sendRequestAndReadResponse(cli.ws, { id: 1, method: "electron_list", params: {} });
		expect(response).toMatchObject({ id: 1, result: { sessions: [] } });
		expect((response.result as { apps: unknown[] }).apps.length).toBeGreaterThan(0);

		cli.ws.close();
	});

	it("routes electron-targeted requests before extension checks", async () => {
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "electron-target-cli" });

		await expect(
			sendRequestAndReadResponse(cli.ws, {
				id: 1,
				method: "screenshot",
				params: {},
				target: { kind: "electron-window", appRef: "vscode", windowRef: "w1" },
			}),
		).resolves.toEqual({
			id: 1,
			error: {
				code: ErrorCodes.NO_ELECTRON_SESSION,
				message: "No Electron session attached for 'vscode'; run 'shuvgeist electron attach vscode' first",
			},
		});

		cli.ws.close();
	});

	it("keeps chrome default requests on the extension relay path", async () => {
		const extension = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 61,
			capabilities: ["screenshot"],
		});
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "chrome-target-cli" });
		const responsePromise = sendRequestAndReadResponse(cli.ws, { id: 8, method: "screenshot", params: {} });
		const relayed = await readMessage<{ id: number; method: string; target?: unknown }>(extension.ws);
		expect(relayed).toMatchObject({ id: 1, method: "screenshot", target: { kind: "chrome-tab" } });
		extension.ws.send(JSON.stringify({ id: relayed.id, result: { ok: true } }));
		await expect(responsePromise).resolves.toEqual({ id: 8, result: { ok: true } });

		extension.ws.close();
		cli.ws.close();
	});

	it("characterizes single-target bridge dispatch to the active extension", async () => {
		const extension = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 62,
			capabilities: ["page_snapshot"],
		});
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "single-target-cli" });
		const params = { tabId: 42, frameId: 7, maxEntries: 25, includeHidden: true };
		const responsePromise = sendRequestAndReadResponse(cli.ws, { id: 77, method: "page_snapshot", params });
		const relayed = await readMessage<{ id: number; method: string; params?: unknown; target?: unknown }>(extension.ws);

		expect(relayed).toEqual({
			id: 1,
			method: "page_snapshot",
			params,
			target: { kind: "chrome-tab" },
		});
		extension.ws.send(
			JSON.stringify({
				id: relayed.id,
				result: {
					tabId: 42,
					frameId: 7,
					entries: [{ snapshotId: "e1", role: "button", name: "Save" }],
				},
			}),
		);
		await expect(responsePromise).resolves.toEqual({
			id: 77,
			result: {
				tabId: 42,
				frameId: 7,
				entries: [{ snapshotId: "e1", role: "button", name: "Save" }],
			},
		});

		extension.ws.close();
		cli.ws.close();
	});

	it("runs eval and screenshot through an attached electron CDP session", async () => {
		const cdpPort = await getAvailablePort();
		const cdp = await createFakeCdpServer(cdpPort);
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "electron-cdp-cli" });
		try {
			await expect(
				sendRequestAndReadResponse(cli.ws, { id: 1, method: "electron_attach", params: { port: cdpPort } }),
			).resolves.toMatchObject({
				id: 1,
				result: { id: "e1", port: cdpPort, browser: "FakeElectron/1.0", launched: false },
			});

			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 2,
					method: "eval",
					params: { code: "2 + 2" },
					target: { kind: "electron-window", sessionId: "e1" },
				}),
			).resolves.toEqual({ id: 2, result: { output: "4", result: 4 } });

			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 3,
					method: "screenshot",
					params: {},
					target: { kind: "electron-window", sessionId: "e1" },
				}),
			).resolves.toMatchObject({
				id: 3,
				result: { mimeType: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" },
			});

			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 4,
					method: "page_snapshot",
					params: {},
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
				}),
			).resolves.toMatchObject({
				id: 4,
				result: {
					entries: [{ snapshotId: "e1:w1:ref1", stableElementId: "stable-save", role: "button", name: "Save" }],
				},
			});
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 5,
					method: "locate_by_role",
					params: { role: "button", name: "Save" },
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
				}),
			).resolves.toMatchObject({
				id: 5,
				result: [{ refId: "e1:w1:ref1", entry: { role: "button", name: "Save" } }],
			});
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 6,
					method: "locate_by_text",
					params: { text: "Save" },
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
				}),
			).resolves.toMatchObject({ id: 6, result: [{ refId: "e1:w1:ref1" }] });
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 7,
					method: "locate_by_label",
					params: { label: "Save changes" },
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
				}),
			).resolves.toMatchObject({ id: 7, result: [{ refId: "e1:w1:ref1" }] });
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 8,
					method: "ref_click",
					params: { refId: "e1:w1:ref1" },
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
				}),
			).resolves.toMatchObject({ id: 8, result: { ok: true, refId: "e1:w1:ref1", selector: "#save" } });
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 9,
					method: "ref_fill",
					params: { refId: "e1:w1:ref1", value: "typed" },
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
				}),
			).resolves.toMatchObject({ id: 9, result: { ok: true, refId: "e1:w1:ref1", selector: "#save" } });
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 10,
					method: "ref_click",
					params: { refId: "e1:w1:ref1", native: true },
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
				}),
			).resolves.toMatchObject({
				id: 10,
				error: { message: "Native ref click is not supported for Electron targets" },
			});
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 11,
					method: "page_assert",
					params: { kind: "text", text: "Save" },
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
				}),
			).resolves.toMatchObject({ id: 11, result: { ok: true, kind: "text", message: "Text assertion passed" } });
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 12,
					method: "network_start",
					params: {},
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
				}),
			).resolves.toMatchObject({ id: 12, result: { active: true, tabId: -1, sessionId: "e1", windowRef: "w1" } });
			await new Promise((resolve) => setTimeout(resolve, 20));
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 13,
					method: "network_list",
					params: {},
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
				}),
			).resolves.toMatchObject({
				id: 13,
				result: [
					{
						requestId: "req-1",
						url: "https://example.test/data",
						status: 200,
						hasResponseBody: true,
						sessionId: "e1",
						windowRef: "w1",
					},
				],
			});
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 14,
					method: "perf_metrics",
					params: {},
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
				}),
			).resolves.toMatchObject({
				id: 14,
				result: {
					tabId: -1,
					sessionId: "e1",
					windowRef: "w1",
					metrics: [
						{ name: "JSHeapUsedSize", value: 1234 },
						{ name: "Nodes", value: 42 },
					],
				},
			});
			cdp.setTargets([
				{
					id: "page-1",
					type: "page",
					title: "Primary",
					url: "app://primary",
					webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/1`,
				},
				{
					id: "page-2",
					type: "page",
					title: "Other",
					url: "app://other",
					webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/2`,
				},
			]);
			await sendRequestAndReadResponse(cli.ws, { id: 15, method: "electron_windows", params: {} });
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 16,
					method: "ref_click",
					params: { refId: "e1:w1:ref1" },
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w2" },
				}),
			).resolves.toMatchObject({
				id: 16,
				error: { message: "Electron ref 'e1:w1:ref1' does not exist for target 'e1:w2'. Run locate or snapshot again." },
			});
		} finally {
			cli.ws.close();
			await cdp.close();
		}
	});

	it("keeps stable electron window refs and resolves labels", async () => {
		const cdpPort = await getAvailablePort();
		const cdp = await createFakeCdpServer(cdpPort);
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "electron-window-cli" });
		try {
			await sendRequestAndReadResponse(cli.ws, { id: 1, method: "electron_attach", params: { port: cdpPort } });
			cdp.setTargets([
				{
					id: "page-1",
					type: "page",
					title: "Primary",
					url: "app://primary",
					webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/1`,
				},
				{
					id: "webview-1",
					type: "webview",
					title: "Embedded",
					url: "app://embedded",
					webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/2`,
				},
				{
					id: "page-2",
					type: "page",
					title: "Secondary",
					url: "app://secondary",
					webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/3`,
				},
			]);
			const windows = await sendRequestAndReadResponse(cli.ws, { id: 2, method: "electron_windows", params: {} });
			expect(windows).toMatchObject({
				id: 2,
				result: {
					sessions: [
						{
							id: "e1",
							windows: [
								{ ref: "w1", type: "page", isPrimary: true },
								{ ref: "w2", type: "webview", isPrimary: false },
								{ ref: "w3", type: "page", isPrimary: false },
							],
						},
					],
				},
			});

			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 3,
					method: "electron_label",
					params: { sessionId: "e1", windowRef: "w3", label: "secondary" },
				}),
			).resolves.toMatchObject({ id: 3, result: { ok: true, window: { ref: "w3", label: "secondary" } } });
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 4,
					method: "electron_label",
					params: { sessionId: "e1", windowRef: "w1", label: "secondary" },
				}),
			).resolves.toMatchObject({
				id: 4,
				error: { message: "Electron window label 'secondary' is already used in session 'e1'." },
			});
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 5,
					method: "eval",
					params: { code: "2 + 2" },
					target: { kind: "electron-window", sessionId: "e1", windowRef: "secondary" },
				}),
			).resolves.toEqual({ id: 5, result: { output: "4", result: 4 } });

			cdp.setTargets([
				{
					id: "page-2",
					type: "page",
					title: "Secondary",
					url: "app://secondary",
					webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/3`,
				},
				{
					id: "page-3",
					type: "page",
					title: "Third",
					url: "app://third",
					webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/4`,
				},
			]);
			await expect(
				sendRequestAndReadResponse(cli.ws, { id: 6, method: "electron_windows", params: {} }),
			).resolves.toMatchObject({
				id: 6,
				result: {
					sessions: [
						{
							windows: [
								{ ref: "w3", label: "secondary" },
								{ ref: "w4" },
							],
						},
					],
				},
			});
		} finally {
			cli.ws.close();
			await cdp.close();
		}
	});

	it("records electron screencast frames through the bridge event contract", async () => {
		const cdpPort = await getAvailablePort();
		const cdp = await createFakeCdpServer(cdpPort);
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "electron-record-cli" });
		try {
			await sendRequestAndReadResponse(cli.ws, { id: 1, method: "electron_attach", params: { port: cdpPort } });
			const startMessages = await sendAndReadResponseAndEvent(
				cli.ws,
				{
					id: 2,
					method: "record_start",
					params: { maxDurationMs: 5000, fps: 12, quality: 80 },
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
				},
				2,
				"record_frame",
			);
			const frame = startMessages.event as {
				type: string;
				event: string;
				data: { recordingId: string; dataBase64: string };
			};
			expect(frame).toMatchObject({
				type: "event",
				event: "record_frame",
				data: { recordingId: expect.stringMatching(/^erec-/), dataBase64: "iVBORw0KGgo=" },
			});
			expect(startMessages.response).toMatchObject({
				id: 2,
				result: { recordingId: frame.data.recordingId, tabId: -1, mimeType: "video/webm", maxDurationMs: 5000 },
			});
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 3,
					method: "record_status",
					params: {},
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
				}),
			).resolves.toMatchObject({ id: 3, result: { active: true, recordingId: frame.data.recordingId, frameCount: 1 } });
			const stopMessages = await sendAndReadResponseAndEvent(
				cli.ws,
				{
					id: 4,
					method: "record_stop",
					params: { recordingId: frame.data.recordingId },
					target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
				},
				4,
				"record_frame",
			);
			expect(stopMessages.event).toMatchObject({
				type: "event",
				event: "record_frame",
				data: { recordingId: frame.data.recordingId, final: true, summary: { outcome: "stopped_user" } },
			});
			expect(stopMessages.response).toMatchObject({
				id: 4,
				result: { recordingId: frame.data.recordingId, outcome: "stopped_user", frameCount: 1 },
			});
		} finally {
			cli.ws.close();
			await cdp.close();
		}
	});

	it("syncs bridge-readable skill snapshots and injects matching Electron app skills", async () => {
		const dir = mkdtempSync(join(tmpdir(), "shuvgeist-skill-snapshot-"));
		const previousSnapshotPath = process.env.SHUVGEIST_SKILL_SNAPSHOT;
		const previousConfigPath = process.env.SHUVGEIST_BRIDGE_CONFIG;
		process.env.SHUVGEIST_SKILL_SNAPSHOT = join(dir, "skills.snapshot.json");
		process.env.SHUVGEIST_BRIDGE_CONFIG = join(dir, "bridge.json");
		const cdpPort = await getAvailablePort();
		const cdp = await createFakeCdpServer(cdpPort);
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "electron-skill-cli" });
		try {
			const snapshot = createBridgeSkillSnapshot([
				{
					name: "electron-skill",
					domainPatterns: [],
					appPatterns: ["vscode"],
					shortDescription: "short",
					description: "description",
					createdAt: "2026-05-19T00:00:00.000Z",
					lastUpdated: "2026-05-19T00:00:00.000Z",
					examples: "",
					library: "globalThis.__electronSkillValue = 9;",
				},
			]);
			await expect(
				fetch(`http://127.0.0.1:${port}/skills/snapshot`, {
					method: "POST",
					headers: {
						authorization: "Bearer secret-token",
						"content-type": "application/json",
					},
					body: JSON.stringify(snapshot),
				}).then((response) => response.json()),
			).resolves.toMatchObject({ ok: true, status: { state: "fresh", skillCount: 1 } });
			await sendRequestAndReadResponse(cli.ws, { id: 1, method: "electron_allow", params: { appRef: "vscode" } });
			await expect(
				sendRequestAndReadResponse(cli.ws, { id: 2, method: "electron_attach", params: { appRef: "vscode", port: cdpPort } }),
			).resolves.toMatchObject({ id: 2, result: { appId: "com.microsoft.VSCode" } });
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 3,
					method: "eval",
					params: { code: "globalThis.__electronSkillValue" },
					target: { kind: "electron-window", appRef: "vscode", windowRef: "w1" },
				}),
			).resolves.toMatchObject({
				id: 3,
				result: { result: 9, output: "9", skillsSnapshot: { state: "fresh", skillCount: 1 } },
			});
			await expect(
				sendRequestAndReadResponse(cli.ws, { id: 4, method: "skills_snapshot_status", params: {} }),
			).resolves.toMatchObject({ id: 4, result: { state: "fresh", skillCount: 1 } });
		} finally {
			cli.ws.close();
			await cdp.close();
			if (previousSnapshotPath === undefined) delete process.env.SHUVGEIST_SKILL_SNAPSHOT;
			else process.env.SHUVGEIST_SKILL_SNAPSHOT = previousSnapshotPath;
			if (previousConfigPath === undefined) delete process.env.SHUVGEIST_BRIDGE_CONFIG;
			else process.env.SHUVGEIST_BRIDGE_CONFIG = previousConfigPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("broadcasts Electron session changes to sidepanels and detaches through HTTP", async () => {
		const cdpPort = await getAvailablePort();
		const cdp = await createFakeCdpServer(cdpPort);
		const extension = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 77,
			capabilities: ["status"],
		});
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "electron-ui-cli" });
		try {
			const attachEvent = readMessage(extension.ws);
			await sendRequestAndReadResponse(cli.ws, { id: 1, method: "electron_attach", params: { port: cdpPort } });
			await expect(attachEvent).resolves.toMatchObject({
				type: "event",
				event: "electron_sessions_changed",
				data: { reason: "attach", sessions: [{ id: "e1", windows: [{ ref: "w1" }] }] },
			});
			await expect(
				fetch(`http://127.0.0.1:${port}/electron/thumbnail`, {
					method: "POST",
					headers: {
						authorization: "Bearer secret-token",
						"content-type": "application/json",
					},
					body: JSON.stringify({ sessionId: "e1", windowRef: "w1", maxWidth: 320 }),
				}).then((response) => response.json()),
			).resolves.toMatchObject({ dataUrl: "data:image/png;base64,iVBORw0KGgo=", imageWidth: expect.any(Number) });
			const detachEvent = readMessage(extension.ws);
			await expect(
				fetch(`http://127.0.0.1:${port}/electron/detach`, {
					method: "POST",
					headers: {
						authorization: "Bearer secret-token",
						"content-type": "application/json",
					},
					body: JSON.stringify({ sessionId: "e1" }),
				}).then((response) => response.json()),
			).resolves.toMatchObject({ ok: true, sessionId: "e1" });
			await expect(detachEvent).resolves.toMatchObject({
				type: "event",
				event: "electron_sessions_changed",
				data: { reason: "detach", sessions: [] },
			});
		} finally {
			extension.ws.close();
			cli.ws.close();
			await cdp.close();
		}
	});

	it("attaches Electron main-process inspector and returns read-only metadata", async () => {
		const cdpPort = await getAvailablePort();
		const inspectPort = await getAvailablePort();
		const cdp = await createFakeCdpServer(cdpPort);
		const inspector = await createFakeCdpServer(inspectPort);
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "electron-main-cli" });
		try {
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 1,
					method: "electron_attach",
					params: { port: cdpPort, inspectPort },
				}),
			).resolves.toMatchObject({
				id: 1,
				result: { id: "e1", mainInspector: { port: inspectPort, available: true } },
			});
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 2,
					method: "electron_main_info",
					params: { sessionId: "e1" },
				}),
			).resolves.toMatchObject({
				id: 2,
				result: {
					windows: [{ title: "Main" }],
					paths: { appPath: "/fixture/app", userData: "/fixture/userData" },
					app: { name: "Fixture", version: "1.2.3" },
					crashDumps: { directory: "/fixture/crashes", files: ["a.dmp"] },
				},
			});
		} finally {
			cli.ws.close();
			await inspector.close();
			await cdp.close();
		}
	});

	it("teaches when main-process inspector commands are unsupported", async () => {
		const dir = mkdtempSync(join(tmpdir(), "shuvgeist-main-inspector-"));
		const previousConfigPath = process.env.SHUVGEIST_BRIDGE_CONFIG;
		process.env.SHUVGEIST_BRIDGE_CONFIG = join(dir, "bridge.json");
		const cdpPort = await getAvailablePort();
		const inspectPort = await getAvailablePort();
		const cdp = await createFakeCdpServer(cdpPort);
		const inspector = await createFakeCdpServer(inspectPort);
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "electron-main-unsupported-cli" });
		try {
			await sendRequestAndReadResponse(cli.ws, { id: 1, method: "electron_allow", params: { appRef: "slack" } });
			await sendRequestAndReadResponse(cli.ws, {
				id: 2,
				method: "electron_attach",
				params: { appRef: "slack", port: cdpPort, inspectPort },
			});
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 3,
					method: "electron_main_info",
					params: { sessionId: "e1" },
				}),
			).resolves.toMatchObject({
				id: 3,
				error: { message: expect.stringContaining("does not support main-process inspector commands") },
			});
		} finally {
			cli.ws.close();
			await inspector.close();
			await cdp.close();
			if (previousConfigPath === undefined) delete process.env.SHUVGEIST_BRIDGE_CONFIG;
			else process.env.SHUVGEIST_BRIDGE_CONFIG = previousConfigPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("starts and stops invasive Electron main-process taps with capability gates", async () => {
		const dir = mkdtempSync(join(tmpdir(), "shuvgeist-main-taps-"));
		const previousConfigPath = process.env.SHUVGEIST_BRIDGE_CONFIG;
		process.env.SHUVGEIST_BRIDGE_CONFIG = join(dir, "bridge.json");
		const cdpPort = await getAvailablePort();
		const inspectPort = await getAvailablePort();
		const cdp = await createFakeCdpServer(cdpPort);
		const inspector = await createFakeCdpServer(inspectPort);
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "electron-main-taps-cli" });
		try {
			await sendRequestAndReadResponse(cli.ws, { id: 1, method: "electron_allow", params: { appRef: "vscode" } });
			await sendRequestAndReadResponse(cli.ws, {
				id: 2,
				method: "electron_attach",
				params: { appRef: "vscode", port: cdpPort, inspectPort },
			});
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 3,
					method: "electron_ipc_tap_start",
					params: { sessionId: "e1", channel: "workbench" },
				}),
			).resolves.toMatchObject({
				id: 3,
				result: {
					active: true,
					channel: "workbench",
					warning: expect.stringContaining("monkey-patches ipcMain.emit"),
				},
			});
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 4,
					method: "electron_main_network_start",
					params: { sessionId: "e1" },
				}),
			).resolves.toMatchObject({
				id: 4,
				result: { active: true, source: "main" },
			});
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 5,
					method: "electron_ipc_tap_stop",
					params: { sessionId: "e1" },
				}),
			).resolves.toMatchObject({
				id: 5,
				result: { ok: true, stopped: 1 },
			});
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 6,
					method: "electron_main_network_stop",
					params: { sessionId: "e1" },
				}),
			).resolves.toMatchObject({
				id: 6,
				result: { ok: true, stopped: 1, source: "main" },
			});
			writeFileSync(
				join(dir, "bridge.json"),
				JSON.stringify({
					token: "secret-token",
					electron: {
						allowlist: ["com.microsoft.VSCode"],
						capabilities: { "com.microsoft.VSCode": { ipc_tap: false } },
					},
				}),
			);
			await expect(
				sendRequestAndReadResponse(cli.ws, {
					id: 7,
					method: "electron_ipc_tap_start",
					params: { sessionId: "e1" },
				}),
			).resolves.toMatchObject({
				id: 7,
				error: { message: expect.stringContaining("capability 'ipc_tap' is disabled") },
			});
		} finally {
			cli.ws.close();
			await inspector.close();
			await cdp.close();
			if (previousConfigPath === undefined) delete process.env.SHUVGEIST_BRIDGE_CONFIG;
			else process.env.SHUVGEIST_BRIDGE_CONFIG = previousConfigPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exports Electron target telemetry attributes for success and failure paths", async () => {
		await server.stop();
		const telemetryPayloads: unknown[] = [];
		const originalFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (url === "http://127.0.0.1:4318/v1/traces") {
				telemetryPayloads.push(JSON.parse(String(init?.body)));
				return new Response("{}", { status: 200 });
			}
			return originalFetch(input, init);
		});
		port = await getAvailablePort();
		baseUrl = `ws://127.0.0.1:${port}/ws`;
		server = new BridgeServer({
			host: "127.0.0.1",
			port,
			token: "secret-token",
			otel: { enabled: true, ingestUrl: "http://127.0.0.1:4318", ingestKey: "maple_sk_test" },
		});
		await server.start();
		const cdpPort = await getAvailablePort();
		const cdp = await createFakeCdpServer(cdpPort);
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "electron-telemetry-cli" });
		try {
			await sendRequestAndReadResponse(cli.ws, { id: 1, method: "electron_attach", params: { port: cdpPort } });
			await sendRequestAndReadResponse(cli.ws, {
				id: 2,
				method: "eval",
				params: { code: "2 + 2" },
				target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
			});
			await sendRequestAndReadResponse(cli.ws, {
				id: 3,
				method: "eval",
				params: { code: "2 + 2" },
				target: { kind: "electron-window", sessionId: "missing", windowRef: "w1" },
			});
			await waitForTelemetryPayloads(telemetryPayloads, 3);
			const attachAttrs = spanAttributes(telemetryPayloads[0], "bridge.server.request.electron_attach");
			expect(attachAttrs).toMatchObject({
				"bridge.method": "electron_attach",
				"bridge.target.kind": "electron-local",
				"electron.port": String(cdpPort),
				"electron.session_id": "e1",
				"bridge.outcome": "success",
			});
			const evalAttrs = spanAttributes(telemetryPayloads[1], "bridge.server.request.eval");
			expect(evalAttrs).toMatchObject({
				"bridge.method": "eval",
				"bridge.target.kind": "electron-window",
				"electron.session_id": "e1",
				"electron.window_ref": "w1",
				"bridge.outcome": "success",
			});
			const failureAttrs = spanAttributes(telemetryPayloads[2], "bridge.server.request.eval");
			expect(failureAttrs).toMatchObject({
				"bridge.method": "eval",
				"bridge.target.kind": "electron-window",
				"electron.session_id": "missing",
				"bridge.outcome": "error",
				"error.type": "Error",
			});
		} finally {
			cli.ws.close();
			await cdp.close();
			vi.restoreAllMocks();
		}
	});

	it("cleans up pending requests and sends aborts on cli disconnect", async () => {
		const extension = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 41,
			capabilities: ["status", "session_inject"],
		});
		const cli = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "disconnect-cli" });
		cli.ws.send(JSON.stringify({ id: 7, method: "status" }));
		const request = await readMessage<{ id: number; method: string }>(extension.ws);
		expect(request).toMatchObject({ id: 1, method: "status" });
		cli.ws.close();
		await expect(readMessage(extension.ws)).resolves.toEqual({ type: "abort", id: 1 });
		extension.ws.close();
	});

	it("enforces a single writer lease and releases it on session change", async () => {
		const extension = await openRegisteredClient(baseUrl, "secret-token", "extension", {
			windowId: 51,
			capabilities: ["session_inject", "session_set_model"],
		});
		const cliA = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "writer-a" });
		const cliB = await openRegisteredClient(baseUrl, "secret-token", "cli", { name: "writer-b" });

		const firstResponsePromise = sendRequestAndReadResponse(cliA.ws, {
			id: 10,
			method: "session_inject",
			params: { expectedSessionId: "session-a", role: "user", content: "hello" },
		});
		const forwarded = await readMessage<{ id: number; method: string }>(extension.ws);
		expect(forwarded).toMatchObject({ id: 1, method: "session_inject" });

		await expect(
			sendRequestAndReadResponse(cliB.ws, {
				id: 11,
				method: "session_set_model",
				params: { model: "anthropic/claude-sonnet-4-6" },
			}),
		).resolves.toEqual({
			id: 11,
			error: {
				code: ErrorCodes.WRITE_LOCKED,
				message: "Another CLI currently holds the session write lock",
			},
		});

		extension.ws.send(JSON.stringify({ id: forwarded.id, result: { ok: true } }));
		await expect(firstResponsePromise).resolves.toEqual({ id: 10, result: { ok: true } });

		extension.ws.send(
			JSON.stringify({
				type: "event",
				event: "session_changed",
				data: { sessionId: "session-b", persisted: true, title: "next", messageCount: 0, lastMessageIndex: -1 },
			}),
		);

		cliB.ws.send(
			JSON.stringify({
				id: 12,
				method: "session_set_model",
				params: { model: "anthropic/claude-sonnet-4-6" },
			}),
		);
		const secondForward = await readMessage<{ id: number; method: string }>(extension.ws);
		expect(secondForward).toMatchObject({ id: 2, method: "session_set_model" });
		extension.ws.send(JSON.stringify({ id: secondForward.id, result: { ok: true } }));
		let secondResponse = await readMessage(cliB.ws);
		if ((secondResponse as { type?: string }).type === "event") {
			secondResponse = await readMessage(cliB.ws);
		}
		expect(secondResponse).toEqual({ id: 12, result: { ok: true } });

		extension.ws.close();
		cliA.ws.close();
		cliB.ws.close();
	});
});
