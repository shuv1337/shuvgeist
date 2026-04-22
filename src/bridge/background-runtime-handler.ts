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
import { RuntimeMessageBridge } from "@mariozechner/pi-web-ui/sandbox/RuntimeMessageBridge.js";
import { getShuvgeistStorage } from "../storage/app-storage.js";
import { isProtectedTabUrl, resolveTabTarget } from "../tools/helpers/browser-target.js";
import { getSharedDebuggerManager } from "../tools/helpers/debugger-manager.js";
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

	// Console messages are captured inline in buildDirectBrowserJsCode's
	// wrapper; still ack them to avoid "receiving end does not exist" warnings
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
 * Build a self-contained wrapper code string for chrome.userScripts.execute().
 *
 * This mirrors src/tools/repl/userscripts-helpers.ts#buildWrapperCode but:
 *   - Does NOT call RUNTIME_MESSAGE_ROUTER.registerSandbox() (service worker
 *     has no DOM, no window message listener).
 *   - Captures console output inline (no ConsoleRuntimeProvider instance).
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
	const { userCode, args, skillLibrary, sandboxId } = options;

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

	// Serialize user args for injection.
	const argsJson = JSON.stringify(args ?? []);

	// Wrapper template. We assemble the user function separately so user code
	// stays syntactically whole (no escaping needed).
	const wrapperHead = `
(async function() {
	const __consoleLogs = [];
	const __origConsole = {
		log: console.log.bind(console),
		warn: console.warn.bind(console),
		error: console.error.bind(console),
		info: console.info.bind(console),
	};
	const __capture = (method) => (...args) => {
		let text;
		try {
			text = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
		} catch {
			text = args.map((a) => String(a)).join(' ');
		}
		__consoleLogs.push({ type: method, text });
		__origConsole[method].apply(console, args);
	};
	console.log = __capture('log');
	console.warn = __capture('warn');
	console.error = __capture('error');
	console.info = __capture('info');

	try {
		${bridgeCode}

		${nativeInputInject}

		${skillLibrary}

		const __args__ = ${argsJson};
		const __func__ = ${userCode};
		const __lastValue__ = await __func__(...__args__);
		return { success: true, lastValue: __lastValue__, console: __consoleLogs };
	} catch (__err__) {
		return {
			success: false,
			error: __err__ && __err__.message ? __err__.message : String(__err__),
			stack: __err__ && __err__.stack ? __err__.stack : '',
			console: __consoleLogs,
		};
	}
})()
`;

	return wrapperHead;
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
	try {
		const resolved = await resolveTabTarget({ windowId });
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

		try {
			await chrome.userScripts.configureWorld({
				worldId: FIXED_WORLD_ID,
				messaging: true,
				csp: "script-src 'unsafe-eval' 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; frame-src 'none'; font-src 'none'; object-src 'none'; default-src 'none';",
			});
		} catch (e) {
			console.warn("[BgRuntime] Failed to configure userScripts world:", e);
		}

		const injectionConfig: chrome.userScripts.UserScriptInjection = {
			js: [{ code: wrapperCode }] as unknown as chrome.userScripts.UserScriptInjection["js"],
			target: { tabId, allFrames: false },
			world: "USER_SCRIPT",
			worldId: FIXED_WORLD_ID,
			injectImmediately: true,
		};

		const results = await chrome.userScripts.execute(injectionConfig);

		const result = results[0]?.result as
			| {
					success: boolean;
					lastValue?: unknown;
					error?: string;
					stack?: string;
					console?: Array<{ type: string; text: string }>;
			  }
			| undefined;

		if (!result) {
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
			result: result.lastValue,
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
		return {
			success: true,
			result: {
				finalUrl: result.details.finalUrl,
				title: result.details.title,
				skills: result.details.skills,
			},
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
