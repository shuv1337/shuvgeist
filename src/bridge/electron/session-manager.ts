import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { promisify } from "node:util";
import type { RankedLocatorCandidate, SemanticLocatorCandidate } from "../../tools/helpers/ref-map.js";
import { rankLocatorCandidates } from "../../tools/helpers/ref-map.js";
import { SNAPSHOT_PAGE_SCRIPT } from "../../tools/helpers/snapshot-page-script.js";
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
} from "../protocol.js";
import { BridgeDefaults } from "../protocol.js";
import { matchSnapshotSkillsForApp } from "../skill-snapshot.js";
import type { BridgeTarget } from "../target.js";
import { resolveElectronApp, resolveExecutable } from "./app-registry.js";
import { ElectronWsCdpSession } from "./cdp-client.js";
import { normalizeElectronConfig, readBridgeConfig } from "./config.js";
import { ElectronSessionStore } from "./session-store.js";
import { readSkillSnapshot } from "./skill-snapshot-store.js";
import type {
	ElectronIpcTap,
	ElectronMainNetworkTap,
	ElectronSession,
	ElectronSessionSummary,
	ElectronWindow,
} from "./types.js";
import { assertElectronWindow, captureElectronWindowScreenshot, evaluateElectronWindow } from "./window-executor.js";

interface CdpVersionResponse {
	Browser?: string;
	webSocketDebuggerUrl?: string;
}

interface InspectorEndpoint {
	Browser?: string;
	webSocketDebuggerUrl?: string;
}

const execFileAsync = promisify(execFile);

export class ElectronSessionManager {
	private readonly sessionStore = new ElectronSessionStore();
	private readonly refs = new Map<string, Map<string, ElectronRefEntry>>();
	private readonly recordings = new Map<string, ElectronRecordingState>();
	private readonly networkCaptures = new Map<string, ElectronNetworkCaptureState>();

	list(): ElectronSessionSummary[] {
		return this.sessionStore.summaries();
	}

	async launch(appRef: string, options: { inspectMain?: boolean } = {}): Promise<ElectronSessionSummary> {
		const app = resolveElectronApp(appRef);
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
		const version = await waitForCdp(port, 10_000);
		const session = this.createSession({
			appId: app.id,
			appRef,
			pid: child.pid,
			port,
			webSocketDebuggerUrl: version.webSocketDebuggerUrl,
			mainInspector: inspectPort ? await this.resolveMainInspector(inspectPort) : undefined,
			browser: version.Browser,
			launched: true,
			process: child,
		});
		await this.refreshWindows(session);
		child.once("exit", () => {
			void this.deleteSessionIfCdpExited(session.id, port);
		});
		return this.sessionStore.toSummary(session);
	}

	async attach(params: {
		appRef?: string;
		pid?: number;
		port?: number;
		inspectPort?: number;
	}): Promise<ElectronSessionSummary> {
		const app = params.appRef ? resolveElectronApp(params.appRef) : undefined;
		if (params.appRef && !app) {
			throw new Error(`Unknown Electron app '${params.appRef}'. Run 'shuvgeist electron list' to see known apps.`);
		}
		if (app) this.assertAllowed(app.id);
		const port =
			params.port ??
			(params.pid ? discoverPortForPid(params.pid) : undefined) ??
			(app ? await discoverPortForApp(app) : undefined);
		if (!port) {
			const target = params.pid ? `pid ${params.pid}` : params.appRef ? `'${params.appRef}'` : "the requested app";
			throw new Error(
				`No Electron CDP port found for ${target}; start it with --remote-debugging-port=<port> or pass --port <port>.`,
			);
		}
		const version = await waitForCdp(port, 3000);
		const session = this.createSession({
			appId: app?.id,
			appRef: params.appRef,
			pid: params.pid,
			port,
			webSocketDebuggerUrl: version.webSocketDebuggerUrl,
			mainInspector: params.inspectPort ? await this.resolveMainInspector(params.inspectPort) : undefined,
			browser: version.Browser,
			launched: false,
		});
		await this.refreshWindows(session);
		return this.sessionStore.toSummary(session);
	}

	detach(sessionId: string): boolean {
		const session = this.sessionStore.get(sessionId);
		if (!session) return false;
		this.sessionStore.delete(sessionId);
		if (session.launched && session.process?.pid) {
			try {
				process.kill(session.process.pid, "SIGTERM");
			} catch {
				// The spawned app may already have exited.
			}
		}
		return true;
	}

	resolveTarget(target: BridgeTarget): { session: ElectronSession; window: ElectronWindow } | undefined {
		if (target.kind !== "electron-window") return undefined;
		const session = this.resolveSession(target);
		if (!session) return undefined;
		const requestedWindowRef = target.windowRef ?? target.targetId;
		const window = requestedWindowRef
			? this.resolveWindow(session, requestedWindowRef)
			: (session.windows.find((candidate) => candidate.isPrimary && !candidate.closed) ??
				session.windows.find((candidate) => !candidate.closed));
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

	async evaluate(
		target: BridgeTarget,
		code: string,
	): Promise<{ output: string; result: unknown; skillsSnapshot?: ReturnType<typeof readSkillSnapshot>["status"] }> {
		const resolved = this.resolveTarget(target);
		if (!resolved) throw noSessionError(target);
		const client = await this.connectToPage(resolved.window);
		try {
			const { snapshot, status } = readSkillSnapshot();
			const matchingSkills = snapshot
				? matchSnapshotSkillsForApp(snapshot, [
						resolved.session.appId,
						resolved.session.appRef,
						target.kind === "electron-window" ? target.appRef : undefined,
					])
				: [];
			const skillLibrary =
				matchingSkills.length > 0 ? `${matchingSkills.map((skill) => skill.library).join("\n\n")}\n\n` : "";
			return await evaluateElectronWindow(client, {
				code,
				skillLibrary,
				skillsSnapshotStatus: status,
				includeSkillsSnapshot: matchingSkills.length > 0 || status.state === "stale" || status.state === "invalid",
			});
		} finally {
			client.close();
		}
	}

	async screenshot(target: BridgeTarget, maxWidth?: number): Promise<BridgeScreenshotResult> {
		const resolved = this.resolveTarget(target);
		if (!resolved) throw noSessionError(target);
		const client = await this.connectToPage(resolved.window);
		try {
			return await captureElectronWindowScreenshot(client, maxWidth);
		} finally {
			client.close();
		}
	}

	async assert(target: BridgeTarget, params: PageAssertParams): Promise<PageAssertResult> {
		const resolved = this.resolveTarget(target);
		if (!resolved) throw noSessionError(target);
		if (params.world === "main") {
			throw new Error("Electron assertions do not support --world main; use renderer/user-world assertions.");
		}
		const client = await this.connectToPage(resolved.window);
		try {
			return await assertElectronWindow(client, params);
		} finally {
			client.close();
		}
	}

	async networkStart(target: BridgeTarget, params: NetworkStartParams): Promise<ElectronNetworkCaptureStats> {
		const resolved = this.resolveTarget(target);
		if (!resolved) throw noSessionError(target);
		const scope = refScope(resolved.session.id, resolved.window.ref);
		const existing = this.networkCaptures.get(scope);
		if (existing?.active) return this.networkStatsForState(existing);
		const client = await this.connectToPage(resolved.window);
		const state: ElectronNetworkCaptureState = existing ?? {
			scope,
			sessionId: resolved.session.id,
			windowRef: resolved.window.ref,
			active: true,
			maxEntries: params.maxEntries ?? 250,
			maxBodyBytes: params.maxBodyBytes ?? 256_000,
			requests: new Map(),
			order: [],
			storedBodyBytes: 0,
			evictedRequests: 0,
			client,
		};
		state.active = true;
		state.client = client;
		state.maxEntries = params.maxEntries ?? state.maxEntries;
		state.maxBodyBytes = params.maxBodyBytes ?? state.maxBodyBytes;
		state.removeListeners?.forEach((remove) => {
			remove();
		});
		state.removeListeners = [
			client.on("Network.requestWillBeSent", (event) => this.handleNetworkEvent(state, "request", event)),
			client.on("Network.responseReceived", (event) => this.handleNetworkEvent(state, "response", event)),
			client.on("Network.loadingFinished", (event) => {
				void this.finishNetworkRequest(state, event);
			}),
			client.on("Network.loadingFailed", (event) => this.handleNetworkEvent(state, "failed", event)),
			client.onClose(() => {
				state.active = false;
			}),
		];
		this.networkCaptures.set(scope, state);
		await client.send("Network.enable");
		return this.networkStatsForState(state);
	}

	async networkStop(target: BridgeTarget): Promise<ElectronNetworkCaptureStats> {
		const state = this.resolveNetworkState(target);
		if (!state) return this.emptyNetworkStats(target);
		state.active = false;
		state.removeListeners?.forEach((remove) => {
			remove();
		});
		state.removeListeners = undefined;
		void state.client.send("Network.disable").catch(() => undefined);
		state.client.close();
		return this.networkStatsForState(state);
	}

	networkList(target: BridgeTarget, params: NetworkListParams): ElectronCapturedNetworkRequest[] {
		const state = this.resolveNetworkState(target);
		if (!state) return [];
		const search = params.search?.toLowerCase();
		const items = state.order
			.map((requestId) => state.requests.get(requestId))
			.filter((request): request is ElectronCapturedNetworkRequest => Boolean(request))
			.filter(
				(request) =>
					!search || request.url.toLowerCase().includes(search) || request.method.toLowerCase().includes(search),
			);
		const limit = typeof params.limit === "number" ? Math.max(0, params.limit) : items.length;
		return items
			.slice(-limit)
			.reverse()
			.map((item) => ({ ...item, id: item.requestId }));
	}

	networkClear(target: BridgeTarget): ElectronNetworkCaptureStats {
		const state = this.resolveNetworkState(target);
		if (!state) return this.emptyNetworkStats(target);
		state.requests.clear();
		state.order = [];
		state.storedBodyBytes = 0;
		state.evictedRequests = 0;
		return this.networkStatsForState(state);
	}

	networkStats(target: BridgeTarget): ElectronNetworkCaptureStats {
		const state = this.resolveNetworkState(target);
		return state ? this.networkStatsForState(state) : this.emptyNetworkStats(target);
	}

	networkGet(target: BridgeTarget, params: NetworkItemParams): ElectronCapturedNetworkRequest {
		const item = this.resolveNetworkState(target)?.requests.get(params.requestId);
		if (!item) throw new Error(`Captured request ${params.requestId} was not found`);
		return { ...item, id: item.requestId };
	}

	networkBody(target: BridgeTarget, params: NetworkItemParams): { requestBody?: string; responseBody?: string } {
		const item = this.networkGet(target, params);
		return { requestBody: item.requestBody, responseBody: item.responseBody };
	}

	networkCurl(target: BridgeTarget, params: NetworkCurlParams): { requestId: string; command: string } {
		const item = this.networkGet(target, params);
		const parts = ["curl", "-X", shellEscape(item.method), shellEscape(item.url)];
		for (const [key, value] of Object.entries(item.requestHeaders ?? {})) {
			parts.push("-H", shellEscape(`${key}: ${value}`));
		}
		if (item.requestBody) parts.push("--data-raw", shellEscape(item.requestBody));
		return { requestId: params.requestId, command: parts.join(" ") };
	}

	async perfMetrics(
		target: BridgeTarget,
		_params: PerfMetricsParams = {},
	): Promise<{
		tabId: number;
		sessionId: string;
		windowRef: string;
		metrics: Array<{ name: string; value: number }>;
	}> {
		const resolved = this.resolveTarget(target);
		if (!resolved) throw noSessionError(target);
		const client = await this.connectToPage(resolved.window);
		try {
			await client.send("Performance.enable");
			const response = await client.send<{ metrics?: Array<{ name?: string; value?: number }> }>(
				"Performance.getMetrics",
			);
			return {
				tabId: -1,
				sessionId: resolved.session.id,
				windowRef: resolved.window.ref,
				metrics: (response.metrics ?? [])
					.filter(
						(metric): metric is { name: string; value: number } =>
							typeof metric.name === "string" && typeof metric.value === "number",
					)
					.map((metric) => ({ name: metric.name, value: metric.value })),
			};
		} finally {
			client.close();
		}
	}

	async snapshot(
		target: BridgeTarget,
		options: { maxEntries?: number; includeHidden?: boolean; query?: string },
	): Promise<PageSnapshotBridgeResult> {
		const resolved = this.resolveTarget(target);
		if (!resolved) throw noSessionError(target);
		const snapshot = await this.captureSnapshot(resolved, options);
		const scope = refScope(resolved.session.id, resolved.window.ref);
		const scopeRefs = this.refsForScope(scope);
		for (const entry of snapshot.entries) {
			scopeRefs.set(entry.snapshotId, {
				refId: entry.snapshotId,
				scope,
				selectorCandidates: entry.selectorCandidates,
				createdAt: Date.now(),
			});
		}
		return snapshot;
	}

	async locateByRole(target: BridgeTarget, params: LocateByRoleParams): Promise<SnapshotLocatorMatchResult[]> {
		const snapshot = await this.snapshot(target, { maxEntries: params.limit ?? 120 });
		return this.locate(snapshot, { kind: "role", value: params.role, name: params.name }, params);
	}

	async locateByText(target: BridgeTarget, params: LocateByTextParams): Promise<SnapshotLocatorMatchResult[]> {
		const snapshot = await this.snapshot(target, { maxEntries: params.limit ?? 120 });
		return this.locate(snapshot, { kind: "text", value: params.text }, params);
	}

	async locateByLabel(target: BridgeTarget, params: LocateByLabelParams): Promise<SnapshotLocatorMatchResult[]> {
		const snapshot = await this.snapshot(target, { maxEntries: params.limit ?? 120 });
		return this.locate(snapshot, { kind: "label", value: params.label }, params);
	}

	async refClick(target: BridgeTarget, params: RefClickParams): Promise<RefActionResult> {
		if (params.native) {
			throw new Error("Native ref click is not supported for Electron targets");
		}
		const resolved = this.resolveTarget(target);
		if (!resolved) throw noSessionError(target);
		const ref = this.resolveRef(resolved.session.id, resolved.window.ref, params.refId);
		await this.runRefAction(resolved.window, ref, "click");
		return { ok: true, refId: params.refId, tabId: -1, frameId: 0, selector: ref.selectorCandidates[0] };
	}

	async refFill(target: BridgeTarget, params: RefFillParams): Promise<RefActionResult> {
		if (params.native) {
			throw new Error("Native ref fill is not supported for Electron targets");
		}
		const resolved = this.resolveTarget(target);
		if (!resolved) throw noSessionError(target);
		const ref = this.resolveRef(resolved.session.id, resolved.window.ref, params.refId);
		await this.runRefAction(resolved.window, ref, "fill", params.value);
		return { ok: true, refId: params.refId, tabId: -1, frameId: 0, selector: ref.selectorCandidates[0] };
	}

	async recordStart(
		target: BridgeTarget,
		params: RecordStartParams,
		emit: (event: RecordFrameEventData) => void,
	): Promise<RecordStartResult> {
		const resolved = this.resolveTarget(target);
		if (!resolved) throw noSessionError(target);
		const existing = Array.from(this.recordings.values()).find(
			(recording) => recording.sessionId === resolved.session.id && recording.windowRef === resolved.window.ref,
		);
		if (existing)
			throw new Error(
				`Recording is already active for Electron window ${resolved.session.id}:${resolved.window.ref}`,
			);
		const maxDurationMs = params.maxDurationMs ?? BridgeDefaults.RECORD_DEFAULT_MAX_DURATION_MS;
		const recordingId = `erec-${resolved.session.id}-${resolved.window.ref}-${Date.now()}`;
		const client = await this.connectToPage(resolved.window);
		const startedAtMs = Date.now();
		const state: ElectronRecordingState = {
			recordingId,
			sessionId: resolved.session.id,
			windowRef: resolved.window.ref,
			startedAtMs,
			startedAt: new Date(startedAtMs).toISOString(),
			mimeType: params.mimeType ?? "video/webm",
			videoBitsPerSecond: params.videoBitsPerSecond,
			maxDurationMs,
			fps: params.fps ?? BridgeDefaults.RECORD_DEFAULT_FPS,
			quality: params.quality ?? BridgeDefaults.RECORD_DEFAULT_JPEG_QUALITY,
			sourceBytes: 0,
			frameCount: 0,
			client,
			emit,
		};
		state.removeFrameListener = client.on("Page.screencastFrame", (frame) => {
			void this.handleElectronScreencastFrame(state, frame).catch((error) => {
				state.lastError = error instanceof Error ? error.message : String(error);
			});
		});
		state.removeCloseListener = client.onClose(() => {
			void this.recordStop({ recordingId }, "stopped_error").catch(() => undefined);
		});
		await client.send("Page.enable");
		await client.send("Page.startScreencast", {
			format: "jpeg",
			quality: state.quality,
			everyNthFrame: 1,
			maxWidth: params.maxWidth ?? BridgeDefaults.RECORD_DEFAULT_MAX_WIDTH,
			...(params.maxHeight ? { maxHeight: params.maxHeight } : {}),
		});
		state.maxDurationTimer = setTimeout(() => {
			void this.recordStop({ recordingId }, "stopped_max_duration").catch(() => undefined);
		}, maxDurationMs);
		this.recordings.set(recordingId, state);
		return {
			ok: true,
			recordingId,
			tabId: -1,
			startedAt: state.startedAt,
			mimeType: state.mimeType,
			videoBitsPerSecond: state.videoBitsPerSecond,
			maxDurationMs,
		};
	}

	async recordStop(
		params: { recordingId?: string },
		outcome: "stopped_user" | "stopped_max_duration" | "stopped_error" = "stopped_user",
	): Promise<RecordStopResult> {
		const state = params.recordingId
			? this.recordings.get(params.recordingId)
			: Array.from(this.recordings.values())[0];
		if (!state) throw new Error("No Electron recording is active.");
		this.recordings.delete(state.recordingId);
		if (state.maxDurationTimer) clearTimeout(state.maxDurationTimer);
		state.removeFrameListener?.();
		state.removeCloseListener?.();
		try {
			await state.client.send("Page.stopScreencast");
		} catch {
			// The target may have closed first.
		}
		state.client.close();
		const endedAtMs = Date.now();
		const summary: RecordStopResult = {
			ok: true,
			recordingId: state.recordingId,
			tabId: -1,
			startedAt: state.startedAt,
			endedAt: new Date(endedAtMs).toISOString(),
			durationMs: endedAtMs - state.startedAtMs,
			mimeType: state.mimeType,
			sizeBytes: state.sourceBytes,
			sourceBytes: state.sourceBytes,
			chunkCount: state.frameCount,
			frameCount: state.frameCount,
			outcome,
		};
		state.emit({
			recordingId: state.recordingId,
			tabId: -1,
			seq: state.frameCount,
			format: "jpeg",
			dataBase64: "",
			capturedAtMs: endedAtMs,
			final: true,
			summary,
		});
		return summary;
	}

	recordStatus(): RecordStatusResult {
		const state = Array.from(this.recordings.values())[0];
		if (!state) return { active: false };
		return {
			active: true,
			recordingId: state.recordingId,
			tabId: -1,
			startedAt: state.startedAt,
			mimeType: state.mimeType,
			durationMs: Date.now() - state.startedAtMs,
			sizeBytes: state.sourceBytes,
			sourceBytes: state.sourceBytes,
			chunkCount: state.frameCount,
			frameCount: state.frameCount,
			fps: state.fps,
			lastError: state.lastError,
		};
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
		const config = normalizeElectronConfig(readBridgeConfig());
		if (!config.allowlist.includes(appId)) {
			throw new Error(`Electron app '${appId}' is not allowlisted; run 'shuvgeist electron allow ${appId}' first.`);
		}
	}

	private defaultFlagsFor(appId: string): string[] {
		return normalizeElectronConfig(readBridgeConfig()).defaultFlags[appId] ?? [];
	}

	private async choosePort(startAt?: number): Promise<number> {
		const [start, end] = normalizeElectronConfig(readBridgeConfig()).portRange;
		for (let port = startAt ?? start; port <= end; port++) {
			if (await isPortAvailable(port)) return port;
		}
		throw new Error(`No available Electron CDP port in configured range ${start}-${end}.`);
	}

	private async resolveMainInspector(port: number): Promise<ElectronSession["mainInspector"]> {
		const version = await resolveInspectorEndpoint(port, 3000);
		return {
			port,
			webSocketDebuggerUrl: version.webSocketDebuggerUrl,
			available: Boolean(version.webSocketDebuggerUrl),
			browser: version.Browser,
		};
	}

	private async deleteSessionIfCdpExited(sessionId: string, port: number): Promise<void> {
		if (await shouldDeleteSessionAfterChildExit(port)) {
			this.sessionStore.delete(sessionId);
		}
	}

	private connectToMainInspector(
		session: ElectronSession | undefined,
		capability: "main_inspect" | "ipc_tap" | "main_network_tap",
	): Promise<ElectronWsCdpSession> {
		if (!session) throw new Error("No Electron session attached for the requested session.");
		const app = session.appRef
			? resolveElectronApp(session.appRef)
			: session.appId
				? resolveElectronApp(session.appId)
				: undefined;
		if (app && !app.mainInspectSupported) {
			throw new Error(
				`Electron app '${session.appRef ?? session.appId}' does not support main-process inspector commands.`,
			);
		}
		this.assertCapabilityAllowed(session, capability);
		if (!session.mainInspector?.available || !session.mainInspector.webSocketDebuggerUrl) {
			throw new Error(
				`No main-process inspector attached for '${session.id}'. Launch with --inspect-main or attach with --inspect-port <port>.`,
			);
		}
		return ElectronWsCdpSession.connect(session.mainInspector.webSocketDebuggerUrl, session.id + ":main");
	}

	private assertCapabilityAllowed(
		session: ElectronSession,
		capability: "eval" | "cookies" | "main_inspect" | "ipc_tap" | "main_network_tap",
	): void {
		const appId = session.appId ?? session.appRef;
		if (!appId) return;
		const config = normalizeElectronConfig(readBridgeConfig());
		const appCapabilities = config.capabilities[appId] ?? {};
		if (appCapabilities[capability] === false) {
			throw new Error(`Electron capability '${capability}' is disabled for app '${appId}' in bridge config.`);
		}
	}

	private async connectToPage(window: ElectronWindow): Promise<ElectronWsCdpSession> {
		return ElectronWsCdpSession.connect(window.webSocketDebuggerUrl, window.ref);
	}

	private async refreshWindows(session: ElectronSession): Promise<void> {
		const targets = await listCdpTargets(session.port);
		const activeTargetIds = new Set(targets.map((target) => target.id));
		for (const existing of session.windows) {
			if (!activeTargetIds.has(existing.targetId)) existing.closed = true;
		}
		let primaryAssigned = session.windows.some((window) => !window.closed && window.isPrimary);
		for (const target of targets) {
			const existing = session.windows.find((window) => window.targetId === target.id);
			if (existing) {
				existing.type = target.type ?? existing.type;
				existing.title = target.title;
				existing.url = target.url;
				existing.webSocketDebuggerUrl = target.webSocketDebuggerUrl;
				existing.lastSeenAt = new Date().toISOString();
				existing.closed = false;
				if (!primaryAssigned && target.type === "page") {
					existing.isPrimary = true;
					primaryAssigned = true;
				}
				continue;
			}
			const ref = `w${session.nextWindowNumber++}`;
			const isPrimary = !primaryAssigned && target.type === "page";
			if (isPrimary) primaryAssigned = true;
			const now = new Date().toISOString();
			session.windows.push({
				ref,
				targetId: target.id,
				type: target.type ?? "unknown",
				title: target.title,
				url: target.url,
				webSocketDebuggerUrl: target.webSocketDebuggerUrl,
				isPrimary,
				attachedAt: now,
				lastSeenAt: now,
			});
		}
	}

	private async captureSnapshot(
		resolved: { session: ElectronSession; window: ElectronWindow },
		options: { maxEntries?: number; includeHidden?: boolean; query?: string },
	): Promise<PageSnapshotBridgeResult> {
		const client = await this.connectToPage(resolved.window);
		try {
			const response = await client.send<{ result?: { value?: ElectronSnapshotScriptResponse } }>(
				"Runtime.evaluate",
				{
					expression: `(${SNAPSHOT_PAGE_SCRIPT.toString()})(${JSON.stringify({
						frameId: 0,
						maxEntries: options.maxEntries ?? 120,
						includeHidden: Boolean(options.includeHidden),
						snapshotIdPrefix: `${resolved.session.id}:${resolved.window.ref}`,
					})})`,
					returnByValue: true,
				},
			);
			const scriptResponse = response.result?.value;
			if (!scriptResponse) throw new Error("Electron snapshot did not return a serializable result.");
			if (!scriptResponse.success || !scriptResponse.result) {
				throw new Error(scriptResponse.error || "Electron snapshot script failed.");
			}
			const value = scriptResponse.result;
			return {
				tabId: -1,
				frameId: 0,
				...(options.query ? { query: options.query } : {}),
				url: value.url,
				title: value.title,
				generatedAt: value.generatedAt,
				totalCandidates: value.totalCandidates,
				truncated: value.truncated,
				entries: value.entries.map((entry) => ({
					...entry,
					tabId: -1,
					frameId: 0,
				})),
			};
		} finally {
			client.close();
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
			return [{ refId: entry.snapshotId, score: match.score, reasons: match.reasons, entry }];
		});
	}

	private refsForScope(scope: string): Map<string, ElectronRefEntry> {
		let refs = this.refs.get(scope);
		if (!refs) {
			refs = new Map();
			this.refs.set(scope, refs);
		}
		return refs;
	}

	private resolveRef(sessionId: string, windowRef: string, refId: string): ElectronRefEntry {
		const scope = refScope(sessionId, windowRef);
		const ref = this.refs.get(scope)?.get(refId);
		if (!ref)
			throw new Error(`Electron ref '${refId}' does not exist for target '${scope}'. Run locate or snapshot again.`);
		return ref;
	}

	private async runRefAction(
		window: ElectronWindow,
		ref: ElectronRefEntry,
		action: "click" | "fill",
		value?: string,
	): Promise<void> {
		const client = await this.connectToPage(window);
		try {
			const response = await client.send<{ result?: { value?: { ok: boolean; error?: string } } }>(
				"Runtime.evaluate",
				{
					expression: `(${ELECTRON_REF_ACTION_SCRIPT})(${JSON.stringify({
						selectors: ref.selectorCandidates,
						action,
						value,
					})})`,
					awaitPromise: true,
					returnByValue: true,
				},
			);
			const result = response.result?.value;
			if (!result?.ok) throw new Error(result?.error ?? `Electron ref ${action} failed.`);
		} finally {
			client.close();
		}
	}

	private async handleElectronScreencastFrame(
		state: ElectronRecordingState,
		frame: Record<string, unknown>,
	): Promise<void> {
		const data = typeof frame.data === "string" ? frame.data : "";
		const sessionId = typeof frame.sessionId === "number" ? frame.sessionId : undefined;
		if (!data) return;
		state.frameCount += 1;
		state.sourceBytes += base64ByteLength(data);
		const capturedAtMs = Date.now();
		state.emit({
			recordingId: state.recordingId,
			tabId: -1,
			seq: state.frameCount,
			format: "jpeg",
			dataBase64: data,
			capturedAtMs,
			metadata:
				typeof frame.metadata === "object" && frame.metadata
					? (frame.metadata as Record<string, number>)
					: undefined,
		});
		if (typeof sessionId === "number") await state.client.send("Page.screencastFrameAck", { sessionId });
	}

	private resolveNetworkState(target: BridgeTarget): ElectronNetworkCaptureState | undefined {
		const resolved = this.resolveTarget(target);
		return resolved ? this.networkCaptures.get(refScope(resolved.session.id, resolved.window.ref)) : undefined;
	}

	private emptyNetworkStats(target: BridgeTarget): ElectronNetworkCaptureStats {
		const resolved = this.resolveTarget(target);
		return {
			tabId: -1,
			active: false,
			requestCount: 0,
			storedBodyBytes: 0,
			evictedRequests: 0,
			sessionId: resolved?.session.id,
			windowRef: resolved?.window.ref,
		};
	}

	private networkStatsForState(state: ElectronNetworkCaptureState): ElectronNetworkCaptureStats {
		return {
			tabId: -1,
			active: state.active,
			requestCount: state.requests.size,
			storedBodyBytes: state.storedBodyBytes,
			evictedRequests: state.evictedRequests,
			sessionId: state.sessionId,
			windowRef: state.windowRef,
		};
	}

	private handleNetworkEvent(
		state: ElectronNetworkCaptureState,
		kind: "request" | "response" | "failed",
		payload: Record<string, unknown>,
	): void {
		if (kind === "request") {
			this.upsertNetworkRequest(state, payload);
		} else if (kind === "response") {
			this.updateNetworkResponse(state, payload);
		} else {
			const item = state.requests.get(String(payload.requestId ?? ""));
			if (item) {
				item.endedAt = Date.now();
				item.durationMs = item.endedAt - item.startedAt;
			}
		}
	}

	private upsertNetworkRequest(state: ElectronNetworkCaptureState, payload: Record<string, unknown>): void {
		const requestId = String(payload.requestId ?? "");
		if (!requestId) return;
		const request = asRecord(payload.request);
		const existing = state.requests.get(requestId);
		const item: ElectronCapturedNetworkRequest = existing ?? {
			requestId,
			method: String(request?.method ?? "GET"),
			url: String(request?.url ?? ""),
			resourceType: typeof payload.type === "string" ? payload.type : undefined,
			startedAt: Date.now(),
			hasRequestBody: false,
			hasResponseBody: false,
			tabId: -1,
			sessionId: state.sessionId,
			windowRef: state.windowRef,
		};
		item.method = String(request?.method ?? item.method);
		item.url = String(request?.url ?? item.url);
		item.resourceType = typeof payload.type === "string" ? payload.type : item.resourceType;
		item.requestHeaders = stringMapFrom(request?.headers);
		const postData = typeof request?.postData === "string" ? request.postData : undefined;
		const bounded = this.boundNetworkBody(state, postData);
		item.requestBody = bounded.text;
		item.requestBodyTruncated = bounded.truncated;
		item.requestBodySize = sizeOfText(postData);
		item.hasRequestBody = Boolean(postData);
		if (!existing) state.order.push(requestId);
		state.requests.set(requestId, item);
		this.evictNetworkOverflow(state);
	}

	private updateNetworkResponse(state: ElectronNetworkCaptureState, payload: Record<string, unknown>): void {
		const item = state.requests.get(String(payload.requestId ?? ""));
		if (!item) return;
		const response = asRecord(payload.response);
		item.status = typeof response?.status === "number" ? response.status : item.status;
		item.responseHeaders = stringMapFrom(response?.headers);
		item.contentType = typeof response?.mimeType === "string" ? response.mimeType : item.contentType;
	}

	private async finishNetworkRequest(
		state: ElectronNetworkCaptureState,
		payload: Record<string, unknown>,
	): Promise<void> {
		const requestId = String(payload.requestId ?? "");
		const item = state.requests.get(requestId);
		if (!item) return;
		item.endedAt = Date.now();
		item.durationMs = item.endedAt - item.startedAt;
		try {
			const bodyResult = await state.client.send<{ body?: string; base64Encoded?: boolean }>(
				"Network.getResponseBody",
				{
					requestId,
				},
			);
			const body =
				typeof bodyResult.body === "string" && bodyResult.base64Encoded !== true ? bodyResult.body : undefined;
			const bounded = this.boundNetworkBody(state, body);
			item.responseBody = bounded.text;
			item.responseBodyTruncated = bounded.truncated;
			item.responseBodySize = sizeOfText(body);
			item.hasResponseBody = Boolean(body);
		} catch {}
	}

	private boundNetworkBody(
		state: ElectronNetworkCaptureState,
		body: string | undefined,
	): { text?: string; truncated: boolean } {
		if (!body) return { text: undefined, truncated: false };
		const size = sizeOfText(body);
		if (size > state.maxBodyBytes) {
			return {
				text: body.slice(0, Math.max(0, Math.floor((state.maxBodyBytes / Math.max(1, size)) * body.length))),
				truncated: true,
			};
		}
		state.storedBodyBytes += size;
		return { text: body, truncated: false };
	}

	private evictNetworkOverflow(state: ElectronNetworkCaptureState): void {
		while (state.order.length > state.maxEntries) {
			const oldestId = state.order.shift();
			if (!oldestId) break;
			const removed = state.requests.get(oldestId);
			if (removed) {
				state.storedBodyBytes -= sizeOfText(removed.requestBody) + sizeOfText(removed.responseBody);
				state.requests.delete(oldestId);
				state.evictedRequests += 1;
			}
		}
	}
}

interface ElectronRefEntry {
	refId: string;
	scope: string;
	selectorCandidates: string[];
	createdAt: number;
}

interface ElectronRecordingState {
	recordingId: string;
	sessionId: string;
	windowRef: string;
	startedAtMs: number;
	startedAt: string;
	mimeType: string;
	videoBitsPerSecond?: number;
	maxDurationMs: number;
	fps: number;
	quality: number;
	sourceBytes: number;
	frameCount: number;
	lastError?: string;
	client: ElectronWsCdpSession;
	emit: (event: RecordFrameEventData) => void;
	maxDurationTimer?: ReturnType<typeof setTimeout>;
	removeFrameListener?: () => void;
	removeCloseListener?: () => void;
}

interface ElectronNetworkCaptureState {
	scope: string;
	sessionId: string;
	windowRef: string;
	active: boolean;
	maxEntries: number;
	maxBodyBytes: number;
	requests: Map<string, ElectronCapturedNetworkRequest>;
	order: string[];
	storedBodyBytes: number;
	evictedRequests: number;
	client: ElectronWsCdpSession;
	removeListeners?: Array<() => void>;
}

interface ElectronCapturedNetworkRequest {
	id?: string;
	requestId: string;
	method: string;
	url: string;
	status?: number;
	resourceType?: string;
	contentType?: string;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	requestHeaders?: Record<string, string>;
	responseHeaders?: Record<string, string>;
	requestBody?: string;
	responseBody?: string;
	requestBodyTruncated?: boolean;
	responseBodyTruncated?: boolean;
	requestBodySize?: number;
	responseBodySize?: number;
	hasRequestBody: boolean;
	hasResponseBody: boolean;
	tabId: number;
	sessionId: string;
	windowRef: string;
}

interface ElectronNetworkCaptureStats {
	tabId: number;
	active: boolean;
	requestCount: number;
	storedBodyBytes: number;
	evictedRequests: number;
	sessionId?: string;
	windowRef?: string;
}

interface ElectronSnapshotScriptResponse {
	success: boolean;
	error?: string;
	result?: Omit<PageSnapshotBridgeResult, "tabId" | "frameId" | "query">;
}

function base64ByteLength(value: string): number {
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringMapFrom(value: unknown): Record<string, string> | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(record)) out[key] = String(entry);
	return Object.keys(out).length > 0 ? out : undefined;
}

function sizeOfText(value: string | undefined): number {
	return value ? new TextEncoder().encode(value).length : 0;
}

function shellEscape(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
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

function refScope(sessionId: string, windowRef: string): string {
	return `${sessionId}:${windowRef}`;
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

function discoverPortForPid(pid: number): number | undefined {
	try {
		const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8").replaceAll("\0", " ");
		return parseRemoteDebuggingPort(cmdline);
	} catch {
		return undefined;
	}
}

async function discoverPortForApp(app: { id: string; aliases: string[] }): Promise<number | undefined> {
	const processRows = await listProcesses();
	const needles = new Set([app.id.toLowerCase(), ...app.aliases.map((alias) => alias.toLowerCase())]);
	for (const row of processRows) {
		const lower = row.command.toLowerCase();
		if (![...needles].some((needle) => lower.includes(needle))) continue;
		const port = parseRemoteDebuggingPort(row.command) ?? discoverPortForPid(row.pid);
		if (port) return port;
	}
	return undefined;
}

async function listProcesses(): Promise<Array<{ pid: number; command: string }>> {
	if (process.platform !== "linux" && process.platform !== "darwin") return [];
	try {
		const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="]);
		return stdout
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const match = /^(\d+)\s+(.*)$/.exec(line);
				return match ? { pid: Number.parseInt(match[1], 10), command: match[2] } : undefined;
			})
			.filter((row): row is { pid: number; command: string } => Boolean(row));
	} catch {
		return [];
	}
}

function parseRemoteDebuggingPort(command: string): number | undefined {
	const equalsMatch = /--remote-debugging-port=(\d+)/.exec(command);
	if (equalsMatch) return Number.parseInt(equalsMatch[1], 10);
	const splitMatch = /--remote-debugging-port\s+(\d+)/.exec(command);
	if (splitMatch) return Number.parseInt(splitMatch[1], 10);
	return undefined;
}

export const electronSessionTestHooks = {
	parseRemoteDebuggingPort,
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

async function listCdpTargets(port: number): Promise<CdpTargetListEntry[]> {
	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
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

const ELECTRON_REF_ACTION_SCRIPT = `async function electronRefActionScript(options) {
	for (const selector of options.selectors) {
		const element = document.querySelector(selector);
		if (!element) continue;
		if (options.action === "click") {
			element.click();
			return { ok: true };
		}
		if ("value" in element) {
			element.value = options.value || "";
			element.dispatchEvent(new Event("input", { bubbles: true }));
			element.dispatchEvent(new Event("change", { bubbles: true }));
			return { ok: true };
		}
		return { ok: false, error: "Element for selector '" + selector + "' cannot be filled." };
	}
	return { ok: false, error: "No element matched the stored Electron ref selectors." };
}`;

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
