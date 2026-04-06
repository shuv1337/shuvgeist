/**
 * Extension-side bridge client.
 *
 * Connects to the bridge server over WebSocket and dispatches incoming
 * commands to a caller-provided CommandDispatcher. The dispatcher is
 * injected via options so the background service worker can provide a
 * lightweight implementation without importing DOM-dependent tool code.
 */

import type { CommandDispatcher } from "./command-dispatcher.js";
import { bridgeLog, type LogFields } from "./logging.js";
import type { AbortMessage, BridgeCapability, BridgeRequest, BridgeResponse, RegisterResult } from "./protocol.js";
import { ErrorCodes, getBridgeCapabilities } from "./protocol.js";

export type BridgeConnectionState = "disabled" | "disconnected" | "connecting" | "connected" | "error";

export interface BridgeClientOptions {
	url: string;
	token: string;
	windowId: number;
	sessionId?: string;
	sensitiveAccessEnabled: boolean;
	/** Command dispatcher for handling bridge requests. */
	executor: CommandDispatcher;
	onStateChange?: (state: BridgeConnectionState, detail?: string) => void;
	/** Optional callback to compute capabilities dynamically (e.g. based on sidepanel state). */
	capabilitiesProvider?: () => BridgeCapability[];
}

export class BridgeClient {
	private ws: WebSocket | null = null;
	private state: BridgeConnectionState = "disabled";
	private stateDetail: string | undefined;
	private options: BridgeClientOptions | null = null;
	private executor: CommandDispatcher | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	private readonly maxReconnectDelay = 30_000;
	private enabled = false;

	/** Active abort controllers keyed by request id, so we can cancel on `abort` messages. */
	private readonly pendingAborts = new Map<number, AbortController>();

	get connectionState(): BridgeConnectionState {
		return this.state;
	}

	get connectionDetail(): string | undefined {
		return this.stateDetail;
	}

	connect(options: BridgeClientOptions): void {
		if (!options.url || !options.token) {
			this.disconnect();
			this.setState("disabled");
			return;
		}

		if (this.options && this.areOptionsEquivalent(this.options, options) && this.enabled) {
			this.options = options;
			return;
		}

		this.disconnect();
		this.enabled = true;
		this.options = options;
		this.executor = options.executor;
		this.reconnectAttempts = 0;
		this.doConnect();
	}

	disconnect(): void {
		this.enabled = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.closeAndDetachWebSocket();
		this.pendingAborts.clear();
		this.setState("disabled");
	}

	/** Send an event to the bridge server (e.g. active_tab_changed). */
	sendEvent(event: string, data?: Record<string, unknown>): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: "event", event, data }));
		}
	}

	/** Re-register with updated capabilities (e.g. when sidepanel opens/closes). */
	sendCapabilitiesUpdate(): void {
		if (this.ws?.readyState !== WebSocket.OPEN || !this.options || this.state !== "connected") return;
		const capabilities = this.options.capabilitiesProvider
			? this.options.capabilitiesProvider()
			: getBridgeCapabilities(this.options.sensitiveAccessEnabled);
		this.sendEvent("capabilities_update", { capabilities });
	}

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	/**
	 * Detach all event handlers from the current WebSocket (preventing stale
	 * `onclose` callbacks from triggering spurious reconnects) and close it.
	 */
	private closeAndDetachWebSocket(): void {
		if (this.ws) {
			this.ws.onopen = null;
			this.ws.onclose = null;
			this.ws.onmessage = null;
			this.ws.onerror = null;
			this.ws.close();
			this.ws = null;
		}
	}

	private doConnect(): void {
		if (!this.enabled || !this.options) return;

		// Close any orphaned WebSocket from a previous cycle to avoid two
		// live connections racing against each other on the server.
		this.closeAndDetachWebSocket();

		const { url, token, windowId, sessionId, sensitiveAccessEnabled } = this.options;
		this.setState("connecting");

		bridgeLog("info", "connecting to bridge", {
			role: "extension",
			windowId,
			sessionId,
			url,
		} as LogFields);

		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch (err: any) {
			bridgeLog("error", "failed to create WebSocket", {
				role: "extension",
				error: err.message,
			});
			this.setState("error", err.message);
			this.scheduleReconnect();
			return;
		}
		this.ws = ws;

		ws.onopen = () => {
			const capabilities = this.options?.capabilitiesProvider
				? this.options.capabilitiesProvider()
				: getBridgeCapabilities(sensitiveAccessEnabled);
			const registration = {
				type: "register",
				role: "extension",
				token,
				windowId,
				sessionId,
				capabilities,
			};
			ws.send(JSON.stringify(registration));
		};

		ws.onmessage = (event: MessageEvent) => {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(event.data as string);
			} catch {
				bridgeLog("warn", "invalid JSON from bridge", { role: "extension" });
				return;
			}
			this.handleMessage(msg);
		};

		ws.onclose = () => {
			// Ignore close events from a WebSocket that has already been
			// superseded by a newer connection (e.g. after connect() replaced
			// it).  Without this guard the stale onclose triggers
			// scheduleReconnect(), creating a second live connection that the
			// server replaces, whose onclose fires again — an infinite 1-second
			// reconnect loop.
			if (this.ws !== ws) return;

			bridgeLog("info", "bridge connection closed", { role: "extension" });
			if (this.enabled) {
				this.setState("disconnected", this.state === "error" ? this.stateDetail : undefined);
				this.scheduleReconnect();
			}
		};

		ws.onerror = () => {
			if (this.ws !== ws) return;
			bridgeLog("warn", "bridge connection error", { role: "extension" });
			if (this.state !== "error") {
				this.setState("error", "Connection failed");
			}
		};
	}

	private handleMessage(msg: Record<string, unknown>): void {
		if (msg.type === "register_result") {
			const reg = msg as unknown as RegisterResult;
			if (reg.ok) {
				this.reconnectAttempts = 0;
				this.setState("connected");
				bridgeLog("info", "registered with bridge", {
					role: "extension",
					windowId: this.options?.windowId,
					sessionId: this.options?.sessionId,
				});
				this.emitCurrentTabSnapshot().catch((err) => {
					bridgeLog("warn", "failed to emit initial tab snapshot", {
						role: "extension",
						error: err.message,
					});
				});
			} else {
				bridgeLog("error", "bridge registration rejected", {
					role: "extension",
					error: reg.error,
				});
				this.setState("error", reg.error || "Registration rejected");
				this.enabled = false;
			}
			return;
		}

		if (msg.type === "abort" && typeof msg.id === "number") {
			const abort = msg as unknown as AbortMessage;
			const controller = this.pendingAborts.get(abort.id);
			if (controller) {
				controller.abort();
				this.pendingAborts.delete(abort.id);
				bridgeLog("info", "aborted request", {
					role: "extension",
					requestId: abort.id,
					outcome: "aborted",
				});
			}
			return;
		}

		if (typeof msg.id === "number" && typeof msg.method === "string") {
			const req = msg as unknown as BridgeRequest;
			void this.handleRequest(req);
		}
	}

	private async handleRequest(req: BridgeRequest): Promise<void> {
		if (!this.executor) {
			this.sendResponse(req.id, undefined, {
				code: ErrorCodes.EXECUTION_ERROR,
				message: "Command executor not initialized",
			});
			return;
		}

		const controller = new AbortController();
		this.pendingAborts.set(req.id, controller);
		const startedAt = Date.now();

		try {
			const result = await this.executor.dispatch(req.method, req.params, controller.signal);
			bridgeLog("info", "command completed", {
				role: "extension",
				requestId: req.id,
				method: req.method,
				durationMs: Date.now() - startedAt,
				outcome: "success",
			});
			this.sendResponse(req.id, result);
		} catch (err: any) {
			const isAborted = controller.signal.aborted;
			const code =
				typeof err?.code === "number" ? err.code : isAborted ? ErrorCodes.ABORTED : ErrorCodes.EXECUTION_ERROR;
			bridgeLog(isAborted ? "info" : "error", "command failed", {
				role: "extension",
				requestId: req.id,
				method: req.method,
				durationMs: Date.now() - startedAt,
				outcome: isAborted ? "aborted" : "error",
				error: err?.message,
			});
			this.sendResponse(req.id, undefined, {
				code,
				message: err?.message || "Command execution failed",
			});
		} finally {
			this.pendingAborts.delete(req.id);
		}
	}

	private sendResponse(id: number, result?: unknown, error?: { code: number; message: string }): void {
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		const response: BridgeResponse = { id };
		if (error) response.error = error;
		else response.result = result;
		this.ws.send(JSON.stringify(response));
	}

	private scheduleReconnect(): void {
		if (!this.enabled || this.reconnectTimer) return;
		const delay = Math.min(1000 * 2 ** this.reconnectAttempts, this.maxReconnectDelay);
		this.reconnectAttempts++;
		bridgeLog("debug", "scheduling reconnect", {
			role: "extension",
			delayMs: delay,
			attempt: this.reconnectAttempts,
		} as LogFields);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.doConnect();
		}, delay);
	}

	private setState(state: BridgeConnectionState, detail?: string): void {
		this.state = state;
		this.stateDetail = detail;
		this.options?.onStateChange?.(state, detail);
	}

	private areOptionsEquivalent(a: BridgeClientOptions, b: BridgeClientOptions): boolean {
		return (
			a.url === b.url &&
			a.token === b.token &&
			a.windowId === b.windowId &&
			a.sessionId === b.sessionId &&
			a.sensitiveAccessEnabled === b.sensitiveAccessEnabled
		);
	}

	private async emitCurrentTabSnapshot(): Promise<void> {
		if (!this.options) return;
		const [tab] = await chrome.tabs.query({ active: true, windowId: this.options.windowId });
		if (!tab?.id) return;
		this.sendEvent("active_tab_changed", {
			url: tab.url || "",
			title: tab.title || "",
			tabId: tab.id,
		});
	}
}
