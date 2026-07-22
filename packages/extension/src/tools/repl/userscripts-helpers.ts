import { RuntimeMessageBridge } from "@shuv1337/pi-web-ui/sandbox/RuntimeMessageBridge.js";
import { RUNTIME_MESSAGE_ROUTER } from "@shuv1337/pi-web-ui/sandbox/RuntimeMessageRouter.js";
import type { SandboxRuntimeProvider } from "@shuv1337/pi-web-ui/sandbox/SandboxRuntimeProvider.js";
import type { BrowserJsWrapperConfig } from "@shuvgeist/driver/injected-contracts";
import { buildInjectedArtifactFunction } from "@shuvgeist/driver/injected-invocation";
import { BROWSERJS_WRAPPER_INJECTED_ARTIFACT } from "../../injected/extension-artifacts.generated.js";

export interface UserScriptsCheckResult {
	available: boolean;
	message?: string;
	shouldRetry?: boolean;
}

/**
 * Check and request userScripts permission.
 * Must be called from a user gesture (e.g., button click) in Firefox.
 * IMPORTANT: In Firefox, browser.permissions.request() must be called synchronously
 * (without any await before it) to preserve the user gesture context.
 */
export async function requestUserScriptsPermission(): Promise<{
	granted: boolean;
	message?: string;
}> {
	const chromeVersion = Number(navigator.userAgent.match(/(Chrome|Chromium)\/([0-9]+)/)?.[2]);
	const isChrome = chromeVersion > 0;
	const isFirefox = !isChrome;

	// Check if API is already available
	if (chrome.userScripts) {
		return { granted: true };
	}

	// Firefox: Request userScripts permission
	if (isFirefox && chrome.permissions) {
		try {
			// CRITICAL: Call request() synchronously (no await before it) to preserve user gesture context!
			// Any async operation before this call will break the user gesture chain.
			const grantedPromise = chrome.permissions.request({
				permissions: ["userScripts"],
			});

			// Now we can await the promise result
			const granted = await grantedPromise;
			if (granted) {
				return {
					granted: true,
					message: "Permission granted. If the tool still doesn't work, please reload the extension.",
				};
			} else {
				return {
					granted: false,
					message:
						"userScripts permission denied. The browserjs() runtime requires this permission to execute code safely.",
				};
			}
		} catch (error) {
			console.error("Failed to request userScripts permission:", error);
			return {
				granted: false,
				message: `Failed to request permission: ${error}`,
			};
		}
	}

	// Chrome: userScripts not available
	if (isChrome) {
		if (chromeVersion >= 138) {
			return {
				granted: false,
				message: `Chrome ${chromeVersion} detected. To enable User Scripts:\n\n1. Go to chrome://extensions/\n2. Find this extension and click 'Details'\n3. Enable the 'Allow User Scripts' toggle\n4. Refresh the page and try again`,
			};
		} else if (chromeVersion >= 120) {
			return {
				granted: false,
				message: `Chrome ${chromeVersion} detected. The userScripts API requires Chrome 120+ with experimental features enabled.`,
			};
		} else {
			return {
				granted: false,
				message: `Chrome ${chromeVersion} detected. The userScripts API requires Chrome 120 or higher. Please update Chrome.`,
			};
		}
	}

	return {
		granted: false,
		message: "userScripts API not available in this browser.",
	};
}

/**
 * Check if userScripts API is available, and provide helpful error messages if not.
 * For Firefox, attempts to request the permission if not granted.
 */
export async function checkUserScriptsAvailability(): Promise<UserScriptsCheckResult> {
	if (chrome.userScripts) {
		return { available: true };
	}

	const chromeVersion = Number(navigator.userAgent.match(/(Chrome|Chromium)\/([0-9]+)/)?.[2]);

	let errorMessage = "Error: browser.userScripts API is not available.\n\n";

	if (chromeVersion >= 138) {
		errorMessage += `Chrome ${chromeVersion} detected. To enable User Scripts:\n\n`;
		errorMessage += "1. Go to chrome://extensions/\n";
		errorMessage += "2. Find this extension and click 'Details'\n";
		errorMessage += "3. Enable the 'Allow User Scripts' toggle\n";
		errorMessage += "4. Refresh the page and try again";
	} else if (chromeVersion >= 120) {
		errorMessage += `Chrome ${chromeVersion} detected. To enable User Scripts:\n\n`;
		errorMessage += "1. Go to chrome://extensions/\n";
		errorMessage += "2. Enable 'Developer mode' toggle in the top right\n";
		errorMessage += "3. Refresh the page and try again";
	} else {
		errorMessage += `Chrome ${chromeVersion} detected, but User Scripts requires Chrome 120+.\n`;
		errorMessage += "Please update Chrome or use a different browser.";
	}

	return {
		available: false,
		message: errorMessage,
	};
}

/**
 * Validates browser JavaScript code for navigation commands.
 * Navigation should use the navigate tool instead.
 */
export function validateBrowserJavaScript(code: string): {
	valid: boolean;
	error?: string;
} {
	// Check if code contains navigation patterns
	const patterns = [
		/\bwindow\.location\s*=\s*["'`]/,
		/\blocation\.href\s*=\s*["'`]/,
		/\bdocument\.location\s*=\s*["'`]/,
		/\bwindow\.location\.href\s*=\s*["'`]/,
		/\blocation\.assign\s*\(/,
		/\blocation\.replace\s*\(/,
		/\bwindow\.location\.assign\s*\(/,
		/\bwindow\.location\.replace\s*\(/,
		/\bhistory\.back\s*\(/,
		/\bhistory\.forward\s*\(/,
		/\bhistory\.go\s*\(/,
	];

	for (const pattern of patterns) {
		if (pattern.test(code)) {
			return {
				valid: false,
				error: "Use navigate tool instead. Navigation in code breaks execution context.",
			};
		}
	}

	return { valid: true };
}

export interface BrowserJsWrapperSourceOptions {
	userCode: string;
	args: unknown[];
	setupCode: string;
	timeoutMs?: number;
}

/** Build a function expression around the single esbuild-authored BrowserJS runtime. */
export function buildBrowserJsWrapperFunctionCode(options: BrowserJsWrapperSourceOptions): string {
	const config: BrowserJsWrapperConfig = {
		args: options.args,
		timeoutMs: options.timeoutMs ?? 120_000,
	};
	return buildInjectedArtifactFunction(BROWSERJS_WRAPPER_INJECTED_ARTIFACT, [
		JSON.stringify(config),
		`() => {\n${options.setupCode}\nreturn (${options.userCode});\n}`,
	]);
}

/**
 * Build the wrapper code by combining safeguards, skill library, providers, and user code
 */
export function buildWrapperCode(
	userCode: string,
	skillLibrary: string,
	_enableSafeguards: boolean,
	providers: SandboxRuntimeProvider[],
	sandboxId: string,
	args?: unknown[],
): string {
	// Inject safeguards at the beginning if enabled (not implemented yet)
	// if (enableSafeguards) { ... }

	// Build provider injections (bridge + data + runtimes)
	const bridgeCode = RuntimeMessageBridge.generateBridgeCode({
		context: "user-script",
		sandboxId: sandboxId,
	});

	let providerInjections = `${bridgeCode}\n`;

	// Register sandbox with RUNTIME_MESSAGE_ROUTER
	RUNTIME_MESSAGE_ROUTER.registerSandbox(sandboxId, providers, []);

	// Inject data from providers (e.g., window.artifacts = {...})
	for (const provider of providers) {
		const data = provider.getData();
		for (const [key, value] of Object.entries(data)) {
			providerInjections += `window.${key} = ${JSON.stringify(value)};\n`;
		}
	}

	// Inject runtime functions from providers
	for (const provider of providers) {
		const runtimeFunc = provider.getRuntime();
		providerInjections += `(${runtimeFunc.toString()})(${JSON.stringify(sandboxId)});\n`;
	}

	// Inject skills AFTER providers
	if (skillLibrary) {
		providerInjections += `\n// Skills auto-injected for domain\n${skillLibrary}\n`;
	}

	const wrapperFunction = buildBrowserJsWrapperFunctionCode({
		userCode,
		args: args ?? [],
		setupCode: providerInjections,
	});
	return `(${wrapperFunction})()`;
}
