import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { promisify } from "node:util";
import type { RankedLocatorCandidate, SemanticLocatorCandidate } from "../../tools/helpers/ref-map.js";
import { rankLocatorCandidates } from "../../tools/helpers/ref-map.js";
import type {
	BridgeScreenshotResult,
	BridgeSnapshotEntry,
	LocateByLabelParams,
	LocateByRoleParams,
	LocateByTextParams,
	PageSnapshotBridgeResult,
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
import { ElectronCdpClient } from "./cdp-client.js";
import { normalizeElectronConfig, readBridgeConfig } from "./config.js";
import { readSkillSnapshot } from "./skill-snapshot-store.js";
import type {
	ElectronIpcTap,
	ElectronMainNetworkTap,
	ElectronSession,
	ElectronSessionSummary,
	ElectronWindow,
} from "./types.js";

interface CdpVersionResponse {
	Browser?: string;
	webSocketDebuggerUrl?: string;
}

const execFileAsync = promisify(execFile);

export class ElectronSessionManager {
	private readonly sessions = new Map<string, ElectronSession>();
	private readonly refs = new Map<string, Map<string, ElectronRefEntry>>();
	private readonly recordings = new Map<string, ElectronRecordingState>();
	private nextSessionNumber = 1;

	list(): ElectronSessionSummary[] {
		return Array.from(this.sessions.values()).map((session) => this.toSummary(session));
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
		child.once("exit", () => this.sessions.delete(session.id));
		return this.toSummary(session);
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
		return this.toSummary(session);
	}

	detach(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		this.sessions.delete(sessionId);
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
				: Array.from(this.sessions.values());
		for (const session of sessions) await this.refreshWindows(session);
		return sessions.map((session) => this.toSummary(session));
	}

	async mainInfo(sessionId: string): Promise<ElectronMainInfoResult> {
		const session = this.sessions.get(sessionId);
		const client = await this.connectToMainInspector(session, "main_inspect");
		try {
			const response = await client.send<{ result?: { value?: ElectronMainInfoResult } }>("Runtime.evaluate", {
				expression: `(${ELECTRON_MAIN_INFO_SCRIPT})()`,
				awaitPromise: true,
				returnByValue: true,
			});
			const value = response.result?.value;
			if (!value) throw new Error("Electron main inspector did not return metadata.");
			return value;
		} finally {
			client.close();
		}
	}

	async startIpcTap(sessionId: string, options: { channel?: string } = {}): Promise<ElectronIpcTap> {
		const session = this.sessions.get(sessionId);
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
		const session = this.sessions.get(sessionId);
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
		const session = this.sessions.get(sessionId);
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
		const session = this.sessions.get(sessionId);
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
		const session = this.sessions.get(sessionId);
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
		if (target.kind !== "electron-window") return undefined;
		if (target.sessionId) return this.sessions.get(target.sessionId);
		if (target.appRef) {
			const app = resolveElectronApp(target.appRef);
			return Array.from(this.sessions.values()).find(
				(session) => session.appRef === target.appRef || (app && session.appId === app.id),
			);
		}
		return Array.from(this.sessions.values())[0];
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
			const response = await client.send<{
				result?: { type?: string; value?: unknown; description?: string };
				exceptionDetails?: { text?: string; exception?: { description?: string } };
			}>("Runtime.evaluate", {
				expression: `${skillLibrary}${code}`,
				awaitPromise: true,
				returnByValue: true,
			});
			if (response.exceptionDetails) {
				throw new Error(
					response.exceptionDetails.exception?.description ??
						response.exceptionDetails.text ??
						"Evaluation failed",
				);
			}
			const value = response.result?.value ?? response.result?.description ?? null;
			return {
				output: typeof value === "string" ? value : JSON.stringify(value),
				result: value,
				skillsSnapshot:
					matchingSkills.length > 0 || status.state === "stale" || status.state === "invalid" ? status : undefined,
			};
		} finally {
			client.close();
		}
	}

	async screenshot(target: BridgeTarget, maxWidth?: number): Promise<BridgeScreenshotResult> {
		const resolved = this.resolveTarget(target);
		if (!resolved) throw noSessionError(target);
		const client = await this.connectToPage(resolved.window);
		try {
			await client.send("Page.enable");
			const viewport = await client.send<{
				result?: {
					value?: { innerWidth?: number; innerHeight?: number; devicePixelRatio?: number };
				};
			}>("Runtime.evaluate", {
				expression: "({ innerWidth, innerHeight, devicePixelRatio })",
				returnByValue: true,
			});
			const cssWidth = viewport.result?.value?.innerWidth ?? 0;
			const cssHeight = viewport.result?.value?.innerHeight ?? 0;
			const devicePixelRatio = viewport.result?.value?.devicePixelRatio ?? 1;
			const capture = await client.send<{ data: string }>("Page.captureScreenshot", {
				format: "png",
				captureBeyondViewport: false,
			});
			const imageWidth = maxWidth && cssWidth > maxWidth ? maxWidth : Math.round(cssWidth * devicePixelRatio);
			const imageHeight = Math.round(cssHeight * (imageWidth / Math.max(cssWidth, 1)));
			return {
				mimeType: "image/png",
				dataUrl: `data:image/png;base64,${capture.data}`,
				cssWidth,
				cssHeight,
				imageWidth,
				imageHeight,
				devicePixelRatio,
				scale: cssWidth > 0 ? imageWidth / cssWidth : 1,
			};
		} finally {
			client.close();
		}
	}

	async snapshot(
		target: BridgeTarget,
		options: { maxEntries?: number; includeHidden?: boolean },
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
		const resolved = this.resolveTarget(target);
		if (!resolved) throw noSessionError(target);
		const ref = this.resolveRef(resolved.session.id, resolved.window.ref, params.refId);
		await this.runRefAction(resolved.window, ref, "click");
		return { ok: true, refId: params.refId, tabId: -1, frameId: 0, selector: ref.selectorCandidates[0] };
	}

	async refFill(target: BridgeTarget, params: RefFillParams): Promise<RefActionResult> {
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
		const next: ElectronSession = {
			...session,
			id: `e${this.nextSessionNumber++}`,
			startedAt: new Date().toISOString(),
			nextWindowNumber: 1,
			windows: [],
			ipcTaps: [],
			mainNetworkTaps: [],
		};
		this.sessions.set(next.id, next);
		return next;
	}

	private toSummary(session: ElectronSession): ElectronSessionSummary {
		return {
			id: session.id,
			appId: session.appId,
			appRef: session.appRef,
			pid: session.pid,
			port: session.port,
			browser: session.browser,
			mainInspector: session.mainInspector,
			launched: session.launched,
			startedAt: session.startedAt,
			windows: session.windows
				.filter((window) => !window.closed)
				.map((window) => ({
					ref: window.ref,
					label: window.label,
					type: window.type,
					title: window.title,
					url: window.url,
					isPrimary: window.isPrimary,
					closed: window.closed,
				})),
		};
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
		const version = await waitForCdp(port, 3000);
		return {
			port,
			webSocketDebuggerUrl: version.webSocketDebuggerUrl,
			available: Boolean(version.webSocketDebuggerUrl),
			browser: version.Browser,
		};
	}

	private connectToMainInspector(
		session: ElectronSession | undefined,
		capability: "main_inspect" | "ipc_tap" | "main_network_tap",
	): Promise<ElectronCdpClient> {
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
		return ElectronCdpClient.connect(session.mainInspector.webSocketDebuggerUrl);
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

	private async connectToPage(window: ElectronWindow): Promise<ElectronCdpClient> {
		return ElectronCdpClient.connect(window.webSocketDebuggerUrl);
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
		options: { maxEntries?: number; includeHidden?: boolean },
	): Promise<PageSnapshotBridgeResult> {
		const client = await this.connectToPage(resolved.window);
		try {
			const response = await client.send<{ result?: { value?: ElectronSnapshotScriptResult } }>("Runtime.evaluate", {
				expression: `(${ELECTRON_SNAPSHOT_SCRIPT})(${JSON.stringify({
					maxEntries: options.maxEntries ?? 120,
					includeHidden: Boolean(options.includeHidden),
					prefix: `${resolved.session.id}:${resolved.window.ref}`,
				})})`,
				returnByValue: true,
			});
			const value = response.result?.value;
			if (!value) throw new Error("Electron snapshot did not return a serializable result.");
			return {
				tabId: -1,
				frameId: 0,
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
	client: ElectronCdpClient;
	emit: (event: RecordFrameEventData) => void;
	maxDurationTimer?: ReturnType<typeof setTimeout>;
	removeFrameListener?: () => void;
	removeCloseListener?: () => void;
}

function base64ByteLength(value: string): number {
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

interface ElectronSnapshotScriptEntry extends Omit<BridgeSnapshotEntry, "tabId" | "frameId"> {}

interface ElectronSnapshotScriptResult {
	url: string;
	title: string;
	generatedAt: number;
	totalCandidates: number;
	truncated: boolean;
	entries: ElectronSnapshotScriptEntry[];
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

const ELECTRON_SNAPSHOT_SCRIPT = String.raw`function electronSnapshotScript(options) {
	function cssEscape(value) { return String(value).replace(/["\\]/g, "\\$&"); }
	function roleFor(element) {
		const explicit = element.getAttribute("role");
		if (explicit) return explicit;
		const tag = element.tagName.toLowerCase();
		if (tag === "button") return "button";
		if (tag === "a" && element.getAttribute("href")) return "link";
		if (tag === "input") {
			const type = (element.getAttribute("type") || "text").toLowerCase();
			if (type === "button" || type === "submit") return "button";
			return "textbox";
		}
		if (tag === "textarea") return "textbox";
		if (/^h[1-6]$/.test(tag)) return "heading";
	}
	function textOf(element) {
		const text = (element.textContent || "").replace(/\s+/g, " ").trim();
		return text ? text.slice(0, 180) : undefined;
	}
	function labelOf(element) {
		const aria = element.getAttribute("aria-label");
		if (aria) return aria;
		const id = element.getAttribute("id");
		if (!id) return undefined;
		const label = document.querySelector('label[for="' + cssEscape(id) + '"]');
		const text = label && label.textContent ? label.textContent.replace(/\s+/g, " ").trim() : "";
		return text ? text.slice(0, 180) : undefined;
	}
	function selectorsFor(element) {
		const selectors = [];
		const id = element.getAttribute("id");
		if (id) selectors.push("#" + cssEscape(id));
		for (const attr of ["data-testid", "data-test", "name", "aria-label"]) {
			const value = element.getAttribute(attr);
			if (value) selectors.push(element.tagName.toLowerCase() + "[" + attr + '="' + cssEscape(value) + '"]');
		}
		selectors.push(element.tagName.toLowerCase());
		return selectors;
	}
	function ordinalPath(element) {
		const path = [];
		let current = element;
		while (current && current.parentElement) {
			path.unshift(Array.from(current.parentElement.children).indexOf(current));
			current = current.parentElement;
		}
		return path;
	}
	const all = Array.from(document.querySelectorAll("button,a,input,textarea,select,[role],[aria-label],[data-testid]"));
	const entries = [];
	let ordinal = 0;
	for (const element of all) {
		const rect = element.getBoundingClientRect();
		const visible = rect.width > 0 && rect.height > 0;
		if (!options.includeHidden && !visible) continue;
		const label = labelOf(element);
		const text = textOf(element);
		entries.push({
			snapshotId: options.prefix + ":ref" + (++ordinal),
			tagName: element.tagName.toLowerCase(),
			role: roleFor(element),
			name: label || text || element.getAttribute("title") || undefined,
			text,
			label,
			attributes: Object.fromEntries(Array.from(element.attributes).map((attr) => [attr.name, attr.value])),
			selectorCandidates: selectorsFor(element),
			ordinalPath: ordinalPath(element),
			boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			interactive: ["button", "a", "input", "textarea", "select"].includes(element.tagName.toLowerCase())
		});
		if (entries.length >= options.maxEntries) break;
	}
	return { url: location.href, title: document.title, generatedAt: Date.now(), totalCandidates: all.length, truncated: entries.length < all.length, entries };
}`;

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
	const electron = require("electron");
	const app = electron.app;
	const browserWindows = electron.BrowserWindow ? electron.BrowserWindow.getAllWindows() : [];
	let crashDirectory;
	let crashFiles = [];
	try {
		crashDirectory = app.getPath("crashDumps");
		const fs = require("fs");
		crashFiles = fs.existsSync(crashDirectory) ? fs.readdirSync(crashDirectory).slice(0, 200) : [];
	} catch {}
	return {
		windows: browserWindows.map((window) => ({
			id: window.id,
			title: window.getTitle ? window.getTitle() : undefined,
			url: window.webContents && window.webContents.getURL ? window.webContents.getURL() : undefined,
		})),
		paths: {
			appPath: app.getAppPath ? app.getAppPath() : undefined,
			userData: app.getPath ? app.getPath("userData") : undefined,
			exe: app.getPath ? app.getPath("exe") : undefined,
			temp: app.getPath ? app.getPath("temp") : undefined,
		},
		app: {
			name: app.getName ? app.getName() : undefined,
			version: app.getVersion ? app.getVersion() : undefined,
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
