import type {
	PageExecutionConsoleEntry,
	PageExecutionInjectionConfig,
	PageExecutionInjectionResult,
} from "@shuvgeist/driver/injected-contracts";
import { buildInjectedArtifactInvocation } from "@shuvgeist/driver/injected-invocation";
import { PAGE_EXECUTION_INJECTED_ARTIFACT } from "../../injected/extension-artifacts.generated.js";

export interface PageExecutionTarget {
	tabId: number;
	frameId?: number;
}

export type PageExecutionFunction = (...args: never[]) => unknown;

export interface PageExecutionOptions {
	worldId: string;
	csp?: string;
	args?: unknown[];
	timeoutMs?: number;
	signal?: AbortSignal;
	includeConsole?: boolean;
	terminateOnAbort?: boolean;
	requireUserScripts?: boolean;
	/** Typed function retained for the chrome.scripting fallback when pageFunction is a bundled source string. */
	scriptingFallback?: PageExecutionFunction;
	/** Packaged extension scripts installed in the same isolated frame before the typed fallback runs. */
	scriptingFiles?: string[];
	/** Arguments for the typed fallback when they differ from the primary user-script invocation. */
	scriptingFallbackArgs?: unknown[];
}

export type { PageExecutionConsoleEntry } from "@shuvgeist/driver/injected-contracts";

export interface PageExecutionResult<T = unknown> {
	success: boolean;
	value?: T;
	error?: string;
	stack?: string;
	console: PageExecutionConsoleEntry[];
	tabId: number;
	frameId: number;
	durationMs: number;
	missingResult?: boolean;
}

type RawPageExecutionResult = PageExecutionInjectionResult;

type UserScriptsExecuteConfig = chrome.userScripts.UserScriptInjection & {
	executionId?: string;
};

type UserScriptsApi = typeof chrome.userScripts & {
	terminate?: (tabId: number, executionId: string) => Promise<void>;
	execute(config: UserScriptsExecuteConfig): Promise<Array<{ result?: unknown }>>;
};

type ScriptingApi = typeof chrome.scripting & {
	executeScript(
		config: chrome.scripting.ScriptInjection<unknown[], RawPageExecutionResult>,
	): Promise<Array<{ result?: unknown }>>;
};

export class PageExecutionAbortError extends Error {
	constructor(message = "Page execution was aborted") {
		super(message);
		this.name = "PageExecutionAbortError";
	}
}

export class PageExecutionTimeoutError extends Error {
	constructor(message = "Page execution timed out") {
		super(message);
		this.name = "PageExecutionTimeoutError";
	}
}

export function isPageExecutionAbortError(error: unknown): error is PageExecutionAbortError {
	return error instanceof PageExecutionAbortError;
}

export function isPageExecutionTimeoutError(error: unknown): error is PageExecutionTimeoutError {
	return error instanceof PageExecutionTimeoutError;
}

export async function executePageFunction<T = unknown>(
	target: PageExecutionTarget,
	pageFunction: string | PageExecutionFunction,
	options: PageExecutionOptions,
): Promise<PageExecutionResult<T>> {
	const startedAt = Date.now();
	if (options.signal?.aborted) {
		throw new PageExecutionAbortError();
	}

	const frameId = typeof target.frameId === "number" ? target.frameId : 0;
	const userScripts = chrome.userScripts as UserScriptsApi | undefined;
	if (!userScripts || typeof userScripts.execute !== "function") {
		if (options.requireUserScripts) {
			throw new Error(
				"userScripts.execute() not available. This feature requires Chrome with User Scripts enabled.",
			);
		}
		return executePageFunctionWithScripting<T>(
			target,
			options.scriptingFallback ?? pageFunction,
			options,
			startedAt,
			frameId,
		);
	}

	await configureUserScriptWorld(userScripts, options);
	if (options.signal?.aborted) {
		throw new PageExecutionAbortError();
	}

	const supportsTerminate = options.terminateOnAbort !== false && typeof userScripts.terminate === "function";
	const executionId = supportsTerminate ? createExecutionId() : undefined;
	let timedOut = false;

	const terminateExecution = async () => {
		if (!executionId || !userScripts.terminate) return;
		try {
			await userScripts.terminate(target.tabId, executionId);
		} catch (error) {
			console.warn("[PageExecution] Failed to terminate user script:", error);
		}
	};

	const abortHandler = () => {
		void terminateExecution();
	};

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	if (options.signal) {
		options.signal.addEventListener("abort", abortHandler, { once: true });
	}
	if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
		timeoutId = setTimeout(() => {
			timedOut = true;
			void terminateExecution();
		}, options.timeoutMs);
	}

	try {
		const injectionConfig = buildInjectionConfig(target, normalizeFunctionSource(pageFunction), options, executionId);
		const results = await userScripts.execute(injectionConfig);
		if (options.signal?.aborted) {
			throw new PageExecutionAbortError();
		}
		if (timedOut) {
			throw new PageExecutionTimeoutError();
		}

		const raw = results[0]?.result as RawPageExecutionResult | undefined;
		if (!raw) {
			return {
				success: false,
				error: "No result returned from script execution",
				console: [],
				tabId: target.tabId,
				frameId,
				durationMs: Date.now() - startedAt,
				missingResult: true,
			};
		}

		return {
			success: raw.success === true,
			value: raw.value as T,
			error: raw.error,
			stack: raw.stack,
			console: Array.isArray(raw.console) ? raw.console : [],
			tabId: target.tabId,
			frameId,
			durationMs: Date.now() - startedAt,
		};
	} catch (error) {
		if (options.signal?.aborted) {
			throw new PageExecutionAbortError();
		}
		if (timedOut) {
			throw new PageExecutionTimeoutError();
		}
		throw error;
	} finally {
		if (options.signal) {
			options.signal.removeEventListener("abort", abortHandler);
		}
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	}
}

async function executePageFunctionWithScripting<T>(
	target: PageExecutionTarget,
	pageFunction: string | PageExecutionFunction,
	options: PageExecutionOptions,
	startedAt: number,
	frameId: number,
): Promise<PageExecutionResult<T>> {
	if (options.signal?.aborted) {
		throw new PageExecutionAbortError();
	}
	const scripting = chrome.scripting as ScriptingApi | undefined;
	if (!scripting || typeof scripting.executeScript !== "function") {
		throw new Error("Neither userScripts.execute() nor scripting.executeScript() is available for page execution.");
	}
	if (typeof pageFunction !== "function") {
		throw new Error(
			"scripting.executeScript() fallback requires a function page execution. String source requires userScripts.execute().",
		);
	}

	const targetConfig = (
		typeof target.frameId === "number" && target.frameId !== 0
			? { tabId: target.tabId, frameIds: [target.frameId] }
			: { tabId: target.tabId, allFrames: false }
	) as chrome.scripting.InjectionTarget;

	let timedOut = false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
		timeoutId = setTimeout(() => {
			timedOut = true;
		}, options.timeoutMs);
	}

	try {
		if (options.scriptingFiles && options.scriptingFiles.length > 0) {
			await scripting.executeScript({
				target: targetConfig,
				files: [...options.scriptingFiles],
				world: "ISOLATED",
				injectImmediately: true,
			} as chrome.scripting.ScriptInjection<unknown[], unknown>);
			if (options.signal?.aborted) {
				throw new PageExecutionAbortError();
			}
			if (timedOut) {
				throw new PageExecutionTimeoutError();
			}
		}
		const results = await scripting.executeScript({
			target: targetConfig,
			func: pageFunction,
			args: options.scriptingFallbackArgs ?? options.args ?? [],
			world: "ISOLATED",
			injectImmediately: true,
		} as chrome.scripting.ScriptInjection<unknown[], T>);
		if (options.signal?.aborted) {
			throw new PageExecutionAbortError();
		}
		if (timedOut) {
			throw new PageExecutionTimeoutError();
		}

		const raw = results[0]?.result as RawPageExecutionResult | undefined;
		return {
			success: true,
			value: raw as T,
			console: [],
			tabId: target.tabId,
			frameId,
			durationMs: Date.now() - startedAt,
		};
	} catch (error) {
		if (options.signal?.aborted) {
			throw new PageExecutionAbortError();
		}
		if (timedOut) {
			throw new PageExecutionTimeoutError();
		}
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error && error.stack ? error.stack : "",
			console: [],
			tabId: target.tabId,
			frameId,
			durationMs: Date.now() - startedAt,
		};
	} finally {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	}
}

function normalizeFunctionSource(pageFunction: string | PageExecutionFunction): string {
	return typeof pageFunction === "string" ? pageFunction : `(${pageFunction.toString()})`;
}

async function configureUserScriptWorld(userScripts: UserScriptsApi, options: PageExecutionOptions): Promise<void> {
	try {
		await userScripts.configureWorld({
			worldId: options.worldId,
			messaging: true,
			...(options.csp ? { csp: options.csp } : {}),
		});
	} catch (error) {
		if (isAlreadyConfiguredError(error)) return;
		console.warn("[PageExecution] Failed to configure userScripts world:", error);
	}
}

function buildInjectionConfig(
	target: PageExecutionTarget,
	fnSource: string,
	options: PageExecutionOptions,
	executionId: string | undefined,
): UserScriptsExecuteConfig {
	const injectionTarget = (
		typeof target.frameId === "number" && target.frameId !== 0
			? { tabId: target.tabId, frameIds: [target.frameId] }
			: { tabId: target.tabId, allFrames: false }
	) as chrome.userScripts.UserScriptInjection["target"];

	const injectionConfig: UserScriptsExecuteConfig = {
		js: [{ code: buildWrapperCode(fnSource, options) }] as unknown as chrome.userScripts.UserScriptInjection["js"],
		target: injectionTarget,
		world: "USER_SCRIPT",
		worldId: options.worldId,
		injectImmediately: true,
	};

	if (executionId) {
		injectionConfig.executionId = executionId;
	}

	return injectionConfig;
}

function buildWrapperCode(fnSource: string, options: PageExecutionOptions): string {
	const config: PageExecutionInjectionConfig = {
		args: options.args ?? [],
		includeConsole: options.includeConsole === true,
	};
	return buildInjectedArtifactInvocation(PAGE_EXECUTION_INJECTED_ARTIFACT, [JSON.stringify(config), fnSource]);
}

function createExecutionId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	return `page_exec_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function isAlreadyConfiguredError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.toLowerCase().includes("already") && message.toLowerCase().includes("configured");
}
