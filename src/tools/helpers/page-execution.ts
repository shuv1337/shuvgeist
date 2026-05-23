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
}

export interface PageExecutionConsoleEntry {
	type: "log" | "warn" | "error" | "info";
	text: string;
}

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

interface RawPageExecutionResult {
	success?: boolean;
	value?: unknown;
	error?: string;
	stack?: string;
	console?: PageExecutionConsoleEntry[];
}

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
		return executePageFunctionWithScripting<T>(target, pageFunction, options, startedAt, frameId);
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
		const results = await scripting.executeScript({
			target: targetConfig,
			func: pageFunction,
			args: options.args ?? [],
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
	const argsJson = JSON.stringify(options.args ?? []);
	const includeConsole = options.includeConsole === true;

	return `
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
		if (${includeConsole ? "true" : "false"}) {
			__consoleLogs.push({ type: method, text });
		}
		__origConsole[method].apply(console, args);
	};
	if (${includeConsole ? "true" : "false"}) {
		console.log = __capture('log');
		console.warn = __capture('warn');
		console.error = __capture('error');
		console.info = __capture('info');
	}

	let __result;
	try {
		const __args__ = ${argsJson};
		const __func__ = ${fnSource};
		const __value__ = await __func__(...__args__);
		__result = { success: true, value: __value__, console: __consoleLogs };
	} catch (__err__) {
		__result = {
			success: false,
			error: __err__ && __err__.message ? __err__.message : String(__err__),
			stack: __err__ && __err__.stack ? __err__.stack : '',
			console: __consoleLogs,
		};
	} finally {
		if (${includeConsole ? "true" : "false"}) {
			console.log = __origConsole.log;
			console.warn = __origConsole.warn;
			console.error = __origConsole.error;
			console.info = __origConsole.info;
		}
	}
	return __result;
})()
`;
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
