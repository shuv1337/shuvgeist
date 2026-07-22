import type { CdpSession } from "@shuvgeist/driver/cdp-session";
import type { BridgeTarget } from "@shuvgeist/protocol/target";
import { PerHandleWriteLock } from "./per-handle-write-lock.js";

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
	private handles = new Map<string, TargetSessionHandle<TConnection>>();
	private activeKey?: string;

	get activeHandle(): TargetSessionHandle<TConnection> | undefined {
		return this.get(this.activeKey) ?? this.lastHandle();
	}

	register(options: RegisterTargetSessionHandleOptions<TConnection>): TargetSessionHandle<TConnection> {
		const key = this.keyFor(options);
		const existing = this.handles.get(key);
		existing?.writeLock.clear();
		const handle: TargetSessionHandle<TConnection> = {
			...options,
			key,
			writeLock: new PerHandleWriteLock(),
		};
		this.handles.set(handle.key, handle);
		this.activeKey = handle.key;
		return handle;
	}

	resolve(target?: BridgeTarget): TargetSessionHandle<TConnection> | undefined {
		if (!target || target.kind === "chrome-tab") {
			if (!target?.tabRef && typeof target?.tabId !== "number") return this.activeHandle;
			if (target.tabRef) return this.resolveChromeRef(target.tabRef) ?? this.activeHandle;
			return this.activeHandle;
		}
		return this.resolveElectronTarget(target) ?? this.activeHandle;
	}

	get(key: string | undefined): TargetSessionHandle<TConnection> | undefined {
		return key ? this.handles.get(key) : undefined;
	}

	findByConnection(connection: TConnection): TargetSessionHandle<TConnection> | undefined {
		return [...this.handles.values()].find((handle) => handle.connection === connection);
	}

	unregisterByConnection(connection: TConnection): TargetSessionHandle<TConnection> | undefined {
		const removed = this.findByConnection(connection);
		if (!removed) return undefined;
		this.handles.delete(removed.key);
		if (this.activeKey === removed.key) this.activeKey = this.lastHandle()?.key;
		removed.writeLock.clear();
		return removed;
	}

	releaseLocksForCli(
		cliConnectionId: string,
	): Array<{ handle: TargetSessionHandle<TConnection>; sessionId?: string }> {
		const released: Array<{ handle: TargetSessionHandle<TConnection>; sessionId?: string }> = [];
		for (const handle of this.handles.values()) {
			const holder = handle.writeLock.currentHolder;
			if (holder?.cliConnectionId !== cliConnectionId) continue;
			handle.writeLock.clear();
			released.push({ handle, sessionId: holder.sessionId });
		}
		return released;
	}

	clear(): void {
		for (const handle of this.handles.values()) handle.writeLock.clear();
		this.handles.clear();
		this.activeKey = undefined;
	}

	private lastHandle(): TargetSessionHandle<TConnection> | undefined {
		return [...this.handles.values()].at(-1);
	}

	private resolveChromeRef(tabRef: string): TargetSessionHandle<TConnection> | undefined {
		const normalized = tabRef.trim();
		if (!normalized) return undefined;
		const withoutPrefix = normalized
			.replace(/^window:/u, "")
			.replace(/^chrome-window:/u, "")
			.replace(/^session:/u, "");
		return [...this.handles.values()].find(
			(handle) =>
				handle.kind === "chrome-tab" &&
				(handle.key === normalized ||
					handle.key === "chrome-window:" + withoutPrefix ||
					String(handle.windowId) === withoutPrefix ||
					handle.sessionId === withoutPrefix),
		);
	}

	private resolveElectronTarget(
		target: Extract<BridgeTarget, { kind: "electron-window" }>,
	): TargetSessionHandle<TConnection> | undefined {
		return [...this.handles.values()].find(
			(handle) =>
				handle.kind === "electron-window" &&
				((target.sessionId && handle.sessionId === target.sessionId) ||
					(target.targetId && handle.key === target.targetId)),
		);
	}

	private keyFor(
		options: Pick<RegisterTargetSessionHandleOptions<TConnection>, "kind" | "windowId" | "sessionId">,
	): string {
		if (options.kind === "chrome-tab") return `chrome-window:${options.windowId ?? "unknown"}`;
		return `electron-window:${options.sessionId ?? options.windowId ?? "unknown"}`;
	}
}
