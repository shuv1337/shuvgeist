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
import {
	type BridgeCommandMethodForRoute,
	type BridgeCommandParams,
	type BridgeCommandResult,
	type BridgeSchemaMethod,
	formatBridgeCommandValidationErrors,
	getBridgeCommandDefinition,
	isBridgeSchemaMethod,
	type ResolvedPageTarget,
	validateBridgeCommandParams,
	validateBridgeCommandResult,
} from "@shuvgeist/protocol/command-schemas";
import { bridgeLog, generateConnectionId, type LogFields } from "@shuvgeist/protocol/logging";
import {
	type AbortMessage,
	BRIDGE_PROTOCOL_MIN_VERSION,
	BRIDGE_PROTOCOL_VERSION,
	BridgeCapabilities,
	type BridgeCapability,
	BridgeDefaults,
	type BridgeEvent,
	type BridgeRequest,
	type BridgeResponse,
	type BridgeServerConfig,
	type BridgeServerStatus,
	ErrorCodes,
	formatBridgeProtocolMismatch,
	isBridgeProtocolCompatible,
	type PageSnapshotBridgeParams,
	type PageSnapshotBridgeResult,
	type PageSnapshotRecordSummary,
	type RegistrationMessage,
} from "@shuvgeist/protocol/protocol";
import { parseBridgeSkillSnapshot } from "@shuvgeist/protocol/skill-snapshot";
import {
	type BridgeTarget,
	isChromeTarget,
	isElectronTarget,
	requestTarget,
	targetTeachingLabel,
} from "@shuvgeist/protocol/target";
import {
	BridgeTelemetry,
	type BridgeTelemetrySpan,
	parseTraceparent,
	type TelemetryAttributes,
} from "@shuvgeist/protocol/telemetry";
import { WebSocket, WebSocketServer } from "ws";
import { CookieAccessPort } from "./cookie-access-port.js";
import { listElectronRegistryEntries, resolveElectronApp } from "./electron/app-registry.js";
import { manageElectronAutoAttach } from "./electron/auto-attach.js";
import { allowElectronApp, normalizeElectronConfig } from "./electron/config.js";
import { runElectronDoctor } from "./electron/doctor.js";
import { ElectronSessionManager } from "./electron/session-manager.js";
import { readSkillSnapshot, writeSkillSnapshot } from "./electron/skill-snapshot-store.js";
import {
	extractElectronSource,
	inspectElectronSourceLayout,
	listElectronSource,
	readElectronSourceFile,
} from "./electron/source-inspector.js";
import { executeElectronTargetCommand, isElectronTargetBridgeMethod } from "./electron/target-handler-registry.js";
import { McpHttpHandler } from "./mcp/http-server.js";
import { createNodeConfigOwner, type NodeConfigOwner } from "./node-config.js";
import { type PageSnapshotRecord, PageSnapshotStore, pageSnapshotStorePath } from "./page-snapshot-store.js";
import { BridgeRequestHandler, type BridgeRequestTargetHandle } from "./request-handler.js";
import { SessionRegistry, type TargetSessionHandle } from "./session-registry.js";
import { TaskRegistry } from "./task-registry.js";

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
	protocolVersion?: number;
	minProtocolVersion?: number;
	appVersion?: string;
	/** CLI-specific metadata. */
	name?: string;
}

const BRIDGE_CAPABILITY_SET = new Set<string>(BridgeCapabilities);

function parseCapabilitiesUpdate(event: BridgeEvent): BridgeCapability[] | undefined {
	const capabilities = event.data?.capabilities;
	if (!Array.isArray(capabilities)) return undefined;
	if (
		capabilities.some((capability) => typeof capability !== "string" || !BRIDGE_CAPABILITY_SET.has(capability)) ||
		new Set(capabilities).size !== capabilities.length
	) {
		return undefined;
	}
	return [...capabilities] as BridgeCapability[];
}

/**
 * Map from requestId → info needed to route the response back and handle
 * cleanup when the CLI disconnects before the extension responds.
 */
interface PendingRequest {
	relayRequestId: number;
	clientRequestId: number;
	cliConnectionId: string;
	cliWs?: WebSocket;
	method: BridgeSchemaMethod;
	startedAt: number;
	targetHandleKey?: string;
	span?: BridgeTelemetrySpan;
	transformResult?: (result: unknown) => unknown;
	respond?: (response: BridgeResponse) => void;
}

interface ActiveRecordingLease {
	cliConnectionId: string;
	recordingId: string;
	target: ResolvedPageTarget;
	startedAt: number;
	targetHandleKey?: string;
}

interface BridgeServerRequestTargetHandle extends BridgeRequestTargetHandle {
	targetHandle: TargetSessionHandle<ClientInfo>;
}

type ServerLocalBridgeMethod = BridgeCommandMethodForRoute<"server-local">;

const SERVER_LOCAL_RESPONSE_HANDLED: unique symbol = Symbol("server-local-response-handled");

interface ServerLocalHandlerContext {
	client: ClientInfo;
	request: BridgeRequest;
	span?: BridgeTelemetrySpan;
	target: BridgeTarget;
}

type ServerLocalHandlerOutcome<M extends ServerLocalBridgeMethod> =
	| BridgeCommandResult<M>
	| typeof SERVER_LOCAL_RESPONSE_HANDLED;

type ServerLocalCommandHandler<M extends ServerLocalBridgeMethod> = (
	context: ServerLocalHandlerContext,
	params: BridgeCommandParams<M>,
) => ServerLocalHandlerOutcome<M> | Promise<ServerLocalHandlerOutcome<M>>;

type ServerLocalCommandHandlerRegistry = {
	[M in ServerLocalBridgeMethod]: ServerLocalCommandHandler<M>;
};

class BridgeCommandBoundaryError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "BridgeCommandBoundaryError";
	}
}

function electronTargetTelemetryAttributes(target: ReturnType<typeof requestTarget>): TelemetryAttributes {
	if (!isElectronTarget(target)) return {};
	return {
		"bridge.target.kind": target.kind,
		"electron.app_ref": target.appRef,
		"electron.session_id": target.sessionId,
		"electron.window_ref": target.windowRef,
		"electron.target_id": target.targetId,
	};
}

function electronServerLocalTelemetryAttributes(req: BridgeRequest): TelemetryAttributes {
	return {
		"bridge.target.kind": "electron-local",
		"electron.app_ref": typeof req.params?.appRef === "string" ? req.params.appRef : undefined,
		"electron.session_id": typeof req.params?.sessionId === "string" ? req.params.sessionId : undefined,
		"electron.window_ref": typeof req.params?.windowRef === "string" ? req.params.windowRef : undefined,
		"electron.port": typeof req.params?.port === "number" ? req.params.port : undefined,
		"electron.pid": typeof req.params?.pid === "number" ? req.params.pid : undefined,
	};
}

function electronResultTelemetryAttributes(result: unknown): TelemetryAttributes {
	const value = result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
	const directWindow =
		value?.window && typeof value.window === "object" ? (value.window as Record<string, unknown>) : undefined;
	const windows =
		Array.isArray(value?.windows) && value.windows[0] && typeof value.windows[0] === "object"
			? (value.windows[0] as Record<string, unknown>)
			: undefined;
	return {
		"electron.app_id": typeof value?.appId === "string" ? value.appId : undefined,
		"electron.app_ref": typeof value?.appRef === "string" ? value.appRef : undefined,
		"electron.session_id": typeof value?.id === "string" ? value.id : undefined,
		"electron.window_ref":
			typeof directWindow?.ref === "string"
				? directWindow.ref
				: typeof windows?.ref === "string"
					? windows.ref
					: undefined,
		"electron.launched": typeof value?.launched === "boolean" ? value.launched : undefined,
		"electron.recording_id": typeof value?.recordingId === "string" ? value.recordingId : undefined,
	};
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface BridgeServerDependencies {
	electronSessionManager?: ElectronSessionManager;
	nodeConfig?: NodeConfigOwner;
	pageSnapshotStore?: PageSnapshotStore;
}

export class BridgeServer {
	private readonly config: BridgeServerConfig;
	private readonly clients = new Map<WebSocket, ClientInfo>();
	private readonly telemetry?: BridgeTelemetry;
	private readonly sessionRegistry = new SessionRegistry<ClientInfo>();
	private readonly requestHandler = new BridgeRequestHandler<BridgeServerRequestTargetHandle>();
	private readonly pendingRequests = new Map<number, PendingRequest>();
	private readonly taskRegistry = new TaskRegistry();
	private readonly rejectedBootstrapCounts = new Map<string, number>();
	private nextRelayRequestId = 1;
	private readonly nodeConfig: NodeConfigOwner;
	private readonly electronSessions: ElectronSessionManager;
	private readonly pageSnapshotStore: PageSnapshotStore;
	private readonly cookieAccessPort = new CookieAccessPort();
	private readonly mcpHandler = new McpHttpHandler({
		taskRegistry: this.taskRegistry,
		executor: { execute: (request) => this.executeMcpBridgeRequest(request) },
		readRequestBody: (req) => this.readRequestBody(req),
	});
	private readonly serverLocalCommandHandlers: ServerLocalCommandHandlerRegistry = {
		cookie_import: async ({ client, request, span }): Promise<typeof SERVER_LOCAL_RESPONSE_HANDLED> => {
			await this.handleCookieImportRequest(client, request, span);
			return SERVER_LOCAL_RESPONSE_HANDLED;
		},
		snapshot_store: async ({ client, request, span }): Promise<typeof SERVER_LOCAL_RESPONSE_HANDLED> => {
			await this.handleSnapshotStoreRequest(client, request, span);
			return SERVER_LOCAL_RESPONSE_HANDLED;
		},
		snapshot_read: (_context, params) => ({
			records: this.pageSnapshotStore
				.read(params)
				.map((record) => ({ ...this.snapshotRecordSummary(record), raw: record.raw })),
		}),
		electron_list: () => {
			const config = normalizeElectronConfig(this.nodeConfig.readBridgeConfig());
			return {
				apps: listElectronRegistryEntries(new Set(config.allowlist)),
				sessions: this.electronSessions.list(),
			};
		},
		electron_allow: (_context, params) => {
			const app = resolveElectronApp(params.appRef);
			if (!app) {
				throw new Error(
					`Unknown Electron app '${params.appRef}'. Run 'shuvgeist electron list' to see known apps.`,
				);
			}
			allowElectronApp(app.id, this.nodeConfig);
			return { ok: true, appId: app.id };
		},
		electron_launch: async (_context, params) => {
			const result = await this.electronSessions.launch(params.appRef, { inspectMain: params.inspectMain === true });
			this.broadcastElectronSessionsChanged("attach");
			return result;
		},
		electron_attach: async (_context, params) => {
			const result = await this.electronSessions.attach(params);
			this.broadcastElectronSessionsChanged("attach");
			return result;
		},
		electron_detach: (_context, params) => {
			const result = { ok: this.electronSessions.detach(params.sessionId), sessionId: params.sessionId };
			this.broadcastElectronSessionsChanged("detach");
			return result;
		},
		electron_windows: async ({ target }) => {
			const result = { sessions: await this.electronSessions.windows(target) };
			this.broadcastElectronSessionsChanged("windows");
			return result;
		},
		electron_label: async (_context, params) => {
			const result = {
				ok: true as const,
				window: await this.electronSessions.labelWindow(params.sessionId, params.windowRef, params.label),
			};
			this.broadcastElectronSessionsChanged("label");
			return result;
		},
		electron_main_info: (_context, params) => this.electronSessions.mainInfo(params.sessionId),
		electron_ipc_tap_start: (_context, params) =>
			this.electronSessions.startIpcTap(params.sessionId, { channel: params.channel }),
		electron_ipc_tap_stop: (_context, params) => this.electronSessions.stopIpcTap(params.sessionId),
		electron_main_network_start: (_context, params) => this.electronSessions.startMainNetworkTap(params.sessionId),
		electron_main_network_stop: (_context, params) => this.electronSessions.stopMainNetworkTap(params.sessionId),
		electron_source_layout: (_context, params) => inspectElectronSourceLayout(params),
		electron_source_list: (_context, params) => listElectronSource(params),
		electron_source_read: (_context, params) => readElectronSourceFile(params),
		electron_source_extract: (_context, params) => extractElectronSource(params),
		electron_doctor: (_context, params) => runElectronDoctor({ ...params, configOwner: this.nodeConfig }),
		electron_auto_attach: (_context, params) => manageElectronAutoAttach(params.action, params.appRef),
		skills_snapshot_status: () => readSkillSnapshot(this.nodeConfig).status,
	};
	private readonly activeRecordingLeases = new Map<string, ActiveRecordingLease>();
	private httpServer?: ReturnType<typeof createServer>;
	private wss?: WebSocketServer;

	constructor(config: BridgeServerConfig, dependencies: BridgeServerDependencies = {}) {
		this.config = config;
		this.nodeConfig = dependencies.nodeConfig ?? createNodeConfigOwner();
		this.electronSessions =
			dependencies.electronSessionManager ?? new ElectronSessionManager({ configOwner: this.nodeConfig });
		const snapshotPath = pageSnapshotStorePath(this.nodeConfig);
		this.pageSnapshotStore = dependencies.pageSnapshotStore ?? new PageSnapshotStore(snapshotPath);
		if (config.otel) {
			this.telemetry = new BridgeTelemetry({
				serviceName: "shuvgeist-bridge-server",
				serviceVersion: config.serverVersion,
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
				void this.handleStatusRequest(res);
			} else if (req.method === "GET" && pathname === "/bootstrap") {
				this.handleBootstrapRequest(req, res);
			} else if (req.method === "POST" && pathname === "/skills/snapshot") {
				void this.handleSkillSnapshotWrite(req, res);
			} else if (pathname === "/mcp") {
				void this.handleMcpRequest(req, res);
			} else if (req.method === "POST" && pathname === "/electron/detach") {
				void this.handleElectronDetachHttp(req, res);
			} else if (req.method === "POST" && pathname === "/electron/thumbnail") {
				void this.handleElectronThumbnailHttp(req, res);
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
		this.sessionRegistry.clear();
		this.pendingRequests.clear();
		this.activeRecordingLeases.clear();
		await this.electronSessions.dispose();

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
			this.handleExtensionEvent(client, msg as unknown as BridgeEvent);
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

		// Protocol v2 registrations predate the explicit minimum field. Treat
		// those peers as a single-version range while negotiating real ranges
		// with current clients.
		const clientMinProtocolVersion =
			typeof msg.minProtocolVersion === "number" ? msg.minProtocolVersion : msg.protocolVersion;
		if (!isBridgeProtocolCompatible(msg.protocolVersion, clientMinProtocolVersion)) {
			const error = formatBridgeProtocolMismatch(
				msg.role === "cli" ? "CLI" : "extension",
				msg.protocolVersion,
				clientMinProtocolVersion,
			);
			bridgeLog("warn", "protocol mismatch", {
				...fields,
				outcome: "rejected",
				clientProtocolVersion: msg.protocolVersion,
				clientMinProtocolVersion,
				clientAppVersion: msg.appVersion,
			});
			this.sendJson(client.ws, {
				type: "register_result",
				ok: false,
				error,
			});
			client.ws.close(4009, "Protocol mismatch");
			return;
		}

		if (msg.role === "extension") {
			const existingHandle = this.sessionRegistry.get("chrome-window:" + msg.windowId);
			if (existingHandle?.connection.ws.readyState === WebSocket.OPEN) {
				bridgeLog("info", "replacing existing extension connection (same windowId)", {
					...fields,
					windowId: msg.windowId,
				});
				const oldWs = existingHandle.connection.ws;
				this.clients.delete(oldWs);
				this.sessionRegistry.unregisterByConnection(existingHandle.connection);
				oldWs.close(4008, "Replaced by new connection from same window");
			}

			client.role = "extension";
			client.registered = true;
			client.windowId = msg.windowId;
			client.sessionId = msg.sessionId;
			client.capabilities = msg.capabilities;
			client.protocolVersion = msg.protocolVersion;
			client.minProtocolVersion = clientMinProtocolVersion;
			client.appVersion = msg.appVersion;
			this.sessionRegistry.register({
				kind: "chrome-tab",
				connection: client,
				windowId: msg.windowId,
				sessionId: msg.sessionId,
				capabilities: msg.capabilities,
				protocolVersion: msg.protocolVersion,
				appVersion: msg.appVersion,
				remoteAddress: client.remoteAddress,
			});

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
			client.protocolVersion = msg.protocolVersion;
			client.minProtocolVersion = clientMinProtocolVersion;
			client.appVersion = msg.appVersion;

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

		const plan = this.requestHandler.plan(req, {
			cliConnectionId: client.connectionId,
			resolveTarget: (target) => this.resolveRequestTargetHandle(target),
		});

		if (plan.type === "error") {
			if (plan.reason === "invalid-method") {
				bridgeLog("warn", "invalid method", { ...fields, outcome: "rejected" });
				span?.recordError(new Error(plan.error.message));
				span?.setAttribute("bridge.outcome", "rejected");
			} else if (plan.reason === "missing-extension-target") {
				bridgeLog("warn", "no extension target", { ...fields, outcome: "error" });
				span?.recordError(new Error(plan.error.message));
				span?.setAttribute("bridge.outcome", "error");
			} else if (plan.reason === "capability-disabled") {
				bridgeLog("warn", "capability disabled on active extension", {
					...fields,
					outcome: "rejected",
				});
				span?.recordError(new Error(plan.error.message));
				span?.setAttribute("bridge.outcome", "rejected");
			} else if (plan.reason === "write-locked") {
				bridgeLog("warn", "session inject rejected due to active writer lock", {
					...fields,
					outcome: "rejected",
					writerCliConnectionId: plan.writeLockHolder?.cliConnectionId,
					writerSessionId: plan.writeLockHolder?.sessionId,
				});
				span?.recordError(new Error(plan.error.message));
				span?.setAttribute("bridge.outcome", "rejected");
			}
			span?.end("error");
			void this.telemetry?.flush();
			this.sendJson(client.ws, {
				id: req.id,
				error: plan.error,
			});
			return;
		}

		if (plan.type === "server-local") {
			this.handleServerLocalRequest(client, req, span);
			return;
		}

		if (plan.type === "electron-target") {
			void this.handleElectronTargetRequest(client, req, plan.target, span, fields);
			return;
		}

		const targetHandle = plan.handle.targetHandle;
		if (plan.writeLockAcquired) {
			bridgeLog("info", "session writer lease acquired", {
				...fields,
				sessionId: plan.expectedSessionId,
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
			targetHandleKey: targetHandle.key,
			span,
		});

		bridgeLog("debug", "forwarding request to extension", {
			...fields,
			relayRequestId,
		});

		this.sendJson(targetHandle.connection.ws, {
			...req,
			id: relayRequestId,
			target: plan.target,
			...(span ? span.toTraceHeaders() : {}),
		});
	}

	private resolveRequestTargetHandle(
		target: ReturnType<typeof requestTarget>,
	): BridgeServerRequestTargetHandle | undefined {
		const targetHandle = this.sessionRegistry.resolve(target);
		if (!targetHandle) return undefined;
		return {
			key: targetHandle.key,
			isOpen: targetHandle.connection.ws.readyState === WebSocket.OPEN,
			capabilities: targetHandle.capabilities,
			acquireWriteLock: (cliConnectionId, expectedSessionId) =>
				targetHandle.writeLock.acquire(cliConnectionId, expectedSessionId),
			targetHandle,
		};
	}

	private validatedCommandParams<M extends BridgeSchemaMethod>(method: M, value: unknown): BridgeCommandParams<M> {
		const validation = validateBridgeCommandParams(method, value);
		if (!validation.ok) {
			throw new BridgeCommandBoundaryError(
				ErrorCodes.INVALID_PARAMS,
				`Invalid parameters for '${method}': ${formatBridgeCommandValidationErrors(validation.errors)}`,
			);
		}
		return validation.value;
	}

	private validatedCommandResult<M extends BridgeSchemaMethod>(method: M, value: unknown): BridgeCommandResult<M> {
		const validation = validateBridgeCommandResult(method, value);
		if (!validation.ok) {
			throw new BridgeCommandBoundaryError(
				ErrorCodes.INVALID_RESULT,
				`Invalid result for '${method}': ${formatBridgeCommandValidationErrors(validation.errors)}`,
			);
		}
		return validation.value;
	}

	private executeServerLocalCommand<M extends ServerLocalBridgeMethod>(
		context: ServerLocalHandlerContext,
		method: M,
		params: BridgeCommandParams<M>,
	): Promise<ServerLocalHandlerOutcome<M>> {
		const handler = this.serverLocalCommandHandlers[method] as ServerLocalCommandHandler<M>;
		return Promise.resolve(handler(context, params));
	}

	private handleServerLocalRequest(client: ClientInfo, req: BridgeRequest, span?: BridgeTelemetrySpan): void {
		void this.handleServerLocalRequestAsync(client, req, span);
	}

	private async handleElectronTargetRequest(
		client: ClientInfo,
		req: BridgeRequest,
		target: ReturnType<typeof requestTarget>,
		span: BridgeTelemetrySpan | undefined,
		fields: LogFields,
	): Promise<void> {
		const startedAt = Date.now();
		const completedRecordingIds = new Set<string>();
		span?.setAttributes(electronTargetTelemetryAttributes(target));
		try {
			if (!isElectronTargetBridgeMethod(req.method)) {
				throw new BridgeCommandBoundaryError(
					ErrorCodes.INVALID_TARGET,
					`Electron target dispatch for '${req.method}' is not implemented yet.`,
				);
			}
			const params = this.validatedCommandParams(req.method, req.params);
			const rawResult = await executeElectronTargetCommand(
				{
					sessions: this.electronSessions,
					target,
					emitRecordFrame: (data) => {
						if (data.final && typeof data.recordingId === "string") {
							completedRecordingIds.add(data.recordingId);
							this.activeRecordingLeases.delete(data.recordingId);
						}
						if (client.ws.readyState === WebSocket.OPEN) {
							this.sendJson(client.ws, { type: "event", event: "record_frame", data });
						}
					},
				},
				req.method,
				params,
			);
			const result = this.validatedCommandResult(req.method, rawResult);
			if (req.method === "record_start") {
				const recording = result as BridgeCommandResult<"record_start">;
				if (recording.target.kind !== "electron-window") {
					throw new BridgeCommandBoundaryError(
						ErrorCodes.INVALID_RESULT,
						"Electron record_start returned a non-Electron target.",
					);
				}
				if (!completedRecordingIds.has(recording.recordingId)) {
					if (client.ws.readyState === WebSocket.OPEN) {
						this.registerRecordingLease(client.connectionId, recording);
					} else {
						await this.stopDisconnectedElectronRecording(recording.recordingId, recording.target);
					}
				}
			} else if (req.method === "record_stop") {
				this.releaseRecordingLease(result as BridgeCommandResult<"record_stop">);
			}
			const durationMs = Date.now() - startedAt;
			const resultAttributes = electronResultTelemetryAttributes(result);
			span?.setAttributes({
				...resultAttributes,
				"electron.duration_ms": durationMs,
			});
			bridgeLog("info", "electron target request completed", {
				...fields,
				target: targetTeachingLabel(target),
				outcome: "success",
				durationMs,
				...resultAttributes,
			});
			span?.setAttribute("bridge.outcome", "success");
			span?.end("ok");
			void this.telemetry?.flush();
			this.sendJson(client.ws, { id: req.id, result });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const durationMs = Date.now() - startedAt;
			bridgeLog("warn", "electron target request failed", {
				...fields,
				target: targetTeachingLabel(target),
				outcome: "error",
				durationMs,
				errorType: error instanceof Error ? error.name : "Error",
				error: message,
			});
			span?.recordError(new Error(message));
			span?.setAttributes({
				"bridge.outcome": "error",
				"electron.duration_ms": durationMs,
			});
			span?.end("error");
			void this.telemetry?.flush();
			const isMissingSession = message.startsWith("No Electron session attached");
			const code =
				error instanceof BridgeCommandBoundaryError
					? error.code
					: isMissingSession
						? ErrorCodes.NO_ELECTRON_SESSION
						: ErrorCodes.EXECUTION_ERROR;
			this.sendJson(client.ws, {
				id: req.id,
				error: { code, message },
			});
		}
	}

	private async handleServerLocalRequestAsync(
		client: ClientInfo,
		req: BridgeRequest,
		span?: BridgeTelemetrySpan,
	): Promise<void> {
		const startedAt = Date.now();
		if (req.method.startsWith("electron_")) {
			span?.setAttributes(electronServerLocalTelemetryAttributes(req));
		}
		try {
			const definition = getBridgeCommandDefinition(req.method);
			if (!isBridgeSchemaMethod(req.method) || definition?.route !== "server-local") {
				throw new BridgeCommandBoundaryError(
					ErrorCodes.INVALID_METHOD,
					"Unknown server-local method: " + req.method,
				);
			}
			const method = req.method as ServerLocalBridgeMethod;
			const params = this.validatedCommandParams(method, req.params);
			const result = await this.executeServerLocalCommand(
				{
					client,
					request: req,
					span,
					target: requestTarget(req),
				},
				method,
				params,
			);
			if (result === SERVER_LOCAL_RESPONSE_HANDLED) return;
			const validatedResult = this.validatedCommandResult(method, result);
			if (req.method.startsWith("electron_")) {
				const durationMs = Date.now() - startedAt;
				const resultAttributes = electronResultTelemetryAttributes(validatedResult);
				span?.setAttributes({
					...resultAttributes,
					"electron.duration_ms": durationMs,
				});
				bridgeLog("info", "electron local request completed", {
					role: "server",
					requestId: req.id,
					method: req.method,
					outcome: "success",
					durationMs,
					...resultAttributes,
				});
			}
			span?.setAttribute("bridge.outcome", "success");
			span?.end("ok");
			void this.telemetry?.flush();
			this.sendJson(client.ws, { id: req.id, result: validatedResult });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (req.method.startsWith("electron_")) {
				const durationMs = Date.now() - startedAt;
				bridgeLog("warn", "electron local request failed", {
					role: "server",
					requestId: req.id,
					method: req.method,
					outcome: "error",
					durationMs,
					errorType: error instanceof Error ? error.name : "Error",
					error: message,
				});
				span?.setAttribute("electron.duration_ms", durationMs);
			}
			span?.recordError(new Error(message));
			span?.setAttribute("bridge.outcome", "error");
			span?.end("error");
			void this.telemetry?.flush();
			this.sendJson(client.ws, {
				id: req.id,
				error: {
					code: error instanceof BridgeCommandBoundaryError ? error.code : ErrorCodes.EXECUTION_ERROR,
					message,
				},
			});
		}
	}

	private async handleSnapshotStoreRequest(
		client: ClientInfo,
		req: BridgeRequest,
		span?: BridgeTelemetrySpan,
	): Promise<void> {
		const target = requestTarget(req);
		const params = this.snapshotStoreParams(req.params);
		if (isElectronTarget(target)) {
			try {
				const snapshot = await this.electronSessions.snapshot(target, params);
				const record = this.pageSnapshotStore.write(target, snapshot);
				const result = this.validatedCommandResult("snapshot_store", {
					record: this.snapshotRecordSummary(record),
				});
				span?.setAttribute("bridge.outcome", "success");
				span?.end("ok");
				void this.telemetry?.flush();
				this.sendJson(client.ws, { id: req.id, result });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				span?.recordError(new Error(message));
				span?.setAttribute("bridge.outcome", "error");
				span?.end("error");
				void this.telemetry?.flush();
				this.sendJson(client.ws, {
					id: req.id,
					error: {
						code: error instanceof BridgeCommandBoundaryError ? error.code : ErrorCodes.EXECUTION_ERROR,
						message,
					},
				});
			}
			return;
		}

		if (!isChromeTarget(target)) {
			this.sendJson(client.ws, {
				id: req.id,
				error: {
					code: ErrorCodes.INVALID_TARGET,
					message: "Cannot store snapshot for target '" + targetTeachingLabel(target) + "'",
				},
			});
			return;
		}

		const handle = this.sessionRegistry.resolve(target);
		if (!handle?.connection || handle.connection.ws.readyState !== WebSocket.OPEN) {
			this.sendJson(client.ws, {
				id: req.id,
				error: { code: ErrorCodes.NO_EXTENSION_TARGET, message: "No active extension target connected" },
			});
			return;
		}
		if (handle.capabilities && !handle.capabilities.includes("page_snapshot")) {
			this.sendJson(client.ws, {
				id: req.id,
				error: {
					code: ErrorCodes.CAPABILITY_DISABLED,
					message: "Method 'page_snapshot' is disabled on the active extension target",
				},
			});
			return;
		}

		const relayRequestId = this.nextRelayRequestId++;
		this.pendingRequests.set(relayRequestId, {
			relayRequestId,
			clientRequestId: req.id,
			cliConnectionId: client.connectionId,
			cliWs: client.ws,
			method: "snapshot_store",
			startedAt: Date.now(),
			targetHandleKey: handle.key,
			span,
			transformResult: (result) => {
				const snapshot = this.parsePageSnapshotResult(result);
				const record = this.pageSnapshotStore.write(target, snapshot);
				return { record: this.snapshotRecordSummary(record) };
			},
		});
		this.sendJson(handle.connection.ws, {
			id: relayRequestId,
			method: "page_snapshot",
			params,
			target,
			...(span ? span.toTraceHeaders() : {}),
		});
	}

	private async handleCookieImportRequest(
		client: ClientInfo,
		req: BridgeRequest,
		span?: BridgeTelemetrySpan,
	): Promise<void> {
		try {
			const sourcePath = typeof req.params?.sourcePath === "string" ? req.params.sourcePath : undefined;
			const siteUrl = typeof req.params?.siteUrl === "string" ? req.params.siteUrl : undefined;
			if (!sourcePath || !siteUrl) throw new Error("cookie_import requires sourcePath and siteUrl.");
			const plan = this.cookieAccessPort.planImport({
				sourcePath,
				siteUrl,
				consent: req.params?.consent === true,
			});
			const target = requestTarget(req);
			if (!isChromeTarget(target))
				throw new Error("cookie_import currently targets Chrome extension sessions only.");
			const handle = this.sessionRegistry.resolve(target);
			if (!handle?.connection || handle.connection.ws.readyState !== WebSocket.OPEN) {
				throw new Error("No active extension target connected");
			}
			if (handle.capabilities && !handle.capabilities.includes("cookie_import_apply")) {
				throw new Error("Cookie import is disabled on the active extension target");
			}
			const relayRequestId = this.nextRelayRequestId++;
			this.pendingRequests.set(relayRequestId, {
				relayRequestId,
				clientRequestId: req.id,
				cliConnectionId: client.connectionId,
				cliWs: client.ws,
				method: "cookie_import",
				startedAt: Date.now(),
				targetHandleKey: handle.key,
				span,
				transformResult: (result) => ({
					...(typeof result === "object" && result !== null ? result : {}),
					siteUrl: plan.siteUrl,
					selected: plan.cookies.length,
				}),
			});
			this.sendJson(handle.connection.ws, {
				id: relayRequestId,
				method: "cookie_import_apply",
				params: { cookies: plan.cookies },
				target,
				...(span ? span.toTraceHeaders() : {}),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			span?.recordError(new Error(message));
			span?.setAttribute("bridge.outcome", "error");
			span?.end("error");
			void this.telemetry?.flush();
			this.sendJson(client.ws, { id: req.id, error: { code: ErrorCodes.EXECUTION_ERROR, message } });
		}
	}

	private snapshotStoreParams(params: Record<string, unknown> | undefined): PageSnapshotBridgeParams {
		return {
			maxEntries: typeof params?.maxEntries === "number" ? params.maxEntries : undefined,
			includeHidden: params?.includeHidden === true,
			query: typeof params?.query === "string" ? params.query : undefined,
			tabId: typeof params?.tabId === "number" ? params.tabId : undefined,
			tabRef: typeof params?.tabRef === "string" ? params.tabRef : undefined,
			windowId: typeof params?.windowId === "number" ? params.windowId : undefined,
			frameId: typeof params?.frameId === "number" ? params.frameId : undefined,
		};
	}

	private parsePageSnapshotResult(result: unknown): PageSnapshotBridgeResult {
		const validation = validateBridgeCommandResult("page_snapshot", result);
		if (!validation.ok) {
			throw new Error(
				`snapshot_store expected a page_snapshot result from the target: ${formatBridgeCommandValidationErrors(validation.errors)}`,
			);
		}
		return validation.value;
	}

	private snapshotRecordSummary(record: PageSnapshotRecord): PageSnapshotRecordSummary {
		return {
			id: record.id,
			capturedAt: record.capturedAt,
			target: record.target,
			navigationGeneration: record.navigationGeneration,
			...(typeof record.tabId === "number" ? { tabId: record.tabId } : {}),
			...(typeof record.frameId === "number" ? { frameId: record.frameId } : {}),
			url: record.url,
			title: record.title,
			query: record.query,
			entryCount: record.raw.entries.length,
			totalCandidates: record.raw.totalCandidates,
			truncated: record.raw.truncated,
		};
	}

	private executeMcpBridgeRequest(request: {
		method: string;
		params?: Record<string, unknown>;
		target?: unknown;
		traceparent?: string;
		tracestate?: string;
	}): Promise<BridgeResponse> {
		const bridgeRequest: BridgeRequest = {
			id: this.nextRelayRequestId++,
			method: request.method as BridgeRequest["method"],
			params: request.params,
			target: request.target as BridgeRequest["target"],
			traceparent: request.traceparent,
			tracestate: request.tracestate,
		};
		const plan = this.requestHandler.plan(bridgeRequest, {
			cliConnectionId: "mcp",
			resolveTarget: (target) => this.resolveRequestTargetHandle(target),
		});
		if (plan.type === "error") {
			return Promise.resolve({ id: bridgeRequest.id, error: plan.error });
		}
		if (plan.type === "server-local" || plan.type === "electron-target") {
			return Promise.resolve({
				id: bridgeRequest.id,
				error: {
					code: ErrorCodes.INVALID_TARGET,
					message: "MCP bridge execution currently supports extension-routed browser targets",
				},
			});
		}

		const targetHandle = plan.handle.targetHandle;
		const relayRequestId = this.nextRelayRequestId++;
		return new Promise<BridgeResponse>((resolve) => {
			this.pendingRequests.set(relayRequestId, {
				relayRequestId,
				clientRequestId: bridgeRequest.id,
				cliConnectionId: "mcp",
				method: bridgeRequest.method,
				startedAt: Date.now(),
				targetHandleKey: targetHandle.key,
				respond: resolve,
			});
			this.sendJson(targetHandle.connection.ws, {
				...bridgeRequest,
				id: relayRequestId,
				target: plan.target,
			});
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
		if (!res.error) {
			try {
				if (pending.transformResult) res = { ...res, result: pending.transformResult(res.result) };
				res = { ...res, result: this.validatedCommandResult(pending.method, res.result) };
				this.updateRecordingLeasesFromResponse(pending, res);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				res = {
					id: res.id,
					error: {
						code: error instanceof BridgeCommandBoundaryError ? error.code : ErrorCodes.EXECUTION_ERROR,
						message,
					},
				};
			}
		}
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

		pending.respond?.({ ...res, id: pending.clientRequestId });
		if (pending.cliWs?.readyState === WebSocket.OPEN) {
			this.sendJson(pending.cliWs, {
				...res,
				id: pending.clientRequestId,
			});
		}
	}

	private stopRecordingLeasesForCli(cliConnectionId: string): void {
		for (const [recordingId, lease] of this.activeRecordingLeases) {
			if (lease.cliConnectionId !== cliConnectionId) continue;
			this.activeRecordingLeases.delete(recordingId);
			if (lease.target.kind === "electron-window") {
				void this.stopDisconnectedElectronRecording(lease.recordingId, lease.target);
			} else {
				const targetHandle = this.sessionRegistry.get(lease.targetHandleKey);
				if (targetHandle?.connection.ws.readyState === WebSocket.OPEN) {
					const syntheticStop: BridgeRequest = {
						id: this.nextRelayRequestId++,
						method: "record_stop",
						params: {
							tabId: lease.target.tabId,
							...(lease.target.frameId !== undefined ? { frameId: lease.target.frameId } : {}),
						},
						target: lease.target,
					};
					this.sendJson(targetHandle.connection.ws, syntheticStop);
				}
			}
			bridgeLog("info", "sent synthetic record_stop for disconnected cli", {
				role: "server",
				outcome: "aborted",
				cliConnectionId,
				recordingId: lease.recordingId,
				target: targetTeachingLabel(lease.target),
			});
		}
	}

	private async stopDisconnectedElectronRecording(
		recordingId: string,
		target: Extract<ResolvedPageTarget, { kind: "electron-window" }>,
	): Promise<void> {
		try {
			await this.electronSessions.recordStop(target);
		} catch (error) {
			bridgeLog("warn", "failed synthetic record_stop for disconnected cli", {
				role: "server",
				outcome: "error",
				recordingId,
				target: targetTeachingLabel(target),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private registerRecordingLease(
		cliConnectionId: string,
		result: BridgeCommandResult<"record_start">,
		targetHandleKey?: string,
	): void {
		this.activeRecordingLeases.set(result.recordingId, {
			cliConnectionId,
			recordingId: result.recordingId,
			target: { ...result.target },
			startedAt: Date.now(),
			targetHandleKey,
		});
	}

	private releaseRecordingLease(result: BridgeCommandResult<"record_stop">): void {
		this.activeRecordingLeases.delete(result.recordingId);
	}

	private updateRecordingLeasesFromResponse(pending: PendingRequest, res: BridgeResponse): void {
		if (pending.method === "record_start") {
			this.registerRecordingLease(
				pending.cliConnectionId,
				res.result as BridgeCommandResult<"record_start">,
				pending.targetHandleKey,
			);
			return;
		}
		if (pending.method === "record_stop") {
			this.releaseRecordingLease(res.result as BridgeCommandResult<"record_stop">);
		}
	}

	// -----------------------------------------------------------------------
	// Extension events → all CLIs
	// -----------------------------------------------------------------------

	private handleExtensionEvent(client: ClientInfo, event: BridgeEvent): void {
		bridgeLog("debug", "extension event", {
			role: "server",
			event: event.event,
		} as LogFields);
		const targetHandle = this.sessionRegistry.findByConnection(client);
		if (event.event === "capabilities_update") {
			const capabilities = parseCapabilitiesUpdate(event);
			if (!targetHandle || !capabilities) {
				bridgeLog("warn", "invalid extension capability update", {
					connectionId: client.connectionId,
					role: "server",
					outcome: "rejected",
				});
				return;
			}
			client.capabilities = [...capabilities];
			targetHandle.capabilities = [...capabilities];
		}
		if (
			(event.event === "record_frame" || event.event === "record_chunk") &&
			!targetHandle?.capabilities?.includes("record_start")
		) {
			bridgeLog("warn", "recording event rejected because recording capability is disabled", {
				role: "server",
				outcome: "rejected",
				event: event.event,
			});
			return;
		}
		if ((event.event === "record_frame" || event.event === "record_chunk") && event.data) {
			const recordingId = typeof event.data.recordingId === "string" ? event.data.recordingId : undefined;
			const final = event.data.final === true;
			if (recordingId && final) {
				this.activeRecordingLeases.delete(recordingId);
			}
		}
		if (event.event === "session_changed") {
			const sessionId =
				event.data && typeof event.data.sessionId === "string" ? (event.data.sessionId as string) : undefined;
			const released = targetHandle?.writeLock.releaseForSessionChange(sessionId);
			if (released) {
				bridgeLog("info", "releasing session writer lease due to session change", {
					role: "server",
					writerCliConnectionId: released.cliConnectionId,
					writerSessionId: released.sessionId,
					sessionId,
				});
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

		const disconnectedTargetHandle =
			client.role === "extension" ? this.sessionRegistry.unregisterByConnection(client) : undefined;
		if (client.role === "extension" && disconnectedTargetHandle) {
			for (const [recordingId, lease] of this.activeRecordingLeases) {
				if (lease.targetHandleKey === disconnectedTargetHandle.key) this.activeRecordingLeases.delete(recordingId);
			}
			bridgeLog("info", "extension disconnected", { ...fields, windowId: client.windowId });

			for (const [relayRequestId, pending] of this.pendingRequests) {
				if (pending.targetHandleKey !== disconnectedTargetHandle.key) continue;
				this.pendingRequests.delete(relayRequestId);
				pending.span?.recordError(new Error("Extension disconnected while request was pending"));
				pending.span?.setAttribute("bridge.outcome", "error");
				pending.span?.end("error");
				pending.respond?.({
					id: pending.clientRequestId,
					error: {
						code: ErrorCodes.NO_EXTENSION_TARGET,
						message: "Extension disconnected while request was pending",
					},
				});
				if (pending.cliWs?.readyState === WebSocket.OPEN) {
					this.sendJson(pending.cliWs, {
						id: pending.clientRequestId,
						error: {
							code: ErrorCodes.NO_EXTENSION_TARGET,
							message: "Extension disconnected while request was pending",
						},
					});
				}
			}
			void this.telemetry?.flush();

			// Broadcast to all CLIs
			this.broadcastToRole("cli", {
				type: "event",
				event: "extension_disconnected",
			});
		} else if (client.role === "cli") {
			const releasedLocks = this.sessionRegistry.releaseLocksForCli(client.connectionId);
			for (const releasedLock of releasedLocks) {
				bridgeLog("info", "releasing session writer lease due to cli disconnect", {
					...fields,
					sessionId: releasedLock.sessionId,
				});
			}
			bridgeLog("info", "cli disconnected", { ...fields, name: client.name });

			this.stopRecordingLeasesForCli(client.connectionId);

			for (const [relayRequestId, pending] of this.pendingRequests) {
				if (pending.cliConnectionId === client.connectionId) {
					this.pendingRequests.delete(relayRequestId);
					pending.span?.recordError(new Error("CLI disconnected while request was pending"));
					pending.span?.setAttribute("bridge.outcome", "aborted");
					pending.span?.end("error");

					const targetHandle =
						this.sessionRegistry.get(pending.targetHandleKey) ?? this.sessionRegistry.activeHandle;
					if (targetHandle?.connection.ws.readyState === WebSocket.OPEN) {
						const abort: AbortMessage = { type: "abort", id: relayRequestId };
						this.sendJson(targetHandle.connection.ws, abort);
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

	private async handleSkillSnapshotWrite(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!this.isAuthorizedHttpRequest(req)) {
			this.writeJson(res, 403, { error: "Invalid bridge token" });
			return;
		}
		try {
			const snapshot = parseBridgeSkillSnapshot(JSON.parse(await this.readRequestBody(req)) as unknown);
			const status = writeSkillSnapshot(snapshot, this.nodeConfig);
			this.writeJson(res, 200, { ok: true, status });
		} catch (error) {
			this.writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!this.isAuthorizedHttpRequest(req)) {
			this.writeJson(res, 403, { error: "Invalid bridge token" });
			return;
		}
		await this.mcpHandler.handle(req, res);
	}

	private async handleElectronDetachHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!this.isAuthorizedHttpRequest(req)) {
			this.writeJson(res, 403, { error: "Invalid bridge token" });
			return;
		}
		try {
			const body = JSON.parse(await this.readRequestBody(req)) as { sessionId?: unknown };
			if (typeof body.sessionId !== "string" || !body.sessionId) {
				throw new Error("sessionId is required");
			}
			const result = { ok: this.electronSessions.detach(body.sessionId), sessionId: body.sessionId };
			this.broadcastElectronSessionsChanged("detach");
			this.writeJson(res, 200, result);
		} catch (error) {
			this.writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async handleElectronThumbnailHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (!this.isAuthorizedHttpRequest(req)) {
			this.writeJson(res, 403, { error: "Invalid bridge token" });
			return;
		}
		try {
			const body = JSON.parse(await this.readRequestBody(req)) as {
				sessionId?: unknown;
				windowRef?: unknown;
				maxWidth?: unknown;
			};
			if (typeof body.sessionId !== "string" || !body.sessionId) throw new Error("sessionId is required");
			if (typeof body.windowRef !== "string" || !body.windowRef) throw new Error("windowRef is required");
			const result = await this.electronSessions.screenshot(
				{ kind: "electron-window", sessionId: body.sessionId, windowRef: body.windowRef },
				typeof body.maxWidth === "number" ? body.maxWidth : 320,
			);
			this.writeJson(res, 200, result);
		} catch (error) {
			this.writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async handleStatusRequest(res: ServerResponse): Promise<void> {
		try {
			const electronSessions = await this.electronSessions.status();
			const ext = this.sessionRegistry.activeHandle;
			const status: BridgeServerStatus = {
				ok: true,
				protocolVersion: BRIDGE_PROTOCOL_VERSION,
				minProtocolVersion: BRIDGE_PROTOCOL_MIN_VERSION,
				serverVersion: this.config.serverVersion ?? "dev",
				extension: ext
					? {
							connected: true,
							windowId: ext.windowId,
							sessionId: ext.sessionId,
							capabilities: ext.capabilities ? [...ext.capabilities] : undefined,
							remoteAddress: ext.remoteAddress,
							protocolVersion: ext.protocolVersion,
							minProtocolVersion: ext.connection.minProtocolVersion,
							appVersion: ext.appVersion,
						}
					: { connected: false },
				clients: {
					total: this.clients.size,
					cli: this.countByRole("cli"),
					extension: this.countByRole("extension"),
				},
				electron: {
					sessions: electronSessions,
				},
				skillsSnapshot: readSkillSnapshot(this.nodeConfig).status,
				pendingRequests: this.pendingRequests.size,
			};

			this.writeJson(res, 200, status);
		} catch (error) {
			this.writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	private isAuthorizedHttpRequest(req: IncomingMessage): boolean {
		return req.headers.authorization === `Bearer ${this.config.token}`;
	}

	private async readRequestBody(req: IncomingMessage): Promise<string> {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		return Buffer.concat(chunks).toString("utf-8");
	}

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

	private broadcastElectronSessionsChanged(reason: string): void {
		const event = {
			type: "event",
			event: "electron_sessions_changed",
			data: {
				reason,
				sessions: this.electronSessions.list(),
			},
		};
		this.broadcastToRole("extension", event);
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
