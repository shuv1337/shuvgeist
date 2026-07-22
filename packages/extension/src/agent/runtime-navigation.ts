import type { RuntimeAgentMessage, RuntimeValue } from "./runtime-protocol.js";

function runtimeRecord(value: RuntimeValue | undefined): { [key: string]: RuntimeValue } | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

export function runtimeNavigationMessage(value: RuntimeValue): RuntimeAgentMessage | undefined {
	const record = runtimeRecord(value);
	if (
		!record ||
		record.role !== "navigation" ||
		typeof record.url !== "string" ||
		!record.url.trim() ||
		typeof record.title !== "string" ||
		typeof record.skillsOutput !== "string"
	) {
		return undefined;
	}
	return structuredClone(record) as RuntimeAgentMessage;
}

/** Mirrors the transcript semantics used by the navigate tool. */
export function latestNavigationUrl(messages: readonly RuntimeAgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message) continue;
		if (message.role === "navigation") {
			return typeof message.url === "string" ? message.url : undefined;
		}
		if (message.role === "toolResult" && message.toolName === "navigate") {
			const details = runtimeRecord(message.details);
			return details && typeof details.finalUrl === "string" ? details.finalUrl : undefined;
		}
	}
	return undefined;
}

export function navigationContextChanged(
	messages: readonly RuntimeAgentMessage[],
	candidate: RuntimeAgentMessage,
): boolean {
	return (
		candidate.role === "navigation" &&
		typeof candidate.url === "string" &&
		latestNavigationUrl(messages) !== candidate.url
	);
}
