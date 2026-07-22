import type {
	AgentRuntimeDeveloperSettingsRequest,
	AgentRuntimeDeveloperSettingsResponse,
} from "../bridge/internal-messages.js";

export interface OffscreenRuntimeMessenger {
	sendMessage(message: AgentRuntimeDeveloperSettingsRequest): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads background-owned developer settings without using unavailable offscreen chrome.storage APIs. */
export async function loadOffscreenDebuggerMode(runtime: OffscreenRuntimeMessenger): Promise<boolean> {
	const responseValue = await runtime.sendMessage({ type: "agent-runtime-get-developer-settings" });
	if (
		!isRecord(responseValue) ||
		responseValue.ok !== true ||
		typeof responseValue.debuggerMode !== "boolean" ||
		Object.keys(responseValue).some((key) => key !== "ok" && key !== "debuggerMode")
	) {
		const error =
			isRecord(responseValue) && responseValue.ok === false && typeof responseValue.error === "string"
				? responseValue.error
				: "Background returned malformed offscreen developer settings";
		throw new Error(error);
	}
	return (responseValue as AgentRuntimeDeveloperSettingsResponse & { ok: true }).debuggerMode;
}
