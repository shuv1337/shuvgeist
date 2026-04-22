import type { AgentTool, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { type Static, StringEnum, Type } from "@mariozechner/pi-ai";
import type { TraceContext } from "../bridge/telemetry.js";
import { resolveBrowserTarget } from "./helpers/browser-target.js";
import { type DebuggerManager, getSharedDebuggerManager } from "./helpers/debugger-manager.js";

// ============================================================================
// TYPES
// ============================================================================

const debuggerSchema = Type.Object({
	action: StringEnum(["eval", "cookies"], {
		description: "Action to perform",
	}),
	tabId: Type.Optional(Type.Number({ description: "Optional tab ID override for bridge workflows" })),
	frameId: Type.Optional(Type.Number({ description: "Optional frame ID override for MAIN-world evaluation" })),
	code: Type.Optional(
		Type.String({
			description: "JavaScript code to execute in MAIN world context (required for eval action)",
		}),
	),
});

export type DebuggerParams = Static<typeof debuggerSchema>;

export interface DebuggerResult {
	value: unknown;
}

export interface DebuggerToolOptions {
	windowId?: number;
	debuggerManager?: DebuggerManager;
}

// ============================================================================
// TOOL
// ============================================================================

export class DebuggerTool implements AgentTool<typeof debuggerSchema, DebuggerResult> {
	label = "Debugger";
	name = "debugger";
	description = `Execute JavaScript in the MAIN world or access browser APIs that browserjs() and repl tool cannot.

ACTIONS:

1. eval - Execute JavaScript in MAIN world context
   USE CASES (what browserjs() and repl tool CANNOT access):
   - Page's own JavaScript variables, functions, framework instances (React, Vue, Angular state)
   - window properties set by page scripts
   - All other MAIN world internals that USER_SCRIPT world cannot see

   Examples:
   { action: "eval", code: "window.myApp.state" } - Access app state
   { action: "eval", code: "window.myFunction()" } - Call page function
   { action: "eval", code: "JSON.stringify(localStorage)" } - Get localStorage

2. cookies - Get all cookies for current domain (including HttpOnly)
   Returns cookies in format: name: value (one per line)

   Example:
   { action: "cookies" } - Get all cookies

CRITICAL: Use browserjs() and repl tool for DOM manipulation. Use this ONLY for MAIN world access or browser APIs.`;
	parameters = debuggerSchema;
	windowId?: number;
	private readonly debuggerManager: DebuggerManager;

	constructor(options: DebuggerToolOptions = {}) {
		this.windowId = options.windowId;
		this.debuggerManager = options.debuggerManager ?? getSharedDebuggerManager();
	}

	async execute(
		toolCallId: string,
		args: DebuggerParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<DebuggerResult>,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: DebuggerResult }> {
		return this.executeInternal(toolCallId, args, signal);
	}

	async executeBridge(
		toolCallId: string,
		args: DebuggerParams,
		signal?: AbortSignal,
		traceContext?: TraceContext,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: DebuggerResult }> {
		return this.executeInternal(toolCallId, args, signal, traceContext);
	}

	private async executeInternal(
		toolCallId: string,
		args: DebuggerParams,
		signal?: AbortSignal,
		traceContext?: TraceContext,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: DebuggerResult }> {
		if (signal?.aborted) {
			throw new Error("Debugger command aborted");
		}

		const { tab, tabId, frameId } = await resolveBrowserTarget({
			windowId: this.windowId,
			tabId: args.tabId,
			frameId: args.frameId,
		});

		try {
			// Handle cookies action
			if (args.action === "cookies") {
				// Check if cookies API is available
				if (!chrome.cookies) {
					throw new Error(
						`TELL THE USER: Cookie access is not available. The "cookies" permission needs to be added to the extension manifest.\n\n` +
							`INSTRUCT THE USER TO:\n` +
							`1. Find where you unpacked the Shuvgeist extension files on your computer\n` +
							`2. Open the manifest.json file in a text editor\n` +
							`3. Find the "permissions" array\n` +
							`4. Add "cookies" to the array if it's not already there. Example:\n\n` +
							`   "permissions": [\n` +
							`     "activeTab",\n` +
							`     "storage",\n` +
							`     "cookies"\n` +
							`   ]\n\n` +
							`5. Save the file\n` +
							`6. Go to chrome://extensions (or about:addons for Firefox)\n` +
							`7. Click the reload/refresh button (circular arrow icon) on the Shuvgeist extension card\n` +
							`8. Try the cookies command again\n\n` +
							`THEN: Ask the user to confirm when they've completed these steps so you can retry.`,
					);
				}

				if (!tab.url) {
					throw new Error("Cannot get cookies for a tab without a URL");
				}

				try {
					const cookies = await chrome.cookies.getAll({ url: tab.url });
					const output = cookies.map((cookie) => `${cookie.name}: ${cookie.value}`).join("\n");
					const details: DebuggerResult = { value: cookies };
					return { content: [{ type: "text", text: output }], details };
				} catch (error) {
					throw new Error(`Failed to get cookies: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			// Handle eval action
			if (args.action === "eval") {
				if (!args.code) {
					throw new Error("eval action requires code parameter");
				}
				if (frameId !== 0) {
					throw new Error("Frame-targeted eval requires frame context support");
				}

				const owner = `debugger:${toolCallId}:${tabId}`;
				await this.debuggerManager.acquireWithTrace(tabId, owner, { parent: traceContext });
				try {
					await this.debuggerManager.ensureDomainWithTrace(tabId, "Runtime", { parent: traceContext });
					const result = await this.debuggerManager.sendCommandWithTrace<unknown>(
						tabId,
						"Runtime.evaluate",
						{
							expression: args.code,
							returnByValue: true,
						},
						{ parent: traceContext },
					);
					const details: DebuggerResult = { value: result };

					let output = "";
					if (result === undefined) {
						output = "undefined";
					} else if (typeof result === "string") {
						output = result;
					} else {
						output = JSON.stringify(result, null, 2);
					}

					return { content: [{ type: "text", text: output }], details };
				} finally {
					await this.debuggerManager.releaseWithTrace(tabId, owner, { parent: traceContext });
				}
			}

			throw new Error(`Unknown action: ${args.action}`);
		} catch (error) {
			throw new Error(`Debugger error: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
