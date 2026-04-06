import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Check if a message is a user message with attachments (role-based type guard). */
function isUserMessageWithAttachments(
	msg: AgentMessage,
): msg is AgentMessage & { role: "user-with-attachments"; attachments: Array<{ fileName: string; mimeType: string }> } {
	return "role" in msg && msg.role === "user-with-attachments";
}

import type {
	SessionArtifactsResult,
	SessionChangedEventData,
	SessionHistoryParams,
	SessionHistoryResult,
	SessionInjectParams,
	SessionInjectResult,
	SessionMessageEventData,
	SessionNewParams,
	SessionNewResult,
	SessionRunStateEventData,
	SessionSetModelParams,
	SessionSetModelResult,
	SessionToolEventData,
	SessionWireMessage,
} from "./protocol.js";

export interface SessionSnapshot {
	sessionId?: string;
	persisted: boolean;
	title: string;
	model?: { provider: string; id: string };
	isStreaming: boolean;
	messageCount: number;
	lastMessageIndex: number;
	messages: SessionWireMessage[];
}

export type SessionBridgeEventEnvelope =
	| { event: "session_changed"; data: SessionChangedEventData }
	| { event: "session_message"; data: SessionMessageEventData }
	| { event: "session_tool"; data: SessionToolEventData }
	| { event: "session_run_state"; data: SessionRunStateEventData };

export interface SessionBridgeAdapter {
	getSnapshot(): SessionSnapshot;
	waitForIdle(): Promise<void>;
	appendInjectedMessage(params: SessionInjectParams): Promise<SessionInjectResult>;
	newSession(params: SessionNewParams): Promise<SessionNewResult>;
	setModel(params: SessionSetModelParams): Promise<SessionSetModelResult>;
	getArtifacts(): SessionArtifactsResult;
	subscribe(listener: (event: SessionBridgeEventEnvelope) => void): () => void;
}

function truncate(text: string, maxLength = 280): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function safePreviewString(value: string, key?: string): string {
	const lowerKey = key?.toLowerCase() || "";
	if (
		lowerKey.includes("base64") ||
		lowerKey === "data" ||
		lowerKey === "content" ||
		lowerKey.includes("dataurl") ||
		lowerKey.includes("preview")
	) {
		return `[omitted ${key || "binary"}: ${value.length} chars]`;
	}
	if (value.startsWith("data:")) {
		return `[omitted data url: ${value.length} chars]`;
	}
	return truncate(value, 160);
}

export function summarizeForBridge(value: unknown, maxLength = 280): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return truncate(value, maxLength);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);

	const seen = new WeakSet<object>();
	try {
		const json = JSON.stringify(
			value,
			(key, innerValue) => {
				if (typeof innerValue === "string") {
					return safePreviewString(innerValue, key || undefined);
				}
				if (typeof innerValue === "object" && innerValue !== null) {
					if (seen.has(innerValue)) return "[circular]";
					seen.add(innerValue);
					if (Array.isArray(innerValue) && innerValue.length > 20) {
						return [...innerValue.slice(0, 20), `[+${innerValue.length - 20} more items]`];
					}
				}
				return innerValue;
			},
			2,
		);
		if (!json) return undefined;
		return truncate(json, maxLength);
	} catch {
		return truncate(String(value), maxLength);
	}
}

function textFromUserContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => Boolean(block) && typeof block === "object")
		.filter((block) => block.type === "text")
		.map((block) => block.text || "")
		.join("\n")
		.trim();
}

function textFromAssistantContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => Boolean(block) && typeof block === "object")
		.filter((block) => block.type === "text")
		.map((block) => block.text || "")
		.join("\n")
		.trim();
}

function textFromToolResultContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => Boolean(block) && typeof block === "object")
		.filter((block) => block.type === "text")
		.map((block) => block.text || "")
		.join("\n")
		.trim();
}

function summarizeToolCalls(content: unknown): SessionWireMessage["toolCalls"] {
	if (!Array.isArray(content)) return undefined;
	const toolCalls = content
		.filter(
			(block): block is { type: "toolCall"; name: string; arguments: Record<string, unknown> } =>
				Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "toolCall",
		)
		.map((block) => ({
			name: block.name,
			argsSummary: summarizeForBridge(block.arguments, 180) || "{}",
		}));
	return toolCalls.length > 0 ? toolCalls : undefined;
}

function summarizeAttachments(
	attachments: Array<{ type?: string; mimeType: string; fileName: string }> | undefined,
): SessionWireMessage["attachments"] {
	if (!attachments?.length) return undefined;
	return attachments.map((attachment) => ({
		kind: attachment.type === "image" ? "image" : "file",
		mimeType: attachment.mimeType,
		name: attachment.fileName,
	}));
}

export function projectSessionMessage(message: AgentMessage, messageIndex: number): SessionWireMessage | null {
	if (isUserMessageWithAttachments(message)) {
		return {
			messageIndex,
			role: "user",
			text: textFromUserContent(message.content),
			timestamp: message.timestamp,
			attachments: summarizeAttachments(message.attachments),
		};
	}

	if (message.role === "user") {
		return {
			messageIndex,
			role: "user",
			text: textFromUserContent(message.content),
			timestamp: message.timestamp,
		};
	}

	if (message.role === "assistant") {
		return {
			messageIndex,
			role: "assistant",
			text: textFromAssistantContent(message.content),
			timestamp: message.timestamp,
			provider: message.provider,
			model: message.model,
			toolCalls: summarizeToolCalls(message.content),
		};
	}

	if (message.role === "toolResult") {
		return {
			messageIndex,
			role: "toolResult",
			text: textFromToolResultContent(message.content),
			timestamp: message.timestamp,
			toolName: message.toolName,
			toolCallId: message.toolCallId,
			isError: message.isError,
		};
	}

	if (message.role === "navigation") {
		const tabText = message.tabId !== undefined ? ` (tab ${message.tabId})` : "";
		return {
			messageIndex,
			role: "navigation",
			text: `Navigation: ${message.title} — ${message.url}${tabText}`,
		};
	}

	return null;
}

export function projectSessionMessages(messages: AgentMessage[]): SessionWireMessage[] {
	const projected: SessionWireMessage[] = [];
	for (let i = 0; i < messages.length; i++) {
		const wireMessage = projectSessionMessage(messages[i], i);
		if (wireMessage) projected.push(wireMessage);
	}
	return projected;
}

export function buildSessionHistoryResult(
	snapshot: SessionSnapshot,
	params?: SessionHistoryParams,
): SessionHistoryResult {
	let messages = snapshot.messages;
	if (typeof params?.afterMessageIndex === "number") {
		messages = messages.filter((message) => message.messageIndex > params.afterMessageIndex!);
	}
	if (typeof params?.last === "number" && params.last >= 0) {
		messages = messages.slice(-params.last);
	}
	return {
		sessionId: snapshot.sessionId,
		persisted: snapshot.persisted,
		title: snapshot.title,
		model: snapshot.model,
		isStreaming: snapshot.isStreaming,
		messageCount: snapshot.messageCount,
		lastMessageIndex: snapshot.lastMessageIndex,
		messages,
	};
}
