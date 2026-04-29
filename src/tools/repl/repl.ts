import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Static } from "@mariozechner/pi-ai";
import { Type } from "@mariozechner/pi-ai";
import type { SandboxFile, SandboxResult } from "@mariozechner/pi-web-ui/components/SandboxedIframe.js";
import type { SandboxRuntimeProvider } from "@mariozechner/pi-web-ui/sandbox/SandboxRuntimeProvider.js";
import { injectOverlayForActiveTab, removeOverlayForActiveTab } from "./overlay-inject.js";

// Execute JavaScript code with attachments using SandboxedIframe
export async function executeJavaScript(
	code: string,
	runtimeProviders: SandboxRuntimeProvider[],
	signal?: AbortSignal,
	sandboxUrlProvider?: () => string,
	taskName?: string,
	overlayWindowId?: number,
	target?: { tabId?: number; frameId?: number },
): Promise<{ output: string; files?: SandboxFile[] }> {
	if (!code) {
		throw new Error("Code parameter is required");
	}

	// Check for restricted navigation patterns in code
	const restrictedPatterns = [
		/window\.location\.href\s*=/i,
		/window\.location\.assign/i,
		/window\.location\.replace/i,
		/window\.location\s*=/i,
		/location\.href\s*=/i,
		/location\.assign/i,
		/location\.replace/i,
		/location\s*=\s*['"`]/i,
	];

	for (const pattern of restrictedPatterns) {
		if (pattern.test(code)) {
			throw new Error(
				"Direct navigation via window.location is not allowed. Use the navigate() function in browserjs() code, or use the navigate tool instead.",
			);
		}
	}

	// Check for abort before starting
	if (signal?.aborted) {
		throw new Error("Execution aborted");
	}

	// Only inject overlay if code uses browserjs() (interacts with active tab)
	const usesBrowserjs = code.includes("browserjs(");
	let overlayTabId: number | undefined;
	if (usesBrowserjs) {
		try {
			overlayTabId = await injectOverlayForActiveTab(
				taskName || "Executing JavaScript",
				overlayWindowId,
				target?.tabId,
			);
		} catch (error) {
			console.warn("[REPL] Failed to inject overlay:", error);
			// Continue execution even if overlay fails
		}
	}

	// Dynamically import SandboxIframe to avoid DOM deps at module load time
	const { SandboxIframe } = await import("@mariozechner/pi-web-ui/components/SandboxedIframe.js");

	// Create a SandboxedIframe instance for execution
	const sandbox = new SandboxIframe();
	if (sandboxUrlProvider) {
		sandbox.sandboxUrlProvider = sandboxUrlProvider;
	}
	sandbox.style.display = "none";
	document.body.appendChild(sandbox);

	try {
		const sandboxId = `repl-${Date.now()}-${Math.random().toString(36).substring(7)}`;

		// Pass providers to execute (router handles all message routing)
		// No additional consumers needed - execute() has its own internal consumer
		const result: SandboxResult = await sandbox.execute(sandboxId, code, runtimeProviders, [], signal);

		// Remove the sandbox iframe after execution
		sandbox.remove();

		// Build plain text response
		let output = "";

		// Add console output - result.console contains { type: string, text: string } from sandbox.js
		if (result.console && result.console.length > 0) {
			for (const entry of result.console) {
				output += entry.text + "\n";
			}
		}

		// Add error if execution failed
		if (!result.success) {
			if (output) output += "\n";
			output += `Error: ${result.error?.message || "Unknown error"}\n${result.error?.stack || ""}`;

			// Throw error so tool call is marked as failed
			throw new Error(output.trim());
		}

		// Add return value if present
		if (result.returnValue !== undefined) {
			if (output) output += "\n";
			output += `=> ${typeof result.returnValue === "object" ? JSON.stringify(result.returnValue, null, 2) : result.returnValue}`;
		}

		// Add file notifications
		if (result.files && result.files.length > 0) {
			output += `\n[Files returned: ${result.files.length}]\n`;
			for (const file of result.files) {
				output += `  - ${file.fileName} (${file.mimeType})\n`;
			}
		} else {
			// Explicitly note when no files were returned (helpful for debugging)
			if (code.includes("returnFile")) {
				output += "\n[No files returned - check async operations]";
			}
		}

		// Remove overlay on success (if it was injected)
		if (usesBrowserjs) {
			await removeOverlayForActiveTab(overlayWindowId, overlayTabId ?? target?.tabId);
		}

		return {
			output: output.trim() || "Code executed successfully (no output)",
			files: result.files,
		};
	} catch (error: unknown) {
		// Clean up on error
		sandbox.remove();
		if (usesBrowserjs) {
			await removeOverlayForActiveTab(overlayWindowId, overlayTabId ?? target?.tabId);
		}
		throw new Error((error as Error).message || "Execution failed");
	}
}

export type ReplToolResult = {
	files?:
		| {
				fileName: string;
				contentBase64: string;
				mimeType: string;
				size: number;
		  }[]
		| undefined;
};

const replSchema = Type.Object({
	title: Type.String({
		description:
			"Brief title describing what the code snippet tries to achieve in active form, e.g. 'Calculating sum'",
	}),
	code: Type.String({ description: "JavaScript code to execute" }),
});

export type ReplParams = Static<typeof replSchema>;

export interface ReplResult {
	output?: string;
	files?: Array<{
		fileName: string;
		mimeType: string;
		size: number;
		contentBase64: string;
	}>;
}

export function createReplTool(): AgentTool<typeof replSchema, ReplToolResult> & {
	runtimeProvidersFactory?: () => SandboxRuntimeProvider[];
	sandboxUrlProvider?: () => string;
	overlayWindowId?: number;
} {
	const tool: AgentTool<typeof replSchema, ReplToolResult> & {
		runtimeProvidersFactory?: () => SandboxRuntimeProvider[];
		sandboxUrlProvider?: () => string;
		overlayWindowId?: number;
	} = {
		label: "JavaScript REPL",
		name: "repl",
		runtimeProvidersFactory: () => [], // default to empty array
		sandboxUrlProvider: undefined, // optional, for browser extensions
		get description() {
			// Dynamically get provider descriptions
			const runtimeProviderDescriptions =
				tool
					.runtimeProvidersFactory?.()
					.map((d) => d.getDescription())
					.filter((d) => d.trim().length > 0) || [];
			// Inject into template - will be dynamically imported in the actual REPL tool description
			return `JavaScript REPL with browser automation capabilities.\n\n${runtimeProviderDescriptions.join("\n\n")}`;
		},
		parameters: replSchema,
		execute: async function (_toolCallId: string, args: Static<typeof replSchema>, signal?: AbortSignal) {
			const result = await executeJavaScript(
				args.code,
				this.runtimeProvidersFactory?.() ?? [],
				signal,
				this.sandboxUrlProvider,
				args.title,
				this.overlayWindowId,
			);
			// Convert files to JSON-serializable with base64 payloads
			const files = (result.files || []).map((f) => {
				const toBase64 = (input: string | Uint8Array): { base64: string; size: number } => {
					if (input instanceof Uint8Array) {
						let binary = "";
						const chunk = 0x8000;
						for (let i = 0; i < input.length; i += chunk) {
							binary += String.fromCharCode(...input.subarray(i, i + chunk));
						}
						return { base64: btoa(binary), size: input.length };
					} else if (typeof input === "string") {
						const enc = new TextEncoder();
						const bytes = enc.encode(input);
						let binary = "";
						const chunk = 0x8000;
						for (let i = 0; i < bytes.length; i += chunk) {
							binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
						}
						return { base64: btoa(binary), size: bytes.length };
					} else {
						const s = String(input);
						const enc = new TextEncoder();
						const bytes = enc.encode(s);
						let binary = "";
						const chunk = 0x8000;
						for (let i = 0; i < bytes.length; i += chunk) {
							binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
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
			});
			return { content: [{ type: "text", text: result.output }], details: { files } };
		},
	};
	return tool;
}

// Export a default instance for backward compatibility
export const javascriptReplTool = createReplTool();
