import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { SNAPSHOT_INJECTED_ARTIFACT } from "@shuvgeist/driver/driver-artifacts-generated";
import type { SnapshotInjectionConfig } from "@shuvgeist/driver/injected-contracts";
import { buildInjectedArtifactInvocation } from "@shuvgeist/driver/injected-invocation";
import {
	type RankedLocatorCandidate,
	rankLocatorCandidates,
	type SemanticLocatorCandidate,
} from "@shuvgeist/driver/locator-scoring";
import type { PageDriver } from "@shuvgeist/driver/page-driver";
import { createWebSocketCdpPageDriver } from "@shuvgeist/driver/page-driver-bindings";
import type { PageDriverScope } from "@shuvgeist/driver/page-driver-identity";
import {
	pageDriverNetworkBodyToWire,
	pageDriverNetworkCurlToWire,
	pageDriverNetworkGetToWire,
	pageDriverNetworkListToWire,
	pageDriverNetworkStatsToWire,
	pageDriverRefActionToWire,
	pageDriverScopeToWire,
	pageDriverSnapshotToWire,
} from "@shuvgeist/driver/page-driver-wire";
import type {
	PageScreencastFrame,
	PageScreencastStatus,
	PageScreencastSummary,
} from "@shuvgeist/driver/page-screencast-engine";
import { ElectronWsCdpSession } from "@shuvgeist/driver/websocket-cdp-session";
import type { BridgeCommandResult, ResolvedPageTarget } from "@shuvgeist/protocol/command-schemas";
import type {
	BridgeScreenshotResult,
	LocateByLabelParams,
	LocateByRoleParams,
	LocateByTextParams,
	NetworkCurlParams,
	NetworkItemParams,
	NetworkListParams,
	NetworkStartParams,
	PageAssertParams,
	PageAssertResult,
	PageSnapshotBridgeResult,
	PerfMetricsParams,
	RecordFrameEventData,
	RecordStartParams,
	RecordStartResult,
	RecordStatusResult,
	RecordStopResult,
	RefActionResult,
	RefClickParams,
	RefFillParams,
	SnapshotLocatorMatchResult,
} from "@shuvgeist/protocol/protocol";
import { matchSnapshotSkillsForApp } from "@shuvgeist/protocol/skill-snapshot";
import type { BridgeTarget } from "@shuvgeist/protocol/target";
import { createNodeConfigOwner, NodeConfigError, type NodeConfigOwner } from "../node-config.js";
import { KNOWN_ELECTRON_APPS, resolveExecutable } from "./app-registry.js";
import { normalizeElectronConfig } from "./config.js";
import {
	canonicalExecutablePath,
	discoverPortForPid,
	type ElectronProcessRow,
	findListeningPidsForPort,
	listElectronProcesses,
	matchElectronAppsForProcesses,
	processFamilyRoot,
	processIdentityKey,
	processIsInFamily,
	processMatchesElectronApp,
	processTerminationIdentityKey,
	remoteDebuggingPortForProcess,
} from "./process-discovery.js";
import { ElectronSessionStore } from "./session-store.js";
import { readSkillSnapshot } from "./skill-snapshot-store.js";
import type {
	ElectronApp,
	ElectronIpcTap,
	ElectronMainNetworkTap,
	ElectronProcessIdentity,
	ElectronSession,
	ElectronSessionStatusSummary,
	ElectronSessionSummary,
	ElectronWindow,
} from "./types.js";
import { assertElectronWindow, captureElectronWindowScreenshot } from "./window-executor.js";

interface CdpVersionResponse {
	Browser?: string;
	webSocketDebuggerUrl?: string;
}

interface InspectorEndpoint {
	Browser?: string;
	webSocketDebuggerUrl?: string;
}

export interface ElectronSessionManagerOptions {
	configOwner?: NodeConfigOwner;
	listProcesses?: () => Promise<ElectronProcessRow[]>;
	listeningPidsForPort?: (port: number) => Promise<number[] | undefined>;
	connectPage?: (url: string, targetId: string) => Promise<ElectronWsCdpSession>;
	apps?: readonly ElectronApp[];
	attachTimeoutMs?: number;
	livenessTimeoutMs?: number;
}

interface VerifiedElectronEndpoint {
	app: ElectronApp;
	owner: ElectronProcessIdentity;
}

interface ElectronPageDriverState {
	driver: PageDriver;
	cdp: ElectronWsCdpSession;
	removeCloseListener: () => void;
}

interface ElectronPageDriverCacheEntry {
	key: string;
	sessionId: string;
	windowRef: string;
	targetId: string;
	endpointKey: string;
	webSocketDebuggerUrl: string;
	disposed: boolean;
	state: Promise<ElectronPageDriverState>;
	disposePromise?: Promise<void>;
}

export class ElectronSessionManager {
	private readonly sessionStore = new ElectronSessionStore();
	private readonly pageDrivers = new Map<string, ElectronPageDriverCacheEntry>();
	private readonly pendingPageDriverDisposals = new Set<Promise<void>>();
	private readonly listElectronProcesses: () => Promise<ElectronProcessRow[]>;
	private readonly listeningPidsForPort: (port: number) => Promise<number[] | undefined>;
	private readonly connectPage: (url: string, targetId: string) => Promise<ElectronWsCdpSession>;
	private readonly apps: readonly ElectronApp[];
	private readonly attachTimeoutMs: number;
	private readonly livenessTimeoutMs: number;
	private readonly configOwner: NodeConfigOwner;

	constructor(options: ElectronSessionManagerOptions = {}) {
		this.configOwner = options.configOwner ?? createNodeConfigOwner();
		this.listElectronProcesses = options.listProcesses ?? listElectronProcesses;
		this.listeningPidsForPort = options.listeningPidsForPort ?? findListeningPidsForPort;
		this.connectPage = options.connectPage ?? ElectronWsCdpSession.connect;
		this.apps = options.apps ?? KNOWN_ELECTRON_APPS;
		this.attachTimeoutMs = options.attachTimeoutMs ?? 3000;
		this.livenessTimeoutMs = options.livenessTimeoutMs ?? 750;
	}

	list(): ElectronSessionSummary[] {
		return this.sessionStore.summaries();
	}

	async status(): Promise<ElectronSessionStatusSummary[]> {
		return Promise.all(this.sessionStore.list().map((session) => this.statusForSession(session)));
	}

	async dispose(): Promise<void> {
		await Promise.all([...this.pageDrivers.values()].map((entry) => this.disposePageDriverEntry(entry)));
		await Promise.all([...this.pendingPageDriverDisposals]);
	}

	async launch(appRef: string, options: { inspectMain?: boolean } = {}): Promise<ElectronSessionSummary> {
		const app = this.resolveApp(appRef);
		if (!app) throw new Error(`Unknown Electron app '${appRef}'. Run 'shuvgeist electron list' to see known apps.`);
		this.assertAllowed(app.id);
		if (options.inspectMain && !app.mainInspectSupported) {
			throw new Error(`Electron app '${appRef}' does not support main-process inspector launch.`);
		}
		const executable = resolveExecutable(app);
		if (!executable) throw new Error(`Electron app '${appRef}' is not installed or its executable path is unknown.`);
		const port = await this.choosePort();
		const inspectPort = options.inspectMain ? await this.choosePort(port + 1) : undefined;
		const args = [
			`--remote-debugging-port=${port}`,
			...(inspectPort ? [`--inspect=${inspectPort}`] : []),
			...app.defaultArgs,
			...this.defaultFlagsFor(app.id),
		];
		const child = spawn(executable, args, { detached: true, stdio: "ignore" });
		if (!child.pid) throw new Error(`Failed to launch '${app.displayName}'.`);
		child.unref();
		const launchedProcess = (await this.listElectronProcesses()).find((candidate) => candidate.pid === child.pid);
		const launchProcessIdentityKey = launchedProcess ? processTerminationIdentityKey(launchedProcess) : undefined;
		try {
			const version = await waitForCdp(port, 10_000);
			const verified = await this.verifyEndpointIdentity(port, app, child.pid);
			const browserEndpointKey = normalizeDebuggerEndpoint(version.webSocketDebuggerUrl, port);
			const endpointKey = compositeEndpointKey(browserEndpointKey, verified.owner, app.id);
			const mainInspector = inspectPort ? await this.resolveVerifiedMainInspector(inspectPort, verified) : undefined;
			const session = this.createSession({
				endpointKey,
				browserEndpointKey,
				owner: verified.owner,
				appId: app.id,
				appRef,
				pid: verified.owner.pid,
				port,
				webSocketDebuggerUrl: version.webSocketDebuggerUrl,
				mainInspector,
				browser: version.Browser,
				launched: true,
				process: child,
				launchProcessIdentityKey,
			});
			await this.refreshWindows(session);
			child.once("exit", () => {
				void this.deleteSessionIfCdpExited(session.id, port);
			});
			return this.sessionStore.toSummary(session);
		} catch (error) {
			if (launchProcessIdentityKey) await this.terminateOwnedLaunchProcess(child, launchProcessIdentityKey);
			throw error;
		}
	}

	async attach(params: {
		appRef?: string;
		pid?: number;
		port?: number;
		inspectPort?: number;
	}): Promise<ElectronSessionSummary> {
		const requestedApp = params.appRef ? this.resolveApp(params.appRef) : undefined;
		if (params.appRef && !requestedApp) {
			throw new Error(`Unknown Electron app '${params.appRef}'. Run 'shuvgeist electron list' to see known apps.`);
		}
		const discoverySnapshot = await this.listElectronProcesses();
		let discoveredPid = params.pid;
		let port =
			params.port ?? (params.pid ? await discoverPortForPid(params.pid, async () => discoverySnapshot) : undefined);
		if (!port && requestedApp) {
			const discovered = await this.discoverEndpointForApp(requestedApp);
			port = discovered?.port;
			discoveredPid ??= discovered?.pid;
		}
		if (!port) {
			const target = params.pid ? `pid ${params.pid}` : params.appRef ? `'${params.appRef}'` : "the requested app";
			throw new Error(
				`No Electron CDP port found for ${target}; start the allowlisted app with --remote-debugging-port=<port> and attach with 'shuvgeist electron attach <app-id-or-alias> --pid <pid>'.`,
			);
		}
		const version = await waitForCdp(port, this.attachTimeoutMs);
		const browserEndpointKey = normalizeDebuggerEndpoint(version.webSocketDebuggerUrl, port);
		for (const stale of this.sessionStore.findByPort(port)) {
			if (stale.browserEndpointKey !== browserEndpointKey) this.discardSession(stale.id);
		}
		const verified = await this.verifyEndpointIdentity(port, requestedApp, discoveredPid);
		const endpointKey = compositeEndpointKey(browserEndpointKey, verified.owner, verified.app.id);
		for (const stale of this.sessionStore.findEndpointConflicts(endpointKey, port)) this.discardSession(stale.id);
		try {
			this.assertAllowed(verified.app.id);
		} catch (error) {
			const denied = this.sessionStore.findByEndpointKey(endpointKey);
			if (denied) this.discardSession(denied.id);
			throw error;
		}
		const mainInspector = params.inspectPort
			? await this.resolveVerifiedMainInspector(params.inspectPort, verified)
			: undefined;
		const existing = this.sessionStore.findByEndpointKey(endpointKey);
		if (existing) {
			existing.appId = verified.app.id;
			existing.appRef = params.appRef ?? existing.appRef ?? verified.app.id;
			existing.pid = verified.owner.pid;
			existing.owner = verified.owner;
			existing.browserEndpointKey = browserEndpointKey;
			existing.browser = version.Browser;
			existing.webSocketDebuggerUrl = version.webSocketDebuggerUrl;
			if (mainInspector) existing.mainInspector = mainInspector;
			try {
				await this.refreshWindows(existing);
			} catch (error) {
				this.discardSession(existing.id);
				throw error;
			}
			return this.sessionStore.toSummary(existing);
		}
		const session = this.createSession({
			endpointKey,
			browserEndpointKey,
			owner: verified.owner,
			appId: verified.app.id,
			appRef: params.appRef ?? verified.app.id,
			pid: verified.owner.pid,
			port,
			webSocketDebuggerUrl: version.webSocketDebuggerUrl,
			mainInspector,
			browser: version.Browser,
			launched: false,
		});
		try {
			await this.refreshWindows(session);
		} catch (error) {
			this.discardSession(session.id);
			throw error;
		}
		return this.sessionStore.toSummary(session);
	}

	detach(sessionId: string): boolean {
		const session = this.sessionStore.get(sessionId);
		if (!session) return false;
		this.discardSession(sessionId);
		if (
			session.launched &&
			session.process?.pid &&
			session.process.exitCode === null &&
			!session.process.killed &&
			session.launchProcessIdentityKey
		) {
			void this.terminateOwnedLaunchProcess(session.process, session.launchProcessIdentityKey);
		}
		return true;
	}

	resolveTarget(target: BridgeTarget): { session: ElectronSession; window: ElectronWindow } | undefined {
		if (target.kind !== "electron-window") return undefined;
		const session = this.resolveSession(target);
		if (!session) return undefined;
		const window = this.resolveTargetWindow(session, target);
		return window ? { session, window } : undefined;
	}

	private async resolveLiveTarget(
		target: BridgeTarget,
	): Promise<{ session: ElectronSession; window: ElectronWindow } | undefined> {
		if (target.kind !== "electron-window") return undefined;
		const session = this.resolveSession(target);
		if (!session) return undefined;
		await this.refreshWindows(session);
		const window = this.resolveTargetWindow(session, target);
		return window ? { session, window } : undefined;
	}

	async windows(target?: BridgeTarget): Promise<ElectronSessionSummary[]> {
		const sessions =
			target?.kind === "electron-window"
				? [this.resolveSession(target)].filter((session): session is ElectronSession => Boolean(session))
				: this.sessionStore.list();
		for (const session of sessions) await this.refreshWindows(session);
		return this.sessionStore.summaries(sessions);
	}

	async mainInfo(sessionId: string): Promise<ElectronMainInfoResult> {
		const session = this.sessionStore.get(sessionId);
		const client = await this.connectToMainInspector(session, "main_inspect");
		try {
			const response = await client.send<{ result?: { value?: ElectronMainInfoResult } }>("Runtime.evaluate", {
				expression: `(${ELECTRON_MAIN_INFO_SCRIPT})()`,
				awaitPromise: true,
				returnByValue: true,
			});
			if ("exceptionDetails" in response && response.exceptionDetails) {
				const details = response.exceptionDetails as { text?: string; exception?: { description?: string } };
				throw new Error(
					details.exception?.description ?? details.text ?? "Electron main inspector evaluation failed.",
				);
			}
			const value = response.result?.value;
			if (!value) throw new Error("Electron main inspector did not return metadata.");
			return value;
		} finally {
			client.close();
		}
	}

	async startIpcTap(sessionId: string, options: { channel?: string } = {}): Promise<ElectronIpcTap> {
		const session = this.sessionStore.get(sessionId);
		const client = await this.connectToMainInspector(session, "ipc_tap");
		const channel = options.channel?.trim() || undefined;
		try {
			await client.send("Runtime.evaluate", {
				expression: `(${ELECTRON_IPC_TAP_SCRIPT})(${JSON.stringify({ channel })})`,
				awaitPromise: true,
				returnByValue: true,
			});
			const tap: ElectronIpcTap = {
				id: `ipc-${Date.now()}`,
				channel,
				startedAt: new Date().toISOString(),
				active: true,
				warning:
					"IPC tap monkey-patches ipcMain.emit in the running app until stopped or the app restarts; crashes may leave the patch active.",
			};
			session?.ipcTaps.push(tap);
			return tap;
		} finally {
			client.close();
		}
	}

	async stopIpcTap(sessionId: string): Promise<{ ok: true; stopped: number; warning: string }> {
		const session = this.sessionStore.get(sessionId);
		const client = await this.connectToMainInspector(session, "ipc_tap");
		try {
			await client.send("Runtime.evaluate", {
				expression: `(${ELECTRON_IPC_UNTAP_SCRIPT})()`,
				awaitPromise: true,
				returnByValue: true,
			});
			const stopped = session?.ipcTaps.filter((tap) => tap.active).length ?? 0;
			for (const tap of session?.ipcTaps ?? []) tap.active = false;
			return {
				ok: true,
				stopped,
				warning: "IPC tap cleanup is best-effort; restart the app if it crashed while tapped.",
			};
		} finally {
			client.close();
		}
	}

	async startMainNetworkTap(sessionId: string): Promise<ElectronMainNetworkTap> {
		const session = this.sessionStore.get(sessionId);
		const client = await this.connectToMainInspector(session, "main_network_tap");
		try {
			await client.send("Runtime.evaluate", {
				expression: `(${ELECTRON_MAIN_NETWORK_TAP_SCRIPT})()`,
				awaitPromise: true,
				returnByValue: true,
			});
			const tap: ElectronMainNetworkTap = {
				id: `mainnet-${Date.now()}`,
				startedAt: new Date().toISOString(),
				active: true,
				source: "main",
			};
			session?.mainNetworkTaps.push(tap);
			return tap;
		} finally {
			client.close();
		}
	}

	async stopMainNetworkTap(sessionId: string): Promise<{ ok: true; stopped: number; source: "main" }> {
		const session = this.sessionStore.get(sessionId);
		const client = await this.connectToMainInspector(session, "main_network_tap");
		try {
			await client.send("Runtime.evaluate", {
				expression: `(${ELECTRON_MAIN_NETWORK_UNTAP_SCRIPT})()`,
				awaitPromise: true,
				returnByValue: true,
			});
			const stopped = session?.mainNetworkTaps.filter((tap) => tap.active).length ?? 0;
			for (const tap of session?.mainNetworkTaps ?? []) tap.active = false;
			return { ok: true, stopped, source: "main" };
		} finally {
			client.close();
		}
	}

	async labelWindow(sessionId: string, windowRef: string, label: string): Promise<ElectronWindow> {
		const session = this.sessionStore.get(sessionId);
		if (!session) throw new Error(`No Electron session attached for '${sessionId}'.`);
		await this.refreshWindows(session);
		const normalized = label.trim();
		if (!normalized) throw new Error("Window label must not be empty.");
		const window = this.resolveWindow(session, windowRef);
		if (!window) throw new Error(`No Electron window '${windowRef}' exists in session '${sessionId}'.`);
		const duplicate = session.windows.find(
			(candidate) => candidate.ref !== window.ref && candidate.label?.toLowerCase() === normalized.toLowerCase(),
		);
		if (duplicate)
			throw new Error(`Electron window label '${normalized}' is already used in session '${sessionId}'.`);
		window.label = normalized;
		return window;
	}

	private resolveSession(target: BridgeTarget): ElectronSession | undefined {
		return this.sessionStore.resolveTargetSession(target);
	}

	private resolveWindow(session: ElectronSession, windowRef?: string): ElectronWindow | undefined {
		if (!windowRef) return undefined;
		return session.windows.find(
			(window) =>
				!window.closed && (window.ref === windowRef || window.label === windowRef || window.targetId === windowRef),
		);
	}

	private resolveTargetWindow(
		session: ElectronSession,
		target: Extract<BridgeTarget, { kind: "electron-window" }>,
	): ElectronWindow | undefined {
		const byWindowRef = target.windowRef ? this.resolveWindow(session, target.windowRef) : undefined;
		const byTargetId = target.targetId
			? session.windows.find((window) => !window.closed && window.targetId === target.targetId)
			: undefined;
		if (target.windowRef && !byWindowRef) return undefined;
		if (target.targetId && !byTargetId) return undefined;
		if (byWindowRef && byTargetId && byWindowRef !== byTargetId) return undefined;
		return (
			byWindowRef ??
			byTargetId ??
			session.windows.find((candidate) => candidate.isPrimary && !candidate.closed) ??
			session.windows.find((candidate) => !candidate.closed)
		);
	}

	async evaluate(
		target: BridgeTarget,
		code: string,
		frameId?: number,
	): Promise<{ output: string; result: unknown; skillsSnapshot?: ReturnType<typeof readSkillSnapshot>["status"] }> {
		this.assertElectronTopFrame(target, frameId, "renderer eval");
		const resolved = await this.resolveLiveTarget(target);
		if (!resolved) throw noSessionError(target);
		this.assertPageWindow(resolved.window);
		this.assertCapabilityAllowed(resolved.session, "eval");
		const state = await this.pageDriverFor(resolved);
		const { snapshot, status } = readSkillSnapshot(this.configOwner);
		const matchingSkills = snapshot
			? matchSnapshotSkillsForApp(snapshot, [
					resolved.session.appId,
					resolved.session.appRef,
					target.kind === "electron-window" ? target.appRef : undefined,
				])
			: [];
		const skillLibrary =
			matchingSkills.length > 0 ? `${matchingSkills.map((skill) => skill.library).join("\n\n")}\n\n` : "";
		const evaluated = await state.driver.evaluate({
			expression: skillLibrary + code,
			awaitPromise: true,
			returnByValue: true,
		});
		const value = evaluated.value ?? evaluated.description ?? null;
		return {
			output: typeof value === "string" ? value : (JSON.stringify(value) ?? "null"),
			result: value,
			skillsSnapshot:
				matchingSkills.length > 0 || status.state === "stale" || status.state === "invalid" ? status : undefined,
		};
	}

	async screenshot(target: BridgeTarget, maxWidth?: number, frameId?: number): Promise<BridgeScreenshotResult> {
		const { state } = await this.resolvePageRuntime(target, frameId, "screenshot");
		return captureElectronWindowScreenshot(state.cdp, maxWidth);
	}

	async assert(target: BridgeTarget, params: PageAssertParams): Promise<PageAssertResult> {
		// Expression assertions run arbitrary renderer JS, same reach as evaluate().
		const { state, pageTarget } = await this.resolvePageRuntime(
			target,
			params.frameId,
			"page assertion",
			params.kind === "expression" ? "eval" : undefined,
		);
		if (params.world === "main") {
			throw new Error("Electron assertions do not support --world main; use renderer/user-world assertions.");
		}
		return assertElectronWindow(state.cdp, params, {
			target: pageTarget,
			navigationGeneration: state.driver.scope.navigationGeneration,
		});
	}

	async networkStart(target: BridgeTarget, params: NetworkStartParams): Promise<BridgeCommandResult<"network_start">> {
		const { state, pageTarget } = await this.resolvePageRuntime(target, undefined, "network capture");
		const result = await state.driver.network.start({
			maxEntries: params.maxEntries,
			maxBodyBytes: params.maxBodyBytes,
		});
		return pageDriverNetworkStatsToWire(result, pageTarget);
	}

	async networkStop(target: BridgeTarget): Promise<BridgeCommandResult<"network_stop">> {
		const { state, pageTarget } = await this.resolvePageRuntime(target);
		return pageDriverNetworkStatsToWire(await state.driver.network.stop(), pageTarget);
	}

	async networkList(target: BridgeTarget, params: NetworkListParams): Promise<BridgeCommandResult<"network_list">> {
		const { state, pageTarget } = await this.resolvePageRuntime(target, undefined, "network list");
		return pageDriverNetworkListToWire(state.driver.network.list(params), pageTarget);
	}

	async networkClear(target: BridgeTarget): Promise<BridgeCommandResult<"network_clear">> {
		const { state, pageTarget } = await this.resolvePageRuntime(target);
		return pageDriverNetworkStatsToWire(state.driver.network.clear(), pageTarget);
	}

	async networkStats(target: BridgeTarget): Promise<BridgeCommandResult<"network_stats">> {
		const { state, pageTarget } = await this.resolvePageRuntime(target);
		return pageDriverNetworkStatsToWire(state.driver.network.stats(), pageTarget);
	}

	async networkGet(target: BridgeTarget, params: NetworkItemParams): Promise<BridgeCommandResult<"network_get">> {
		const { state, pageTarget } = await this.resolvePageRuntime(target, undefined, "network request lookup");
		return pageDriverNetworkGetToWire(state.driver.network.get(params.requestId), pageTarget);
	}

	async networkBody(target: BridgeTarget, params: NetworkItemParams): Promise<BridgeCommandResult<"network_body">> {
		const { state, pageTarget } = await this.resolvePageRuntime(target, undefined, "network body lookup");
		return pageDriverNetworkBodyToWire(state.driver.network.body(params.requestId), pageTarget);
	}

	async networkCurl(target: BridgeTarget, params: NetworkCurlParams): Promise<BridgeCommandResult<"network_curl">> {
		const { state, pageTarget } = await this.resolvePageRuntime(target, undefined, "network curl export");
		return pageDriverNetworkCurlToWire(
			state.driver.network.toCurl(params.requestId, { redactSensitiveHeaders: params.includeSensitive !== true }),
			pageTarget,
		);
	}

	async perfMetrics(
		target: BridgeTarget,
		_params: PerfMetricsParams = {},
	): Promise<BridgeCommandResult<"perf_metrics">> {
		const { state, pageTarget } = await this.resolvePageRuntime(target, undefined, "performance metrics");
		await state.cdp.ensureDomain("Performance");
		const response = await state.cdp.send<{ metrics?: Array<{ name?: string; value?: number }> }>(
			"Performance.getMetrics",
		);
		return {
			...pageDriverScopeToWire(state.driver.scope, pageTarget),
			metrics: (response.metrics ?? [])
				.filter(
					(metric): metric is { name: string; value: number } =>
						typeof metric.name === "string" && typeof metric.value === "number",
				)
				.map((metric) => ({ name: metric.name, value: metric.value })),
		};
	}

	async snapshot(
		target: BridgeTarget,
		options: { frameId?: number; maxEntries?: number; includeHidden?: boolean; query?: string },
	): Promise<PageSnapshotBridgeResult> {
		const { state, pageTarget } = await this.resolvePageRuntime(target, options.frameId, "page snapshot");
		const result = await state.driver.snapshot(options);
		return pageDriverSnapshotToWire(result, pageTarget, { query: options.query });
	}

	async locateByRole(target: BridgeTarget, params: LocateByRoleParams): Promise<SnapshotLocatorMatchResult[]> {
		const snapshot = await this.snapshot(target, { frameId: params.frameId, maxEntries: params.limit ?? 120 });
		return this.locate(snapshot, { kind: "role", value: params.role, name: params.name }, params);
	}

	async locateByText(target: BridgeTarget, params: LocateByTextParams): Promise<SnapshotLocatorMatchResult[]> {
		const snapshot = await this.snapshot(target, { frameId: params.frameId, maxEntries: params.limit ?? 120 });
		return this.locate(snapshot, { kind: "text", value: params.text }, params);
	}

	async locateByLabel(target: BridgeTarget, params: LocateByLabelParams): Promise<SnapshotLocatorMatchResult[]> {
		const snapshot = await this.snapshot(target, { frameId: params.frameId, maxEntries: params.limit ?? 120 });
		return this.locate(snapshot, { kind: "label", value: params.label }, params);
	}

	async refClick(target: BridgeTarget, params: RefClickParams): Promise<RefActionResult> {
		this.assertElectronRefInputMode(params);
		const { state, pageTarget } = await this.resolvePageRuntime(target, params.frameId, "reference click");
		const result = await state.driver.actOnRef({
			refId: params.refId,
			action: { kind: "click", mode: params.trusted ? "cdp-trusted" : "dom" },
		});
		if (result.ok && typeof params.waitMs === "number" && params.waitMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, params.waitMs));
		}
		return pageDriverRefActionToWire(result, pageTarget);
	}

	async refFill(target: BridgeTarget, params: RefFillParams): Promise<RefActionResult> {
		this.assertElectronRefInputMode(params);
		const { state, pageTarget } = await this.resolvePageRuntime(target, params.frameId, "reference fill");
		return pageDriverRefActionToWire(
			await state.driver.actOnRef({
				refId: params.refId,
				action: { kind: "fill", mode: params.trusted ? "cdp-trusted" : "dom", value: params.value },
			}),
			pageTarget,
		);
	}

	async recordStart(
		target: BridgeTarget,
		params: RecordStartParams,
		emit: (event: RecordFrameEventData) => void,
	): Promise<RecordStartResult> {
		const { state, pageTarget } = await this.resolvePageRuntime(target, params.frameId, "recording");
		const started = await state.driver.screencast.start(params, {
			onFrame: (frame) => emit(this.recordFrameToWire(frame, pageTarget)),
			onComplete: (summary) => {
				emit({
					...this.recordFrameToWire(
						{
							scope: summary.scope,
							recordingId: summary.recordingId,
							seq: summary.frameCount,
							format: "jpeg",
							dataBase64: "",
							capturedAtMs: Date.parse(summary.endedAt),
						},
						pageTarget,
					),
					final: true,
					summary: this.recordSummaryToWire(summary, pageTarget),
				});
			},
		});
		return {
			...pageDriverScopeToWire(started.scope, pageTarget),
			ok: true,
			recordingId: started.recordingId,
			startedAt: started.startedAt,
			mimeType: started.mimeType,
			...(started.videoBitsPerSecond !== undefined ? { videoBitsPerSecond: started.videoBitsPerSecond } : {}),
			maxDurationMs: started.maxDurationMs,
		};
	}

	async recordStop(target: BridgeTarget, frameId?: number): Promise<RecordStopResult> {
		const { state, pageTarget } = await this.resolvePageRuntime(target, frameId, "recording stop");
		return this.recordSummaryToWire(await state.driver.screencast.stop(), pageTarget);
	}

	async recordStatus(target: BridgeTarget, frameId?: number): Promise<RecordStatusResult> {
		const { state, pageTarget } = await this.resolvePageRuntime(target, frameId, "recording status");
		return this.recordStatusToWire(state.driver.screencast.status(), pageTarget);
	}

	private createSession(
		session: Omit<
			ElectronSession,
			"id" | "startedAt" | "nextWindowNumber" | "windows" | "ipcTaps" | "mainNetworkTaps"
		>,
	): ElectronSession {
		return this.sessionStore.create(session);
	}

	private assertAllowed(appId: string): void {
		const config = normalizeElectronConfig(this.configOwner.readBridgeConfig());
		if (!config.allowlist.includes(appId)) {
			throw new Error(`Electron app '${appId}' is not allowlisted; run 'shuvgeist electron allow ${appId}' first.`);
		}
	}

	private defaultFlagsFor(appId: string): string[] {
		return normalizeElectronConfig(this.configOwner.readBridgeConfig()).defaultFlags[appId] ?? [];
	}

	private resolveApp(appRef: string): ElectronApp | undefined {
		const normalized = appRef.trim().toLowerCase();
		return this.apps.find(
			(app) =>
				app.id.toLowerCase() === normalized || app.aliases.some((alias) => alias.toLowerCase() === normalized),
		);
	}

	private async discoverEndpointForApp(app: ElectronApp): Promise<{ pid: number; port: number } | undefined> {
		const processes = await this.listElectronProcesses();
		for (const processRow of processes) {
			if (!processMatchesElectronApp(processRow, app)) continue;
			const port = remoteDebuggingPortForProcess(processRow);
			if (port) return { pid: processRow.pid, port };
		}
		return undefined;
	}

	private async verifyEndpointIdentity(
		port: number,
		requestedApp: ElectronApp | undefined,
		requestedPid: number | undefined,
	): Promise<VerifiedElectronEndpoint> {
		const listeningPids = await this.listeningPidsForPort(port);
		if (!listeningPids) {
			throw new Error(
				`Cannot verify which process owns Electron CDP port ${port} on this system. Endpoint access is denied; install the platform process/listener tooling and attach with 'shuvgeist electron attach <app-id-or-alias> --pid <pid>'.`,
			);
		}
		if (listeningPids.length === 0) {
			throw new Error(`Cannot verify a listening process for Electron CDP port ${port}; refusing to attach.`);
		}
		const processes = await this.listElectronProcesses();
		const owners = processes.filter((process) => listeningPids.includes(process.pid));
		const ownerMatches = matchElectronAppsForProcesses(owners, this.apps);
		let app = requestedApp;
		let requestedRootKey: string | undefined;
		let requestedRoot: ElectronProcessRow | undefined;
		if (requestedPid) {
			const requestedProcess = processes.find((candidate) => candidate.pid === requestedPid);
			if (!requestedProcess) throw new Error(`Electron process PID ${requestedPid} no longer exists.`);
			const requestedMatches = matchElectronAppsForProcesses([requestedProcess], app ? [app] : this.apps);
			const requestedAppIds = new Set(requestedMatches.map((match) => match.app.id));
			if (requestedAppIds.size !== 1) {
				throw new Error(
					`PID ${requestedPid} does not canonically identify ${app ? `'${app.id}'` : "exactly one known Electron app"}; refusing to trust command names or aliases.`,
				);
			}
			app ??= requestedMatches[0]?.app;
			if (!app) throw new Error(`Could not resolve Electron app identity for PID ${requestedPid}.`);
			requestedRoot = processFamilyRoot(requestedProcess, processes, app);
			requestedRootKey = requestedRoot ? processIdentityKey(requestedRoot) : undefined;
			if (!requestedRoot || !requestedRootKey) {
				throw new Error(
					`Cannot verify the process ancestry, generation, and executable identity for Electron PID ${requestedPid}; refusing to attach.`,
				);
			}
		}
		const candidateMatches = ownerMatches.filter((match) => !app || match.app.id === app.id);
		const familyCandidates = candidateMatches.flatMap((match) => {
			const root = processFamilyRoot(match.process, processes, match.app);
			const rootKey = root ? processIdentityKey(root) : undefined;
			if (!root || !rootKey || (requestedRootKey && rootKey !== requestedRootKey)) return [];
			return [{ app: match.app, root, rootKey }];
		});
		const families = new Map<string, (typeof familyCandidates)[number]>();
		for (const candidate of familyCandidates) families.set(`${candidate.app.id}:${candidate.rootKey}`, candidate);
		if (!requestedRoot && families.size !== 1) {
			const reason = families.size === 0 ? "unknown" : "ambiguous";
			throw new Error(
				`Electron app identity for CDP port ${port} is ${reason}. Raw --port/--pid attaches are denied; use 'shuvgeist electron attach <app-id-or-alias> --pid <pid>' for a known allowlisted app.`,
			);
		}
		const family =
			requestedRoot && requestedRootKey && app
				? { app, root: requestedRoot, rootKey: requestedRootKey }
				: families.values().next().value;
		if (!family) throw new Error(`Could not resolve Electron app identity for CDP port ${port}.`);
		if (requestedApp && family.app.id !== requestedApp.id) {
			throw new Error(
				`Electron CDP port ${port} is not owned by '${requestedApp.id}'; refusing to trust the supplied app identity.`,
			);
		}
		const uniqueListeningPids = Array.from(new Set(listeningPids));
		const processByPid = new Map(processes.map((processRow) => [processRow.pid, processRow]));
		const allListenersBelongToFamily = uniqueListeningPids.every((listenerPid) => {
			const listener = processByPid.get(listenerPid);
			return listener ? processIsInFamily(listener, family.root, processes) : false;
		});
		if (!allListenersBelongToFamily) {
			throw new Error(
				`Electron CDP port ${port} has mixed or unverifiable listener owners; every listener must belong to the verified '${family.app.id}' process family.`,
			);
		}
		const executablePath = family.root.executablePath
			? canonicalExecutablePath(family.root.executablePath)
			: undefined;
		if (!family.root.generation || !executablePath) {
			throw new Error(`Cannot verify canonical executable and process generation for Electron CDP port ${port}.`);
		}
		const familyKey = `${family.app.id}:${family.rootKey}:${executablePath}`;
		return {
			app: family.app,
			owner: {
				pid: family.root.pid,
				parentPid: family.root.parentPid,
				generation: family.root.generation,
				executablePath,
				familyKey,
			},
		};
	}

	private discardSession(sessionId: string): void {
		this.sessionStore.delete(sessionId);
		this.disposePageDriversForSession(sessionId);
	}

	private async choosePort(startAt?: number): Promise<number> {
		const [start, end] = normalizeElectronConfig(this.configOwner.readBridgeConfig()).portRange;
		for (let port = startAt ?? start; port <= end; port++) {
			if (await isPortAvailable(port)) return port;
		}
		throw new Error(`No available Electron CDP port in configured range ${start}-${end}.`);
	}

	private async resolveVerifiedMainInspector(
		port: number,
		browserEndpoint: VerifiedElectronEndpoint,
	): Promise<ElectronSession["mainInspector"]> {
		const inspectorEndpoint = await this.verifyEndpointIdentity(port, browserEndpoint.app, undefined);
		if (inspectorEndpoint.owner.familyKey !== browserEndpoint.owner.familyKey) {
			throw new Error(
				`Electron main inspector port ${port} is not owned by the same '${browserEndpoint.app.id}' process family as CDP port; refusing cross-process inspector access.`,
			);
		}
		const version = await resolveInspectorEndpoint(port, 3000);
		return {
			port,
			webSocketDebuggerUrl: version.webSocketDebuggerUrl,
			available: Boolean(version.webSocketDebuggerUrl),
			browser: version.Browser,
			ownerKey: inspectorEndpoint.owner.familyKey,
		};
	}

	private async revalidateSession(session: ElectronSession): Promise<CdpVersionResponse> {
		try {
			const app = session.appId
				? this.resolveApp(session.appId)
				: session.appRef
					? this.resolveApp(session.appRef)
					: undefined;
			if (!app) throw new Error("the registered app identity no longer exists");
			this.assertAllowed(app.id);
			const verified = await this.verifyEndpointIdentity(session.port, app, session.owner.pid);
			const version = await readCdpVersion(session.port);
			const browserEndpointKey = normalizeDebuggerEndpoint(version.webSocketDebuggerUrl, session.port);
			const endpointKey = compositeEndpointKey(browserEndpointKey, verified.owner, app.id);
			if (endpointKey !== session.endpointKey) {
				throw new Error("the listener process generation or browser endpoint changed");
			}
			session.owner = verified.owner;
			session.pid = verified.owner.pid;
			session.browser = version.Browser ?? session.browser;
			session.browserEndpointKey = browserEndpointKey;
			session.webSocketDebuggerUrl = version.webSocketDebuggerUrl;
			return version;
		} catch (error) {
			this.discardSession(session.id);
			if (error instanceof NodeConfigError) {
				throw new NodeConfigError(
					error.code,
					error.path,
					`Electron session '${session.id}' failed ownership revalidation and was detached: ${error.message}`,
					error,
				);
			}
			throw new Error(
				`Electron session '${session.id}' failed ownership revalidation and was detached: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async revalidateMainInspector(session: ElectronSession): Promise<void> {
		const inspector = session.mainInspector;
		if (!inspector?.available || !inspector.webSocketDebuggerUrl || !inspector.ownerKey) {
			throw new Error(
				`No main-process inspector attached for '${session.id}'. Launch with --inspect-main or attach with --inspect-port <port>.`,
			);
		}
		const app = session.appId ? this.resolveApp(session.appId) : undefined;
		if (!app) throw new Error(`Electron session '${session.id}' has no registered app identity.`);
		try {
			const verified = await this.verifyEndpointIdentity(inspector.port, app, undefined);
			if (verified.owner.familyKey !== session.owner.familyKey || verified.owner.familyKey !== inspector.ownerKey) {
				throw new Error("the inspector listener belongs to a different process family");
			}
		} catch (error) {
			this.discardSession(session.id);
			throw new Error(
				`Electron session '${session.id}' main inspector failed ownership revalidation and was detached: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async terminateOwnedLaunchProcess(
		child: NonNullable<ElectronSession["process"]>,
		launchProcessIdentityKey: string | undefined,
	): Promise<void> {
		if (!launchProcessIdentityKey || !child.pid || child.exitCode !== null || child.killed) return;
		const processRow = (await this.listElectronProcesses()).find((candidate) => candidate.pid === child.pid);
		if (!processRow || processTerminationIdentityKey(processRow) !== launchProcessIdentityKey) return;
		child.kill("SIGTERM");
	}

	private async deleteSessionIfCdpExited(sessionId: string, port: number): Promise<void> {
		if (await shouldDeleteSessionAfterChildExit(port)) {
			this.discardSession(sessionId);
		}
	}

	private async connectToMainInspector(
		session: ElectronSession | undefined,
		capability: "main_inspect" | "ipc_tap" | "main_network_tap",
	): Promise<ElectronWsCdpSession> {
		if (!session) throw new Error("No Electron session attached for the requested session.");
		const app = session.appRef
			? this.resolveApp(session.appRef)
			: session.appId
				? this.resolveApp(session.appId)
				: undefined;
		if (app && !app.mainInspectSupported) {
			throw new Error(
				`Electron app '${session.appRef ?? session.appId}' does not support main-process inspector commands.`,
			);
		}
		this.assertCapabilityAllowed(session, capability);
		await this.revalidateSession(session);
		await this.revalidateMainInspector(session);
		if (!session.mainInspector?.webSocketDebuggerUrl)
			throw new Error("Electron main inspector endpoint is unavailable.");
		return ElectronWsCdpSession.connect(session.mainInspector.webSocketDebuggerUrl, session.id + ":main");
	}

	private assertCapabilityAllowed(
		session: ElectronSession,
		capability: "eval" | "cookies" | "main_inspect" | "ipc_tap" | "main_network_tap" | "cdp_input",
	): void {
		const appId = session.appId ?? session.appRef;
		if (!appId) {
			throw new Error(
				`Electron capability '${capability}' requires a verified app identity; detach and reattach with 'shuvgeist electron attach <app-id-or-alias> --pid <pid>'.`,
			);
		}
		const config = normalizeElectronConfig(this.configOwner.readBridgeConfig());
		const appCapabilities = config.capabilities[appId] ?? {};
		if (capability === "cdp_input" ? appCapabilities.cdp_input !== true : appCapabilities[capability] === false) {
			throw new Error(`Electron capability '${capability}' is disabled for app '${appId}' in bridge config.`);
		}
	}

	private async resolvePageRuntime(
		target: BridgeTarget,
		frameId?: number,
		operation = "page command",
		capability?: Parameters<ElectronSessionManager["assertCapabilityAllowed"]>[1],
	): Promise<{
		resolved: { session: ElectronSession; window: ElectronWindow };
		state: ElectronPageDriverState;
		pageTarget: Extract<ResolvedPageTarget, { kind: "electron-window" }>;
	}> {
		this.assertElectronTopFrame(target, frameId, operation);
		const resolved = await this.resolveLiveTarget(target);
		if (!resolved) throw noSessionError(target);
		this.assertPageWindow(resolved.window);
		if (capability) this.assertCapabilityAllowed(resolved.session, capability);
		const pageTarget = this.resolvedElectronTarget(resolved);
		const state = await this.pageDriverFor(resolved);
		return { resolved, state, pageTarget };
	}

	private resolvedElectronTarget(resolved: {
		session: ElectronSession;
		window: ElectronWindow;
	}): Extract<ResolvedPageTarget, { kind: "electron-window" }> {
		return {
			kind: "electron-window",
			sessionId: resolved.session.id,
			windowRef: resolved.window.ref,
			targetId: resolved.window.targetId,
		};
	}

	private async pageDriverFor(resolved: {
		session: ElectronSession;
		window: ElectronWindow;
	}): Promise<ElectronPageDriverState> {
		this.assertPageWindow(resolved.window);
		const key = electronPageDriverKey(resolved.session.id, resolved.window.ref, resolved.window.targetId);
		const existing = this.pageDrivers.get(key);
		if (
			existing &&
			!existing.disposed &&
			existing.endpointKey === resolved.session.endpointKey &&
			existing.webSocketDebuggerUrl === resolved.window.webSocketDebuggerUrl
		) {
			return existing.state;
		}
		if (existing) void this.disposePageDriverEntry(existing);

		let entry!: ElectronPageDriverCacheEntry;
		entry = {
			key,
			sessionId: resolved.session.id,
			windowRef: resolved.window.ref,
			targetId: resolved.window.targetId,
			endpointKey: resolved.session.endpointKey,
			webSocketDebuggerUrl: resolved.window.webSocketDebuggerUrl,
			disposed: false,
			state: Promise.resolve().then(() => this.createPageDriverState(entry)),
		};
		this.pageDrivers.set(key, entry);
		try {
			return await entry.state;
		} catch (error) {
			if (this.pageDrivers.get(key) === entry) this.pageDrivers.delete(key);
			throw error;
		}
	}

	private async createPageDriverState(entry: ElectronPageDriverCacheEntry): Promise<ElectronPageDriverState> {
		const cdp = await this.connectPage(entry.webSocketDebuggerUrl, entry.targetId);
		let driver: PageDriver | undefined;
		try {
			driver = createWebSocketCdpPageDriver({
				sessionId: entry.sessionId,
				windowId: entry.windowRef,
				pageId: entry.targetId,
				cdp,
				buildSnapshotExpression: buildElectronSnapshotExpression,
				authorizeCdpInput: (scope) => this.authorizeCdpInput(scope, entry),
			});
			await driver.ready;
		} catch (error) {
			cdp.close();
			await driver?.dispose().catch(() => undefined);
			throw error;
		}
		if (!driver) throw new Error(`Electron page driver '${entry.targetId}' did not initialize`);
		const state: ElectronPageDriverState = {
			driver,
			cdp,
			removeCloseListener: () => {},
		};
		state.removeCloseListener = cdp.onClose(() => this.handlePageDriverTransportClose(entry, state));
		if (entry.disposed || this.pageDrivers.get(entry.key) !== entry) {
			await this.disposePageDriverState(state);
			throw new Error(`Electron page target '${entry.targetId}' was detached while connecting`);
		}
		return state;
	}

	private async authorizeCdpInput(scope: PageDriverScope, entry: ElectronPageDriverCacheEntry): Promise<boolean> {
		if (
			entry.disposed ||
			scope.page.transport !== "websocket-cdp" ||
			scope.page.sessionId !== entry.sessionId ||
			scope.page.windowId !== entry.windowRef ||
			scope.page.pageId !== entry.targetId
		) {
			return false;
		}
		const session = this.sessionStore.get(entry.sessionId);
		if (!session || session.endpointKey !== entry.endpointKey) return false;
		try {
			const resolved = await this.resolveLiveTarget({
				kind: "electron-window",
				sessionId: entry.sessionId,
				windowRef: entry.windowRef,
				targetId: entry.targetId,
			});
			if (
				!resolved ||
				resolved.session.id !== entry.sessionId ||
				resolved.session.endpointKey !== entry.endpointKey ||
				resolved.window.ref !== entry.windowRef ||
				resolved.window.targetId !== entry.targetId ||
				resolved.window.type !== "page" ||
				resolved.window.webSocketDebuggerUrl !== entry.webSocketDebuggerUrl ||
				entry.disposed
			) {
				return false;
			}
			this.assertCapabilityAllowed(resolved.session, "cdp_input");
			return true;
		} catch {
			return false;
		}
	}

	private handlePageDriverTransportClose(entry: ElectronPageDriverCacheEntry, state: ElectronPageDriverState): void {
		if (this.pageDrivers.get(entry.key) === entry) this.pageDrivers.delete(entry.key);
		entry.disposed = true;
		state.removeCloseListener();
		if (!entry.disposePromise) {
			// Let the shared engines observe the transport-close event before disposal
			// asks them to stop, preserving the more precise target-closed outcome.
			entry.disposePromise = this.trackPageDriverDisposal(
				Promise.resolve()
					.then(() => state.driver.dispose())
					.catch(() => undefined),
			);
		}
	}

	private disposePageDriverEntry(entry: ElectronPageDriverCacheEntry): Promise<void> {
		if (this.pageDrivers.get(entry.key) === entry) this.pageDrivers.delete(entry.key);
		entry.disposed = true;
		if (!entry.disposePromise) {
			entry.disposePromise = this.trackPageDriverDisposal(
				entry.state.then((state) => this.disposePageDriverState(state)).catch(() => undefined),
			);
		}
		return entry.disposePromise;
	}

	private trackPageDriverDisposal(disposal: Promise<void>): Promise<void> {
		this.pendingPageDriverDisposals.add(disposal);
		void disposal.finally(() => this.pendingPageDriverDisposals.delete(disposal));
		return disposal;
	}

	private async disposePageDriverState(state: ElectronPageDriverState): Promise<void> {
		state.removeCloseListener();
		state.cdp.close();
		await state.driver.dispose().catch(() => undefined);
	}

	private disposePageDriversForSession(sessionId: string): void {
		for (const entry of this.pageDrivers.values()) {
			if (entry.sessionId === sessionId) void this.disposePageDriverEntry(entry);
		}
	}

	private disposePageDriversForWindow(sessionId: string, windowRef: string): void {
		for (const entry of this.pageDrivers.values()) {
			if (entry.sessionId === sessionId && entry.windowRef === windowRef) {
				void this.disposePageDriverEntry(entry);
			}
		}
	}

	private assertElectronRefInputMode(params: { native?: boolean; trusted?: boolean }): void {
		if (params.native && params.trusted) {
			throw new Error("Electron ref actions cannot combine --native with --trusted/--cdp-input.");
		}
		if (params.native) {
			throw new Error(
				"Electron --native requests OS-level input, which is unsupported. Use --trusted/--cdp-input for CDP trusted input after enabling the app's cdp_input capability.",
			);
		}
	}

	private assertPageWindow(window: ElectronWindow): void {
		if (window.type !== "page") {
			throw new Error(
				`Electron target '${window.targetId}' has CDP type '${window.type}', but renderer page commands require a 'page' target.`,
			);
		}
	}

	private assertElectronTopFrame(target: BridgeTarget, paramsFrameId: number | undefined, operation: string): void {
		const targetFrameId =
			target.kind === "electron-window"
				? (target as Extract<BridgeTarget, { kind: "electron-window" }> & { frameId?: number }).frameId
				: undefined;
		for (const frameId of [targetFrameId, paramsFrameId]) {
			if (frameId === undefined || frameId === 0) continue;
			throw new Error(
				`Electron ${operation} supports only the top frame (frameId 0); received frameId ${String(frameId)}.`,
			);
		}
	}

	private recordFrameToWire(
		frame: PageScreencastFrame,
		target: Extract<ResolvedPageTarget, { kind: "electron-window" }>,
	): RecordFrameEventData {
		return {
			...pageDriverScopeToWire(frame.scope, target),
			recordingId: frame.recordingId,
			seq: frame.seq,
			format: frame.format,
			dataBase64: frame.dataBase64,
			capturedAtMs: frame.capturedAtMs,
			...(frame.metadata ? { metadata: { ...frame.metadata } } : {}),
		};
	}

	private recordSummaryToWire(
		summary: PageScreencastSummary,
		target: Extract<ResolvedPageTarget, { kind: "electron-window" }>,
	): RecordStopResult {
		return {
			...pageDriverScopeToWire(summary.scope, target),
			ok: true,
			recordingId: summary.recordingId,
			startedAt: summary.startedAt,
			endedAt: summary.endedAt,
			durationMs: summary.durationMs,
			mimeType: summary.mimeType,
			sourceBytes: summary.sourceBytes,
			frameCount: summary.frameCount,
			outcome: screencastOutcome(summary.reason),
			...(summary.lastError ? { lastError: summary.lastError } : {}),
		};
	}

	private recordStatusToWire(
		status: PageScreencastStatus,
		target: Extract<ResolvedPageTarget, { kind: "electron-window" }>,
	): RecordStatusResult {
		const scope = pageDriverScopeToWire(status.scope, target);
		if (!status.active) return { ...scope, active: false };
		return {
			...scope,
			active: true,
			recordingId: status.recordingId,
			startedAt: status.startedAt,
			mimeType: status.mimeType,
			durationMs: status.durationMs,
			sourceBytes: status.sourceBytes,
			frameCount: status.frameCount,
			fps: status.fps,
			...(status.lastError ? { lastError: status.lastError } : {}),
		};
	}

	private async statusForSession(session: ElectronSession): Promise<ElectronSessionStatusSummary> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.livenessTimeoutMs);
		const livenessCheckedAt = new Date().toISOString();
		try {
			const app = session.appId
				? this.resolveApp(session.appId)
				: session.appRef
					? this.resolveApp(session.appRef)
					: undefined;
			if (!app) throw new Error("registered Electron app identity is unavailable");
			this.assertAllowed(app.id);
			const verified = await raceWithAbort(
				this.verifyEndpointIdentity(session.port, app, session.owner.pid),
				controller.signal,
			);
			const version = await readCdpVersion(session.port, controller.signal);
			const browserEndpointKey = normalizeDebuggerEndpoint(version.webSocketDebuggerUrl, session.port);
			if (compositeEndpointKey(browserEndpointKey, verified.owner, app.id) !== session.endpointKey) {
				this.disposePageDriversForSession(session.id);
				return {
					...this.sessionStore.toSummary(session),
					live: false,
					livePageTargetCount: 0,
					livenessCheckedAt,
					livenessReason: "endpoint_changed",
				};
			}
			const targets = await listCdpTargets(session.port, controller.signal);
			const verifiedAfterTargets = await raceWithAbort(
				this.verifyEndpointIdentity(session.port, app, session.owner.pid),
				controller.signal,
			);
			if (compositeEndpointKey(browserEndpointKey, verifiedAfterTargets.owner, app.id) !== session.endpointKey) {
				this.disposePageDriversForSession(session.id);
				return {
					...this.sessionStore.toSummary(session),
					live: false,
					livePageTargetCount: 0,
					livenessCheckedAt,
					livenessReason: "endpoint_changed",
				};
			}
			this.updateWindowsFromTargets(session, targets);
			session.browser = version.Browser ?? session.browser;
			const livePageTargetCount = targets.filter((target) => target.type === "page").length;
			return {
				...this.sessionStore.toSummary(session),
				live: livePageTargetCount > 0,
				livePageTargetCount,
				livenessCheckedAt,
				livenessReason: livePageTargetCount > 0 ? "ok" : "no_page_targets",
			};
		} catch {
			this.disposePageDriversForSession(session.id);
			return {
				...this.sessionStore.toSummary(session),
				live: false,
				livePageTargetCount: 0,
				livenessCheckedAt,
				livenessReason: "cdp_unreachable",
			};
		} finally {
			clearTimeout(timeout);
		}
	}

	private async refreshWindows(session: ElectronSession): Promise<void> {
		await this.revalidateSession(session);
		const targets = await listCdpTargets(session.port);
		await this.revalidateSession(session);
		this.updateWindowsFromTargets(session, targets);
	}

	private updateWindowsFromTargets(session: ElectronSession, targets: CdpTargetListEntry[]): void {
		const activeTargetIds = new Set(targets.map((target) => target.id));
		const primaryTargetId = targets.find((target) => target.type === "page")?.id;
		for (const existing of session.windows) {
			existing.closed = !activeTargetIds.has(existing.targetId);
			existing.isPrimary = !existing.closed && existing.targetId === primaryTargetId;
			if (existing.closed) this.disposePageDriversForWindow(session.id, existing.ref);
		}
		for (const target of targets) {
			const existing = session.windows.find((window) => window.targetId === target.id);
			if (existing) {
				const nextType = target.type ?? existing.type;
				if (existing.webSocketDebuggerUrl !== target.webSocketDebuggerUrl || existing.type !== nextType) {
					this.disposePageDriversForWindow(session.id, existing.ref);
				}
				existing.type = nextType;
				existing.title = target.title;
				existing.url = target.url;
				existing.webSocketDebuggerUrl = target.webSocketDebuggerUrl;
				existing.lastSeenAt = new Date().toISOString();
				existing.closed = false;
				existing.isPrimary = target.id === primaryTargetId;
				continue;
			}
			const ref = `w${session.nextWindowNumber++}`;
			const now = new Date().toISOString();
			session.windows.push({
				ref,
				targetId: target.id,
				type: target.type ?? "unknown",
				title: target.title,
				url: target.url,
				webSocketDebuggerUrl: target.webSocketDebuggerUrl,
				isPrimary: target.id === primaryTargetId,
				attachedAt: now,
				lastSeenAt: now,
			});
		}
	}

	private locate(
		snapshot: PageSnapshotBridgeResult,
		query: Parameters<typeof rankLocatorCandidates>[1],
		options: { minScore?: number; limit?: number },
	): SnapshotLocatorMatchResult[] {
		const candidates: SemanticLocatorCandidate[] = snapshot.entries.map((entry) => ({
			candidateId: entry.snapshotId,
			role: entry.role,
			name: entry.name,
			text: entry.text,
			label: entry.label,
			tagName: entry.tagName,
			attributes: entry.attributes,
		}));
		const ranked: RankedLocatorCandidate[] = rankLocatorCandidates(candidates, query, options);
		const byId = new Map(snapshot.entries.map((entry) => [entry.snapshotId, entry]));
		return ranked.flatMap((match) => {
			const entry = byId.get(match.candidate.candidateId);
			if (!entry) return [];
			return [
				{
					target: { ...snapshot.target },
					navigationGeneration: snapshot.navigationGeneration,
					refId: entry.snapshotId,
					score: match.score,
					reasons: match.reasons,
					entry,
				},
			];
		});
	}
}

interface ElectronMainInfoResult {
	windows: Array<{ title?: string; url?: string; id?: number }>;
	paths: {
		appPath?: string;
		userData?: string;
		exe?: string;
		temp?: string;
	};
	app: {
		name?: string;
		version?: string;
		electronVersion?: string;
		chromeVersion?: string;
		nodeVersion?: string;
	};
	crashDumps: {
		directory?: string;
		files: string[];
	};
}

async function isPortAvailable(port: number): Promise<boolean> {
	const server = createServer();
	try {
		server.listen(port, "127.0.0.1");
		await once(server, "listening");
		return true;
	} catch {
		return false;
	} finally {
		server.close();
	}
}

async function waitForCdp(port: number, timeoutMs: number): Promise<CdpVersionResponse> {
	const startedAt = Date.now();
	let lastError = "";
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (response.ok) return (await response.json()) as CdpVersionResponse;
			lastError = `${response.status} ${response.statusText}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`No Electron CDP endpoint responded on port ${port}: ${lastError || "timed out"}`);
}

async function resolveInspectorEndpoint(port: number, timeoutMs: number): Promise<InspectorEndpoint> {
	const version = await waitForCdp(port, timeoutMs);
	if (version.webSocketDebuggerUrl) return version;
	const targets = await listCdpTargets(port);
	return {
		Browser: version.Browser,
		webSocketDebuggerUrl: targets.find((target) => target.webSocketDebuggerUrl)?.webSocketDebuggerUrl,
	};
}

async function shouldDeleteSessionAfterChildExit(port: number, graceMs = 500): Promise<boolean> {
	await new Promise((resolve) => setTimeout(resolve, graceMs));
	try {
		await waitForCdp(port, 500);
		return false;
	} catch {
		return true;
	}
}

function normalizeDebuggerEndpoint(webSocketDebuggerUrl: string | undefined, port: number): string {
	if (!webSocketDebuggerUrl) return `cdp://127.0.0.1:${port}`;
	try {
		const endpoint = new URL(webSocketDebuggerUrl);
		const hostname = endpoint.hostname.toLowerCase();
		if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") endpoint.hostname = "127.0.0.1";
		endpoint.protocol = endpoint.protocol.toLowerCase();
		endpoint.hash = "";
		return endpoint.toString();
	} catch {
		return webSocketDebuggerUrl.trim();
	}
}

function compositeEndpointKey(browserEndpointKey: string, owner: ElectronProcessIdentity, appId: string): string {
	return `${browserEndpointKey}|app=${encodeURIComponent(appId)}|owner=${encodeURIComponent(owner.familyKey)}`;
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw new Error("aborted");
	let removeAbortListener: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		const onAbort = () => reject(new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		removeAbortListener = () => signal.removeEventListener("abort", onAbort);
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		removeAbortListener?.();
	}
}

export const electronSessionTestHooks = {
	compositeEndpointKey,
	normalizeDebuggerEndpoint,
	resolveInspectorEndpoint,
	shouldDeleteSessionAfterChildExit,
};

interface CdpTargetListEntry {
	id: string;
	type?: string;
	title?: string;
	url?: string;
	webSocketDebuggerUrl: string;
}

async function readCdpVersion(port: number, signal?: AbortSignal): Promise<CdpVersionResponse> {
	const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal });
	if (!response.ok) throw new Error(`Could not read Electron CDP version on port ${port}: ${response.status}`);
	return (await response.json()) as CdpVersionResponse;
}

async function listCdpTargets(port: number, signal?: AbortSignal): Promise<CdpTargetListEntry[]> {
	const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal });
	if (!response.ok) throw new Error(`Could not list Electron CDP targets on port ${port}: ${response.status}`);
	const targets = (await response.json()) as Array<{
		id?: string;
		type?: string;
		title?: string;
		url?: string;
		webSocketDebuggerUrl?: string;
	}>;
	return targets
		.filter((target) => target.id && target.webSocketDebuggerUrl)
		.map((target) => ({
			id: target.id!,
			type: target.type,
			title: target.title,
			url: target.url,
			webSocketDebuggerUrl: target.webSocketDebuggerUrl!,
		}));
}

function noSessionError(target: BridgeTarget): Error {
	const ref = target.kind === "electron-window" ? (target.appRef ?? target.sessionId ?? "unknown") : "unknown";
	return new Error(`No Electron session attached for '${ref}'; run 'shuvgeist electron attach ${ref}' first`);
}

function buildElectronSnapshotExpression(config: SnapshotInjectionConfig): string {
	return buildInjectedArtifactInvocation(SNAPSHOT_INJECTED_ARTIFACT, [
		JSON.stringify(config).replaceAll("<", "\\u003c"),
	]);
}

function electronPageDriverKey(sessionId: string, windowRef: string, targetId: string): string {
	return JSON.stringify([sessionId, windowRef, targetId]);
}

function screencastOutcome(reason: PageScreencastSummary["reason"]): RecordStopResult["outcome"] {
	switch (reason) {
		case "user":
			return "stopped_user";
		case "max-duration":
			return "stopped_max_duration";
		case "max-bytes":
			return "stopped_max_bytes";
		case "target-closed":
			return "stopped_target_closed";
		case "abort":
		case "error":
			return "stopped_error";
	}
}

const ELECTRON_MAIN_INFO_SCRIPT = `function electronMainInfoScript() {
	const nodeRequire =
		typeof require === "function"
			? require
			: process.mainModule && typeof process.mainModule.require === "function"
				? process.mainModule.require.bind(process.mainModule)
				: undefined;
	let electron;
	try {
		electron = nodeRequire ? nodeRequire("electron") : undefined;
	} catch {}
	const app = electron && electron.app;
	const browserWindows = electron && electron.BrowserWindow ? electron.BrowserWindow.getAllWindows() : [];
	let crashDirectory;
	let crashFiles = [];
	try {
		crashDirectory = app && app.getPath ? app.getPath("crashDumps") : undefined;
		const fs = nodeRequire("fs");
		crashFiles = crashDirectory && fs.existsSync(crashDirectory) ? fs.readdirSync(crashDirectory).slice(0, 200) : [];
	} catch {}
	return {
		windows: browserWindows.map((window) => ({
			id: window.id,
			title: window.getTitle ? window.getTitle() : undefined,
			url: window.webContents && window.webContents.getURL ? window.webContents.getURL() : undefined,
		})),
		paths: {
			appPath: app && app.getAppPath ? app.getAppPath() : undefined,
			userData: app && app.getPath ? app.getPath("userData") : undefined,
			exe: app && app.getPath ? app.getPath("exe") : process.execPath,
			temp: app && app.getPath ? app.getPath("temp") : undefined,
		},
		app: {
			name: app && app.getName ? app.getName() : undefined,
			version: app && app.getVersion ? app.getVersion() : undefined,
			electronVersion: process.versions.electron,
			chromeVersion: process.versions.chrome,
			nodeVersion: process.versions.node,
		},
		crashDumps: {
			directory: crashDirectory,
			files: crashFiles,
		},
	};
}`;

const ELECTRON_IPC_TAP_SCRIPT = `function electronIpcTapScript(options) {
	const electron = require("electron");
	const ipcMain = electron.ipcMain;
	if (!ipcMain) throw new Error("electron.ipcMain is unavailable in this main process.");
	const channelFilter = options && options.channel ? String(options.channel) : "";
	if (!global.__shuvgeistIpcTap) {
		const originalEmit = ipcMain.emit.bind(ipcMain);
		global.__shuvgeistIpcTap = { originalEmit, events: [], filters: [] };
		ipcMain.emit = function patchedShuvgeistIpcEmit(channel, event, ...args) {
			const tap = global.__shuvgeistIpcTap;
			const channelText = String(channel);
			const shouldRecord = !tap.filters.length || tap.filters.some((filter) => channelText.includes(filter));
			if (shouldRecord) {
				tap.events.push({
					source: "main",
					channel: channelText,
					ts: Date.now(),
					argCount: args.length,
				});
				if (tap.events.length > 1000) tap.events.shift();
			}
			return originalEmit(channel, event, ...args);
		};
	}
	if (channelFilter && !global.__shuvgeistIpcTap.filters.includes(channelFilter)) {
		global.__shuvgeistIpcTap.filters.push(channelFilter);
	}
	return { ok: true, source: "main", channel: channelFilter || undefined };
}`;

const ELECTRON_IPC_UNTAP_SCRIPT = `function electronIpcUntapScript() {
	const electron = require("electron");
	const ipcMain = electron.ipcMain;
	if (global.__shuvgeistIpcTap && ipcMain) {
		ipcMain.emit = global.__shuvgeistIpcTap.originalEmit;
		delete global.__shuvgeistIpcTap;
	}
	return { ok: true };
}`;

const ELECTRON_MAIN_NETWORK_TAP_SCRIPT = `function electronMainNetworkTapScript() {
	if (!global.__shuvgeistMainNetworkTap) {
		const http = require("http");
		const https = require("https");
		const originalHttpRequest = http.request;
		const originalHttpsRequest = https.request;
		const events = [];
		function record(protocol, args) {
			events.push({ source: "main", protocol, ts: Date.now(), argCount: args.length });
			if (events.length > 1000) events.shift();
		}
		http.request = function patchedHttpRequest(...args) {
			record("http", args);
			return originalHttpRequest.apply(this, args);
		};
		https.request = function patchedHttpsRequest(...args) {
			record("https", args);
			return originalHttpsRequest.apply(this, args);
		};
		global.__shuvgeistMainNetworkTap = { originalHttpRequest, originalHttpsRequest, events };
	}
	return { ok: true, source: "main" };
}`;

const ELECTRON_MAIN_NETWORK_UNTAP_SCRIPT = `function electronMainNetworkUntapScript() {
	if (global.__shuvgeistMainNetworkTap) {
		const http = require("http");
		const https = require("https");
		http.request = global.__shuvgeistMainNetworkTap.originalHttpRequest;
		https.request = global.__shuvgeistMainNetworkTap.originalHttpsRequest;
		delete global.__shuvgeistMainNetworkTap;
	}
	return { ok: true, source: "main" };
}`;
