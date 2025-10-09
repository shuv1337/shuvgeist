import { html, i18n, type TemplateResult } from "@mariozechner/mini-lit";
import type { AgentTool, ToolResultMessage } from "@mariozechner/pi-ai";
import {
	type Agent,
	type ArtifactsPanel,
	ArtifactsRuntimeProvider,
	type Attachment,
	type ConsoleLog,
	ConsoleRuntimeProvider,
	FileDownloadRuntimeProvider,
	RUNTIME_MESSAGE_ROUTER,
	RuntimeMessageBridge,
	registerToolRenderer,
	renderCollapsibleHeader,
	renderHeader,
	type SandboxRuntimeProvider,
	type ToolRenderer,
} from "@mariozechner/pi-web-ui";
import { type Static, Type } from "@sinclair/typebox";
import { createRef, ref } from "lit/directives/ref.js";
import "@mariozechner/pi-web-ui"; // Ensure all components are registered
import { Globe } from "lucide";
import { BROWSER_JAVASCRIPT_DESCRIPTION } from "../prompts/tool-prompts.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import "../utils/i18n-extension.js";

// Cross-browser API compatibility
// @ts-expect-error - browser global exists in Firefox, chrome in Chrome
const browser = globalThis.browser || globalThis.chrome;

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
	const chromeVersion = Number(
		navigator.userAgent.match(/(Chrome|Chromium)\/([0-9]+)/)?.[2],
	);
	const isChrome = chromeVersion > 0;
	const isFirefox = !isChrome;

	// Check if API is already available
	if (browser.userScripts) {
		return { granted: true };
	}

	// Firefox: Request userScripts permission
	if (isFirefox && browser.permissions) {
		try {
			// CRITICAL: Call request() synchronously (no await before it) to preserve user gesture context!
			// Any async operation before this call will break the user gesture chain.
			const grantedPromise = browser.permissions.request({
				permissions: ["userScripts"],
			});

			// Now we can await the promise result
			const granted = await grantedPromise;
			if (granted) {
				return {
					granted: true,
					message:
						"Permission granted. If the tool still doesn't work, please reload the extension.",
				};
			} else {
				return {
					granted: false,
					message:
						"userScripts permission denied. The browser_javascript tool requires this permission to execute code safely.",
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

// Security safeguards function - will be converted to string with .toString()
function securitySafeguards() {
	// Lock down access to sensitive APIs by deleting them from window
	delete (window as any).localStorage;
	delete (window as any).sessionStorage;
	delete (window as any).indexedDB;
	delete (window as any).fetch;
	delete (window as any).XMLHttpRequest;
	delete (window as any).WebSocket;
	delete (window as any).EventSource;
	delete (window as any).caches;
	delete (window as any).cookieStore;

	// Block WebRTC for network exfiltration prevention
	delete (window as any).RTCPeerConnection;
	delete (window as any).RTCDataChannel;
	delete (window as any).RTCSessionDescription;
	delete (window as any).RTCIceCandidate;
	delete (window as any).webkitRTCPeerConnection;

	// CRITICAL: Block iframe and window creation to prevent API bypass via iframe.contentWindow
	const blockedError = () => {
		throw new Error("Creating new browsing contexts is blocked for security");
	};
	delete (window as any).HTMLIFrameElement;
	delete (window as any).HTMLFrameElement;
	delete (window as any).HTMLObjectElement;
	delete (window as any).HTMLEmbedElement;
	(window as any).open = blockedError;
	(window as any).showModalDialog = blockedError;

	// Block document.createElement for iframes, frames, objects, embeds
	const originalCreateElement = document.createElement.bind(document);
	document.createElement = ((tagName: string, options?: any) => {
		const tag = tagName.toLowerCase();
		if (
			tag === "iframe" ||
			tag === "frame" ||
			tag === "object" ||
			tag === "embed"
		) {
			throw new Error(`Creating ${tag} elements is blocked for security`);
		}
		return originalCreateElement(tagName, options);
	}) as any;

	// Block createElementNS (for SVG/XML iframes)
	const originalCreateElementNS = document.createElementNS.bind(document);
	document.createElementNS = ((
		namespaceURI: string,
		qualifiedName: string,
		options?: any,
	) => {
		const tag = qualifiedName.toLowerCase();
		if (
			tag === "iframe" ||
			tag === "frame" ||
			tag === "object" ||
			tag === "embed"
		) {
			throw new Error(`Creating ${tag} elements is blocked for security`);
		}
		return originalCreateElementNS(namespaceURI, qualifiedName, options);
	}) as any;

	// Block innerHTML/outerHTML that could inject iframes
	const blockIframeHTML = (value: string) => {
		if (typeof value === "string" && /<i?frame|<object|<embed/i.test(value)) {
			throw new Error(
				"HTML containing iframe/frame/object/embed is blocked for security",
			);
		}
		return value;
	};

	// Override Element.prototype.innerHTML setter
	const originalInnerHTMLDesc = Object.getOwnPropertyDescriptor(
		Element.prototype,
		"innerHTML",
	)!;
	Object.defineProperty(Element.prototype, "innerHTML", {
		set: function (value: string) {
			blockIframeHTML(value);
			originalInnerHTMLDesc.set?.call(this, value);
		},
		get: originalInnerHTMLDesc.get,
	});

	// Override Element.prototype.outerHTML setter
	const originalOuterHTMLDesc = Object.getOwnPropertyDescriptor(
		Element.prototype,
		"outerHTML",
	)!;
	Object.defineProperty(Element.prototype, "outerHTML", {
		set: function (value: string) {
			blockIframeHTML(value);
			originalOuterHTMLDesc.set?.call(this, value);
		},
		get: originalOuterHTMLDesc.get,
	});

	// Block insertAdjacentHTML
	const originalInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
	Element.prototype.insertAdjacentHTML = function (
		position: InsertPosition,
		html: string,
	) {
		blockIframeHTML(html);
		return originalInsertAdjacentHTML.call(this, position, html);
	};

	// Block document.write/writeln which could inject iframes
	(document as any).write = blockedError;
	(document as any).writeln = blockedError;

	// CRITICAL: Block modification of existing iframe src to prevent exfiltration via navigation
	try {
		const existingIframes = document.querySelectorAll(
			"iframe, frame, object, embed",
		);
		existingIframes.forEach((element) => {
			try {
				// Make src property read-only
				Object.defineProperty(element, "src", {
					get: function () {
						return this.getAttribute("src");
					},
					set: () => {
						throw new Error(
							"Modifying iframe/frame/object/embed src is blocked for security",
						);
					},
					configurable: false,
				});

				// Also block setAttribute for src
				const originalSetAttribute = element.setAttribute.bind(element);
				element.setAttribute = (name: string, value: string) => {
					if (name.toLowerCase() === "src") {
						throw new Error(
							"Modifying iframe/frame/object/embed src is blocked for security",
						);
					}
					return originalSetAttribute(name, value);
				};
			} catch (_e) {
				// Ignore errors for individual elements (may be cross-origin or protected)
			}
		});
	} catch (_e) {
		// Ignore if querySelectorAll fails
	}

	// Also block document.cookie access
	Object.defineProperty(document, "cookie", {
		get: () => {
			throw new Error("Access to document.cookie is blocked for security");
		},
		set: () => {
			throw new Error("Access to document.cookie is blocked for security");
		},
	});
}

// Wrapper function that executes user code - will be converted to string with .toString()
async function wrapperFunction() {
	let timeoutId: number;

	// Runtime providers (bridge + data + runtimes) will be injected here by buildWrapperCode()

	const cleanup = () => {
		if (timeoutId) clearTimeout(timeoutId);
		// Runtime provider cleanup will be handled automatically
	};

	try {
		// Set timeout
		const timeoutPromise = new Promise((_, reject) => {
			timeoutId = setTimeout(() => {
				reject(
					new Error(
						"Execution timeout: Code did not complete within 30 seconds",
					),
				);
			}, 120000) as unknown as number;
		});

		// Execute user code and capture the last expression value
		// USER_CODE_PLACEHOLDER will be replaced with the actual async function containing user code
		// @ts-expect-error
		const userCodeFunc = USER_CODE_PLACEHOLDER;
		const codePromise = userCodeFunc();

		// Race between execution and timeout
		const lastValue = await Promise.race([codePromise, timeoutPromise]);

		// Call completion callbacks before returning (success path)
		// @ts-expect-error
		if (window.__completionCallbacks) {
			// @ts-expect-error
			await Promise.all(window.__completionCallbacks.map(cb => cb(true)));
		}

		cleanup();
		return {
			success: true,
			lastValue: lastValue,
		};
	} catch (error: any) {
		// Call completion callbacks before returning (error path)
		// @ts-expect-error
		if (window.__completionCallbacks) {
			// @ts-expect-error
			await Promise.all(window.__completionCallbacks.map(cb => cb(false)));
		}

		cleanup();
		return {
			success: false,
			error: error.message,
			stack: error.stack,
		};
	}
}

// Build the wrapper code by combining safeguards and wrapper, then replacing placeholder
function buildWrapperCode(
	userCode: string,
	skillLibrary: string,
	enableSafeguards: boolean,
	providers: SandboxRuntimeProvider[],
	sandboxId: string,
): string {
	// No escaping needed - we're injecting raw code into a function body
	let code = `(${wrapperFunction.toString()})`;

	// Inject safeguards at the beginning of the function if enabled
	if (enableSafeguards) {
		const safeguardsBody = securitySafeguards
			.toString()
			.replace(/^function securitySafeguards\(\) \{/, "")
			.replace(/\}$/, "");
		code = code.replace(
			/async function wrapperFunction\(\) \{/,
			`async function wrapperFunction() {\n${safeguardsBody}`,
		);
	}

	// Inject skill library after safeguards but before user code
	if (skillLibrary) {
		code = code.replace(
			/async function wrapperFunction\(\) \{/,
			`async function wrapperFunction() {\n${skillLibrary}`,
		);
	}

	// Build provider injections (bridge + data + runtimes)
	const bridgeCode = RuntimeMessageBridge.generateBridgeCode({
		context: "user-script",
		sandboxId: sandboxId,
	});

	let providerInjections = `${bridgeCode}\n`;

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

	// Inject provider code after skill library
	code = code.replace(
		/async function wrapperFunction\(\) \{/,
		`async function wrapperFunction() {\n${providerInjections}`,
	);

	// Replace USER_CODE_PLACEHOLDER with an async function containing the user code
	code = code.replace(/USER_CODE_PLACEHOLDER/, `async () => { ${userCode} }`);

	// Call the function immediately
	return `${code}()`;
}

/**
 * Format console log entry with appropriate prefix
 */
function formatConsoleEntry(entry: ConsoleLog, includeLog = false): string {
	const prefix =
		entry.type === "error"
			? "[ERROR]"
			: entry.type === "warn"
				? "[WARN]"
				: entry.type === "info"
					? "[INFO]"
					: includeLog
						? "[LOG]"
						: "";
	const text = entry.args ? entry.args.join(" ") : entry.text;
	return prefix ? `${prefix} ${text}` : text;
}

/**
 * Check if userScripts API is available, and provide helpful error messages if not.
 * For Firefox, attempts to request the permission if not granted.
 */
async function checkUserScriptsAvailability(): Promise<{
	available: boolean;
	message?: string;
	shouldRetry?: boolean;
}> {
	if (browser.userScripts) {
		return { available: true };
	}

	const chromeVersion = Number(
		navigator.userAgent.match(/(Chrome|Chromium)\/([0-9]+)/)?.[2],
	);
	const isChrome = chromeVersion > 0;
	const isFirefox = !isChrome;

	// Firefox: Try to request userScripts permission if not granted
	if (isFirefox && browser.permissions) {
		try {
			const hasPermission = await browser.permissions.contains({
				permissions: ["userScripts"],
			});
			if (!hasPermission) {
				const granted = await browser.permissions.request({
					permissions: ["userScripts"],
				});
				if (!granted) {
					return {
						available: false,
						message:
							"Error: userScripts permission denied.\n\nThe userScripts permission is required to execute JavaScript code safely.\nPlease allow the permission when prompted.",
					};
				}
				// Permission was just granted, but API might not be available yet
				return {
					available: false,
					message:
						"userScripts permission granted! Please try your request again.",
					shouldRetry: true,
				};
			}
		} catch {
			// Permission request failed or not supported
		}
	}

	let errorMessage = "Error: browser.userScripts API is not available.\n\n";

	if (isChrome && chromeVersion >= 138) {
		errorMessage += `Chrome ${chromeVersion} detected. To enable User Scripts:\n\n`;
		errorMessage += "1. Go to chrome://extensions/\n";
		errorMessage += "2. Find this extension and click 'Details'\n";
		errorMessage += "3. Enable the 'Allow User Scripts' toggle\n";
		errorMessage += "4. Refresh the page and try again";
	} else if (isChrome && chromeVersion >= 120) {
		errorMessage += `Chrome ${chromeVersion} detected. To enable User Scripts:\n\n`;
		errorMessage += "1. Go to chrome://extensions/\n";
		errorMessage += "2. Enable 'Developer mode' toggle in the top right\n";
		errorMessage += "3. Refresh the page and try again";
	} else if (isChrome) {
		errorMessage += `Chrome ${chromeVersion} detected, but User Scripts requires Chrome 120+.\n`;
		errorMessage += "Please update Chrome or use a different browser.";
	} else {
		errorMessage +=
			"This requires Chrome 120+ or Firefox with userScripts support.";
	}

	return {
		available: false,
		message: errorMessage,
	};
}

/**
 * Validates browser JavaScript code for navigation commands.
 * Navigation commands destroy the execution context, so they must be isolated.
 */
function validateBrowserJavaScript(code: string): {
	valid: boolean;
	error?: string;
} {
	// Check if code contains navigation that will destroy execution context
	const navigationRegex =
		/\b(window\.location\s*=|location\.href\s*=|history\.(back|forward|go)\s*\(|window\.open\s*\(|document\.location\s*=)/;
	const navigationMatch = code.match(navigationRegex);

	if (!navigationMatch) {
		return { valid: true };
	}

	// Extract just the navigation command if found
	let navigationCommand: string | null = null;
	const lines = code.split("\n");
	for (const line of lines) {
		if (navigationRegex.test(line)) {
			navigationCommand = line.trim();
			break;
		}
	}

	// If navigation is detected and there's other code around it, reject and ask for split
	const codeWithoutComments = code
		.replace(/\/\/.*$/gm, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.trim();
	const codeLines = codeWithoutComments
		.split("\n")
		.filter((line) => line.trim().length > 0);

	// If there's more than just the navigation line, reject
	if (codeLines.length > 1) {
		return {
			valid: false,
			error: `⚠️ Navigation command detected in multi-line code block.

Navigation commands (history.back/forward/go, window.location assignment, etc.) destroy the execution context, so any code before or after them may not execute properly.

Please split this into TWO separate tool calls:

1. First tool call - navigation only:
${navigationCommand}

2. Second tool call - everything else (will run on the new page after navigation completes)

This ensures reliable execution.`,
		};
	}

	return { valid: true };
}

const browserJavaScriptSchema = Type.Object({
	code: Type.String({
		description: "JavaScript code to execute in the active browser tab",
	}),
	title: Type.String({
		description:
			"Brief description of what this code does in active form (e.g., 'Extracting page links', 'Getting article text')",
	}),
});

export type BrowserJavaScriptToolResult = {
	files?:
		| {
				fileName: string;
				contentBase64: string;
				mimeType: string;
				size: number;
		  }[]
		| undefined;
};

export class BrowserJavaScriptTool
	implements
		AgentTool<typeof browserJavaScriptSchema, BrowserJavaScriptToolResult>
{
	label = "Browser JavaScript";
	name = "browser_javascript";
	description = BROWSER_JAVASCRIPT_DESCRIPTION;
	parameters = browserJavaScriptSchema;

	constructor(
		private artifactsPanel: ArtifactsPanel,
		private agent: Agent,
	) {}

	execute = async (
		_toolCallId: string,
		args: Static<typeof browserJavaScriptSchema>,
		signal?: AbortSignal,
	) => {
		try {
			// Check if already aborted
			if (signal?.aborted) {
				return {
					output: "Tool execution was aborted",
					isError: true,
					details: { files: [] },
				};
			}

			// Validate navigation commands
			const validation = validateBrowserJavaScript(args.code);
			if (!validation.valid) {
				return {
					output: validation.error!,
					isError: true,
					details: { files: [] },
				};
			}

			// Get the active tab
			const [tab] = await browser.tabs.query({
				active: true,
				currentWindow: true,
			});
			if (!tab || !tab.id) {
				return {
					output: "Error: No active tab found",
					isError: true,
					details: { files: [] },
				};
			}

			// Check if we can execute scripts on this tab
			if (
				tab.url?.startsWith("chrome://") ||
				tab.url?.startsWith("chrome-extension://") ||
				tab.url?.startsWith("about:")
			) {
				return {
					output: `Error: Cannot execute scripts on ${tab.url}. Extension pages and internal URLs are protected.`,
					isError: true,
					details: { files: [] },
				};
			}

			// Check if userScripts API is available
			const apiCheck = await checkUserScriptsAvailability();
			if (!apiCheck.available) {
				return {
					output: apiCheck.message!,
					isError: !apiCheck.shouldRetry,
					details: { files: [] },
				};
			}

			// Load all skills for current domain and prepend libraries
			const skillsRepo = getSitegeistStorage().skills;
			let skillLibrary = "";

			if (tab.url) {
				const matchingSkills = await skillsRepo.getSkillsForUrl(tab.url);
				if (matchingSkills.length > 0) {
					skillLibrary = `${matchingSkills.map((s) => s.library).join("\n\n")}\n\n`;
				}
			}

			// Generate unique sandbox ID for this execution
			const sandboxId = `userscript_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

			// Create runtime providers
			const consoleProvider = new ConsoleRuntimeProvider();
			const artifactsProvider = new ArtifactsRuntimeProvider(
				() => this.artifactsPanel.artifacts,
				async (filename: string, content: string, _title?: string) => {
					await this.artifactsPanel.tool.execute("", {
						command: "create",
						filename,
						content,
					});
				},
				async (filename: string, content: string, _title?: string) => {
					await this.artifactsPanel.tool.execute("", {
						command: "rewrite",
						filename,
						content,
					});
				},
				async (filename: string) => {
					await this.artifactsPanel.tool.execute("", {
						command: "delete",
						filename,
					});
				},
				(message: any) => this.agent.appendMessage(message),
			);
			const fileDownloadProvider = new FileDownloadRuntimeProvider();

			const providers: SandboxRuntimeProvider[] = [
				consoleProvider,
				artifactsProvider,
				fileDownloadProvider,
			];

			// Register sandbox with RUNTIME_MESSAGE_ROUTER before building wrapper
			RUNTIME_MESSAGE_ROUTER.registerSandbox(sandboxId, providers, []);

			// Build the wrapper code using the function-based approach with providers
			// TODO: Add user setting to enable/disable safeguards
			const wrapperCode = buildWrapperCode(
				args.code,
				skillLibrary,
				false,
				providers,
				sandboxId,
			); // Safeguards enabled now that we have isolated worlds

			let results: any[];

			try {
				// Dual implementation: Use userScripts.execute() if available (Chrome 135+),
				// otherwise fall back to scripting.executeScript()
				if (
					browser.userScripts &&
					typeof browser.userScripts.execute === "function"
				) {
					// Chrome 135+ or future Firefox: Use userScripts.execute() API
					// This provides proper USER_SCRIPT world with configurable CSP

					// Configure this specific world with CSP that allows eval but blocks network
					try {
						await browser.userScripts.configureWorld({
							worldId: sandboxId,
							messaging: true,
							// Allow eval for code execution, but block all network requests (fetch, XHR, WebSocket, etc.)
							csp: "script-src 'unsafe-eval'; connect-src 'none'; default-src 'none';",
						});
					} catch (e) {
						// May fail if already configured or not supported - non-fatal
						console.warn("Failed to configure userScripts world:", e);
					}

					results = await browser.userScripts.execute({
						js: [{ code: wrapperCode }],
						target: { tabId: tab.id },
						world: "USER_SCRIPT",
						worldId: sandboxId,
						injectImmediately: true,
					});
				} else {
					// Firefox doesn't have userScripts.execute() yet, and scripting.executeScript()
					// cannot bypass page CSP to use eval. We have no workaround.
					// See: https://bugzilla.mozilla.org/show_bug.cgi?id=1930776
					return {
						output: `Error: Firefox is currently not supported for the browser_javascript tool.

Firefox does not yet support the userScripts.execute() API, which is required to execute arbitrary JavaScript code while bypassing page Content Security Policy.

Please use Chrome 138+ with the "Allow User Scripts" toggle enabled, or wait for Firefox to implement userScripts.execute().

Track Firefox implementation: https://bugzilla.mozilla.org/show_bug.cgi?id=1930776`,
						isError: true,
						details: { files: [] },
					};
				}

				const result = results[0]?.result as
					| {
							success: boolean;
							lastValue?: unknown;
							error?: string;
							stack?: string;
					  }
					| undefined;

				if (!result) {
					return {
						output:
							"Error: No result returned from script execution. Need to reload page.",
						isError: true,
						details: { files: [] },
					};
				}

				// Get console logs from provider
				const consoleLogs = consoleProvider.getLogs();
				const _isCompleted = consoleProvider.isCompleted();
				const _completionError = consoleProvider.getCompletionError();

				if (!result.success) {
					// Build error output with console logs if any
					let errorOutput = `Error: ${result.error}\n\nStack trace:\n${result.stack || "No stack trace available"}`;

					if (consoleLogs.length > 0) {
						errorOutput += "\n\nConsole output:\n";
						for (const entry of consoleLogs) {
							const line = formatConsoleEntry(entry, true);
							errorOutput += `${line}\n`;
						}
					}

					return {
						output: errorOutput,
						isError: true,
						details: { files: [] },
					};
				}

				// Build output with console logs
				let output = "";

				// Add console output
				if (consoleLogs.length > 0) {
					for (const entry of consoleLogs) {
						const line = formatConsoleEntry(entry);
						output += `${line}\n`;
					}
				}

				// Add last expression value if present and not undefined
				if (result.lastValue !== undefined) {
					const formatted =
						typeof result.lastValue === "string"
							? result.lastValue
							: JSON.stringify(result.lastValue, null, 2);
					output += `${(output ? "\n" : "") + formatted}\n`;
				}

				// Get files from provider
				const returnedFiles = fileDownloadProvider.getFiles();

				// Add file notifications
				if (returnedFiles.length > 0) {
					output += `\n[Files returned: ${returnedFiles.length}]\n`;
					for (const file of returnedFiles) {
						output += `  - ${file.fileName} (${file.mimeType})\n`;
					}
				}

				// Convert files to base64 for transport
				const files = returnedFiles.map(
					(f: {
						fileName: string;
						content: string | Uint8Array;
						mimeType: string;
					}) => {
						const toBase64 = (
							input: string | Uint8Array,
						): { base64: string; size: number } => {
							if (input instanceof Uint8Array) {
								let binary = "";
								const chunk = 0x8000;
								for (let i = 0; i < input.length; i += chunk) {
									binary += String.fromCharCode(
										...input.subarray(i, i + chunk),
									);
								}
								return { base64: btoa(binary), size: input.length };
							} else {
								const enc = new TextEncoder();
								const bytes = enc.encode(input);
								let binary = "";
								const chunk = 0x8000;
								for (let i = 0; i < bytes.length; i += chunk) {
									binary += String.fromCharCode(
										...bytes.subarray(i, i + chunk),
									);
								}
								return { base64: btoa(binary), size: bytes.length };
							}
						};

						const { base64, size } = toBase64(f.content);
						return {
							fileName: f.fileName || "file",
							mimeType: f.mimeType || "application/octet-stream",
							size,
							contentBase64: base64,
						};
					},
				);

				return {
					output: output.trim() || "Code executed successfully (no output)",
					isError: false,
					details: { files },
				};
			} catch (error: unknown) {
				const err = error as Error;
				// Check if this was an abort
				if (err.message === "Aborted" || signal?.aborted) {
					return {
						output: "Tool execution was aborted by user",
						isError: true,
						details: { files: [] },
					};
				}
				return {
					output: `Error executing script: ${err.message}`,
					isError: true,
					details: { files: [] },
				};
			} finally {
				// Unregister sandbox from RUNTIME_MESSAGE_ROUTER
				RUNTIME_MESSAGE_ROUTER.unregisterSandbox(sandboxId);
			}
		} catch (error: unknown) {
			const err = error as Error;
			// Check if this was an abort
			if (err.message === "Aborted" || signal?.aborted) {
				return {
					output: "Tool execution was aborted by user",
					isError: true,
					details: { files: [] },
				};
			}
			return {
				output: `Error executing script: ${err.message}`,
				isError: true,
				details: { files: [] },
			};
		}
	};
}

// Legacy export - creates a dummy instance (won't have artifacts support)
// Use createBrowserJavaScriptTool() instead
export const browserJavaScriptTool = new BrowserJavaScriptTool(
	null as unknown as ArtifactsPanel, // No artifacts panel
	null as unknown as Agent, // No agent
);

// Browser JavaScript renderer
interface BrowserJavaScriptParams {
	title: string;
	code: string;
}

interface BrowserJavaScriptResult {
	files?: Array<{
		fileName: string;
		mimeType: string;
		size: number;
		contentBase64: string;
	}>;
}

export const browserJavaScriptRenderer: ToolRenderer<
	BrowserJavaScriptParams,
	BrowserJavaScriptResult
> = {
	render(
		params: BrowserJavaScriptParams | undefined,
		result: ToolResultMessage<BrowserJavaScriptResult> | undefined,
		isStreaming?: boolean,
	): TemplateResult {
		// Determine status
		const state = result
			? result.isError
				? "error"
				: "complete"
			: isStreaming
				? "inprogress"
				: "complete";

		// Create refs for collapsible code section
		const codeContentRef = createRef<HTMLDivElement>();
		const codeChevronRef = createRef<HTMLSpanElement>();

		// With result: show params + result
		if (result && params) {
			const output = result.output || "";
			const files = result.details?.files || [];

			const attachments: Attachment[] = files.map((f, i) => {
				// Decode base64 content for text files to show in overlay
				let extractedText: string | undefined;
				const isTextBased =
					f.mimeType?.startsWith("text/") ||
					f.mimeType === "application/json" ||
					f.mimeType === "application/javascript" ||
					f.mimeType?.includes("xml");

				if (isTextBased && f.contentBase64) {
					try {
						extractedText = atob(f.contentBase64);
					} catch (_e) {
						console.warn("Failed to decode base64 content for", f.fileName);
					}
				}

				return {
					id: `browser-js-${Date.now()}-${i}`,
					type: f.mimeType?.startsWith("image/") ? "image" : "document",
					fileName: f.fileName || `file-${i}`,
					mimeType: f.mimeType || "application/octet-stream",
					size: f.size ?? 0,
					content: f.contentBase64,
					preview: f.mimeType?.startsWith("image/")
						? f.contentBase64
						: undefined,
					extractedText,
				};
			});

			return html`
				<div>
					${renderCollapsibleHeader(state, Globe, params.title, codeContentRef, codeChevronRef, false)}
					<div ${ref(codeContentRef)} class="max-h-0 overflow-hidden transition-all duration-300 space-y-3">
						<code-block .code=${params.code || ""} language="javascript"></code-block>
						${output ? html`<console-block .content=${output} .variant=${result.isError ? "error" : "default"}></console-block>` : ""}
					</div>
					${
						attachments.length
							? html`<div class="flex flex-wrap gap-2 mt-3">
								${attachments.map((att) => html`<attachment-tile .attachment=${att}></attachment-tile>`)}
							</div>`
							: ""
					}
				</div>
			`;
		}

		// Just params (streaming or waiting for result)
		if (params) {
			return html`
				<div>
					${renderCollapsibleHeader(state, Globe, params.title || (isStreaming ? i18n("Writing JavaScript code...") : i18n("Execute JavaScript")), codeContentRef, codeChevronRef, false)}
					<div ${ref(codeContentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						${params.code ? html`<code-block .code=${params.code} language="javascript"></code-block>` : ""}
					</div>
				</div>
			`;
		}

		// No params or result yet
		return renderHeader(state, Globe, i18n("Preparing JavaScript..."));
	},
};

// Auto-register the renderer
registerToolRenderer(browserJavaScriptTool.name, browserJavaScriptRenderer);
