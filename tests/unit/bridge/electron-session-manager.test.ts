import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Window } from "happy-dom";
import { KNOWN_ELECTRON_APPS } from "@shuvgeist/server/electron/app-registry";
import {
	ElectronWsCdpSession,
	type ElectronCdpTransport,
} from "@shuvgeist/driver/websocket-cdp-session";
import {
	type ElectronProcessRow,
	parseRemoteDebuggingPort,
	processIdentityKey,
	processTerminationIdentityKey,
} from "@shuvgeist/server/electron/process-discovery";
import {
	ElectronSessionManager,
	electronSessionTestHooks,
} from "@shuvgeist/server/electron/session-manager";
import type { RecordFrameEventData } from "@shuvgeist/protocol/protocol";
import type { BridgeTarget } from "@shuvgeist/protocol/target";

class FakeElectronCdpTransport implements ElectronCdpTransport {
	readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
	private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
	private readonly closeListeners = new Set<() => void>();
	private closed = false;
	closeCalls = 0;

	constructor(
		private readonly responseFor: (
			method: string,
			params?: Record<string, unknown>,
		) => unknown | Promise<unknown> = () => ({}),
	) {}

	async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
		this.calls.push({ method, params });
		return (await this.responseFor(method, params)) as T;
	}

	on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
		let listeners = this.listeners.get(method);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(method, listeners);
		}
		listeners.add(listener);
		return () => listeners?.delete(listener);
	}

	onClose(listener: () => void): () => void {
		if (this.closed) {
			listener();
			return () => {};
		}
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.closeCalls += 1;
		for (const listener of [...this.closeListeners]) listener();
		this.closeListeners.clear();
	}

	emit(method: string, params: Record<string, unknown> = {}): void {
		for (const listener of this.listeners.get(method) ?? []) listener(params);
	}
}

describe("electron session manager", () => {
	const temporaryDirectories: string[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("parses remote debugging ports from process command lines", () => {
		expect(parseRemoteDebuggingPort("code --remote-debugging-port=9333 --new-window")).toBe(9333);
		expect(parseRemoteDebuggingPort("code --remote-debugging-port 9334")).toBe(9334);
		expect(parseRemoteDebuggingPort("code --disable-gpu")).toBeUndefined();
	});

	it("uses a Chromium /json/version websocket for inspector endpoints", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					Browser: "Chrome/142",
					webSocketDebuggerUrl: "ws://127.0.0.1:9331/devtools/browser/main",
				}),
				{ status: 200 },
			),
		);

		await expect(electronSessionTestHooks.resolveInspectorEndpoint(9331, 10)).resolves.toEqual({
			Browser: "Chrome/142",
			webSocketDebuggerUrl: "ws://127.0.0.1:9331/devtools/browser/main",
		});
	});

	it("falls back to /json/list for Node inspector endpoints", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ Browser: "node.js/v22.22.1", "Protocol-Version": "1.1" }), {
					status: 200,
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify([
						{
							id: "node-target",
							type: "node",
							title: "electron/js2c/browser_init",
							webSocketDebuggerUrl: "ws://127.0.0.1:9331/node-target",
						},
					]),
					{ status: 200 },
				),
			);

		await expect(electronSessionTestHooks.resolveInspectorEndpoint(9331, 10)).resolves.toEqual({
			Browser: "node.js/v22.22.1",
			webSocketDebuggerUrl: "ws://127.0.0.1:9331/node-target",
		});
	});

	it("keeps a wrapper-launched session when CDP is still alive after child exit", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response(JSON.stringify({ Browser: "Chrome/142" }), { status: 200 }),
		);

		await expect(electronSessionTestHooks.shouldDeleteSessionAfterChildExit(9330, 0)).resolves.toBe(false);
	});

	it("deletes a launched session when CDP is gone after child exit", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

		await expect(electronSessionTestHooks.shouldDeleteSessionAfterChildExit(9330, 0)).resolves.toBe(true);
	});

	it("normalizes debugger endpoint aliases", () => {
		expect(
			electronSessionTestHooks.normalizeDebuggerEndpoint("ws://localhost:9333/devtools/browser/live", 9333),
		).toBe("ws://127.0.0.1:9333/devtools/browser/live");
	});

	it("reuses and refreshes a verified endpoint across raw PID and port attaches", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		let browserEndpoint = "ws://localhost:9333/devtools/browser/live";
		let targets = [
			cdpTarget("target-1", "Main"),
			cdpTarget("target-2", "Secondary"),
		];
		mockCdp(() => browserEndpoint, () => targets);
		const manager = verifiedVscodeManager();

		const first = await manager.attach({ pid: 101 });
		browserEndpoint = "ws://127.0.0.1:9333/devtools/browser/live";
		targets = [cdpTarget("target-1", "Main refreshed"), cdpTarget("target-2", "Secondary")];
		const second = await manager.attach({ port: 9333 });

		expect(second.id).toBe(first.id);
		expect(second.windows).toHaveLength(2);
		expect(second.windows[0]?.title).toBe("Main refreshed");
		expect(manager.list()).toHaveLength(1);
	});

	it("discovers and attaches Codex by alias when its launcher exposes a flattened argv field", async () => {
		configurePolicy({ allowlist: ["codex-desktop"] });
		const directory = mkdtempSync(join(tmpdir(), "shuvgeist-codex-app-"));
		temporaryDirectories.push(directory);
		const codexPath = join(directory, "codex-desktop-electron");
		writeFileSync(codexPath, "codex");
		const command = `${codexPath} --no-sandbox --remote-debugging-port=9228`;
		const apps = KNOWN_ELECTRON_APPS.map((app) => ({
			...app,
			paths: {
				...app.paths,
				[process.platform]: app.id === "codex-desktop" ? [codexPath] : [],
			},
		}));
		mockCdp(
			() => "ws://127.0.0.1:9228/devtools/browser/codex",
			() => [cdpTarget("codex-main", "Codex")],
		);
		const manager = new ElectronSessionManager({
			apps,
			listProcesses: async () => [
				{
					pid: 202,
					parentPid: 1,
					command,
					args: [command],
					executablePath: codexPath,
					generation: "codex-1",
				},
			],
			listeningPidsForPort: async () => [202],
		});

		await expect(manager.attach({ appRef: "codex" })).resolves.toMatchObject({
			appId: "codex-desktop",
			appRef: "codex",
			pid: 202,
			port: 9228,
			windows: [expect.objectContaining({ title: "Codex" })],
		});
	});

	it("accepts an inherited listener owned by a verified descendant in the requested process family", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const manager = verifiedVscodeManager({
			listProcesses: async ({ vscode }) => [
				{
					pid: 101,
					parentPid: 1,
					command: `${vscode} --remote-debugging-port=9333`,
					args: [vscode, "--remote-debugging-port=9333"],
					executablePath: vscode,
					generation: "100",
				},
				{
					pid: 102,
					parentPid: 101,
					command: `${vscode} --type=renderer`,
					args: [vscode, "--type=renderer"],
					executablePath: vscode,
					generation: "200",
				},
			],
			listeningPidsForPort: async () => [102],
		});

		await expect(manager.attach({ appRef: "vscode", pid: 101 })).resolves.toMatchObject({ pid: 101 });
	});

	it("accepts many verified descendants even when their executable differs from the app root", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const manager = verifiedVscodeManager({
			listProcesses: async ({ vscode, helper }) => [
				{
					pid: 101,
					parentPid: 1,
					command: `${vscode} --remote-debugging-port=9333`,
					args: [vscode, "--remote-debugging-port=9333"],
					executablePath: vscode,
					generation: "100",
				},
				{ pid: 102, parentPid: 101, command: helper, executablePath: helper, generation: "200" },
				{ pid: 103, parentPid: 102, command: helper, executablePath: helper, generation: "300" },
				{ pid: 104, parentPid: 101, command: helper, executablePath: helper, generation: "250" },
			],
			listeningPidsForPort: async () => [102, 103, 104],
		});

		await expect(manager.attach({ appRef: "vscode", pid: 101 })).resolves.toMatchObject({ pid: 101 });
	});

	it("rejects mixed listener owners for app-qualified, raw-port, and inspector attaches", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const mixedBrowserManager = verifiedVscodeManager({
			listProcesses: async ({ vscode, helper }) => [
				{
					pid: 101,
					parentPid: 1,
					command: `${vscode} --remote-debugging-port=9333`,
					args: [vscode, "--remote-debugging-port=9333"],
					executablePath: vscode,
					generation: "100",
				},
				{ pid: 202, parentPid: 1, command: helper, executablePath: helper, generation: "150" },
			],
			listeningPidsForPort: async () => [101, 202],
		});

		await expect(mixedBrowserManager.attach({ appRef: "vscode", port: 9333 })).rejects.toThrow(
			"mixed or unverifiable listener owners",
		);
		await expect(mixedBrowserManager.attach({ port: 9333 })).rejects.toThrow(
			"mixed or unverifiable listener owners",
		);

		const mixedInspectorManager = verifiedVscodeManager({
			listProcesses: async ({ vscode, helper }) => [
				{
					pid: 101,
					parentPid: 1,
					command: `${vscode} --remote-debugging-port=9333`,
					args: [vscode, "--remote-debugging-port=9333"],
					executablePath: vscode,
					generation: "100",
				},
				{
					pid: 102,
					parentPid: 101,
					command: `${vscode} --inspect=9444`,
					args: [vscode, "--inspect=9444"],
					executablePath: vscode,
					generation: "200",
				},
				{ pid: 202, parentPid: 1, command: helper, executablePath: helper, generation: "150" },
			],
			listeningPidsForPort: async (port) => (port === 9444 ? [102, 202] : [101]),
		});
		await expect(
			mixedInspectorManager.attach({ appRef: "vscode", port: 9333, pid: 101, inspectPort: 9444 }),
		).rejects.toThrow("mixed or unverifiable listener owners");
	});

	it("reports a session live only while its tracked CDP endpoint has a current page", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		let targets: unknown[] = [cdpTarget("target-1", "Main")];
		mockCdp(() => "ws://127.0.0.1:9333/devtools/browser/live", () => targets);
		const manager = verifiedVscodeManager();
		await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });

		await expect(manager.status()).resolves.toEqual([
			expect.objectContaining({
				live: true,
				livePageTargetCount: 1,
				livenessReason: "ok",
			}),
		]);
		targets = [cdpTarget("target-2", "Replacement")];
		const [refreshed] = await manager.status();
		expect(refreshed?.windows).toEqual([
			expect.objectContaining({ ref: "w2", title: "Replacement", isPrimary: true }),
		]);

		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
		const [stale] = await manager.status();
		expect(stale).toEqual(
			expect.objectContaining({
				live: false,
				livePageTargetCount: 0,
				livenessReason: "cdp_unreachable",
			}),
		);
		expect(stale?.windows).toEqual([expect.objectContaining({ ref: "w2", title: "Replacement" })]);
	});

	it("bounds a liveness probe that never responds", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const manager = verifiedVscodeManager({ livenessTimeoutMs: 1 });
		await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		vi.mocked(globalThis.fetch).mockImplementation(
			(_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) return;
					if (signal.aborted) {
						reject(new Error("aborted"));
						return;
					}
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);

		await expect(manager.status()).resolves.toEqual([
			expect.objectContaining({ live: false, livenessReason: "cdp_unreachable" }),
		]);
	});

	it("does not call a reused port or worker-only endpoint live", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		let browserEndpoint = "ws://127.0.0.1:9333/devtools/browser/live";
		let targets: unknown[] = [cdpTarget("target-1", "Main")];
		mockCdp(() => browserEndpoint, () => targets);
		const manager = verifiedVscodeManager();
		await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });

		browserEndpoint = "ws://127.0.0.1:9333/devtools/browser/reused";
		await expect(manager.status()).resolves.toEqual([
			expect.objectContaining({ live: false, livenessReason: "endpoint_changed" }),
		]);

		browserEndpoint = "ws://127.0.0.1:9333/devtools/browser/live";
		targets = [
			{
				id: "worker-1",
				type: "worker",
				title: "Background worker",
				webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/worker/worker-1",
			},
		];
		await expect(manager.status()).resolves.toEqual([
			expect.objectContaining({
				live: false,
				livePageTargetCount: 0,
				livenessReason: "no_page_targets",
			}),
		]);
	});

	it("reports owner-generation changes stale while preserving cached diagnostics", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		let generation = "vscode-1";
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const manager = verifiedVscodeManager({ generation: () => generation });
		await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		generation = "vscode-2";

		await expect(manager.status()).resolves.toEqual([
			expect.objectContaining({
				live: false,
				livenessReason: "endpoint_changed",
				windows: [expect.objectContaining({ title: "Main" })],
			}),
		]);
		expect(manager.list()).toHaveLength(1);
	});

	it("recomputes exactly one primary page from the current target order", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		let targets: unknown[] = [cdpTarget("target-1", "First"), cdpTarget("target-2", "Second")];
		mockCdp(() => "ws://127.0.0.1:9333/devtools/browser/live", () => targets);
		const manager = verifiedVscodeManager();
		await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });

		targets = [cdpTarget("target-2", "Second"), cdpTarget("target-1", "First")];
		const [status] = await manager.status();
		expect(status?.windows.filter((window) => window.isPrimary)).toEqual([
			expect.objectContaining({ title: "Second" }),
		]);
	});

	it("replaces a stale same-port session when the live browser endpoint changes", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		let browserEndpoint = "ws://127.0.0.1:9333/devtools/browser/old";
		mockCdp(() => browserEndpoint, () => [cdpTarget("target-old", "Old")]);
		const manager = verifiedVscodeManager();
		const first = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });

		browserEndpoint = "ws://127.0.0.1:9333/devtools/browser/new";
		const replacement = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });

		expect(replacement.id).not.toBe(first.id);
		expect(manager.list().map((session) => session.id)).toEqual([replacement.id]);
	});

	it("replaces a session when the same PID or browser URL has a new process generation", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		let generation = "vscode-1";
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const manager = verifiedVscodeManager({ generation: () => generation });
		const first = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });

		generation = "vscode-2";
		const replacement = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });

		expect(replacement.id).not.toBe(first.id);
		expect(manager.list().map((session) => session.id)).toEqual([replacement.id]);
	});

	it("detaches a session before renderer access when endpoint ownership changes", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		let generation = "vscode-1";
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const manager = verifiedVscodeManager({ generation: () => generation });
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		generation = "vscode-taken-over";

		await expect(
			manager.evaluate(
				{ kind: "electron-window", sessionId: session.id, windowRef: "w1" },
				"document.title",
			),
		).rejects.toThrow("failed ownership revalidation and was detached");
		expect(manager.list()).toEqual([]);
	});

	it("accepts only a same-family main inspector listener", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const sameFamily = verifiedVscodeManager({
			listProcesses: async ({ vscode }) => [
				{
					pid: 101,
					parentPid: 1,
					command: `${vscode} --remote-debugging-port=9333`,
					args: [vscode, "--remote-debugging-port=9333"],
					executablePath: vscode,
					generation: "100",
				},
				{
					pid: 102,
					parentPid: 101,
					command: `${vscode} --inspect=9444`,
					args: [vscode, "--inspect=9444"],
					executablePath: vscode,
					generation: "200",
				},
			],
			listeningPidsForPort: async (port) => (port === 9444 ? [102] : [101]),
		});
		await expect(
			sameFamily.attach({ appRef: "vscode", port: 9333, pid: 101, inspectPort: 9444 }),
		).resolves.toMatchObject({ mainInspector: { port: 9444, available: true } });

		const differentFamily = verifiedVscodeManager({
			listProcesses: async ({ vscode }) => [
				{
					pid: 101,
					parentPid: 1,
					command: `${vscode} --remote-debugging-port=9333`,
					args: [vscode, "--remote-debugging-port=9333"],
					executablePath: vscode,
					generation: "family-a",
				},
				{
					pid: 202,
					parentPid: 1,
					command: `${vscode} --inspect=9444`,
					args: [vscode, "--inspect=9444"],
					executablePath: vscode,
					generation: "family-b",
				},
			],
			listeningPidsForPort: async (port) => (port === 9444 ? [202] : [101]),
		});
		await expect(
			differentFamily.attach({ appRef: "vscode", port: 9333, pid: 101, inspectPort: 9444 }),
		).rejects.toThrow("not owned by the same 'com.microsoft.VSCode' process family");
	});

	it("creates a new session after an explicit detach", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const manager = verifiedVscodeManager();
		const first = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });

		expect(manager.detach(first.id)).toBe(true);
		const second = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });

		expect(second.id).not.toBe(first.id);
		expect(manager.list()).toHaveLength(1);
	});

	it("does not terminate a reused PID when its canonical executable identity changed", async () => {
		const directory = mkdtempSync(join(tmpdir(), "shuvgeist-electron-launch-identity-"));
		temporaryDirectories.push(directory);
		const launchedExecutable = join(directory, "Launched Electron");
		const replacementExecutable = join(directory, "Replacement Process");
		writeFileSync(launchedExecutable, "launched");
		writeFileSync(replacementExecutable, "replacement");
		const generation = "4242";
		const launchIdentityKey = processIdentityKey({
			pid: 401,
			command: launchedExecutable,
			executablePath: launchedExecutable,
			generation,
		});
		if (!launchIdentityKey) throw new Error("failed to create launch identity fixture");
		const manager = new ElectronSessionManager({
			listProcesses: async () => [
				{
					pid: 401,
					command: replacementExecutable,
					executablePath: replacementExecutable,
					generation,
				},
			],
		});
		const kill = vi.fn(() => true);
		const internals = manager as unknown as {
			terminateOwnedLaunchProcess: (
				child: { pid: number; exitCode: number | null; killed: boolean; kill: (signal: string) => boolean },
				identityKey: string | undefined,
			) => Promise<void>;
		};

		await internals.terminateOwnedLaunchProcess(
			{ pid: 401, exitCode: null, killed: false, kill },
			launchIdentityKey,
		);

		expect(kill).not.toHaveBeenCalled();
	});

	it("does not terminate a same-executable PID replacement under coarse macOS generation precision", async () => {
		const directory = mkdtempSync(join(tmpdir(), "shuvgeist-electron-coarse-launch-identity-"));
		temporaryDirectories.push(directory);
		const executablePath = join(directory, "Electron");
		writeFileSync(executablePath, "electron");
		const processRow = {
			pid: 402,
			command: executablePath,
			executablePath,
			generation: "Tue Jul 21 18:00:00 2026",
		};
		const launchIdentityKey = processTerminationIdentityKey(processRow);
		expect(launchIdentityKey).toBeUndefined();
		const manager = new ElectronSessionManager({ listProcesses: async () => [processRow] });
		const kill = vi.fn(() => true);
		const internals = manager as unknown as {
			terminateOwnedLaunchProcess: (
				child: { pid: number; exitCode: number | null; killed: boolean; kill: (signal: string) => boolean },
				identityKey: string | undefined,
			) => Promise<void>;
		};

		await internals.terminateOwnedLaunchProcess(
			{ pid: 402, exitCode: null, killed: false, kill },
			launchIdentityKey,
		);

		expect(kill).not.toHaveBeenCalled();
	});

	it("retains the prior session when a transient reattach probe cannot reach CDP", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const manager = verifiedVscodeManager({ attachTimeoutMs: 1 });
		const first = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		vi.mocked(globalThis.fetch).mockRejectedValue(new Error("connection refused"));

		await expect(manager.attach({ appRef: "vscode", port: 9333, pid: 101 })).rejects.toThrow(
			"No Electron CDP endpoint responded on port 9333",
		);
		expect(manager.list()).toEqual([expect.objectContaining({ id: first.id })]);
	});

	it("denies unknown raw endpoints and app identities that do not own the port", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode", "com.tinyspeck.slackmacgap"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const unknownManager = new ElectronSessionManager({
			listProcesses: async () => [
				{
					pid: 202,
					command: "/opt/mystery-app --remote-debugging-port=9333",
					args: ["/opt/mystery-app", "--remote-debugging-port=9333"],
					executablePath: "/opt/mystery-app",
					generation: "mystery-1",
				},
			],
			listeningPidsForPort: async () => [202],
		});

		await expect(unknownManager.attach({ port: 9333 })).rejects.toThrow("identity for CDP port 9333 is unknown");
		await expect(unknownManager.attach({ pid: 202 })).rejects.toThrow("does not canonically identify");
		await expect(verifiedVscodeManager().attach({ appRef: "slack", port: 9333, pid: 101 })).rejects.toThrow(
			"does not canonically identify 'com.tinyspeck.slackmacgap'",
		);
	});

	it("retains the allowlist gate for a verified known endpoint", async () => {
		configurePolicy({ allowlist: [] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);

		await expect(verifiedVscodeManager().attach({ appRef: "vscode", port: 9333, pid: 101 })).rejects.toThrow(
			"Electron app 'com.microsoft.VSCode' is not allowlisted",
		);
	});

	it("fails closed when listener tooling is unavailable", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const manager = verifiedVscodeManager({ listeningPidsForPort: async () => undefined });

		await expect(manager.attach({ appRef: "vscode", port: 9333, pid: 101 })).rejects.toThrow(
			"Cannot verify which process owns Electron CDP port 9333",
		);
		expect(manager.list()).toEqual([]);
	});

	it("revalidates the allowlist before later renderer actions", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const manager = verifiedVscodeManager();
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		configurePolicy({ allowlist: [] });

		await expect(
			manager.screenshot({ kind: "electron-window", sessionId: session.id, windowRef: "w1" }),
		).rejects.toThrow("is not allowlisted");
		expect(manager.list()).toEqual([]);
	});

	it("fails closed when policy becomes malformed after a session is attached", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const manager = verifiedVscodeManager();
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		const path = process.env.SHUVGEIST_BRIDGE_CONFIG;
		if (!path) throw new Error("test bridge config path was not set");
		writeFileSync(path, '{ "electron": ');

		await expect(
			manager.evaluate(
				{ kind: "electron-window", sessionId: session.id, windowRef: "w1" },
				"document.title",
			),
		).rejects.toMatchObject({ code: "INVALID_JSON", path });
	});

	it("fails closed before main-inspector capability access when policy is malformed", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const manager = verifiedVscodeManager();
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		const path = process.env.SHUVGEIST_BRIDGE_CONFIG;
		if (!path) throw new Error("test bridge config path was not set");
		writeFileSync(path, '{ "electron": ');

		await expect(manager.mainInfo(session.id)).rejects.toMatchObject({ code: "INVALID_JSON", path });
	});

	it("disposes a cached page driver exactly once when its session detaches", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const transport = new FakeElectronCdpTransport((_method) => snapshotEvaluateResponse());
		const connectPage = vi.fn(
			async (_url: string, targetId: string) => new ElectronWsCdpSession({ transport, targetId }),
		);
		const manager = verifiedVscodeManager({ connectPage });
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		const target = { kind: "electron-window" as const, sessionId: session.id, windowRef: "w1" };

		await manager.snapshot(target, {});
		expect(connectPage).toHaveBeenCalledOnce();
		expect(manager.detach(session.id)).toBe(true);
		expect(manager.detach(session.id)).toBe(false);
		await manager.dispose();

		expect(transport.closeCalls).toBe(1);
	});

	it("enforces sensitive Electron capability policy at operation boundaries", async () => {
		configurePolicy({
			allowlist: ["com.microsoft.VSCode"],
			capabilities: {
				"com.microsoft.VSCode": {
					eval: false,
					main_inspect: false,
					ipc_tap: false,
					main_network_tap: false,
				},
			},
		});
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const manager = verifiedVscodeManager();
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		const target = { kind: "electron-window" as const, sessionId: session.id, windowRef: "w1" };

		await expect(manager.evaluate(target, "document.title")).rejects.toThrow(
			"Electron capability 'eval' is disabled",
		);
		await expect(manager.mainInfo(session.id)).rejects.toThrow("Electron capability 'main_inspect' is disabled");
		await expect(manager.startIpcTap(session.id)).rejects.toThrow("Electron capability 'ipc_tap' is disabled");
		await expect(manager.startMainNetworkTap(session.id)).rejects.toThrow(
			"Electron capability 'main_network_tap' is disabled",
		);
	});

	it("routes renderer eval through the persistent PageDriver without changing output semantics", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const transport = new FakeElectronCdpTransport((method) =>
			method === "Runtime.evaluate" ? { result: { value: { ok: true } } } : {},
		);
		const connectPage = vi.fn(
			async (_url: string, targetId: string) => new ElectronWsCdpSession({ transport, targetId }),
		);
		const manager = verifiedVscodeManager({ connectPage });
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		const target = { kind: "electron-window" as const, sessionId: session.id, windowRef: "w1" };

		await expect(manager.evaluate(target, "app.value()")).resolves.toMatchObject({
			output: '{"ok":true}',
			result: { ok: true },
		});
		expect(connectPage).toHaveBeenCalledOnce();
		expect(transport.calls.filter((call) => call.method === "Page.enable")).toHaveLength(1);
		expect(transport.calls.find((call) => call.method === "Runtime.evaluate")).toMatchObject({
			params: { expression: expect.stringContaining("app.value()"), awaitPromise: true, returnByValue: true },
		});
		await manager.dispose();
	});

	it("validates every supplied Electron session and window identity component", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main"), cdpTarget("target-2", "Secondary")],
		);
		const transport = new FakeElectronCdpTransport((_method) => snapshotEvaluateResponse());
		const connectPage = vi.fn(
			async (_url: string, targetId: string) => new ElectronWsCdpSession({ transport, targetId }),
		);
		const manager = verifiedVscodeManager({ connectPage });
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });

		await expect(
			manager.snapshot(
				{
					kind: "electron-window",
					sessionId: session.id,
					appRef: "slack",
					windowRef: "w1",
					targetId: "target-1",
				},
				{},
			),
		).rejects.toThrow("No Electron session attached");
		await expect(
			manager.snapshot(
				{
					kind: "electron-window",
					sessionId: session.id,
					appRef: "vscode",
					windowRef: "w1",
					targetId: "target-2",
				},
				{},
			),
		).rejects.toThrow("No Electron session attached");
		await expect(
			manager.snapshot(
				{
					kind: "electron-window",
					sessionId: session.id,
					appRef: "vscode",
					windowRef: "w1",
					targetId: "target-1",
				},
				{},
			),
		).resolves.toMatchObject({ target: { sessionId: session.id, windowRef: "w1", targetId: "target-1" } });
		expect(connectPage).toHaveBeenCalledOnce();
		await manager.dispose();
	});

	it("rejects nonzero Electron frames before any shared PageDriver page command", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const connectPage = vi.fn(
			async (_url: string, targetId: string) =>
				new ElectronWsCdpSession({ transport: new FakeElectronCdpTransport(), targetId }),
		);
		const manager = verifiedVscodeManager({ connectPage });
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		const target = { kind: "electron-window" as const, sessionId: session.id, windowRef: "w1" };

		await expect(manager.snapshot(target, { frameId: 1 })).rejects.toThrow("only the top frame");
		await expect(manager.locateByRole(target, { role: "button", frameId: 2 })).rejects.toThrow("only the top frame");
		await expect(manager.refClick(target, { refId: "ref-1", frameId: 3 })).rejects.toThrow("only the top frame");
		await expect(manager.assert(target, { kind: "text", text: "Ready", frameId: 4 })).rejects.toThrow(
			"only the top frame",
		);
		await expect(manager.screenshot(target, undefined, 5)).rejects.toThrow("only the top frame");
		await expect(manager.evaluate(target, "document.title", 6)).rejects.toThrow("only the top frame");
		await expect(manager.recordStart(target, { frameId: 7 }, vi.fn())).rejects.toThrow("only the top frame");
		await expect(manager.recordStop(target, 8)).rejects.toThrow("only the top frame");
		await expect(manager.recordStatus(target, 9)).rejects.toThrow("only the top frame");
		await expect(manager.snapshot({ ...target, frameId: 10 } as BridgeTarget, {})).rejects.toThrow(
			"only the top frame",
		);
		expect(connectPage).not.toHaveBeenCalled();
		await manager.dispose();
	});

	it("rejects non-page CDP targets for PageDriver commands and trusted input", async () => {
		configurePolicy({
			allowlist: ["com.microsoft.VSCode"],
			capabilities: { "com.microsoft.VSCode": { cdp_input: true } },
		});
		let targetType = "page";
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [{ ...cdpTarget("target-1", "Main"), type: targetType }],
		);
		const transport = new FakeElectronCdpTransport((method, params) =>
			method === "Runtime.evaluate" ? pageRuntimeEvaluateResponse(params) : {},
		);
		const connectPage = vi.fn(
			async (_url: string, targetId: string) => new ElectronWsCdpSession({ transport, targetId }),
		);
		const manager = verifiedVscodeManager({ connectPage });
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		const target = { kind: "electron-window" as const, sessionId: session.id, windowRef: "w1" };
		const snapshot = await manager.snapshot(target, {});
		const refId = snapshot.entries[0]?.snapshotId;
		if (!refId) throw new Error("missing snapshot ref fixture");

		targetType = "service_worker";
		await expect(manager.snapshot(target, {})).rejects.toThrow("renderer page commands require a 'page' target");
		await expect(manager.refClick(target, { refId, trusted: true })).rejects.toThrow(
			"renderer page commands require a 'page' target",
		);
		expect(transport.calls.some((call) => call.method.startsWith("Input."))).toBe(false);
		await manager.dispose();
	});

	it("requires explicit cdp_input opt-in after fresh target revalidation", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const transport = new FakeElectronCdpTransport((method, params) =>
			method === "Runtime.evaluate" ? pageRuntimeEvaluateResponse(params) : {},
		);
		const manager = verifiedVscodeManager({
			connectPage: async (_url, targetId) => new ElectronWsCdpSession({ transport, targetId }),
		});
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		const target = { kind: "electron-window" as const, sessionId: session.id, windowRef: "w1" };
		const snapshot = await manager.snapshot(target, {});
		const refId = snapshot.entries[0]?.snapshotId;
		if (!refId) throw new Error("missing snapshot ref fixture");

		const denied = await manager.refClick(target, { refId, trusted: true });
		expect(denied).toMatchObject({ ok: false, reason: "capability_denied" });
		expect(transport.calls.some((call) => call.method.startsWith("Input."))).toBe(false);

		configurePolicy({
			allowlist: ["com.microsoft.VSCode"],
			capabilities: { "com.microsoft.VSCode": { cdp_input: true } },
		});
		const allowed = await manager.refClick(target, { refId, trusted: true });
		expect(allowed).toMatchObject({ ok: true, mode: "cdp-trusted" });
		expect(transport.calls.filter((call) => call.method === "Input.dispatchMouseEvent")).toHaveLength(3);
		await expect(manager.refClick(target, { refId, native: true })).rejects.toThrow(
			"Use --trusted/--cdp-input",
		);
		await manager.dispose();
	});

	it("keeps navigation generation on the cached driver and rejects stale refs without acting", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const transport = new FakeElectronCdpTransport((method, params) =>
			method === "Runtime.evaluate" ? pageRuntimeEvaluateResponse(params) : {},
		);
		const connectPage = vi.fn(
			async (_url: string, targetId: string) => new ElectronWsCdpSession({ transport, targetId }),
		);
		const manager = verifiedVscodeManager({ connectPage });
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		const target = { kind: "electron-window" as const, sessionId: session.id, windowRef: "w1" };
		const snapshot = await manager.snapshot(target, {});
		const refId = snapshot.entries[0]?.snapshotId;
		if (!refId) throw new Error("missing snapshot ref fixture");
		const evaluationsBeforeNavigation = transport.calls.filter((call) => call.method === "Runtime.evaluate").length;

		transport.emit("Page.frameNavigated", { frame: { id: "main" } });
		const result = await manager.refClick(target, { refId });

		expect(result).toMatchObject({ ok: false, reason: "stale_generation", navigationGeneration: 1 });
		expect(transport.calls.filter((call) => call.method === "Runtime.evaluate")).toHaveLength(
			evaluationsBeforeNavigation,
		);
		expect(connectPage).toHaveBeenCalledOnce();
		await manager.dispose();
	});

	it("uses the shared network engine and redacts curl secrets by default", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const transport = new FakeElectronCdpTransport();
		const manager = verifiedVscodeManager({
			connectPage: async (_url, targetId) => new ElectronWsCdpSession({ transport, targetId }),
		});
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		const target = { kind: "electron-window" as const, sessionId: session.id, windowRef: "w1" };
		await manager.networkStart(target, {});
		transport.emit("Network.requestWillBeSent", {
			requestId: "req-1",
			request: {
				method: "POST",
				url: "https://example.test/api",
				headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
				postData: '{"ok":true}',
			},
		});

		const redacted = await manager.networkCurl(target, { requestId: "req-1" });
		expect(redacted.command).toContain("Authorization: <redacted>");
		expect(redacted.command).not.toContain("Bearer secret");
		expect(redacted.redactedHeaders).toEqual(["Authorization"]);
		expect("tabId" in redacted).toBe(false);
		const sensitive = await manager.networkCurl(target, { requestId: "req-1", includeSensitive: true });
		expect(sensitive.command).toContain("Bearer secret");
		await manager.dispose();
	});

	it("maps page-local screencast frames, status, and stop without a tab sentinel", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const transport = new FakeElectronCdpTransport();
		const manager = verifiedVscodeManager({
			connectPage: async (_url, targetId) => new ElectronWsCdpSession({ transport, targetId }),
		});
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		const target = { kind: "electron-window" as const, sessionId: session.id, windowRef: "w1" };
		const events: RecordFrameEventData[] = [];
		const started = await manager.recordStart(target, { maxDurationMs: 5_000 }, (event) => events.push(event));
		transport.emit("Page.screencastFrame", { sessionId: 7, data: "AQID" });
		await vi.waitFor(() => expect(events).toHaveLength(1));

		const status = await manager.recordStatus(target);
		expect(status).toMatchObject({ active: true, recordingId: started.recordingId, sourceBytes: 3, frameCount: 1 });
		expect("tabId" in status).toBe(false);
		const stopped = await manager.recordStop(target);
		expect(stopped).toMatchObject({ outcome: "stopped_user", sourceBytes: 3, frameCount: 1 });
		expect("sizeBytes" in stopped).toBe(false);
		expect(events).toHaveLength(2);
		expect(events[1]).toMatchObject({
			final: true,
			target: { kind: "electron-window" },
			summary: { sourceBytes: 3, frameCount: 1 },
		});
		await manager.dispose();
	});

	it("preserves a target-closed recording outcome and emits one final event", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const transport = new FakeElectronCdpTransport();
		const manager = verifiedVscodeManager({
			connectPage: async (_url, targetId) => new ElectronWsCdpSession({ transport, targetId }),
		});
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		const target = { kind: "electron-window" as const, sessionId: session.id, windowRef: "w1" };
		const events: RecordFrameEventData[] = [];
		await manager.recordStart(target, { maxDurationMs: 5_000 }, (event) => events.push(event));

		transport.close();
		await vi.waitFor(() =>
			expect(events.filter((event) => event.final)).toEqual([
				expect.objectContaining({ summary: expect.objectContaining({ outcome: "stopped_target_closed" }) }),
			]),
		);
		await manager.dispose();
		expect(transport.closeCalls).toBe(1);
	});

	it("filters captured snapshots by query while preserving ancestors", async () => {
		configurePolicy({ allowlist: ["com.microsoft.VSCode"] });
		mockCdp(
			() => "ws://127.0.0.1:9333/devtools/browser/live",
			() => [cdpTarget("target-1", "Main")],
		);
		const fixtureWindow = new Window({ url: "https://example.test/settings" });
		fixtureWindow.document.title = "Settings";
		fixtureWindow.document.body.innerHTML =
			'<main><button id="save">Save billing settings</button></main><button id="cancel">Cancel</button>';
		let runtimeExpression = "";
		const transport = new FakeElectronCdpTransport(async (method, params) => {
			if (method !== "Runtime.evaluate") return {};
			runtimeExpression = String(params?.expression ?? "");
			const evaluate = Function(
				"window",
				"document",
				"location",
				"HTMLElement",
				"HTMLInputElement",
				"HTMLTextAreaElement",
				"HTMLSelectElement",
				`return ${runtimeExpression}`,
			);
			return {
				result: {
					value: await evaluate(
						fixtureWindow,
						fixtureWindow.document,
						fixtureWindow.location,
						fixtureWindow.HTMLElement,
						fixtureWindow.HTMLInputElement,
						fixtureWindow.HTMLTextAreaElement,
						fixtureWindow.HTMLSelectElement,
					),
				},
			};
		});
		const connectPage = vi.fn(
			async (_url: string, targetId: string) => new ElectronWsCdpSession({ transport, targetId }),
		);
		const manager = verifiedVscodeManager({ connectPage });
		const session = await manager.attach({ appRef: "vscode", port: 9333, pid: 101 });
		const target = { kind: "electron-window" as const, sessionId: session.id, windowRef: "w1" };
		const snapshot = await manager.snapshot(target, { query: "billing", maxEntries: 1, includeHidden: true });

		expect(snapshot.query).toBe("billing");
		expect(snapshot.target).toEqual({
			kind: "electron-window",
			sessionId: session.id,
			windowRef: "w1",
			targetId: "target-1",
		});
		expect(snapshot.entries.some((entry) => entry.tagName === "button" && entry.text?.includes("billing"))).toBe(
			true,
		);
		expect(snapshot.entries.some((entry) => entry.text === "Cancel")).toBe(false);
		expect("tabId" in snapshot).toBe(false);
		expect(snapshot.entries.every((entry) => !("tabId" in entry) && entry.frameId === 0)).toBe(true);
		expect(runtimeExpression).not.toContain("const __name = (fn) => fn");
		await manager.networkStats(target);
		expect(connectPage).toHaveBeenCalledOnce();
		await manager.dispose();
		expect(transport.closeCalls).toBe(1);
		fixtureWindow.close();
	});

	function configurePolicy(electron: {
		allowlist: string[];
		capabilities?: Record<string, Record<string, boolean>>;
	}): void {
		let path = process.env.SHUVGEIST_BRIDGE_CONFIG;
		if (!path) {
			const directory = mkdtempSync(join(tmpdir(), "shuvgeist-electron-session-manager-"));
			temporaryDirectories.push(directory);
			path = join(directory, "bridge.json");
			vi.stubEnv("SHUVGEIST_BRIDGE_CONFIG", path);
		}
		writeFileSync(path, JSON.stringify({ electron }));
	}

	function verifiedVscodeManager(
		options: {
			generation?: () => string;
			listProcesses?: (paths: { vscode: string; slack: string; helper: string }) => Promise<ElectronProcessRow[]>;
			listeningPidsForPort?: (port: number) => Promise<number[] | undefined>;
			connectPage?: (url: string, targetId: string) => Promise<ElectronWsCdpSession>;
			attachTimeoutMs?: number;
			livenessTimeoutMs?: number;
		} = {},
	): ElectronSessionManager {
		const directory = mkdtempSync(join(tmpdir(), "shuvgeist-electron-apps-"));
		temporaryDirectories.push(directory);
		const vscodePath = join(directory, "Visual Studio Code");
		const slackPath = join(directory, "Slack");
		const helperPath = join(directory, "Electron Helper");
		writeFileSync(vscodePath, "vscode");
		writeFileSync(slackPath, "slack");
		writeFileSync(helperPath, "helper");
		const apps = KNOWN_ELECTRON_APPS.map((app) => ({
			...app,
			paths: {
				...app.paths,
				[process.platform]:
					app.id === "com.microsoft.VSCode"
						? [vscodePath]
						: app.id === "com.tinyspeck.slackmacgap"
							? [slackPath]
							: [],
				},
			}));
		const injectedListProcesses = options.listProcesses;
		return new ElectronSessionManager({
			apps,
			connectPage: options.connectPage,
			attachTimeoutMs: options.attachTimeoutMs,
			livenessTimeoutMs: options.livenessTimeoutMs,
			listProcesses: injectedListProcesses
				? () => injectedListProcesses({ vscode: vscodePath, slack: slackPath, helper: helperPath })
				: async () => [
						{
							pid: 101,
							parentPid: 1,
							command: `${vscodePath} --remote-debugging-port=9333`,
							args: [vscodePath, "--remote-debugging-port=9333"],
							executablePath: vscodePath,
							generation: options.generation?.() ?? "vscode-1",
						},
					],
			listeningPidsForPort: options.listeningPidsForPort ?? (async () => [101]),
		});
	}

	function mockCdp(endpoint: () => string, targets: () => unknown[]): void {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith("/json/version")) {
				return new Response(JSON.stringify({ Browser: "Electron/30", webSocketDebuggerUrl: endpoint() }), {
					status: 200,
				});
			}
			if (url.endsWith("/json/list")) return new Response(JSON.stringify(targets()), { status: 200 });
			return new Response("{}", { status: 404 });
		});
	}

	function cdpTarget(id: string, title: string): Record<string, unknown> {
		return {
			id,
			type: "page",
			title,
			url: `app://${id}`,
			webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/${id}`,
		};
	}

	function snapshotEvaluateResponse(snapshotId = "stored-ref"): Record<string, unknown> {
		return {
			result: {
				value: {
					success: true,
					result: {
						url: "app://target-1",
						title: "Main",
						generatedAt: Date.now(),
						totalCandidates: 1,
						truncated: false,
						entries: [snapshotEntry(snapshotId)],
					},
				},
			},
		};
	}

	function pageRuntimeEvaluateResponse(params?: Record<string, unknown>): Record<string, unknown> {
		const expression = String(params?.expression ?? "");
		if (!expression.includes("__SHUVGEIST_INJECTED_PAGE_REF_ACTION__")) return snapshotEvaluateResponse();
		return {
			result: {
				value: {
					ok: true,
					operation: "resolve",
					match: { entry: snapshotEntry("fresh-ref"), score: 1, reasons: ["stable-id"] },
				},
			},
		};
	}

	function snapshotEntry(snapshotId: string): Record<string, unknown> {
		return {
			snapshotId,
			stableElementId: "save-action",
			frameId: 0,
			tagName: "button",
			role: "button",
			name: "Save",
			text: "Save",
			attributes: { id: "save" },
			selectorCandidates: ["#save"],
			ordinalPath: [0],
			boundingBox: { x: 10, y: 20, width: 100, height: 32 },
			interactive: true,
		};
	}
});
