import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@mariozechner/pi-ai";
import { convertAttachments, isUserMessageWithAttachments } from "@mariozechner/pi-web-ui";
import type { PageSnapshotEntry, PageSnapshotResult } from "../tools/page-snapshot.js";
import type { NavigationMessage } from "./NavigationMessage.js";

// Helper: Check if a message has toolCall blocks
function hasToolCalls(msg: Message): boolean {
	if (msg.role !== "assistant") return false;
	return msg.content.some((block) => block.type === "toolCall");
}

// Helper: Get all toolCall IDs from an assistant message
function getToolCallIds(msg: Message): Set<string> {
	const ids = new Set<string>();
	if (msg.role !== "assistant") return ids;

	for (const block of msg.content) {
		if (block.type === "toolCall") {
			ids.add(block.id);
		}
	}
	return ids;
}

// Helper: Check if a toolResult message matches the given tool call IDs
function isToolResultFor(msg: Message, toolCallIds: Set<string>): boolean {
	if (msg.role !== "toolResult") return false;
	return toolCallIds.has(msg.toolCallId);
}

// Reorder messages so assistant tool calls are immediately followed by their tool results
// This moves navigation and other user messages after the tool results
function reorderMessages(messages: Message[]): Message[] {
	const result: Message[] = [];
	let i = 0;

	while (i < messages.length) {
		const msg = messages[i];

		if (msg.role === "assistant" && hasToolCalls(msg)) {
			// Found assistant with tool calls
			result.push(msg);
			i++;

			// Collect tool call IDs from this assistant message
			const toolCallIds = getToolCallIds(msg);

			// Scan forward and collect messages until next assistant or end
			const toolResultMessages: Message[] = [];
			const otherMessages: Message[] = [];

			while (i < messages.length && messages[i].role !== "assistant") {
				const nextMsg = messages[i];

				if (isToolResultFor(nextMsg, toolCallIds)) {
					toolResultMessages.push(nextMsg);
				} else {
					otherMessages.push(nextMsg);
				}
				i++;
			}

			// Add tool result messages first, then other messages (like nav)
			result.push(...toolResultMessages);
			result.push(...otherMessages);
		} else {
			// Not an assistant with tool calls, just add it
			result.push(msg);
			i++;
		}
	}

	return result;
}

function truncateSnapshotText(text: string | undefined, maxLength = 120): string | undefined {
	const normalized = text?.replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}...`;
}

function formatSnapshotEntry(entry: PageSnapshotEntry): string {
	const label = truncateSnapshotText(entry.label);
	const name = truncateSnapshotText(entry.name);
	const text = truncateSnapshotText(entry.text);
	const selectors = entry.selectorCandidates.slice(0, 2).join(", ");
	const stableId = entry.stableElementId ? ` stable=${entry.stableElementId}` : "";
	const role = entry.role ? ` role=${entry.role}` : "";
	const heading = entry.headingLevel ? ` heading=${entry.headingLevel}` : "";
	const landmark = entry.landmark ? ` landmark=${entry.landmark}` : "";
	const content = [
		name ? `name="${name}"` : undefined,
		label ? `label="${label}"` : undefined,
		text ? `text="${text}"` : undefined,
		selectors ? `selectors="${selectors}"` : undefined,
	]
		.filter((part): part is string => Boolean(part))
		.join(" ");
	const bbox = `bbox=${Math.round(entry.boundingBox.x)},${Math.round(entry.boundingBox.y)},${Math.round(
		entry.boundingBox.width,
	)}x${Math.round(entry.boundingBox.height)}`;
	return `- ref=${entry.snapshotId}${stableId}${role}${heading}${landmark} tag=${entry.tagName} interactive=${entry.interactive} ${bbox}${content ? ` ${content}` : ""}`;
}

function formatNavigationSnapshot(snapshot: PageSnapshotResult | undefined): string {
	if (!snapshot) return "";
	const entries = snapshot.entries.map(formatSnapshotEntry).join("\n");
	const query = snapshot.query ? ` query="${snapshot.query}"` : "";
	return `
<page-snapshot tab-id="${snapshot.tabId}" frame-id="${snapshot.frameId}" generated-at="${snapshot.generatedAt}" total-candidates="${snapshot.totalCandidates}" returned="${snapshot.entries.length}" truncated="${snapshot.truncated}"${query}>
${entries}
</page-snapshot>
`;
}

// Custom message transformer for browser extension
// Handles navigation messages and app-specific message types
export async function browserMessageTransformer(messages: AgentMessage[]): Promise<Message[]> {
	const transformed = [];

	for (const m of messages) {
		// Filter out UI-only messages
		if (m.role === "artifact" || m.role === "welcome") {
			continue;
		}

		// Filter non-LLM messages
		if (
			m.role !== "user" &&
			m.role !== "user-with-attachments" &&
			m.role !== "assistant" &&
			m.role !== "toolResult" &&
			m.role !== "navigation"
		) {
			continue;
		}

		if (m.role === "navigation") {
			const nav = m as NavigationMessage;
			const tabInfo = nav.tabId !== undefined ? ` (tab id: ${nav.tabId})` : "";
			const snapshotInfo = formatNavigationSnapshot(nav.snapshot);

			// Use cached skills output (formatted at message creation time)
			const skillsInfo = nav.skillsOutput;

			transformed.push({
				role: "user",
				content: `<browser-context>
✓ Navigation succeeded: ${nav.title}${tabInfo}
✓ URL: ${nav.url}
${snapshotInfo}
</browser-context>

<skills>
${skillsInfo}
</skills>

<instructions>
- DO NOT STOP - This is informational only. CONTINUE IMMEDIATELY with the next step of your multi-step workflow. This message does NOT mean you should wait for user input.
- DO NOT REPEAT THIS MESSAGE BACK TO THE USER!
</instructions>`,
			} as Message);
		} else if (isUserMessageWithAttachments(m)) {
			const content: (TextContent | ImageContent)[] =
				typeof m.content === "string" ? [{ type: "text", text: m.content }] : [...m.content];

			if (m.attachments) {
				content.push(...convertAttachments(m.attachments));
			}

			transformed.push({
				role: "user",
				content,
				timestamp: m.timestamp,
			} as Message);
		} else if (m.role === "user") {
			const { attachments, ...rest } = m as any;
			transformed.push(rest as Message);
		} else {
			transformed.push(m as Message);
		}
	}

	return reorderMessages(transformed);
}
