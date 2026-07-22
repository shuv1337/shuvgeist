/**
 * Compatibility exports for the pre-offscreen REPL provider API.
 *
 * Runtime behavior is implemented once by the canonical providers in
 * `src/agent/offscreen-tool-environment.ts`. These adapters preserve the old
 * constructor surface for downstream imports without reintroducing a second
 * sandbox runtime or browserjs wrapper implementation.
 */

import type { SandboxRuntimeProvider } from "@shuv1337/pi-web-ui/sandbox/SandboxRuntimeProvider.js";
import type { OffscreenRuntimeSessionScope } from "../../agent/offscreen-runtime-host.js";
import {
	OffscreenBrowserJsRuntimeProvider,
	OffscreenNavigateRuntimeProvider,
	type OffscreenPrivilegedOperationExecutor,
} from "../../agent/offscreen-tool-environment.js";
import type { RuntimeValue } from "../../agent/runtime-protocol.js";
import { handleBackgroundPageRuntimeOperation } from "../../bridge/background-runtime-handler.js";
import type { NavigateParams, NavigateTool } from "../navigate.js";

interface BrowserJsCompatibilityTarget {
	tabId?: number;
	frameId?: number;
}

function compatibilityScope(windowId?: number): OffscreenRuntimeSessionScope {
	const resolvedWindowId = windowId ?? 0;
	return {
		clientId: "legacy-runtime-provider",
		windowId: resolvedWindowId,
		sessionId: "legacy-runtime-provider",
		target: {
			kind: "chrome-tab",
			tabRef: windowId === undefined ? "active" : `window:${windowId}`,
		},
	};
}

function browserJsCompatibilityExecutor(
	windowId: number | undefined,
	target: BrowserJsCompatibilityTarget,
): OffscreenPrivilegedOperationExecutor {
	return {
		async execute(operation, params, context) {
			if (operation !== "browser-js") {
				throw new Error(`Legacy BrowserJsRuntimeProvider cannot execute '${operation}'`);
			}
			const response = await handleBackgroundPageRuntimeOperation(
				"browser-js",
				{ ...params, ...target },
				windowId,
				undefined,
				undefined,
				context.signal,
			);
			return structuredClone(response) as unknown as RuntimeValue;
		},
	};
}

function navigateCompatibilityExecutor(navigateTool: NavigateTool): OffscreenPrivilegedOperationExecutor {
	return {
		async execute(operation, params, context) {
			if (operation !== "navigate") {
				throw new Error(`Legacy NavigateRuntimeProvider cannot execute '${operation}'`);
			}
			const result = await navigateTool.execute(
				context.operationId,
				params as unknown as NavigateParams,
				context.signal,
			);
			return structuredClone(result.details) as unknown as RuntimeValue;
		},
	};
}

/** @deprecated Runtime ownership now lives in the offscreen agent environment. */
export class BrowserJsRuntimeProvider extends OffscreenBrowserJsRuntimeProvider {
	private readonly activeCompatibilitySandboxes = new Set<string>();

	constructor(
		sharedProviders: SandboxRuntimeProvider[],
		windowId?: number,
		target: BrowserJsCompatibilityTarget = {},
	) {
		super(compatibilityScope(windowId), browserJsCompatibilityExecutor(windowId, target), () => sharedProviders);
	}

	override onExecutionStart(sandboxId: string, signal?: AbortSignal): void {
		this.activeCompatibilitySandboxes.add(sandboxId);
		super.onExecutionStart(sandboxId, signal);
	}

	override onExecutionEnd(sandboxId: string): void {
		this.activeCompatibilitySandboxes.delete(sandboxId);
		super.onExecutionEnd(sandboxId);
	}

	cleanupAll(): void {
		for (const sandboxId of this.activeCompatibilitySandboxes) super.onExecutionEnd(sandboxId);
		this.activeCompatibilitySandboxes.clear();
	}
}

/** @deprecated Runtime ownership now lives in the offscreen agent environment. */
export class NavigateRuntimeProvider extends OffscreenNavigateRuntimeProvider {
	constructor(navigateTool: NavigateTool) {
		super(compatibilityScope(), navigateCompatibilityExecutor(navigateTool));
	}
}

export type { BrowserJsCompatibilityTarget };
