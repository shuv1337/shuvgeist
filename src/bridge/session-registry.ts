import type { CdpSession } from "../tools/helpers/cdp-session.js";
import { PerHandleWriteLock } from "./per-handle-write-lock.js";
import type { BridgeTarget } from "./target.js";

export type TargetSessionKind = BridgeTarget["kind"];

export interface TargetSessionHandle<TConnection> {
	key: string;
	kind: TargetSessionKind;
	connection: TConnection;
	writeLock: PerHandleWriteLock;
	windowId?: number;
	sessionId?: string;
	capabilities?: readonly string[];
	protocolVersion?: number;
	appVersion?: string;
	remoteAddress?: string;
	cdp?: CdpSession;
	agentContext?: unknown;
}

export interface RegisterTargetSessionHandleOptions<TConnection> {
	kind: TargetSessionKind;
	connection: TConnection;
	windowId?: number;
	sessionId?: string;
	capabilities?: readonly string[];
	protocolVersion?: number;
	appVersion?: string;
	remoteAddress?: string;
	cdp?: CdpSession;
	agentContext?: unknown;
}

export class SessionRegistry<TConnection> {
	private handle?: TargetSessionHandle<TConnection>;

	get activeHandle(): TargetSessionHandle<TConnection> | undefined {
		return this.handle;
	}

	register(options: RegisterTargetSessionHandleOptions<TConnection>): TargetSessionHandle<TConnection> {
		const handle: TargetSessionHandle<TConnection> = {
			...options,
			key: this.keyFor(options),
			writeLock: new PerHandleWriteLock(),
		};
		this.handle = handle;
		return handle;
	}

	resolve(_target?: BridgeTarget): TargetSessionHandle<TConnection> | undefined {
		return this.handle;
	}

	get(key: string | undefined): TargetSessionHandle<TConnection> | undefined {
		if (!key || this.handle?.key !== key) return undefined;
		return this.handle;
	}

	findByConnection(connection: TConnection): TargetSessionHandle<TConnection> | undefined {
		return this.handle?.connection === connection ? this.handle : undefined;
	}

	unregisterByConnection(connection: TConnection): TargetSessionHandle<TConnection> | undefined {
		if (this.handle?.connection !== connection) return undefined;
		const removed = this.handle;
		this.handle = undefined;
		removed.writeLock.clear();
		return removed;
	}

	releaseLocksForCli(
		cliConnectionId: string,
	): Array<{ handle: TargetSessionHandle<TConnection>; sessionId?: string }> {
		const holder = this.handle?.writeLock.currentHolder;
		if (!this.handle || holder?.cliConnectionId !== cliConnectionId) return [];
		this.handle.writeLock.clear();
		return [{ handle: this.handle, sessionId: holder.sessionId }];
	}

	clear(): void {
		this.handle?.writeLock.clear();
		this.handle = undefined;
	}

	private keyFor(
		options: Pick<RegisterTargetSessionHandleOptions<TConnection>, "kind" | "windowId" | "sessionId">,
	): string {
		if (options.kind === "chrome-tab") return `chrome-window:${options.windowId ?? "unknown"}`;
		return `electron-window:${options.sessionId ?? options.windowId ?? "unknown"}`;
	}
}
