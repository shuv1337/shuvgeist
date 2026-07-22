import type {
	AgentRuntimeConnectionDescriptor,
	AgentRuntimePortRequest,
	AgentRuntimePortResponse,
} from "../bridge/internal-messages.js";
import type { RemoteSessionTransport } from "./remote-session-client.js";
import { correlateRuntimeResponse } from "./runtime-channel.js";
import { sameRuntimeTarget as sameTarget } from "./runtime-identity.js";
import {
	isRuntimeRequestEnvelope,
	isRuntimeResponseEnvelope,
	isRuntimeStreamEnvelope,
	isRuntimeWireValue,
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeRequestEnvelope,
	type RuntimeResponseEnvelope,
	type RuntimeStreamEnvelope,
} from "./runtime-protocol.js";
import {
	type AgentRuntimePortIdentity,
	agentRuntimePortName,
	parseAgentRuntimePortName,
} from "./sidepanel-context-identity.js";

export { agentRuntimePortName, type AgentRuntimePortIdentity, parseAgentRuntimePortName };

export interface ChromeRuntimePortEventLike<TListener extends (...args: never[]) => void> {
	addListener(listener: TListener): void;
	removeListener?(listener: TListener): void;
}

export interface ChromeRuntimePortLike {
	readonly name: string;
	postMessage(message: AgentRuntimePortRequest): void;
	disconnect(): void;
	readonly onMessage: ChromeRuntimePortEventLike<(message: unknown) => void>;
	readonly onDisconnect: ChromeRuntimePortEventLike<() => void>;
}

export type ChromeRuntimePortFactory = (connectInfo: { name: string }) => ChromeRuntimePortLike;

export type ChromeRuntimeSessionTransportErrorCode =
	| "DISPOSED"
	| "INVALID_DESCRIPTOR"
	| "INVALID_REQUEST"
	| "REQUEST_SCOPE_MISMATCH"
	| "DUPLICATE_REQUEST_ID"
	| "PORT_CONNECT_FAILED"
	| "PORT_CONNECT_REJECTED"
	| "PORT_HANDSHAKE_TIMEOUT"
	| "PORT_DISCONNECTED"
	| "PORT_DISCONNECTED_IN_FLIGHT"
	| "PORT_POST_FAILED"
	| "MALFORMED_PORT_MESSAGE"
	| "ORPHAN_RESPONSE"
	| "RESPONSE_CORRELATION_FAILED"
	| "REMOTE_PORT_ERROR";

export class ChromeRuntimeSessionTransportError extends Error {
	readonly code: ChromeRuntimeSessionTransportErrorCode;
	readonly retryable: boolean;
	readonly requestId?: string;
	readonly requestMayHaveExecuted: boolean;

	constructor(
		code: ChromeRuntimeSessionTransportErrorCode,
		message: string,
		options: { retryable?: boolean; requestId?: string; requestMayHaveExecuted?: boolean } = {},
	) {
		super(message);
		this.name = "ChromeRuntimeSessionTransportError";
		this.code = code;
		this.retryable = options.retryable ?? false;
		this.requestId = options.requestId;
		this.requestMayHaveExecuted = options.requestMayHaveExecuted ?? false;
	}
}

export interface ChromeRuntimeSessionTransportOptions {
	descriptor: AgentRuntimeConnectionDescriptor;
	documentNonce: string;
	continuationToken: string;
	transactionId: string;
	leaseId: string;
	portFactory: ChromeRuntimePortFactory;
	onError?: (error: ChromeRuntimeSessionTransportError) => void;
	reconnectDelayMs?: number;
	handshakeTimeoutMs?: number;
	/** Number of connection-only retries permitted before an operation is posted. */
	maxConnectRetries?: number;
}

interface ConnectionState {
	readonly port: ChromeRuntimePortLike;
	readonly ready: Promise<void>;
	readonly resolveReady: () => void;
	readonly rejectReady: (error: unknown) => void;
	readonly onMessage: (message: unknown) => void;
	readonly onDisconnect: () => void;
	readySettled: boolean;
	readySucceeded: boolean;
	handshakeTimeout?: ReturnType<typeof setTimeout>;
}

interface PendingRequest {
	readonly request: RuntimeRequestEnvelope;
	readonly resolve: (response: RuntimeResponseEnvelope) => void;
	readonly reject: (error: unknown) => void;
}

function createDeferredConnection(
	port: ChromeRuntimePortLike,
	onMessage: (message: unknown) => void,
	onDisconnect: () => void,
): ConnectionState {
	let resolveReady: () => void = () => {};
	let rejectReady: (error: unknown) => void = () => {};
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	return {
		port,
		ready,
		resolveReady,
		rejectReady,
		onMessage,
		onDisconnect,
		readySettled: false,
		readySucceeded: false,
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(record).every((key) => allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function descriptorValidationError(value: unknown): string | undefined {
	if (!isRuntimeWireValue(value) || !isPlainRecord(value)) return "descriptor must be finite, acyclic plain wire data";
	if (
		!hasOnlyKeys(value, [
			"clientId",
			"windowId",
			"sessionId",
			"target",
			"mode",
			"systemPrompt",
			"model",
			"thinkingLevel",
			"initialMessages",
		])
	) {
		return "descriptor contains unsupported fields";
	}
	if (value.mode !== "create" && value.mode !== "load") return "descriptor.mode must be create or load";
	if (typeof value.systemPrompt !== "string") return "descriptor.systemPrompt must be a string";
	const validationEnvelope = {
		kind: "request",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "descriptor-validation",
		clientId: value.clientId,
		windowId: value.windowId,
		sessionId: value.sessionId,
		target: value.target,
		requestId: "descriptor-validation",
		operation: {
			type: "create",
			systemPrompt: value.systemPrompt,
			...(value.model !== undefined ? { model: value.model } : {}),
			...(value.thinkingLevel !== undefined ? { thinkingLevel: value.thinkingLevel } : {}),
			...(value.initialMessages !== undefined ? { initialMessages: value.initialMessages } : {}),
		},
	};
	return isRuntimeRequestEnvelope(validationEnvelope) ? undefined : "descriptor fields are not valid runtime data";
}

function validatePortResponse(value: unknown): AgentRuntimePortResponse | undefined {
	if (!isRuntimeWireValue(value) || !isPlainRecord(value) || !nonEmptyString(value.type)) return undefined;
	switch (value.type) {
		case "agent-runtime-port-connected":
			if (!hasOnlyKeys(value, ["type", "ok", "error"]) || typeof value.ok !== "boolean") return undefined;
			if (value.ok) {
				if (value.error !== undefined) return undefined;
			} else if (!nonEmptyString(value.error)) {
				return undefined;
			}
			return value as unknown as AgentRuntimePortResponse;
		case "agent-runtime-port-response":
			if (!hasOnlyKeys(value, ["type", "response"]) || !isRuntimeResponseEnvelope(value.response)) {
				return undefined;
			}
			return value as unknown as AgentRuntimePortResponse;
		case "agent-runtime-port-error":
			if (
				!hasOnlyKeys(value, ["type", "requestId", "error"]) ||
				!nonEmptyString(value.requestId) ||
				!nonEmptyString(value.error)
			) {
				return undefined;
			}
			return value as unknown as AgentRuntimePortResponse;
		case "agent-runtime-port-stream":
			if (!hasOnlyKeys(value, ["type", "envelope"]) || !isRuntimeStreamEnvelope(value.envelope)) {
				return undefined;
			}
			return value as unknown as AgentRuntimePortResponse;
		default:
			return undefined;
	}
}

function requestScopeMatchesDescriptor(
	request: RuntimeRequestEnvelope,
	descriptor: AgentRuntimeConnectionDescriptor,
): boolean {
	return (
		request.clientId === descriptor.clientId &&
		request.windowId === descriptor.windowId &&
		request.sessionId === descriptor.sessionId &&
		sameTarget(request.target, descriptor.target)
	);
}

function streamScopeMatchesDescriptor(
	envelope: RuntimeStreamEnvelope,
	descriptor: AgentRuntimeConnectionDescriptor,
): boolean {
	if (envelope.clientId !== descriptor.clientId || envelope.windowId !== descriptor.windowId) return false;
	if (envelope.streamType === "hello") {
		const ownCursor = envelope.recovery.sessions.find((cursor) => cursor.sessionId === descriptor.sessionId);
		return ownCursor === undefined || sameTarget(ownCursor.target, descriptor.target);
	}
	return envelope.sessionId === descriptor.sessionId && sameTarget(envelope.target, descriptor.target);
}

/**
 * Dedicated sidepanel-to-service-worker transport for one client/window/session.
 * A reconnect repeats only the connection descriptor. Requests that may have
 * crossed a disconnected port are rejected and are never replayed. The
 * background coordinator must therefore treat an identical descriptor as an
 * idempotent bind, including a create descriptor whose acknowledgement was
 * lost after processing.
 */
export class ChromeRuntimeSessionTransport implements RemoteSessionTransport {
	readonly portName: string;

	private readonly descriptor: AgentRuntimeConnectionDescriptor;
	private readonly portFactory: ChromeRuntimePortFactory;
	private readonly onError?: (error: ChromeRuntimeSessionTransportError) => void;
	private readonly reconnectDelayMs: number;
	private readonly handshakeTimeoutMs: number;
	private readonly maxConnectRetries: number;
	private readonly listeners = new Set<(envelope: RuntimeStreamEnvelope) => void>();
	private readonly pending = new Map<string, PendingRequest>();
	private connection?: ConnectionState;
	private reconnectTimer?: ReturnType<typeof setTimeout>;
	private disposed = false;

	constructor(options: ChromeRuntimeSessionTransportOptions) {
		const descriptorError = descriptorValidationError(options.descriptor);
		if (descriptorError) {
			throw new ChromeRuntimeSessionTransportError("INVALID_DESCRIPTOR", descriptorError);
		}
		if (!Number.isFinite(options.reconnectDelayMs ?? 100) || (options.reconnectDelayMs ?? 100) < 0) {
			throw new Error("reconnectDelayMs must be a non-negative finite number");
		}
		if (!Number.isInteger(options.maxConnectRetries ?? 1) || (options.maxConnectRetries ?? 1) < 0) {
			throw new Error("maxConnectRetries must be a non-negative integer");
		}
		if (!Number.isFinite(options.handshakeTimeoutMs ?? 5_000) || (options.handshakeTimeoutMs ?? 5_000) <= 0) {
			throw new Error("handshakeTimeoutMs must be a positive finite number");
		}
		this.descriptor = structuredClone(options.descriptor);
		this.portFactory = options.portFactory;
		this.onError = options.onError;
		this.reconnectDelayMs = options.reconnectDelayMs ?? 100;
		this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
		this.maxConnectRetries = options.maxConnectRetries ?? 1;
		this.portName = agentRuntimePortName({
			clientId: this.descriptor.clientId,
			windowId: this.descriptor.windowId,
			documentNonce: options.documentNonce,
			continuationToken: options.continuationToken,
			transactionId: options.transactionId,
			leaseId: options.leaseId,
		});
	}

	subscribe(listener: (envelope: RuntimeStreamEnvelope) => void): () => void {
		this.assertUsable();
		this.listeners.add(listener);
		// Register the stream listener before opening the Chrome port. A host may
		// emit its hello as soon as it accepts the descriptor.
		try {
			const connection = this.ensureConnection();
			void connection.ready.catch((error: unknown) => this.report(this.asTransportError(error)));
		} catch (error) {
			this.report(this.asTransportError(error));
		}
		return () => {
			this.listeners.delete(listener);
		};
	}

	async send(request: RuntimeRequestEnvelope): Promise<RuntimeResponseEnvelope> {
		this.assertUsable();
		if (!isRuntimeRequestEnvelope(request)) {
			throw new ChromeRuntimeSessionTransportError("INVALID_REQUEST", "Runtime request failed wire validation");
		}
		if (!requestScopeMatchesDescriptor(request, this.descriptor)) {
			throw new ChromeRuntimeSessionTransportError(
				"REQUEST_SCOPE_MISMATCH",
				"Runtime request does not match the transport client, window, session, and target scope",
				{ requestId: request.requestId },
			);
		}
		const ownedRequest = structuredClone(request);
		const connection = await this.readyConnection();
		this.assertUsable();
		if (this.pending.has(ownedRequest.requestId)) {
			throw new ChromeRuntimeSessionTransportError(
				"DUPLICATE_REQUEST_ID",
				`Request ${ownedRequest.requestId} is already in flight`,
				{ requestId: ownedRequest.requestId },
			);
		}
		return new Promise<RuntimeResponseEnvelope>((resolve, reject) => {
			const pending: PendingRequest = { request: ownedRequest, resolve, reject };
			this.pending.set(ownedRequest.requestId, pending);
			try {
				connection.port.postMessage({ type: "agent-runtime-port-request", request: ownedRequest });
			} catch (error) {
				this.pending.delete(ownedRequest.requestId);
				const transportError = new ChromeRuntimeSessionTransportError(
					"PORT_POST_FAILED",
					`Failed to post request ${ownedRequest.requestId}; delivery is unknown and the request was not retried: ${this.errorMessage(error)}`,
					{ requestId: ownedRequest.requestId, requestMayHaveExecuted: true },
				);
				reject(transportError);
				this.invalidateConnection(connection, transportError, true);
			}
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.reconnectTimer !== undefined) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		for (const [requestId, pending] of this.pending) {
			pending.reject(
				new ChromeRuntimeSessionTransportError(
					"DISPOSED",
					`Runtime port transport was disposed while request ${requestId} was in flight`,
					{ requestId, requestMayHaveExecuted: true },
				),
			);
		}
		this.pending.clear();
		this.listeners.clear();
		const connection = this.connection;
		this.connection = undefined;
		if (connection) {
			this.rejectReady(
				connection,
				new ChromeRuntimeSessionTransportError("DISPOSED", "Runtime port transport was disposed"),
			);
			this.detach(connection);
			try {
				connection.port.disconnect();
			} catch {
				// The port may already be disconnected.
			}
		}
	}

	private async readyConnection(): Promise<ConnectionState> {
		let retries = 0;
		while (true) {
			this.assertUsable();
			let connection: ConnectionState;
			try {
				connection = this.ensureConnection();
				await connection.ready;
			} catch (error) {
				if (retries >= this.maxConnectRetries || !this.isRetryablePreSendError(error)) throw error;
				retries++;
				continue;
			}
			if (this.connection === connection && connection.readySucceeded) return connection;
			if (retries >= this.maxConnectRetries) {
				throw new ChromeRuntimeSessionTransportError(
					"PORT_DISCONNECTED",
					"Runtime port disconnected before the request was posted",
					{ retryable: true },
				);
			}
			retries++;
		}
	}

	private ensureConnection(): ConnectionState {
		this.assertUsable();
		if (this.connection) return this.connection;
		if (this.reconnectTimer !== undefined) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		let port: ChromeRuntimePortLike;
		try {
			port = this.portFactory({ name: this.portName });
		} catch (error) {
			const transportError = new ChromeRuntimeSessionTransportError(
				"PORT_CONNECT_FAILED",
				`Failed to open runtime port: ${this.errorMessage(error)}`,
				{ retryable: true },
			);
			this.scheduleReconnect();
			throw transportError;
		}
		let connection: ConnectionState;
		const onMessage = (message: unknown): void => this.receive(connection, message);
		const onDisconnect = (): void => this.handleDisconnect(connection);
		connection = createDeferredConnection(port, onMessage, onDisconnect);
		// Every connection promise also has an internal rejection observer. Calls
		// may still await the original promise, but a synchronous descriptor-post
		// failure cannot become an unhandled rejection.
		void connection.ready.catch(() => {});
		this.connection = connection;
		port.onMessage.addListener(onMessage);
		port.onDisconnect.addListener(onDisconnect);
		connection.handshakeTimeout = setTimeout(() => {
			if (this.connection !== connection || connection.readySettled) return;
			this.invalidateConnection(
				connection,
				new ChromeRuntimeSessionTransportError(
					"PORT_HANDSHAKE_TIMEOUT",
					`Runtime port did not acknowledge its descriptor within ${this.handshakeTimeoutMs}ms`,
					{ retryable: true },
				),
				true,
			);
		}, this.handshakeTimeoutMs);
		try {
			port.postMessage({
				type: "agent-runtime-port-connect",
				descriptor: structuredClone(this.descriptor),
			});
		} catch (error) {
			const transportError = new ChromeRuntimeSessionTransportError(
				"PORT_CONNECT_FAILED",
				`Failed to send runtime connection descriptor: ${this.errorMessage(error)}`,
				{ retryable: true },
			);
			this.invalidateConnection(connection, transportError, true);
			throw transportError;
		}
		return connection;
	}

	private receive(connection: ConnectionState, message: unknown): void {
		if (this.disposed || this.connection !== connection) return;
		const response = validatePortResponse(message);
		if (!response) {
			const malformed = this.malformedMessageError(message);
			if (isPlainRecord(message) && message.type === "agent-runtime-port-connected") {
				const handshakeError = new ChromeRuntimeSessionTransportError(
					"MALFORMED_PORT_MESSAGE",
					"Background runtime delivered a malformed connection acknowledgement",
					{ retryable: true },
				);
				this.report(handshakeError);
				this.invalidateConnection(connection, handshakeError, true);
				return;
			}
			if (malformed.requestId) {
				const pending = this.pending.get(malformed.requestId);
				if (pending) {
					this.pending.delete(malformed.requestId);
					pending.reject(malformed);
				}
			}
			this.report(malformed);
			return;
		}
		switch (response.type) {
			case "agent-runtime-port-connected":
				if (connection.readySettled) {
					this.report(
						new ChromeRuntimeSessionTransportError(
							"MALFORMED_PORT_MESSAGE",
							"Background runtime delivered more than one connection acknowledgement",
						),
					);
					return;
				}
				if (response.ok) {
					this.resolveReady(connection);
					return;
				}
				this.invalidateConnection(
					connection,
					new ChromeRuntimeSessionTransportError("PORT_CONNECT_REJECTED", response.error),
					false,
				);
				return;
			case "agent-runtime-port-response":
				this.receiveResponse(response.response);
				return;
			case "agent-runtime-port-error":
				this.receiveRequestError(response.requestId, response.error);
				return;
			case "agent-runtime-port-stream":
				this.receiveStream(response.envelope);
				return;
		}
	}

	private receiveResponse(response: RuntimeResponseEnvelope): void {
		const pending = this.pending.get(response.requestId);
		if (!pending) {
			this.report(
				new ChromeRuntimeSessionTransportError(
					"ORPHAN_RESPONSE",
					`Background runtime delivered a response for unknown request ${response.requestId}`,
					{ requestId: response.requestId },
				),
			);
			return;
		}
		const correlation = correlateRuntimeResponse(pending.request, response);
		if (!correlation.ok) {
			this.pending.delete(response.requestId);
			pending.reject(
				new ChromeRuntimeSessionTransportError(
					"RESPONSE_CORRELATION_FAILED",
					`Runtime response did not match request ${response.requestId}: ${correlation.mismatches.join(", ")}`,
					{ requestId: response.requestId, requestMayHaveExecuted: true },
				),
			);
			return;
		}
		this.pending.delete(response.requestId);
		pending.resolve(structuredClone(response));
	}

	private receiveRequestError(requestId: string, message: string): void {
		const pending = this.pending.get(requestId);
		if (!pending) {
			this.report(
				new ChromeRuntimeSessionTransportError(
					"ORPHAN_RESPONSE",
					`Background runtime delivered an error for unknown request ${requestId}`,
					{ requestId },
				),
			);
			return;
		}
		this.pending.delete(requestId);
		pending.reject(
			new ChromeRuntimeSessionTransportError("REMOTE_PORT_ERROR", message, {
				requestId,
				requestMayHaveExecuted: true,
			}),
		);
	}

	private receiveStream(envelope: RuntimeStreamEnvelope): void {
		if (!streamScopeMatchesDescriptor(envelope, this.descriptor)) {
			this.report(
				new ChromeRuntimeSessionTransportError(
					"MALFORMED_PORT_MESSAGE",
					"Background runtime delivered a stream outside this transport scope",
				),
			);
			return;
		}
		for (const listener of this.listeners) {
			try {
				listener(structuredClone(envelope));
			} catch (error) {
				this.report(
					new ChromeRuntimeSessionTransportError(
						"MALFORMED_PORT_MESSAGE",
						`Runtime stream listener failed: ${this.errorMessage(error)}`,
					),
				);
			}
		}
	}

	private handleDisconnect(connection: ConnectionState): void {
		if (this.connection !== connection) return;
		const connectionError = new ChromeRuntimeSessionTransportError("PORT_DISCONNECTED", "Runtime port disconnected", {
			retryable: true,
		});
		this.connection = undefined;
		this.detach(connection);
		this.rejectReady(connection, connectionError);
		for (const [requestId, pending] of this.pending) {
			this.pending.delete(requestId);
			pending.reject(
				new ChromeRuntimeSessionTransportError(
					"PORT_DISCONNECTED_IN_FLIGHT",
					`Runtime port disconnected while request ${requestId} was in flight; it may have executed and was not retried`,
					{ retryable: true, requestId, requestMayHaveExecuted: true },
				),
			);
		}
		this.scheduleReconnect();
	}

	private invalidateConnection(
		connection: ConnectionState,
		error: ChromeRuntimeSessionTransportError,
		reconnect: boolean,
	): void {
		if (this.connection !== connection) return;
		this.connection = undefined;
		this.detach(connection);
		this.rejectReady(connection, error);
		this.rejectInFlightRequests("Runtime port was invalidated");
		try {
			connection.port.disconnect();
		} catch {
			// The port may already be disconnected.
		}
		if (reconnect) this.scheduleReconnect();
	}

	private rejectReady(connection: ConnectionState, error: unknown): void {
		if (connection.readySettled) return;
		connection.readySettled = true;
		this.clearHandshakeTimeout(connection);
		connection.rejectReady(error);
	}

	private resolveReady(connection: ConnectionState): void {
		if (connection.readySettled) return;
		connection.readySettled = true;
		connection.readySucceeded = true;
		this.clearHandshakeTimeout(connection);
		connection.resolveReady();
	}

	private clearHandshakeTimeout(connection: ConnectionState): void {
		if (connection.handshakeTimeout === undefined) return;
		clearTimeout(connection.handshakeTimeout);
		connection.handshakeTimeout = undefined;
	}

	private rejectInFlightRequests(reason: string): void {
		for (const [requestId, pending] of this.pending) {
			this.pending.delete(requestId);
			pending.reject(
				new ChromeRuntimeSessionTransportError(
					"PORT_DISCONNECTED_IN_FLIGHT",
					`${reason} while request ${requestId} was in flight; it may have executed and was not retried`,
					{ retryable: true, requestId, requestMayHaveExecuted: true },
				),
			);
		}
	}

	private malformedMessageError(message: unknown): ChromeRuntimeSessionTransportError {
		let requestId: string | undefined;
		if (isPlainRecord(message)) {
			if (message.type === "agent-runtime-port-error" && nonEmptyString(message.requestId)) {
				requestId = message.requestId;
			} else if (
				message.type === "agent-runtime-port-response" &&
				isPlainRecord(message.response) &&
				nonEmptyString(message.response.requestId)
			) {
				requestId = message.response.requestId;
			}
		}
		return new ChromeRuntimeSessionTransportError(
			"MALFORMED_PORT_MESSAGE",
			requestId
				? `Background runtime delivered a malformed reply for request ${requestId}`
				: "Background runtime delivered a malformed port message",
			{ requestId, requestMayHaveExecuted: requestId !== undefined },
		);
	}

	private detach(connection: ConnectionState): void {
		this.clearHandshakeTimeout(connection);
		connection.port.onMessage.removeListener?.(connection.onMessage);
		connection.port.onDisconnect.removeListener?.(connection.onDisconnect);
	}

	private scheduleReconnect(): void {
		if (this.disposed || this.listeners.size === 0 || this.reconnectTimer !== undefined) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			if (this.disposed || this.connection || this.listeners.size === 0) return;
			try {
				const connection = this.ensureConnection();
				void connection.ready.catch((error: unknown) => this.report(this.asTransportError(error)));
			} catch (error) {
				this.report(this.asTransportError(error));
			}
		}, this.reconnectDelayMs);
	}

	private isRetryablePreSendError(error: unknown): boolean {
		return (
			error instanceof ChromeRuntimeSessionTransportError &&
			error.retryable &&
			!error.requestMayHaveExecuted &&
			!this.disposed
		);
	}

	private asTransportError(error: unknown): ChromeRuntimeSessionTransportError {
		return error instanceof ChromeRuntimeSessionTransportError
			? error
			: new ChromeRuntimeSessionTransportError("PORT_CONNECT_FAILED", this.errorMessage(error));
	}

	private errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private report(error: ChromeRuntimeSessionTransportError): void {
		try {
			this.onError?.(error);
		} catch {
			// Diagnostics must not break transport delivery.
		}
	}

	private assertUsable(): void {
		if (this.disposed) {
			throw new ChromeRuntimeSessionTransportError("DISPOSED", "Runtime port transport was disposed");
		}
	}
}
