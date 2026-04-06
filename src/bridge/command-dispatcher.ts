/**
 * Command dispatcher interface for the bridge client.
 *
 * Decouples BridgeClient from BrowserCommandExecutor so the background
 * service worker can provide its own dispatcher without importing tool
 * files that depend on DOM APIs (lit, pi-web-ui, etc.).
 */

import type { BridgeMethod } from "./protocol.js";

export interface CommandDispatcher {
	dispatch(method: BridgeMethod, params: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<unknown>;
}
