/**
 * Centralized port communication module for sidepanel <-> background messaging.
 *
 * Handles automatic reconnection when port disconnects (Chrome disconnects after ~5min inactivity).
 * Background script listeners (runtime.onConnect) stay alive forever and handle new connections.
 */

// ============================================================================
// MESSAGE INTERFACES
// ============================================================================

/**
 * Request to acquire a session lock.
 * Sent from sidepanel to background.
 */
export interface AcquireLockMessage {
	type: "acquireLock";
	sessionId: string;
	windowId: number;
}

/**
 * Response to acquireLock request.
 * Sent from background to sidepanel.
 */
export interface LockResultMessage {
	type: "lockResult";
	sessionId: string;
	success: boolean;
	ownerWindowId?: number; // Set if lock failed (session owned by another window)
}

/**
 * Request to get all currently locked sessions.
 * Sent from sidepanel to background.
 */
export interface GetLockedSessionsMessage {
	type: "getLockedSessions";
}

/**
 * Response to getLockedSessions request.
 * Sent from background to sidepanel.
 */
export interface LockedSessionsMessage {
	type: "lockedSessions";
	locks: Record<string, number>; // sessionId -> windowId
}

// ============================================================================
// DERIVED TYPES
// ============================================================================

/**
 * Defines all request/response message pairs.
 * This is the single source of truth for all port communication.
 */
export type MessagePair =
	| { request: AcquireLockMessage; response: LockResultMessage }
	| { request: GetLockedSessionsMessage; response: LockedSessionsMessage };

/**
 * All messages that can be sent from sidepanel to background.
 */
export type SidepanelToBackgroundMessage = MessagePair["request"];

/**
 * All messages that can be sent from background to sidepanel.
 */
export type BackgroundToSidepanelMessage = MessagePair["response"];

/**
 * Maps request message type to corresponding response message type.
 */
export type ResponseForRequest<TRequest extends SidepanelToBackgroundMessage> = Extract<
	MessagePair,
	{ request: TRequest }
>["response"];

/**
 * Runtime mapping from request type to response type.
 * Used to determine which response message to wait for.
 */
export const REQUEST_TO_RESPONSE_TYPE: Record<
	SidepanelToBackgroundMessage["type"],
	BackgroundToSidepanelMessage["type"]
> = {
	acquireLock: "lockResult",
	getLockedSessions: "lockedSessions",
};

// ============================================================================
// PORT COMMUNICATION
// ============================================================================

let port: chrome.runtime.Port | null = null;
let currentWindowId: number | undefined;
const responseHandlers = new Map<string, (msg: BackgroundToSidepanelMessage) => void>();

export function resetPortStateForTests(): void {
	port = null;
	currentWindowId = undefined;
	responseHandlers.clear();
}

/**
 * Initialize port system with window ID.
 * Must be called before sending any messages.
 */
export function initialize(windowId: number): void {
	currentWindowId = windowId;
	connect();
}

/**
 * Create new port connection and set up listeners.
 * Background script will receive this connection via runtime.onConnect.
 */
export function connect(): chrome.runtime.Port {
	if (!currentWindowId) {
		throw new Error("[Port] Cannot connect: windowId not initialized");
	}

	console.log(`[Port] Connecting... (${new Date().toISOString()})`);
	const tmpPort = chrome.runtime.connect({ name: `sidepanel:${currentWindowId}` });

	// Set up message listener to dispatch responses
	tmpPort.onMessage.addListener((msg: BackgroundToSidepanelMessage) => {
		// Dispatch to registered response handlers
		const handler = responseHandlers.get(msg.type);
		if (handler) {
			handler(msg);
		}
	});

	// Set up disconnect listener
	tmpPort.onDisconnect.addListener(() => {
		console.log(`[Port] Disconnected (likely due to inactivity timeout) (${new Date().toISOString()})`);
		port = null;
	});

	console.log(`[Port] Connected (${new Date().toISOString()})`);
	return tmpPort;
}

/**
 * Mark port as disconnected.
 * Next send attempt will create a new connection.
 */
export function disconnect(): void {
	port = null;
}

/**
 * Send a message through the port and wait for a response.
 * The response type is automatically inferred from the request message type.
 *
 * @param message - Request message to send to background script
 * @param timeoutMs - Response timeout in milliseconds (default: 5000)
 * @returns Promise resolving to the corresponding response message
 */
export async function sendMessage<TRequest extends SidepanelToBackgroundMessage>(
	message: TRequest,
	timeoutMs = 5000,
): Promise<ResponseForRequest<TRequest>> {
	for (let attempt = 1; attempt <= 2; attempt++) {
		// Ensure we have a port connection
		if (!port) {
			port = connect();
		}

		try {
			// Determine expected response type from request type
			const responseType = REQUEST_TO_RESPONSE_TYPE[message.type];
			if (!responseType) {
				throw new Error(`[Port] No response type mapping for message type: ${message.type}`);
			}

			// Set up response handler (all messages expect a response)
			const responsePromise = new Promise<BackgroundToSidepanelMessage>((resolve, reject) => {
				const timeoutId = setTimeout(() => {
					responseHandlers.delete(responseType);
					reject(new Error(`[Port] Timeout waiting for response: ${responseType}`));
				}, timeoutMs);

				responseHandlers.set(responseType, (msg: BackgroundToSidepanelMessage) => {
					clearTimeout(timeoutId);
					responseHandlers.delete(responseType);
					resolve(msg);
				});
			});

			// Try to send the message
			// This can throw if port disconnected between our check and this call
			port.postMessage(message);

			// Wait for response
			return (await responsePromise) as ResponseForRequest<TRequest>;
		} catch (err) {
			// Determine expected response type from request type for cleanup
			const responseType = REQUEST_TO_RESPONSE_TYPE[message.type];

			// Clean up response handler if we set one up
			if (responseType) {
				responseHandlers.delete(responseType);
			}

			// If this was our last attempt, give up
			if (attempt === 2) {
				throw new Error(`[Port] Failed to send message after ${attempt} attempts: ${err}`);
			}

			// Retry: disconnect and loop will reconnect
			console.warn(`[Port] Send attempt ${attempt} failed, will retry...`, err);
			disconnect();
		}
	}

	// TypeScript: This should never be reached (we throw on attempt 2 in catch block)
	throw new Error("[Port] Failed to send message: max attempts exceeded");
}

/**
 * Check if port is currently connected.
 * Note: This is best-effort - port can disconnect immediately after this check.
 */
export function isConnected(): boolean {
	return port !== null;
}
