/**
 * Proxy SandboxRuntimeProviders used by the offscreen document when it hosts
 * the REPL sandbox with the sidepanel closed.
 *
 * Each provider exposes the same window globals as its real counterpart
 * (`browserjs()`, `navigate()`, `nativeClick`/`nativeType`/`nativePress`/
 * `nativeKeyDown`/`nativeKeyUp`) but their `handleMessage()` implementations
 * forward to the background service worker via `chrome.runtime.sendMessage`
 * ({ type: "bg-runtime-exec", ... }).
 *
 * The `getRuntime()` implementations are deliberately self-contained strings
 * (runtimes are stringified with `.toString()`) and must match the sidepanel
 * providers' runtime surfaces exactly.
 */
import type { SandboxRuntimeProvider } from "@mariozechner/pi-web-ui/sandbox/SandboxRuntimeProvider.js";
import {
	BROWSERJS_RUNTIME_PROVIDER_DESCRIPTION,
	NATIVE_INPUT_EVENTS_DESCRIPTION,
	NAVIGATE_RUNTIME_PROVIDER_DESCRIPTION,
} from "../prompts/prompts.js";
import type { BgRuntimeExecMessage, BgRuntimeExecResponse, BgRuntimeType } from "./internal-messages.js";

interface OffscreenRuntimeOptions {
	tabId?: number;
	frameId?: number;
	traceparent?: string;
	tracestate?: string;
}

/**
 * Forward a runtime call to the background service worker. Wraps
 * `chrome.runtime.sendMessage` in a promise with explicit error translation.
 */
async function forwardToBackground(
	runtimeType: BgRuntimeType,
	payload: Record<string, unknown>,
	windowId: number | undefined,
	sandboxId: string,
	options: OffscreenRuntimeOptions = {},
): Promise<BgRuntimeExecResponse> {
	const msg: BgRuntimeExecMessage = {
		type: "bg-runtime-exec",
		runtimeType,
		payload,
		windowId,
		sandboxId,
		tabId: options.tabId,
		frameId: options.frameId,
		traceparent: options.traceparent,
		tracestate: options.tracestate,
	};
	try {
		const response = (await chrome.runtime.sendMessage(msg)) as BgRuntimeExecResponse | undefined;
		if (!response) {
			return { success: false, error: `No response from background for ${runtimeType}` };
		}
		return response;
	} catch (err: unknown) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ---------------------------------------------------------------------------
// browserjs() proxy
// ---------------------------------------------------------------------------

export class OffscreenBrowserJsProxy implements SandboxRuntimeProvider {
	constructor(
		private readonly windowId?: number,
		private readonly options: OffscreenRuntimeOptions = {},
	) {}

	getData(): Record<string, unknown> {
		return {};
	}

	getDescription(): string {
		return BROWSERJS_RUNTIME_PROVIDER_DESCRIPTION;
	}

	/**
	 * Identical shape to BrowserJsRuntimeProvider#getRuntime. Must remain a
	 * self-contained function: it gets stringified via .toString() and
	 * injected into the sandbox iframe with no access to outer scope.
	 */
	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			const sendRuntimeMessage = (window as any).sendRuntimeMessage;
			if (typeof sendRuntimeMessage !== "function") {
				throw new Error("sendRuntimeMessage is not available in this context");
			}

			(window as any).browserjs = async (func: () => any, ...args: any[]): Promise<any> => {
				if (typeof func !== "function") {
					throw new Error("First argument to browserjs() must be a function");
				}

				const response = await sendRuntimeMessage({
					type: "browser-js",
					code: func.toString(),
					args: JSON.stringify(args),
				});

				if (response.console && Array.isArray(response.console)) {
					for (const log of response.console) {
						const method = log.type || "log";
						const message = `[browserjs] ${log.text}`;
						if (method === "error") console.error(message);
						else if (method === "warn") console.warn(message);
						else if (method === "info") console.info(message);
						else console.log(message);
					}
				}

				if (!response.success) {
					throw new Error(response.error || "browserjs() execution failed");
				}

				return response.result;
			};
		};
	}

	async handleMessage(message: any, respond: (response: any) => void): Promise<void> {
		if (message?.type !== "browser-js") return;

		const result = await forwardToBackground(
			"browser-js",
			{ code: message.code, args: message.args },
			this.windowId,
			(message.sandboxId as string) || "offscreen",
			this.options,
		);

		respond({
			success: result.success,
			result: result.result,
			error: result.error,
			stack: result.stack,
			console: result.console ?? [],
			cancelled: result.cancelled,
		});
	}
}

// ---------------------------------------------------------------------------
// navigate() proxy
// ---------------------------------------------------------------------------

export class OffscreenNavigateProxy implements SandboxRuntimeProvider {
	constructor(
		private readonly windowId?: number,
		private readonly options: OffscreenRuntimeOptions = {},
	) {}

	getData(): Record<string, unknown> {
		return {};
	}

	getDescription(): string {
		return NAVIGATE_RUNTIME_PROVIDER_DESCRIPTION;
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			const sendRuntimeMessage = (window as any).sendRuntimeMessage;
			if (typeof sendRuntimeMessage !== "function") {
				throw new Error("sendRuntimeMessage is not available in this context");
			}

			(window as any).navigate = async (args: any): Promise<any> => {
				const response = await sendRuntimeMessage({
					type: "navigate",
					args,
				});
				if (!response.success) {
					throw new Error(response.error || "navigate() execution failed");
				}
				return response.result;
			};
		};
	}

	async handleMessage(message: any, respond: (response: any) => void): Promise<void> {
		if (message?.type !== "navigate") return;

		const result = await forwardToBackground(
			"navigate",
			{ args: message.args },
			this.windowId,
			(message.sandboxId as string) || "offscreen",
			this.options,
		);

		respond({
			success: result.success,
			result: result.result,
			error: result.error,
		});
	}
}

// ---------------------------------------------------------------------------
// native-input proxy (nativeClick / nativeType / nativePress / nativeKeyDown /
// nativeKeyUp)
// ---------------------------------------------------------------------------

export class OffscreenNativeInputProxy implements SandboxRuntimeProvider {
	constructor(
		private readonly windowId?: number,
		private readonly options: OffscreenRuntimeOptions = {},
	) {}

	getData(): Record<string, unknown> {
		return {};
	}

	getDescription(): string {
		return NATIVE_INPUT_EVENTS_DESCRIPTION;
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			const sendRuntimeMessage = (window as any).sendRuntimeMessage;
			if (typeof sendRuntimeMessage !== "function") {
				throw new Error("sendRuntimeMessage is not available in this context");
			}

			(window as any).nativeClick = async (selector: string): Promise<void> => {
				await sendRuntimeMessage({ type: "native-input", action: "click", selector });
			};
			(window as any).nativeType = async (selector: string, text: string): Promise<void> => {
				await sendRuntimeMessage({ type: "native-input", action: "type", selector, text });
			};
			(window as any).nativePress = async (key: string): Promise<void> => {
				await sendRuntimeMessage({ type: "native-input", action: "press", key });
			};
			(window as any).nativeKeyDown = async (key: string): Promise<void> => {
				await sendRuntimeMessage({ type: "native-input", action: "keyDown", key });
			};
			(window as any).nativeKeyUp = async (key: string): Promise<void> => {
				await sendRuntimeMessage({ type: "native-input", action: "keyUp", key });
			};
		};
	}

	async handleMessage(message: any, respond: (response: any) => void): Promise<void> {
		if (message?.type !== "native-input") return;

		const {
			type: _type,
			sandboxId: _sandboxId,
			messageId: _messageId,
			...payload
		} = message as Record<string, unknown>;
		const result = await forwardToBackground(
			"native-input",
			payload,
			this.windowId,
			(message.sandboxId as string) || "offscreen",
			this.options,
		);

		if (result.success) {
			respond({ success: true });
		} else {
			respond({ success: false, error: result.error });
		}
	}
}

/**
 * Build the full set of proxy providers for the offscreen REPL sandbox.
 * The order mirrors the sidepanel path: native-input first so browserjs
 * skill code can still issue native input events.
 */
export function buildOffscreenRuntimeProviders(
	windowId: number | undefined,
	options: OffscreenRuntimeOptions = {},
): SandboxRuntimeProvider[] {
	return [
		new OffscreenNativeInputProxy(windowId, options),
		new OffscreenBrowserJsProxy(windowId, options),
		new OffscreenNavigateProxy(windowId, options),
	];
}
