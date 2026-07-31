export interface PrototypeCdpCommand {
	method: string;
	params?: Record<string, unknown>;
	sessionId?: string;
}

export interface PrototypeCdpBackend {
	send(command: PrototypeCdpCommand, signal: AbortSignal): Promise<Record<string, unknown>>;
	releaseSession?(sessionId: string): Promise<void>;
}

export interface PrototypeCdpEvent {
	method: string;
	params?: Record<string, unknown>;
	sessionId?: string;
}

export interface PrototypeRootTarget {
	kind: "page";
	rootKey: string;
	targetId: string;
	sessionId: string;
	url: string;
	title: string;
	rootGeneration: number;
	navigationGeneration: number;
}

export interface PrototypeChildTarget {
	parentSessionId: string;
	targetId: string;
	sessionId: string;
	type: "iframe" | "worker" | "service_worker" | "shared_worker" | "other";
	url: string;
	title?: string;
	navigationGeneration: number;
}

export interface ConnectPrototypeClientOptions {
	clientId: string;
	bearerAuthenticated: boolean;
	capabilities: readonly string[];
	commandTimeoutMs?: number;
	onEvent: (event: PrototypeCdpEvent) => void;
}

export class PlaywrightAdapterError extends Error {
	constructor(
		readonly code:
			| "AUTH_REQUIRED"
			| "CAPABILITY_REQUIRED"
			| "METHOD_DENIED"
			| "UNKNOWN_SESSION"
			| "COMMAND_TIMEOUT"
			| "CLIENT_DISCONNECTED",
		message: string,
	) {
		super(message);
	}
}

interface ClientState {
	id: string;
	capabilities: ReadonlySet<string>;
	commandTimeoutMs: number;
	onEvent: (event: PrototypeCdpEvent) => void;
	connected: boolean;
	nextAlias: number;
	nextTargetAlias: number;
	backendToAlias: Map<string, string>;
	aliasToBackend: Map<string, string>;
	backendTargetToAlias: Map<string, string>;
	announcedTargets: Map<string, string>;
	generationByAlias: Map<string, { rootGeneration: number; navigationGeneration: number }>;
	pending: Set<{ controller: AbortController; rejectDisconnected: () => void }>;
}

const LOCAL_METHODS = new Set([
	"Browser.getVersion",
	"Target.getTargets",
	"Target.setDiscoverTargets",
	"Target.setAutoAttach",
]);
const ROUTED_READ_PREFIXES = ["Accessibility.", "CSS.", "DOM.", "DOMSnapshot.", "Log.", "Network.", "Page."];
const ROUTED_EXACT_METHODS = new Set([
	"Runtime.enable",
	"Runtime.disable",
	"Runtime.getIsolateId",
	"Runtime.releaseObject",
	"Runtime.releaseObjectGroup",
]);
const DENIED_METHODS = new Set([
	"Browser.setDownloadBehavior",
	"Page.setDownloadBehavior",
	"Target.createBrowserContext",
	"Target.createTarget",
	"Target.closeTarget",
	"Storage.getCookies",
	"Storage.setCookies",
	"Network.getAllCookies",
	"Network.setCookie",
	"Network.setCookies",
]);

function exposeChild(target: PrototypeChildTarget): boolean {
	return target.type === "iframe" || target.type === "worker";
}

function targetKey(target: PrototypeRootTarget | PrototypeChildTarget): string {
	return `${target.targetId}:${target.sessionId}`;
}

/**
 * Node-only compatibility spike. It models the isolated CDP views required by
 * Playwright without importing Playwright or integrating with the live bridge.
 */
export class PlaywrightCdpAdapterPrototype {
	private readonly roots = new Map<string, PrototypeRootTarget>();
	private readonly rootByTargetId = new Map<string, PrototypeRootTarget>();
	private readonly children = new Map<string, PrototypeChildTarget>();
	private readonly childByTargetId = new Map<string, PrototypeChildTarget>();
	private readonly frameReplayByChildSession = new Map<string, PrototypeCdpEvent[]>();
	private readonly clients = new Map<string, ClientState>();
	private readonly backendViewers = new Map<string, Set<string>>();

	constructor(private readonly backend: PrototypeCdpBackend) {}

	connect(options: ConnectPrototypeClientOptions): PrototypePlaywrightClient {
		if (!options.bearerAuthenticated) {
			throw new PlaywrightAdapterError("AUTH_REQUIRED", "A valid bridge bearer token is required.");
		}
		if (!options.capabilities.includes("playwright_compat")) {
			throw new PlaywrightAdapterError(
				"CAPABILITY_REQUIRED",
				"The playwright_compat capability is required for this adapter.",
			);
		}
		if (this.clients.has(options.clientId)) {
			throw new PlaywrightAdapterError("AUTH_REQUIRED", `Client ${options.clientId} is already connected.`);
		}
		const state: ClientState = {
			id: options.clientId,
			capabilities: new Set(options.capabilities),
			commandTimeoutMs: options.commandTimeoutMs ?? 5_000,
			onEvent: options.onEvent,
			connected: true,
			nextAlias: 0,
			nextTargetAlias: 0,
			backendToAlias: new Map(),
			aliasToBackend: new Map(),
			backendTargetToAlias: new Map(),
			announcedTargets: new Map(),
			generationByAlias: new Map(),
			pending: new Set(),
		};
		this.clients.set(state.id, state);
		for (const root of this.roots.values()) this.announceRootToClient(state, root);
		for (const child of this.children.values()) {
			if (exposeChild(child)) this.announceChildToClient(state, child);
		}
		return new PrototypePlaywrightClient(this, state);
	}

	announceRoot(target: PrototypeRootTarget): void {
		const existing = this.rootByTargetId.get(target.targetId);
		if (existing && targetKey(existing) === targetKey(target) && existing.rootGeneration === target.rootGeneration) {
			if (target.navigationGeneration > existing.navigationGeneration) this.navigateRoot(target);
			return;
		}
		if (existing) this.removeRoot(existing.rootKey);
		this.roots.set(target.rootKey, { ...target });
		this.rootByTargetId.set(target.targetId, { ...target });
		for (const client of this.clients.values()) this.announceRootToClient(client, target);
	}

	announceChild(target: PrototypeChildTarget): void {
		const existing = this.childByTargetId.get(target.targetId);
		if (
			existing &&
			targetKey(existing) === targetKey(target) &&
			existing.navigationGeneration === target.navigationGeneration
		) {
			return;
		}
		if (existing) this.removeChild(existing.sessionId);
		this.children.set(target.sessionId, { ...target });
		this.childByTargetId.set(target.targetId, { ...target });
		if (!exposeChild(target)) return;
		for (const client of this.clients.values()) this.announceChildToClient(client, target);
	}

	recordChildFrameEvent(childSessionId: string, event: PrototypeCdpEvent): void {
		const events = this.frameReplayByChildSession.get(childSessionId) ?? [];
		events.push({ ...event, params: event.params ? { ...event.params } : undefined });
		this.frameReplayByChildSession.set(childSessionId, events.slice(-20));
		const child = this.children.get(childSessionId);
		if (!child || !exposeChild(child)) return;
		for (const client of this.clients.values()) this.emitBackendEvent(client, childSessionId, event);
	}

	navigateRoot(target: PrototypeRootTarget): void {
		const existing = this.roots.get(target.rootKey);
		if (!existing || target.rootGeneration !== existing.rootGeneration) {
			this.announceRoot(target);
			return;
		}
		if (target.navigationGeneration <= existing.navigationGeneration) return;
		const updated = { ...target };
		this.roots.set(target.rootKey, updated);
		this.rootByTargetId.set(target.targetId, updated);
		for (const client of this.clients.values()) {
			const alias = client.backendToAlias.get(target.sessionId);
			if (!alias) continue;
			client.generationByAlias.set(alias, {
				rootGeneration: target.rootGeneration,
				navigationGeneration: target.navigationGeneration,
			});
			client.onEvent({
				method: "Page.frameNavigated",
				sessionId: alias,
				params: {
					frame: { id: target.targetId, url: target.url },
				},
			});
		}
	}

	removeRoot(rootKey: string): void {
		const root = this.roots.get(rootKey);
		if (!root) return;
		for (const child of [...this.children.values()]) {
			if (child.parentSessionId === root.sessionId) this.removeChild(child.sessionId);
		}
		this.roots.delete(rootKey);
		if (this.rootByTargetId.get(root.targetId)?.sessionId === root.sessionId) {
			this.rootByTargetId.delete(root.targetId);
		}
		for (const client of this.clients.values()) this.detachFromClient(client, root.sessionId, root.targetId);
	}

	removeChild(sessionId: string): void {
		const child = this.children.get(sessionId);
		if (!child) return;
		this.children.delete(sessionId);
		this.frameReplayByChildSession.delete(sessionId);
		if (this.childByTargetId.get(child.targetId)?.sessionId === child.sessionId) {
			this.childByTargetId.delete(child.targetId);
		}
		for (const client of this.clients.values()) this.detachFromClient(client, child.sessionId, child.targetId);
	}

	async send(client: ClientState, command: PrototypeCdpCommand): Promise<{ result: Record<string, unknown> }> {
		this.requireConnected(client);
		this.assertMethodAllowed(client, command.method);
		if (LOCAL_METHODS.has(command.method)) return { result: this.localResult(client, command.method) };
		if (!command.sessionId) {
			throw new PlaywrightAdapterError("UNKNOWN_SESSION", `${command.method} requires a client session alias.`);
		}
		const backendSessionId = client.aliasToBackend.get(command.sessionId);
		if (!backendSessionId) {
			throw new PlaywrightAdapterError("UNKNOWN_SESSION", `Unknown client session alias ${command.sessionId}.`);
		}
		const controller = new AbortController();
		let rejectDisconnected = (): void => undefined;
		const disconnected = new Promise<never>((_resolve, reject) => {
			rejectDisconnected = () =>
				reject(
					new PlaywrightAdapterError("CLIENT_DISCONNECTED", `Client ${client.id} disconnected during command.`),
				);
		});
		const pending = { controller, rejectDisconnected };
		client.pending.add(pending);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(
						new PlaywrightAdapterError(
							"COMMAND_TIMEOUT",
							`${command.method} timed out after ${client.commandTimeoutMs}ms; late results are discarded.`,
						),
					);
				}, client.commandTimeoutMs);
			});
			const result = await Promise.race([
				this.backend.send(
					{
						method: command.method,
						params: command.params ? { ...command.params } : undefined,
						sessionId: backendSessionId,
					},
					controller.signal,
				),
				timeout,
				disconnected,
			]);
			this.requireConnected(client);
			return { result };
		} finally {
			if (timer) clearTimeout(timer);
			client.pending.delete(pending);
		}
	}

	async disconnect(client: ClientState): Promise<void> {
		if (!client.connected) return;
		client.connected = false;
		for (const pending of client.pending) {
			pending.controller.abort();
			pending.rejectDisconnected();
		}
		client.pending.clear();
		this.clients.delete(client.id);
		const releases: Promise<void>[] = [];
		for (const backendSessionId of client.backendToAlias.keys()) {
			const viewers = this.backendViewers.get(backendSessionId);
			viewers?.delete(client.id);
			if (viewers?.size === 0) {
				this.backendViewers.delete(backendSessionId);
				if (this.backend.releaseSession) releases.push(this.backend.releaseSession(backendSessionId));
			}
		}
		client.backendToAlias.clear();
		client.aliasToBackend.clear();
		client.announcedTargets.clear();
		client.backendTargetToAlias.clear();
		client.generationByAlias.clear();
		await Promise.all(releases);
	}

	targetGeneration(
		client: ClientState,
		sessionAlias: string,
	): { rootGeneration: number; navigationGeneration: number } | undefined {
		const generation = client.generationByAlias.get(sessionAlias);
		return generation ? { ...generation } : undefined;
	}

	private announceRootToClient(client: ClientState, root: PrototypeRootTarget): void {
		const alias = this.aliasFor(client, root.sessionId);
		if (client.announcedTargets.get(root.targetId) === alias) return;
		client.announcedTargets.set(root.targetId, alias);
		client.generationByAlias.set(alias, {
			rootGeneration: root.rootGeneration,
			navigationGeneration: root.navigationGeneration,
		});
		client.onEvent({
			method: "Target.targetCreated",
			params: { targetInfo: this.targetInfo(root, client, "page") },
		});
		client.onEvent({
			method: "Target.attachedToTarget",
			params: {
				sessionId: alias,
				targetInfo: this.targetInfo(root, client, "page"),
				waitingForDebugger: false,
			},
		});
	}

	private announceChildToClient(client: ClientState, child: PrototypeChildTarget): void {
		const alias = this.aliasFor(client, child.sessionId);
		if (client.announcedTargets.get(child.targetId) === alias) return;
		client.announcedTargets.set(child.targetId, alias);
		const root = [...this.roots.values()].find((candidate) => candidate.sessionId === child.parentSessionId);
		client.generationByAlias.set(alias, {
			rootGeneration: root?.rootGeneration ?? 0,
			navigationGeneration: child.navigationGeneration,
		});
		client.onEvent({
			method: "Target.attachedToTarget",
			sessionId: root ? client.backendToAlias.get(root.sessionId) : undefined,
			params: {
				sessionId: alias,
				targetInfo: this.targetInfo(child, client, child.type),
				waitingForDebugger: false,
			},
		});
		for (const event of this.frameReplayByChildSession.get(child.sessionId) ?? []) {
			this.emitBackendEvent(client, child.sessionId, event);
		}
	}

	private emitBackendEvent(client: ClientState, backendSessionId: string, event: PrototypeCdpEvent): void {
		const alias = client.backendToAlias.get(backendSessionId);
		if (!alias) return;
		client.onEvent({
			method: event.method,
			params: event.params ? { ...event.params } : undefined,
			sessionId: alias,
		});
	}

	private detachFromClient(client: ClientState, backendSessionId: string, targetId: string): void {
		const alias = client.backendToAlias.get(backendSessionId);
		if (!alias) return;
		client.onEvent({
			method: "Target.detachedFromTarget",
			params: { sessionId: alias, targetId: this.clientTargetId(client, targetId) },
		});
		client.backendToAlias.delete(backendSessionId);
		client.aliasToBackend.delete(alias);
		client.announcedTargets.delete(targetId);
		client.backendTargetToAlias.delete(targetId);
		client.generationByAlias.delete(alias);
		const viewers = this.backendViewers.get(backendSessionId);
		viewers?.delete(client.id);
		if (viewers?.size === 0) this.backendViewers.delete(backendSessionId);
	}

	private aliasFor(client: ClientState, backendSessionId: string): string {
		const existing = client.backendToAlias.get(backendSessionId);
		if (existing) return existing;
		const alias = `pw:${client.id}:session:${++client.nextAlias}`;
		client.backendToAlias.set(backendSessionId, alias);
		client.aliasToBackend.set(alias, backendSessionId);
		const viewers = this.backendViewers.get(backendSessionId) ?? new Set<string>();
		viewers.add(client.id);
		this.backendViewers.set(backendSessionId, viewers);
		return alias;
	}

	private clientTargetId(client: ClientState, backendTargetId: string): string {
		const existing = client.backendTargetToAlias.get(backendTargetId);
		if (existing) return existing;
		const alias = `pw:${client.id}:target:${++client.nextTargetAlias}`;
		client.backendTargetToAlias.set(backendTargetId, alias);
		return alias;
	}

	private targetInfo(
		target: PrototypeRootTarget | PrototypeChildTarget,
		client: ClientState,
		type: string,
	): Record<string, unknown> {
		return {
			targetId: this.clientTargetId(client, target.targetId),
			type,
			title: target.title ?? "",
			url: target.url,
			attached: true,
			canAccessOpener: false,
		};
	}

	private localResult(client: ClientState, method: string): Record<string, unknown> {
		if (method === "Browser.getVersion") {
			return {
				protocolVersion: "1.3",
				product: "Shuvgeist Playwright compatibility prototype",
				revision: "prototype",
				userAgent: "Shuvgeist",
				jsVersion: "prototype",
			};
		}
		if (method === "Target.getTargets") {
			return {
				targetInfos: [...this.roots.values()].map((root) => this.targetInfo(root, client, "page")),
			};
		}
		return {};
	}

	private assertMethodAllowed(client: ClientState, method: string): void {
		if (DENIED_METHODS.has(method)) {
			throw new PlaywrightAdapterError("METHOD_DENIED", `${method} is denied by the compatibility policy.`);
		}
		if (LOCAL_METHODS.has(method)) return;
		if (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") {
			if (client.capabilities.has("playwright_evaluate")) return;
			throw new PlaywrightAdapterError(
				"CAPABILITY_REQUIRED",
				`${method} requires the separate playwright_evaluate capability.`,
			);
		}
		if (method.startsWith("Input.")) {
			if (client.capabilities.has("playwright_input")) return;
			throw new PlaywrightAdapterError(
				"CAPABILITY_REQUIRED",
				`${method} requires the separate playwright_input capability.`,
			);
		}
		if (ROUTED_EXACT_METHODS.has(method) || ROUTED_READ_PREFIXES.some((prefix) => method.startsWith(prefix))) return;
		throw new PlaywrightAdapterError("METHOD_DENIED", `${method} is not in the compatibility method allowlist.`);
	}

	private requireConnected(client: ClientState): void {
		if (!client.connected) {
			throw new PlaywrightAdapterError("CLIENT_DISCONNECTED", `Client ${client.id} is disconnected.`);
		}
	}
}

export class PrototypePlaywrightClient {
	constructor(
		private readonly adapter: PlaywrightCdpAdapterPrototype,
		private readonly state: ClientState,
	) {}

	send(command: PrototypeCdpCommand): Promise<{ result: Record<string, unknown> }> {
		return this.adapter.send(this.state, command);
	}

	disconnect(): Promise<void> {
		return this.adapter.disconnect(this.state);
	}

	targetGeneration(sessionAlias: string): { rootGeneration: number; navigationGeneration: number } | undefined {
		return this.adapter.targetGeneration(this.state, sessionAlias);
	}
}
