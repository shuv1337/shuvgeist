import type { AgentTool } from "@shuv1337/pi-agent-core";
import { type Static, Type } from "@shuv1337/pi-ai";
import { ASK_USER_WHICH_ELEMENT_TOOL_DESCRIPTION } from "../prompts/prompts.js";
import { isProtectedTabUrl, resolveTabTarget } from "./helpers/browser-target.js";
import { type ElementInfo, ElementPickCancelled, pickElement } from "./helpers/element-picker.js";

// ============================================================================
// TYPES
// ============================================================================

const selectElementSchema = Type.Object({
	message: Type.Optional(
		Type.String({
			description:
				"Optional message to show the user while they select the element (e.g., 'Please click the table you want to extract')",
		}),
	),
});

export type SelectElementParams = Static<typeof selectElementSchema>;

// Re-export ElementInfo from the shared helper so existing imports keep working.
export type { ElementInfo } from "./helpers/element-picker.js";
export type SelectElementResult = ElementInfo;

// ============================================================================
// TOOL
// ============================================================================

export class AskUserWhichElementTool implements AgentTool<typeof selectElementSchema, SelectElementResult> {
	label = "Ask User Which Element";
	name = "ask_user_which_element";
	description = ASK_USER_WHICH_ELEMENT_TOOL_DESCRIPTION;
	parameters = selectElementSchema;
	windowId?: number;

	constructor(options: { windowId?: number } = {}) {
		this.windowId = options.windowId;
	}

	async execute(
		_toolCallId: string,
		args: SelectElementParams,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: SelectElementResult }> {
		try {
			// Check if already aborted
			if (signal?.aborted) {
				throw new Error("Tool execution was aborted");
			}

			// Get the active tab
			const { tab, tabId } = await resolveTabTarget({ windowId: this.windowId });

			// Check if we can execute scripts on this tab
			if (isProtectedTabUrl(tab.url)) {
				throw new Error(`Cannot select elements on ${tab.url}. Extension pages and internal URLs are protected.`);
			}

			let result: ElementInfo;
			try {
				result = await pickElement(tabId, { message: args.message, signal });
			} catch (err) {
				if (err instanceof ElementPickCancelled) {
					throw new Error("Element selection was cancelled");
				}
				throw err;
			}

			// Build output message
			let output = `Element selected: <${result.tagName}>\n`;
			output += `Selector: ${result.selector}\n`;
			output += `XPath: ${result.xpath}\n`;

			if (result.attributes.id) {
				output += `ID: ${result.attributes.id}\n`;
			}
			if (result.attributes.class) {
				output += `Classes: ${result.attributes.class}\n`;
			}

			if (result.text) {
				const displayText = result.text.length > 100 ? `${result.text.substring(0, 100)}...` : result.text;
				output += `Text: ${displayText}\n`;
			}

			output += `Position: (${Math.round(result.boundingBox.x)}, ${Math.round(result.boundingBox.y)})\n`;
			output += `Size: ${Math.round(result.boundingBox.width)}x${Math.round(result.boundingBox.height)}\n`;

			return {
				content: [{ type: "text", text: output }],
				details: result,
			};
		} catch (error: unknown) {
			const err = error as Error;
			console.error("[select-element] Caught error, re-throwing:", err.message);
			throw err;
		}
	}
}

// Create singleton instance
export const askUserWhichElementTool = new AskUserWhichElementTool();
