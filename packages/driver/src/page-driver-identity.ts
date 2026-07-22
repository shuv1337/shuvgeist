export type PageDriverTransport = "chrome-debugger" | "websocket-cdp";

/** Stable target identity. Protocol-specific numeric tab sentinels never enter this shape. */
export interface PageIdentity {
	readonly transport: PageDriverTransport;
	readonly sessionId: string;
	readonly windowId: string;
	readonly pageId: string;
}

/** Identity captured at one navigation generation. */
export interface PageDriverScope {
	readonly page: PageIdentity;
	readonly navigationGeneration: number;
}

export class PageDriverTargetChangedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PageDriverTargetChangedError";
	}
}

export function createPageIdentity(
	transport: PageDriverTransport,
	parts: { sessionId: string; windowId: string; pageId: string },
): PageIdentity {
	return Object.freeze({
		transport,
		sessionId: requireIdentityPart(parts.sessionId, "sessionId"),
		windowId: requireIdentityPart(parts.windowId, "windowId"),
		pageId: requireIdentityPart(parts.pageId, "pageId"),
	});
}

export function pageIdentityKey(identity: PageIdentity): string {
	return JSON.stringify([identity.transport, identity.sessionId, identity.windowId, identity.pageId]);
}

export function samePageIdentity(left: PageIdentity, right: PageIdentity): boolean {
	return pageIdentityKey(left) === pageIdentityKey(right);
}

export function createPageDriverScope(page: PageIdentity, navigationGeneration: number): PageDriverScope {
	if (!Number.isSafeInteger(navigationGeneration) || navigationGeneration < 0) {
		throw new Error("Page navigation generation must be a non-negative safe integer");
	}
	return Object.freeze({ page, navigationGeneration });
}

export function samePageDriverScope(left: PageDriverScope, right: PageDriverScope): boolean {
	return samePageIdentity(left.page, right.page) && left.navigationGeneration === right.navigationGeneration;
}

function requireIdentityPart(value: string, name: "sessionId" | "windowId" | "pageId"): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`Page identity ${name} must not be empty`);
	return normalized;
}
