/** Background-owned adapter for privileged Agent page operations. */
import { RuntimeMessageBridge } from "@shuv1337/pi-web-ui/sandbox/RuntimeMessageBridge.js";
import type { BrowserJsWrapperResult } from "@shuvgeist/driver/injected-contracts";
import type { BridgeTelemetry, TraceContext } from "@shuvgeist/protocol/telemetry";
import { getShuvgeistStorage } from "../storage/app-storage.js";
import { isProtectedTabUrl, resolveTabTarget } from "../tools/helpers/browser-target.js";
import { getSharedDebuggerManager } from "../tools/helpers/debugger-manager.js";
import { executePageFunction } from "../tools/helpers/page-execution.js";
import { NativeInputEventsRuntimeProvider } from "../tools/NativeInputEventsRuntimeProvider.js";
import { type NavigateParams, NavigateTool } from "../tools/navigate.js";
import { buildBrowserJsWrapperFunctionCode, checkUserScriptsAvailability } from "../tools/repl/userscripts-helpers.js";
import type { BackgroundPageRuntimeResponse, BackgroundPageRuntimeType } from "./internal-messages.js";

// ---------------------------------------------------------------------------
// Active execution registry
//
// While a background-initiated chrome.userScripts.execute() call is running,
// the injected user script may call helpers like `nativeClick()` which, via
// the injected bridge, post back through chrome.runtime.sendMessage. Those
// messages arrive on the chrome.runtime.onUserScriptMessage listener owned by
// src/background.ts. We register per-execution handlers here so the main
// listener can route to us.
// ---------------------------------------------------------------------------

const activeExecutions = new Map<
	string,
	{
		nativeInput: NativeInputEventsRuntimeProvider;
		artifacts: {
			contents: Record<string, string>;
			mutations: NonNullable<BackgroundPageRuntimeResponse["artifactMutations"]>;
		};
	}
>();

function abortError(): Error {
	const error = new Error("Background page operation was aborted");
	error.name = "AbortError";
	return error;
}

async function awaitAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw abortError();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * Chrome.runtime.onUserScriptMessage entrypoint. The background listener calls
 * this for every incoming user-script message and falls through to its own
 * default handling only if we return `false`.
 */
export function resolveBackgroundUserScriptMessage(
	message: Record<string, unknown>,
	_sender: chrome.runtime.MessageSender,
	sendResponse: (response: unknown) => void,
): boolean {
	const sandboxId = typeof message?.sandboxId === "string" ? (message.sandboxId as string) : undefined;
	if (!sandboxId) return false;
	const entry = activeExecutions.get(sandboxId);
	if (!entry) return false;

	// Native-input calls issued from inside skill library code while a
	// background-initiated execute() is running.
	if (message.type === "native-input") {
		void entry.nativeInput.handleMessage(message, (response) => {
			sendResponse({ ...(response as object), sandboxId });
		});
		return true; // async
	}

	if (message.type === "artifact-operation") {
		const action = message.action;
		const filename = typeof message.filename === "string" ? message.filename : undefined;
		try {
			switch (action) {
				case "list":
					sendResponse({ success: true, result: Object.keys(entry.artifacts.contents), sandboxId });
					return true;
				case "get":
					if (!filename) throw new Error("Artifact get requires filename");
					if (!Object.hasOwn(entry.artifacts.contents, filename)) {
						throw new Error(`Artifact not found: ${filename}`);
					}
					sendResponse({ success: true, result: entry.artifacts.contents[filename], sandboxId });
					return true;
				case "createOrUpdate": {
					if (!filename || typeof message.content !== "string") {
						throw new Error("Artifact write requires filename and content");
					}
					entry.artifacts.contents[filename] = message.content;
					entry.artifacts.mutations.push({
						action: "put",
						filename,
						content: message.content,
						...(typeof message.mimeType === "string" ? { mimeType: message.mimeType } : {}),
					});
					sendResponse({ success: true, result: null, sandboxId });
					return true;
				}
				case "delete":
					if (!filename) throw new Error("Artifact delete requires filename");
					if (!Object.hasOwn(entry.artifacts.contents, filename)) {
						throw new Error(`Artifact not found: ${filename}`);
					}
					delete entry.artifacts.contents[filename];
					entry.artifacts.mutations.push({ action: "delete", filename });
					sendResponse({ success: true, result: null, sandboxId });
					return true;
				default:
					throw new Error(`Unknown artifact action: ${String(action)}`);
			}
		} catch (error) {
			sendResponse({ success: false, error: error instanceof Error ? error.message : String(error), sandboxId });
			return true;
		}
	}

	// Console messages are captured inline in executePageFunction's wrapper;
	// still ack them to avoid "receiving end does not exist" warnings
	// when user skill code happens to call sendRuntimeMessage({type: "console"}).
	if (message.type === "console") {
		sendResponse({ success: true, sandboxId });
		return true;
	}

	return false;
}

function buildProviderSetupCode(payload: Record<string, unknown>, sandboxId: string): string {
	const setup: string[] = [];
	const providerData = payload.providerData;
	if (providerData && typeof providerData === "object" && !Array.isArray(providerData)) {
		for (const [key, value] of Object.entries(providerData)) {
			const serialized = JSON.stringify(value);
			if (serialized !== undefined) setup.push(`window[${JSON.stringify(key)}] = ${serialized};`);
		}
	}
	if (Array.isArray(payload.providerRuntimes)) {
		for (const runtime of payload.providerRuntimes) {
			if (typeof runtime === "string" && runtime.trim()) {
				setup.push(`(${runtime})(${JSON.stringify(sandboxId)});`);
			}
		}
	}
	return setup.join("\n");
}

function initialArtifactContents(payload: Record<string, unknown>): Record<string, string> {
	const providerData = payload.providerData;
	if (!providerData || typeof providerData !== "object" || Array.isArray(providerData)) return {};
	const artifacts = (providerData as Record<string, unknown>).artifacts;
	if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return {};
	const contents: Record<string, string> = {};
	for (const [filename, content] of Object.entries(artifacts)) {
		if (typeof content === "string") contents[filename] = content;
	}
	return contents;
}

// ---------------------------------------------------------------------------
// browserjs handler
// ---------------------------------------------------------------------------

const FIXED_WORLD_ID = "shuvgeist-browser-script";

export async function handleBgBrowserJs(
	payload: Record<string, unknown>,
	windowId: number | undefined,
	telemetry?: BridgeTelemetry,
	traceContext?: TraceContext,
	signal?: AbortSignal,
): Promise<BackgroundPageRuntimeResponse> {
	if (signal?.aborted) return { success: false, error: "Background page operation was aborted", cancelled: true };
	const apiCheck = await checkUserScriptsAvailability();
	if (!apiCheck.available) {
		return { success: false, error: apiCheck.message || "userScripts API not available" };
	}

	let tab: chrome.tabs.Tab;
	let tabId: number;
	const targetTabId = typeof payload.tabId === "number" ? payload.tabId : undefined;
	const targetFrameId = typeof payload.frameId === "number" ? payload.frameId : undefined;
	try {
		const resolved = await resolveTabTarget({ windowId, tabId: targetTabId, frameId: targetFrameId });
		tab = resolved.tab;
		tabId = resolved.tabId;
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : "No active tab found" };
	}

	if (isProtectedTabUrl(tab.url)) {
		return {
			success: false,
			error: `Cannot execute scripts on ${tab.url}. Extension pages and internal URLs are protected.`,
		};
	}

	// Load domain-scoped skill libraries via the IndexedDB-backed store. The
	// background service worker has IndexedDB so this works even with the
	// sidepanel closed.
	let skillLibrary = "";
	try {
		const skillsRepo = getShuvgeistStorage().skills;
		if (tab.url) {
			const matchingSkills = await skillsRepo.getSkillsForUrl(tab.url);
			if (matchingSkills.length > 0) {
				skillLibrary = `${matchingSkills.map((s) => s.library).join("\n\n")}\n\n`;
			}
		}
	} catch (err) {
		console.warn("[BackgroundPageRuntime] Failed to load skills for url:", err);
	}

	const code = typeof payload.code === "string" ? (payload.code as string) : "";
	if (!code) {
		return { success: false, error: "browserjs() requires code" };
	}

	let parsedArgs: unknown[] = [];
	if (typeof payload.args === "string" && payload.args) {
		try {
			parsedArgs = JSON.parse(payload.args as string) as unknown[];
		} catch (err) {
			return { success: false, error: `Failed to parse arguments: ${err instanceof Error ? err.message : err}` };
		}
	}

	const execSandboxId = `bg_browserjs_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
	const artifactMutations: NonNullable<BackgroundPageRuntimeResponse["artifactMutations"]> = [];
	const includeArtifactMutations = (response: BackgroundPageRuntimeResponse): BackgroundPageRuntimeResponse =>
		artifactMutations.length > 0 ? { ...response, artifactMutations: [...artifactMutations] } : response;

	// Register for nested native-input routing during the userScripts.execute()
	// call. Skill code inside browserjs() may call nativeClick() which goes
	// through chrome.runtime.sendMessage -> onUserScriptMessage.
	activeExecutions.set(execSandboxId, {
		nativeInput: new NativeInputEventsRuntimeProvider({
			windowId,
			tabId,
			frameId: targetFrameId,
			debuggerManager: getSharedDebuggerManager(),
			telemetry,
			traceContext,
		}),
		artifacts: { contents: initialArtifactContents(payload), mutations: artifactMutations },
	});

	try {
		const bridgeCode = RuntimeMessageBridge.generateBridgeCode({
			context: "user-script",
			sandboxId: execSandboxId,
		});
		const nativeInputRuntime = new NativeInputEventsRuntimeProvider().getRuntime();
		const nativeInputSetup = `(${nativeInputRuntime.toString()})(${JSON.stringify(execSandboxId)});`;
		const providerSetup = buildProviderSetupCode(payload, execSandboxId);
		const wrapperCode = buildBrowserJsWrapperFunctionCode({
			userCode: code,
			args: parsedArgs,
			setupCode: [bridgeCode, nativeInputSetup, providerSetup, skillLibrary].filter(Boolean).join("\n"),
		});

		const result = await awaitAbortable(
			executePageFunction<BrowserJsWrapperResult>({ tabId, frameId: targetFrameId }, wrapperCode, {
				worldId: FIXED_WORLD_ID,
				csp: "script-src 'unsafe-eval' 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; frame-src 'none'; font-src 'none'; object-src 'none'; default-src 'none';",
				includeConsole: true,
				requireUserScripts: true,
			}),
			signal,
		);

		if (result.missingResult) {
			return includeArtifactMutations({
				success: true,
				error: "No result returned from script execution",
				console: [],
			});
		}

		if (!result.success) {
			return includeArtifactMutations({
				success: false,
				error: result.error,
				stack: result.stack,
				console: result.console ?? [],
			});
		}
		const wrapperResult = result.value;
		if (!wrapperResult) {
			return includeArtifactMutations({
				success: true,
				error: "No result returned from script execution",
				console: result.console ?? [],
			});
		}
		if (!wrapperResult.success) {
			return includeArtifactMutations({
				success: false,
				error: wrapperResult.error,
				stack: wrapperResult.stack,
				console: result.console ?? [],
			});
		}

		return includeArtifactMutations({
			success: true,
			result: wrapperResult.lastValue,
			console: result.console ?? [],
		});
	} catch (error: unknown) {
		if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
			return { success: false, error: "Background page operation was aborted", cancelled: true };
		}
		return includeArtifactMutations({
			success: false,
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		activeExecutions.delete(execSandboxId);
	}
}

// ---------------------------------------------------------------------------
// navigate handler
// ---------------------------------------------------------------------------

export async function handleBgNavigate(
	payload: Record<string, unknown>,
	windowId: number | undefined,
	_telemetry?: BridgeTelemetry,
	_traceContext?: TraceContext,
	signal?: AbortSignal,
): Promise<BackgroundPageRuntimeResponse> {
	try {
		const navigateTool = new NavigateTool({ windowId });
		const args = (payload?.args ?? payload) as NavigateParams;
		const result = await navigateTool.execute(`bg_navigate_${Date.now()}`, args, signal);
		// Pass through full details so list/close/windows fields reach REPL and CLI clients.
		return {
			success: true,
			result: result.details,
		};
	} catch (err: unknown) {
		if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
			return { success: false, error: "Background page operation was aborted", cancelled: true };
		}
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ---------------------------------------------------------------------------
// native-input handler (direct, not nested inside browserjs)
// ---------------------------------------------------------------------------

export async function handleBgNativeInput(
	payload: Record<string, unknown>,
	windowId: number | undefined,
	telemetry?: BridgeTelemetry,
	traceContext?: TraceContext,
	signal?: AbortSignal,
): Promise<BackgroundPageRuntimeResponse> {
	const provider = new NativeInputEventsRuntimeProvider({
		windowId,
		tabId: typeof payload.tabId === "number" ? payload.tabId : undefined,
		frameId: typeof payload.frameId === "number" ? payload.frameId : undefined,
		debuggerManager: getSharedDebuggerManager(),
		telemetry,
		traceContext,
	});

	return new Promise((resolve) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			resolve({ success: false, error: "Background page operation was aborted", cancelled: true });
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		const respond = (response: unknown) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			const typed = response as {
				success?: boolean;
				error?: string;
				[key: string]: unknown;
			};
			if (typed?.success) {
				resolve({ success: true, result: typed });
			} else {
				resolve({ success: false, error: typed?.error || "native-input failed" });
			}
		};
		void provider.handleMessage(payload, respond).catch((err: unknown) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			resolve({ success: false, error: err instanceof Error ? err.message : String(err) });
		});
	});
}

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

export async function handleBackgroundPageRuntimeOperation(
	runtimeType: BackgroundPageRuntimeType,
	payload: Record<string, unknown>,
	windowId: number | undefined,
	telemetry?: BridgeTelemetry,
	traceContext?: TraceContext,
	signal?: AbortSignal,
): Promise<BackgroundPageRuntimeResponse> {
	const span = telemetry?.startSpan(`background.runtime.${runtimeType}`, {
		parent: traceContext,
		attributes: {
			"runtime.type": runtimeType,
			"runtime.window_id": windowId,
		},
	});
	try {
		let response: BackgroundPageRuntimeResponse;
		switch (runtimeType) {
			case "browser-js":
				response = await handleBgBrowserJs(payload, windowId, telemetry, span?.context, signal);
				break;
			case "navigate":
				response = await handleBgNavigate(payload, windowId, telemetry, span?.context, signal);
				break;
			case "native-input":
				response = await handleBgNativeInput(payload, windowId, telemetry, span?.context, signal);
				break;
			default:
				response = { success: false, error: `Unknown runtime type: ${runtimeType as string}` };
				break;
		}
		span?.setAttribute("runtime.success", response.success);
		if (response.error) {
			span?.recordError(new Error(response.error));
			span?.end("error");
		} else {
			span?.end("ok");
		}
		return response;
	} catch (error) {
		span?.recordError(error);
		span?.end("error");
		throw error;
	} finally {
		await telemetry?.flush();
	}
}
