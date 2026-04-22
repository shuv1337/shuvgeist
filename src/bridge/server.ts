/**
 * Bridge server — lightweight relay between CLI agents and the Shuvgeist
 * extension sidepanel.
 *
 * Runs as a foreground Node process. Binds to a configurable host/port
 * (default 0.0.0.0:19285) so it is reachable from other machines on a
 * trusted local network.
 *
 * V1 trust model: intended for a secure local test network only.
 * No TLS, no public-network posture.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import { bridgeLog, generateConnectionId, type LogFields } from "./logging.js";
import {
	type AbortMessage,
	BridgeDefaults,
	type BridgeEvent,
	type BridgeMethod,
	BridgeMethods,
	type BridgeRequest,
	type BridgeResponse,
	type BridgeServerConfig,
	type BridgeServerStatus,
	ErrorCodes,
	isWriteMethod,
	type RegistrationMessage,
} from "./protocol.js";
import { BridgeTelemetry, type BridgeTelemetrySpan, parseTraceparent } from "./telemetry.js";

// ---------------------------------------------------------------------------
// Client tracking
// ---------------------------------------------------------------------------

interface ClientInfo {
	ws: WebSocket;
	connectionId: string;
	remoteAddress: string;
	registered: boolean;
	role?: "cli" | "extension";
	/** Extension-specific metadata. */
	windowId?: number;
	sessionId?: string;
	capabilities?: string[];
	/** CLI-specific metadata. */
	name?: string;
}

/**
 * Map from requestId → info needed to route the response back and handle
 * cleanup when the CLI disconnects before the extension responds.
 */
interface PendingRequest {
	relayRequestId: number;
	clientRequestId: number;
	cliConnectionId: string;
	cliWs: WebSocket;
	method: string;
	startedAt: number;
	span?: BridgeTelemetrySpan;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export class BridgeServer {
	private readonly config: BridgeServerConfig;
	private readonly clients = new Map<WebSocket, ClientInfo>();
	private readonly telemetry?: BridgeTelemetry;
	private activeExtension: ClientInfo | null = null;
	private readonly pendingRequests = new Map<number, PendingRequest>();
	private readonly rejectedBootstrapCounts = new Map<string, number>();
	private nextRelayRequestId = 1;
	private writerCliConnectionId?: string;
	private writerSessionId?: string;
	private httpServer?: ReturnType<typeof createServer>;
	private wss?: WebSocketServer;

	constructor(config: BridgeServerConfig) {
		this.config = config;
		if (config.otel) {
			this.telemetry = new BridgeTelemetry({
				serviceName: "shuvgeist-bridge-server",
				enabled: config.otel.enabled ?? false,
				ingestUrl: config.otel.ingestUrl,
				ingestKey: config.otel.ingestKey,
			});
		}
	}

	async start(): Promise<void> {
		const { host, port, token } = this.config;

		// -- HTTP server for /status health endpoint --------------------------
		const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
			const pathname = this.getRequestPathname(req);
			if (req.method === "GET" && pathname === "/status") {
				this.handleStatusRequest(res);
			} else if (req.method === "GET" && pathname === "/bootstrap") {
				this.handleBootstrapRequest(req, res);
			} else {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Not found" }));
			}
		});

		httpServer.on("error", (err: NodeJS.ErrnoException) => {
			bridgeLog("error", "bridge server failed to start", {
				role: "server",
				host,
				port,
				error: err.message,
				code: err.code,
			});
			console.error(`Failed to start bridge server on ${host}:${port}: ${err.message}`);
			process.exitCode = 1;
		});

		// -- WebSocket server attached to /ws ----------------------------------
		this.httpServer = httpServer;
		const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
		this.wss = wss;
		wss.on("error", (err: Error) => {
			bridgeLog("error", "websocket server error", {
				role: "server",
				host,
				port,
				error: err.message,
			});
		});

		wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
			const remoteAddress = req.socket.remoteAddress + ":" + req.socket.remotePort;
			const connectionId = generateConnectionId();

			const client: ClientInfo = {
				ws,
				connectionId,
				remoteAddress,
				registered: false,
			};
			this.clients.set(ws, client);

			bridgeLog("info", "client connected", {
				connectionId,
				remoteAddress,
				role: "server",
			});

			// Require registration within the timeout window
			const registerTimer = setTimeout(() => {
				if (!client.registered) {
					bridgeLog("warn", "registration timeout — closing", {
						connectionId,
						remoteAddress,
						role: "server",
						outcome: "timeout",
					});
					this.sendJson(ws, { type: "register_result", ok: false, error: "Registration timeout" });
					ws.close(4001, "Registration timeout");
				}
			}, BridgeDefaults.REGISTER_TIMEOUT_MS);

			ws.on("message", (data: Buffer | string) => {
				let msg: Record<string, unknown>;
				try {
					msg = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
				} catch {
					bridgeLog("warn", "invalid JSON from client", { connectionId, role: "server" });
					return;
				}
				this.handleMessage(client, msg);
			});

			ws.on("close", () => {
				clearTimeout(registerTimer);
				this.handleDisconnect(client);
			});

			ws.on("error", (err: Error) => {
				bridgeLog("error", "websocket error", {
					connectionId,
					role: "server",
					error: err.message,
				});
			});
		});

		// -- Start listening ---------------------------------------------------
		await new Promise<void>((resolve, reject) => {
			httpServer.listen(port, host, () => {
				bridgeLog("info", "bridge server started", {
					role: "server",
					host,
					port,
				});

				const advertisedUrls = this.getAdvertisedUrls(host);
				console.log("");
				console.log(`Bridge server listening on ${host}:${port}`);
				console.log("");
				if (advertisedUrls.length > 0) {
					console.log("Reachable at:");
					for (const url of advertisedUrls) {
						console.log(`  ws://${url}:${port}/ws`);
					}
					console.log("");
				}
				console.log("V1 — intended for a trusted local network only.");
				console.log("");
				resolve();
			});
			httpServer.once("error", reject);
		});
	}

	async stop(): Promise<void> {
		for (const client of this.clients.values()) {
			client.ws.close();
		}
		this.clients.clear();
		this.activeExtension = null;
		this.pendingRequests.clear();
		this.writerCliConnectionId = undefined;
		this.writerSessionId = undefined;

		if (this.wss) {
			await new Promise<void>((resolve, reject) => {
				this.wss?.close((err) => {
					if (err) reject(err);
					else resolve();
				});
			});
			this.wss = undefined;
		}

		if (this.httpServer) {
			await new Promise<void>((resolve, reject) => {
				this.httpServer?.close((err) => {
					if (err) reject(err);
					else resolve();
				});
			});
			this.httpServer = undefined;
		}
	}

	// -----------------------------------------------------------------------
	// Message routing
	// -----------------------------------------------------------------------

	private handleMessage(client: ClientInfo, msg: Record<string, unknown>): void {
		// Registration must come first
		if (!client.registered) {
			if (msg.type === "register") {
				this.handleRegistration(client, msg as unknown as RegistrationMessage);
			} else {
				bridgeLog("warn", "message before registration", {
					connectionId: client.connectionId,
					role: "server",
					outcome: "rejected",
				});
				this.sendJson(client.ws, {
					type: "register_result",
					ok: false,
					error: "Must register first",
				});
			}
			return;
		}

		// Post-registration message routing
		if (client.role === "cli" && typeof msg.id === "number" && typeof msg.method === "string") {
			this.handleCliRequest(client, msg as unknown as BridgeRequest);
		} else if (client.role === "extension" && typeof msg.id === "number" && ("result" in msg || "error" in msg)) {
			this.handleExtensionResponse(msg as unknown as BridgeResponse);
		} else if (client.role === "extension" && msg.type === "event") {
			this.handleExtensionEvent(msg as unknown as BridgeEvent);
		} else {
			bridgeLog("debug", "unhandled message type", {
				connectionId: client.connectionId,
				role: "server",
			});
		}
	}

	// -----------------------------------------------------------------------
	// Registration
	// -----------------------------------------------------------------------

	private handleRegistration(client: ClientInfo, msg: RegistrationMessage): void {
		const fields: LogFields = {
			connectionId: client.connectionId,
			remoteAddress: client.remoteAddress,
			role: "server",
		};

		// Auth check
		if (msg.token !== this.config.token) {
			bridgeLog("warn", "auth failed", { ...fields, outcome: "rejected" });
			this.sendJson(client.ws, {
				type: "register_result",
				ok: false,
				error: "Invalid token",
			});
			client.ws.close(4003, "Invalid token");
			return;
		}

		if (msg.role === "extension") {
			// Handle existing extension connection
			if (this.activeExtension && this.activeExtension.ws.readyState === WebSocket.OPEN) {
				if (this.activeExtension.windowId === msg.windowId) {
					// Same window reconnecting (sidepanel reload, settings change, etc.)
					// — replace the old connection gracefully
					bridgeLog("info", "replacing existing extension connection (same windowId)", {
						...fields,
						windowId: msg.windowId,
					});
					const oldWs = this.activeExtension.ws;
					this.clients.delete(oldWs);
					oldWs.close(4008, "Replaced by new connection from same window");
				} else {
					// Different window — reject (single active target constraint)
					bridgeLog("warn", "extension already connected — rejecting new registration", {
						...fields,
						outcome: "rejected",
						existingWindowId: this.activeExtension.windowId,
						newWindowId: msg.windowId,
					});
					this.sendJson(client.ws, {
						type: "register_result",
						ok: false,
						error: "Another extension target is already connected",
					});
					client.ws.close(4007, "Extension already connected");
					return;
				}
			}

			client.role = "extension";
			client.registered = true;
			client.windowId = msg.windowId;
			client.sessionId = msg.sessionId;
			client.capabilities = msg.capabilities;
			this.activeExtension = client;

			bridgeLog("info", "extension registered", {
				...fields,
				windowId: msg.windowId,
			});

			this.sendJson(client.ws, { type: "register_result", ok: true });

			// Broadcast to all CLIs
			this.broadcastToRole("cli", {
				type: "event",
				event: "extension_connected",
				data: { windowId: msg.windowId },
			});
		} else if (msg.role === "cli") {
			client.role = "cli";
			client.registered = true;
			client.name = msg.name;

			bridgeLog("info", "cli registered", {
				...fields,
				name: msg.name,
			});

			this.sendJson(client.ws, { type: "register_result", ok: true });
		}
	}

	// -----------------------------------------------------------------------
	// CLI request → extension
	// -----------------------------------------------------------------------

	private handleCliRequest(client: ClientInfo, req: BridgeRequest): void {
		const fields: LogFields = {
			connectionId: client.connectionId,
			role: "server",
			requestId: req.id,
			method: req.method,
		};
		const span = this.telemetry?.startSpan(`bridge.server.request.${req.method}`, {
			parent: parseTraceparent(req.traceparent, req.tracestate),
			kind: "server",
			attributes: {
				"bridge.method": req.method,
				"bridge.request_id": req.id,
				"bridge.cli_connection_id": client.connectionId,
			},
		});

		// Validate method
		if (!BridgeMethods.includes(req.method as BridgeMethod)) {
			bridgeLog("warn", "invalid method", { ...fields, outcome: "rejected" });
			span?.recordError(new Error("Unknown method: " + req.method));
			span?.setAttribute("bridge.outcome", "rejected");
			span?.end("error");
			void this.telemetry?.flush();
			this.sendJson(client.ws, {
				id: req.id,
				error: { code: ErrorCodes.INVALID_METHOD, message: "Unknown method: " + req.method },
			});
			return;
		}

		// Check extension target
		if (!this.activeExtension || this.activeExtension.ws.readyState !== WebSocket.OPEN) {
			bridgeLog("warn", "no extension target", { ...fields, outcome: "error" });
			span?.recordError(new Error("No active extension target connected"));
			span?.setAttribute("bridge.outcome", "error");
			span?.end("error");
			void this.telemetry?.flush();
			this.sendJson(client.ws, {
				id: req.id,
				error: { code: ErrorCodes.NO_EXTENSION_TARGET, message: "No active extension target connected" },
			});
			return;
		}

		if (this.activeExtension.capabilities && !this.activeExtension.capabilities.includes(req.method)) {
			bridgeLog("warn", "capability disabled on active extension", {
				...fields,
				outcome: "rejected",
				capabilities: this.activeExtension.capabilities,
			});
			span?.recordError(new Error(`Method '${req.method}' is disabled on the active extension target`));
			span?.setAttribute("bridge.outcome", "rejected");
			span?.end("error");
			void this.telemetry?.flush();
			this.sendJson(client.ws, {
				id: req.id,
				error: {
					code: ErrorCodes.CAPABILITY_DISABLED,
					message: `Method '${req.method}' is disabled on the active extension target`,
				},
			});
			return;
		}

		if (isWriteMethod(req.method)) {
			if (this.writerCliConnectionId && this.writerCliConnectionId !== client.connectionId) {
				bridgeLog("warn", "session inject rejected due to active writer lock", {
					...fields,
					outcome: "rejected",
					writerCliConnectionId: this.writerCliConnectionId,
					writerSessionId: this.writerSessionId,
				});
				span?.recordError(new Error("Another CLI currently holds the session write lock"));
				span?.setAttribute("bridge.outcome", "rejected");
				span?.end("error");
				void this.telemetry?.flush();
				this.sendJson(client.ws, {
					id: req.id,
					error: {
						code: ErrorCodes.WRITE_LOCKED,
						message: "Another CLI currently holds the session write lock",
					},
				});
				return;
			}
			this.writerCliConnectionId = client.connectionId;
			const expectedSessionId =
				req.params && typeof req.params.expectedSessionId === "string" ? req.params.expectedSessionId : undefined;
			this.writerSessionId = expectedSessionId;
			bridgeLog("info", "session writer lease acquired", {
				...fields,
				sessionId: expectedSessionId,
				outcome: "success",
			});
		}

		const relayRequestId = this.nextRelayRequestId++;
		this.pendingRequests.set(relayRequestId, {
			relayRequestId,
			clientRequestId: req.id,
			cliConnectionId: client.connectionId,
			cliWs: client.ws,
			method: req.method,
			startedAt: Date.now(),
			span,
		});

		bridgeLog("debug", "forwarding request to extension", {
			...fields,
			relayRequestId,
		});

		this.sendJson(this.activeExtension.ws, {
			...req,
			id: relayRequestId,
			...(span ? span.toTraceHeaders() : {}),
		});
	}

	// -----------------------------------------------------------------------
	// Extension response → CLI
	// -----------------------------------------------------------------------

	private handleExtensionResponse(res: BridgeResponse): void {
		const pending = this.pendingRequests.get(res.id);
		if (!pending) {
			bridgeLog("warn", "response for unknown request", {
				role: "server",
				requestId: res.id,
			});
			return;
		}

		this.pendingRequests.delete(res.id);

		const durationMs = Date.now() - pending.startedAt;
		const outcome = res.error ? "error" : "success";

		bridgeLog("info", "command completed", {
			role: "server",
			requestId: pending.clientRequestId,
			relayRequestId: pending.relayRequestId,
			method: pending.method,
			connectionId: pending.cliConnectionId,
			durationMs,
			outcome,
		});
		pending.span?.setAttribute("bridge.outcome", outcome);
		if (res.error) {
			pending.span?.recordError(new Error(res.error.message));
			pending.span?.end("error");
		} else {
			pending.span?.end("ok");
		}
		void this.telemetry?.flush();

		if (pending.cliWs.readyState === WebSocket.OPEN) {
			this.sendJson(pending.cliWs, {
				...res,
				id: pending.clientRequestId,
			});
		}
	}

	// -----------------------------------------------------------------------
	// Extension events → all CLIs
	// -----------------------------------------------------------------------

	private handleExtensionEvent(event: BridgeEvent): void {
		bridgeLog("debug", "extension event", {
			role: "server",
			event: event.event,
		} as LogFields);
		if (event.event === "session_changed") {
			const sessionId =
				event.data && typeof event.data.sessionId === "string" ? (event.data.sessionId as string) : undefined;
			if (this.writerSessionId && this.writerSessionId !== sessionId) {
				bridgeLog("info", "releasing session writer lease due to session change", {
					role: "server",
					writerCliConnectionId: this.writerCliConnectionId,
					writerSessionId: this.writerSessionId,
					sessionId,
				});
				this.writerCliConnectionId = undefined;
				this.writerSessionId = undefined;
			}
		}
		this.broadcastToRole("cli", event);
	}

	// -----------------------------------------------------------------------
	// Disconnect handling
	// -----------------------------------------------------------------------

	private handleDisconnect(client: ClientInfo): void {
		const fields: LogFields = {
			connectionId: client.connectionId,
			remoteAddress: client.remoteAddress,
			role: "server",
		};

		this.clients.delete(client.ws);

		if (client.role === "extension" && this.activeExtension === client) {
			this.activeExtension = null;
			this.writerCliConnectionId = undefined;
			this.writerSessionId = undefined;
			bridgeLog("info", "extension disconnected", { ...fields, windowId: client.windowId });

			for (const pending of this.pendingRequests.values()) {
				pending.span?.recordError(new Error("Extension disconnected while request was pending"));
				pending.span?.setAttribute("bridge.outcome", "error");
				pending.span?.end("error");
				if (pending.cliWs.readyState === WebSocket.OPEN) {
					this.sendJson(pending.cliWs, {
						id: pending.clientRequestId,
						error: {
							code: ErrorCodes.NO_EXTENSION_TARGET,
							message: "Extension disconnected while request was pending",
						},
					});
				}
			}
			this.pendingRequests.clear();
			void this.telemetry?.flush();

			// Broadcast to all CLIs
			this.broadcastToRole("cli", {
				type: "event",
				event: "extension_disconnected",
			});
		} else if (client.role === "cli") {
			if (this.writerCliConnectionId === client.connectionId) {
				bridgeLog("info", "releasing session writer lease due to cli disconnect", {
					...fields,
					sessionId: this.writerSessionId,
				});
				this.writerCliConnectionId = undefined;
				this.writerSessionId = undefined;
			}
			bridgeLog("info", "cli disconnected", { ...fields, name: client.name });

			for (const [relayRequestId, pending] of this.pendingRequests) {
				if (pending.cliConnectionId === client.connectionId) {
					this.pendingRequests.delete(relayRequestId);
					pending.span?.recordError(new Error("CLI disconnected while request was pending"));
					pending.span?.setAttribute("bridge.outcome", "aborted");
					pending.span?.end("error");

					if (this.activeExtension && this.activeExtension.ws.readyState === WebSocket.OPEN) {
						const abort: AbortMessage = { type: "abort", id: relayRequestId };
						this.sendJson(this.activeExtension.ws, abort);
					}

					bridgeLog("info", "aborted pending request (cli disconnected)", {
						role: "server",
						requestId: pending.clientRequestId,
						relayRequestId,
						method: pending.method,
						outcome: "aborted",
					});
				}
			}
			void this.telemetry?.flush();
		} else {
			bridgeLog("info", "unregistered client disconnected", fields);
		}
	}

	// -----------------------------------------------------------------------
	// /status and /bootstrap endpoints
	// -----------------------------------------------------------------------

	private handleBootstrapRequest(req: IncomingMessage, res: ServerResponse): void {
		const rejectionReason = this.getBootstrapRejectionReason(req);
		if (rejectionReason) {
			this.logBootstrapRejection(req, rejectionReason);
			this.writeJson(res, 403, { error: rejectionReason });
			return;
		}

		// Trust model: a same-user local process can already read
		// ~/.shuvgeist/bridge.json, so /bootstrap does not add a meaningful new
		// attack surface as long as loopback-only transport, Host/Origin checks,
		// the custom bootstrap header requirement, and closed-by-default CORS
		// behavior are all enforced here.
		this.writeJson(res, 200, {
			version: 1,
			token: this.config.token,
		});
	}

	private handleStatusRequest(res: ServerResponse): void {
		const ext = this.activeExtension;
		const status: BridgeServerStatus = {
			ok: true,
			extension: ext
				? {
						connected: true,
						windowId: ext.windowId,
						sessionId: ext.sessionId,
						capabilities: ext.capabilities,
						remoteAddress: ext.remoteAddress,
					}
				: { connected: false },
			clients: {
				total: this.clients.size,
				cli: this.countByRole("cli"),
				extension: this.countByRole("extension"),
			},
			pendingRequests: this.pendingRequests.size,
		};

		this.writeJson(res, 200, status);
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	private getRequestPathname(req: IncomingMessage): string {
		return new URL(req.url || "/", "http://127.0.0.1").pathname;
	}

	private getBootstrapRejectionReason(req: IncomingMessage): string | null {
		const remoteAddress = req.socket.remoteAddress;
		if (!this.isLoopbackRemoteAddress(remoteAddress)) {
			return "Bootstrap is only available from loopback callers";
		}

		if (!this.isAllowedBootstrapHost(req.headers.host)) {
			return "Bootstrap rejected due to invalid Host header";
		}

		if (!this.isAllowedBootstrapOrigin(req.headers.origin)) {
			return "Bootstrap rejected due to invalid Origin header";
		}

		if (req.headers["x-shuvgeist-bootstrap"] !== "1") {
			return "Bootstrap requires X-Shuvgeist-Bootstrap: 1";
		}

		return null;
	}

	private isLoopbackRemoteAddress(remoteAddress?: string): boolean {
		return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
	}

	private isAllowedBootstrapHost(hostHeader?: string): boolean {
		return (
			hostHeader === `127.0.0.1:${this.config.port}` ||
			hostHeader === `localhost:${this.config.port}` ||
			hostHeader === `[::1]:${this.config.port}`
		);
	}

	private isAllowedBootstrapOrigin(originHeader?: string): boolean {
		if (!originHeader) return true;
		if (/^chrome-extension:\/\/[a-p]{32}$/u.test(originHeader)) return true;
		return false;
	}

	private logBootstrapRejection(req: IncomingMessage, reason: string): void {
		const remoteAddress = req.socket.remoteAddress || "unknown";
		const key = `${remoteAddress}:${reason}`;
		const count = (this.rejectedBootstrapCounts.get(key) || 0) + 1;
		this.rejectedBootstrapCounts.set(key, count);
		if (count <= 3 || count % 10 === 0) {
			bridgeLog("warn", "bootstrap request rejected", {
				role: "server",
				remoteAddress,
				outcome: "rejected",
				reason,
				count,
			});
		}
	}

	private writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
		res.writeHead(statusCode, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body, null, statusCode === 200 ? 2 : undefined));
	}

	private sendJson(ws: WebSocket, data: unknown): void {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(data));
		}
	}

	private broadcastToRole(role: "cli" | "extension", data: unknown): void {
		for (const client of this.clients.values()) {
			if (client.registered && client.role === role && client.ws.readyState === WebSocket.OPEN) {
				this.sendJson(client.ws, data);
			}
		}
	}

	private countByRole(role: "cli" | "extension"): number {
		let count = 0;
		for (const client of this.clients.values()) {
			if (client.registered && client.role === role) count++;
		}
		return count;
	}

	private getAdvertisedUrls(host: string): string[] {
		if (host === "127.0.0.1" || host === "localhost") {
			return ["127.0.0.1"];
		}
		if (host !== "0.0.0.0") {
			return [host];
		}

		const urls = new Set<string>(["127.0.0.1"]);
		const ifaces = networkInterfaces();
		for (const name in ifaces) {
			for (const iface of ifaces[name] || []) {
				if (iface.family === "IPv4" && !iface.internal) {
					urls.add(iface.address);
				}
			}
		}
		return [...urls];
	}
}
