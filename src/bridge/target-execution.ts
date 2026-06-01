import { getBridgeCommandMetadata, isCatalogTargetDispatchedMethod } from "./command-catalog.js";
import { type BridgeError, type BridgeMethod, ErrorCodes } from "./protocol.js";
import { type BridgeTarget, isChromeTarget, isElectronTarget, targetTeachingLabel } from "./target.js";

export type BridgeExecutionAdapter = "server-local" | "electron-target" | "chrome-extension" | "unsupported-target";

export interface BridgeTargetSupport {
	serverLocal: boolean;
	chromeExtension: boolean;
	electronWindow: boolean;
	requiresExtension: boolean;
}

export interface BridgeExecutionResolution {
	adapter: BridgeExecutionAdapter;
	target: BridgeTarget;
	support: BridgeTargetSupport;
	error?: BridgeError;
}

export function getBridgeTargetSupport(method: BridgeMethod): BridgeTargetSupport {
	const metadata = getBridgeCommandMetadata(method);
	const serverLocal = metadata?.route === "server-local";
	const electronTargetDispatched = isCatalogTargetDispatchedMethod(method, "electron-window");
	return {
		serverLocal,
		chromeExtension: !serverLocal,
		electronWindow: !serverLocal && electronTargetDispatched,
		requiresExtension: !serverLocal,
	};
}

export function resolveBridgeExecution(method: BridgeMethod, target: BridgeTarget): BridgeExecutionResolution {
	const support = getBridgeTargetSupport(method);
	if (support.serverLocal) {
		return { adapter: "server-local", target, support };
	}
	if (support.electronWindow && isElectronTarget(target)) {
		return { adapter: "electron-target", target, support };
	}
	if (support.chromeExtension && isChromeTarget(target)) {
		return { adapter: "chrome-extension", target, support };
	}
	return {
		adapter: "unsupported-target",
		target,
		support,
		error: unsupportedTargetError(method, target),
	};
}

export function unsupportedTargetError(method: BridgeMethod, target: BridgeTarget): BridgeError {
	return {
		code: ErrorCodes.INVALID_TARGET,
		message: `Method '${method}' cannot be routed to target '${targetTeachingLabel(target)}'`,
	};
}

export function missingExtensionTargetError(): BridgeError {
	return { code: ErrorCodes.NO_EXTENSION_TARGET, message: "No active extension target connected" };
}
