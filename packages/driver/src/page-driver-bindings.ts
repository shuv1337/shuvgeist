import { type CdpSession, type ChromeDebuggerManagerLike, ChromeDebuggerSession } from "./cdp-session.js";
import {
	createPageDriver,
	type PageDriver,
	type PageRefActionExpressionBuilder,
	type PageSnapshotExpressionBuilder,
} from "./page-driver.js";
import { createPageIdentity } from "./page-driver-identity.js";

interface CommonPageDriverBindingOptions {
	sessionId: string;
	windowId: string;
	pageId: string;
	buildSnapshotExpression: PageSnapshotExpressionBuilder;
	buildRefActionExpression?: PageRefActionExpressionBuilder;
	onClose?: Parameters<typeof createPageDriver>[1]["onClose"];
}

export interface ChromeDebuggerPageDriverOptions extends CommonPageDriverBindingOptions {
	tabId: number;
	manager: ChromeDebuggerManagerLike;
}

export interface WebSocketCdpPageDriverOptions extends CommonPageDriverBindingOptions {
	cdp: CdpSession;
	authorizeCdpInput?: Parameters<typeof createPageDriver>[1]["authorizeCdpInput"];
}

export function createChromeDebuggerPageDriver(options: ChromeDebuggerPageDriverOptions): PageDriver {
	const identity = createPageIdentity("chrome-debugger", options);
	const cdp = new ChromeDebuggerSession({
		tabId: options.tabId,
		manager: options.manager,
		targetId: identity.pageId,
	});
	return createPageDriver(cdp, {
		identity,
		buildSnapshotExpression: options.buildSnapshotExpression,
		buildRefActionExpression: options.buildRefActionExpression,
		authorizeCdpInput: () => true,
		onClose: options.onClose,
	});
}

/** Electron and direct-headless both bind their existing WebSocket CdpSession here. */
export function createWebSocketCdpPageDriver(options: WebSocketCdpPageDriverOptions): PageDriver {
	return createPageDriver(options.cdp, {
		identity: createPageIdentity("websocket-cdp", options),
		buildSnapshotExpression: options.buildSnapshotExpression,
		buildRefActionExpression: options.buildRefActionExpression,
		authorizeCdpInput: options.authorizeCdpInput,
		onClose: options.onClose,
	});
}
