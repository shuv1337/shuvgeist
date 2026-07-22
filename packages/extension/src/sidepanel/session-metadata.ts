import type { AgentMessage, AgentState } from "@shuv1337/pi-agent-core";
import type { SessionMetadata } from "@shuv1337/pi-web-ui";

export type ShuvgeistSessionMetadata = SessionMetadata & { modelId: string };

export function shouldSaveSession(messages: AgentMessage[]): boolean {
	const hasUserMsg = messages.some((message) => message.role === "user" || message.role === "user-with-attachments");
	const hasAssistantMsg = messages.some((message) => message.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
}

export function generateSessionTitle(messages: AgentMessage[]): string {
	const firstUserMsg = messages.find((message) => message.role === "user" || message.role === "user-with-attachments");
	if (!firstUserMsg || (firstUserMsg.role !== "user" && firstUserMsg.role !== "user-with-attachments")) return "";

	let text = "";
	const content = firstUserMsg.content;
	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((block) => block.type === "text");
		text = textBlocks.map((block) => block.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : text.substring(0, 47) + "...";
}

export function aggregateSessionUsage(messages: AgentMessage[]): SessionMetadata["usage"] {
	const usage: SessionMetadata["usage"] = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	for (const message of messages) {
		if (message.role !== "assistant") continue;
		usage.input += message.usage.input;
		usage.output += message.usage.output;
		usage.cacheRead += message.usage.cacheRead;
		usage.cacheWrite += message.usage.cacheWrite;
		usage.totalTokens +=
			message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
		if (message.usage.cost) {
			usage.cost.input += message.usage.cost.input;
			usage.cost.output += message.usage.cost.output;
			usage.cost.cacheRead += message.usage.cost.cacheRead;
			usage.cost.cacheWrite += message.usage.cost.cacheWrite;
			usage.cost.total += message.usage.cost.total;
		}
	}

	return usage;
}

export function buildSessionPreview(messages: AgentMessage[], maxLength = 2048): string {
	let preview = "";
	for (const message of messages) {
		if (preview.length >= maxLength) break;
		if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((content) => content.type === "text")
							.map((content) => content.text)
							.join("\n") || "";
			preview += `${text}\n`;
		} else if (message.role === "assistant") {
			const text = message.content
				.filter((content) => content.type === "text" || content.type === "thinking")
				.map((content) => (content.type === "text" ? content.text : content.thinking))
				.join("\n");
			preview += `${text}\n`;
		}
	}
	return preview.substring(0, maxLength);
}

export function buildSessionMetadata(options: {
	sessionId: string;
	title: string;
	createdAt: string;
	lastModified: string;
	state: AgentState;
}): ShuvgeistSessionMetadata {
	return {
		id: options.sessionId,
		title: options.title,
		createdAt: options.createdAt,
		lastModified: options.lastModified,
		messageCount: options.state.messages.length,
		usage: aggregateSessionUsage(options.state.messages),
		modelId: options.state.model.id,
		thinkingLevel: options.state.thinkingLevel,
		preview: buildSessionPreview(options.state.messages),
	};
}
