/**
 * Background-side implementation of the REPL runtime providers.
 *
 * When the sidepanel is closed and a bridge REPL command arrives, the offscreen
 * document hosts the sandbox iframe but cannot call Chrome extension APIs
 * (chrome.tabs / chrome.userScripts / chrome.debugger). The offscreen sandbox
 * ships proxy runtime providers (see offscreen-runtime-providers.ts) that
 * forward `browserjs()`, `navigate()`, and `nativeClick`/`nativeType`/...
 * calls to the background service worker via `chrome.runtime.sendMessage`.
 *
 * This module implements the receiving end. Handlers run inside the service
 * worker, where full Chrome API access is available. They reuse the sidepanel
 * implementations (NavigateTool, NativeInputEventsRuntimeProvider) where
 * possible and provide a self-contained wrapper for `chrome.userScripts.execute()`
 * that does NOT depend on the DOM-bound `RUNTIME_MESSAGE_ROUTER`.
 */
import { RuntimeMessageBridge } from "@shuv1337/pi-web-ui/sandbox/RuntimeMessageBridge.js";
import { getShuvgeistStorage } from "../storage/app-storage.js";
import { isProtectedTabUrl, resolveTabTarget } from "../tools/helpers/browser-target.js";
import { getSharedDebuggerManager } from "../tools/helpers/debugger-manager.js";
import { executePageFunction } from "../tools/helpers/page-execution.js";
import { NativeInputEventsRuntimeProvider } from "../tools/NativeInputEventsRuntimeProvider.js";
import { type NavigateParams, NavigateTool } from "../tools/navigate.js";
import { checkUserScriptsAvailability } from "../tools/repl/userscripts-helpers.js";
import type { BgRuntimeExecResponse, BgRuntimeType } from "./internal-messages.js";
import type { BridgeTelemetry, TraceContext } from "./telemetry.js";

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
	}
>();

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

	// Console messages are captured inline in executePageFunction's wrapper;
	// still ack them to avoid "receiving end does not exist" warnings
	// when user skill code happens to call sendRuntimeMessage({type: "console"}).
	if (message.type === "console") {
		sendResponse({ success: true, sandboxId });
		return true;
	}

	return false;
}

// ---------------------------------------------------------------------------
// Direct wrapper code builder (no RUNTIME_MESSAGE_ROUTER dependency)
// ---------------------------------------------------------------------------

/**
 * Build a self-contained page function for chrome.userScripts.execute().
 *
 * This mirrors src/tools/repl/userscripts-helpers.ts#buildWrapperCode but:
 *   - Does NOT call RUNTIME_MESSAGE_ROUTER.registerSandbox() (service worker
 *     has no DOM, no window message listener).
 *   - Still injects the RuntimeMessageBridge for "user-script" context so that
 *     skill code running inside browserjs() can call nativeClick() / etc via
 *     chrome.runtime.sendMessage; those messages get routed by the background
 *     onUserScriptMessage listener (see resolveBackgroundUserScriptMessage).
 */
export function buildDirectBrowserJsCode(options: {
	userCode: string;
	args: unknown[];
	skillLibrary: string;
	sandboxId: string;
}): string {
	const { userCode, skillLibrary, sandboxId } = options;

	const bridgeCode = RuntimeMessageBridge.generateBridgeCode({
		context: "user-script",
		sandboxId,
	});

	// Inject the native input runtime (provides nativeClick / nativeType / ...
	// as window globals inside the page). It relies on window.sendRuntimeMessage
	// which the bridge code above defines.
	const nativeInput = new NativeInputEventsRuntimeProvider();
	const nativeInputRuntime = nativeInput.getRuntime();
	const nativeInputInject = `(${nativeInputRuntime.toString()})(${JSON.stringify(sandboxId)});`;

	return `
	(async function(...__args__) {
			${bridgeCode}

			${nativeInputInject}

			${skillLibrary}

			const __func__ = ${userCode};
			return await __func__(...__args__);
	})
	`;
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
): Promise<BgRuntimeExecResponse> {
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
		console.warn("[BgRuntime] Failed to load skills for url:", err);
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
	});

	try {
		const wrapperCode = buildDirectBrowserJsCode({
			userCode: code,
			args: parsedArgs,
			skillLibrary,
			sandboxId: execSandboxId,
		});

		const result = await executePageFunction({ tabId, frameId: targetFrameId }, wrapperCode, {
			worldId: FIXED_WORLD_ID,
			csp: "script-src 'unsafe-eval' 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; frame-src 'none'; font-src 'none'; object-src 'none'; default-src 'none';",
			args: parsedArgs,
			includeConsole: true,
			requireUserScripts: true,
		});

		if (result.missingResult) {
			return { success: true, error: "No result returned from script execution", console: [] };
		}

		if (!result.success) {
			return {
				success: false,
				error: result.error,
				stack: result.stack,
				console: result.console ?? [],
			};
		}

		return {
			success: true,
			result: result.value,
			console: result.console ?? [],
		};
	} catch (error: unknown) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
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
): Promise<BgRuntimeExecResponse> {
	try {
		const navigateTool = new NavigateTool({ windowId });
		const args = (payload?.args ?? payload) as NavigateParams;
		const result = await navigateTool.execute(`bg_navigate_${Date.now()}`, args);
		// Pass through full details so list/close/windows fields reach REPL and CLI clients.
		return {
			success: true,
			result: result.details,
		};
	} catch (err: unknown) {
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
): Promise<BgRuntimeExecResponse> {
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
		const respond = (response: unknown) => {
			if (settled) return;
			settled = true;
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
			resolve({ success: false, error: err instanceof Error ? err.message : String(err) });
		});
	});
}

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

export async function handleBgRuntimeExec(
	runtimeType: BgRuntimeType,
	payload: Record<string, unknown>,
	windowId: number | undefined,
	telemetry?: BridgeTelemetry,
	traceContext?: TraceContext,
): Promise<BgRuntimeExecResponse> {
	const span = telemetry?.startSpan(`background.runtime.${runtimeType}`, {
		parent: traceContext,
		attributes: {
			"runtime.type": runtimeType,
			"runtime.window_id": windowId,
		},
	});
	try {
		let response: BgRuntimeExecResponse;
		switch (runtimeType) {
			case "browser-js":
				response = await handleBgBrowserJs(payload, windowId, telemetry, span?.context);
				break;
			case "navigate":
				response = await handleBgNavigate(payload, windowId, telemetry, span?.context);
				break;
			case "native-input":
				response = await handleBgNativeInput(payload, windowId, telemetry, span?.context);
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
