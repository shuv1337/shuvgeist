import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentMessage,
	BeforeToolCallContext,
	BeforeToolCallResult,
} from "@shuv1337/pi-agent-core";
import type { TextContent } from "@shuv1337/pi-ai";
import type { AgentRuntimeHooks } from "./runtime.js";

export interface PlannerValidatorNote {
	kind: "tool-result" | "drift";
	message: string;
	toolName?: string;
	turn: number;
}

export interface PlannerValidatorState {
	turns: number;
	toolCalls: number;
	validatorNotes: PlannerValidatorNote[];
	driftDetected: boolean;
}

export interface PlannerValidatorOptions {
	plannerPrompt?: string;
	driftMarkers?: readonly string[];
	maxConsecutiveDriftMarkers?: number;
	state?: PlannerValidatorState;
}

export interface PlannerValidatorHooks extends AgentRuntimeHooks {
	state: PlannerValidatorState;
}

const DEFAULT_PLANNER_PROMPT = [
	"Planner-Actor-Validator mode:",
	"1. Plan the next browser action from the current observation before acting.",
	"2. Prefer semantic refs and fresh snapshots over brittle selectors.",
	"3. After each tool result, validate whether the page state still matches the task.",
	"4. If the trajectory has drifted, stop and explain the mismatch instead of continuing blindly.",
].join("\n");

const DEFAULT_DRIFT_MARKERS = ["drift", "wrong page", "stale ref", "unexpected navigation", "off task"] as const;

export function createPlannerValidatorHooks(options: PlannerValidatorOptions = {}): PlannerValidatorHooks {
	const state = options.state ?? createPlannerValidatorState();
	const plannerPrompt = options.plannerPrompt ?? DEFAULT_PLANNER_PROMPT;
	const driftMarkers = options.driftMarkers ?? DEFAULT_DRIFT_MARKERS;
	const maxConsecutiveDriftMarkers = options.maxConsecutiveDriftMarkers ?? 1;

	return {
		state,
		async transformContext(messages) {
			if (messages.some(isPlannerInstructionMessage)) return messages;
			return [createPlannerInstructionMessage(plannerPrompt), ...messages];
		},
		async beforeToolCall(context) {
			state.toolCalls++;
			return blockToolCallAfterDrift(context, state);
		},
		async afterToolCall(context) {
			const note = validatorNoteFromToolResult(context, state.turns + 1);
			if (note) {
				state.validatorNotes.push(note);
				if (containsDriftMarker(note.message, driftMarkers)) {
					state.driftDetected = true;
				}
			}
			return undefined satisfies AfterToolCallResult | undefined;
		},
		async shouldStopAfterTurn(context) {
			state.turns++;
			const assistantText = textFromMessage(context.message);
			if (containsDriftMarker(assistantText, driftMarkers)) {
				state.validatorNotes.push({
					kind: "drift",
					message: assistantText,
					turn: state.turns,
				});
				state.driftDetected = true;
			}
			return recentDriftCount(state.validatorNotes, state.turns) >= maxConsecutiveDriftMarkers;
		},
	};
}

export function createPlannerValidatorState(): PlannerValidatorState {
	return {
		turns: 0,
		toolCalls: 0,
		validatorNotes: [],
		driftDetected: false,
	};
}

function createPlannerInstructionMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text: "[shuvgeist-planner-validator]\n" + text }],
		timestamp: 0,
	};
}

function isPlannerInstructionMessage(message: AgentMessage): boolean {
	return textFromMessage(message).includes("[shuvgeist-planner-validator]");
}

function blockToolCallAfterDrift(
	context: BeforeToolCallContext,
	state: PlannerValidatorState,
): BeforeToolCallResult | undefined {
	if (!state.driftDetected) return undefined;
	const toolName = typeof context.toolCall.name === "string" ? context.toolCall.name : "tool";
	return {
		block: true,
		reason: `Planner-validator blocked ${toolName} because drift was detected in the previous turn.`,
	};
}

function validatorNoteFromToolResult(context: AfterToolCallContext, turn: number): PlannerValidatorNote | undefined {
	const text = textFromToolResult(context.result);
	if (!text) return undefined;
	const toolName = typeof context.toolCall.name === "string" ? context.toolCall.name : undefined;
	return {
		kind: "tool-result",
		message: text,
		toolName,
		turn,
	};
}

function textFromToolResult(result: AfterToolCallContext["result"]): string {
	const content = result.content ?? [];
	return content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
}

function textFromMessage(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
}

function containsDriftMarker(text: string, markers: readonly string[]): boolean {
	const normalized = text.toLowerCase();
	return markers.some((marker) => normalized.includes(marker.toLowerCase()));
}

function recentDriftCount(notes: PlannerValidatorNote[], currentTurn: number): number {
	let count = 0;
	for (let turn = currentTurn; turn > 0; turn--) {
		const hasDrift = notes.some((note) => note.turn === turn && note.kind === "drift");
		if (!hasDrift) break;
		count++;
	}
	return count;
}
