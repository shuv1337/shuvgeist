import { Agent, type AgentOptions, type AgentState } from "@mariozechner/pi-agent-core";
import {
	createPlannerValidatorHooks,
	type PlannerValidatorOptions,
	type PlannerValidatorState,
} from "./planner-validator.js";

export type AgentRuntimeInitialState = NonNullable<AgentOptions["initialState"]>;
export type AgentRuntimeThinkingLevel = AgentState["thinkingLevel"];
export type AgentRuntimeHooks = Pick<
	AgentOptions,
	"transformContext" | "beforeToolCall" | "afterToolCall" | "shouldStopAfterTurn" | "prepareNextTurn"
>;

export const DEFAULT_AGENT_THINKING_LEVEL: AgentRuntimeThinkingLevel = "medium";

export interface AgentSessionContext {
	agent: Agent;
	sessionId?: string;
	systemPrompt: string;
	model: AgentState["model"];
	thinkingLevel: AgentRuntimeThinkingLevel;
	plannerValidator?: PlannerValidatorState;
}

export interface CreateAgentRuntimeOptions extends AgentRuntimeHooks {
	initialState?: AgentRuntimeInitialState;
	systemPrompt: string;
	model?: AgentState["model"];
	thinkingLevel?: AgentRuntimeThinkingLevel;
	convertToLlm?: AgentOptions["convertToLlm"];
	streamFn?: AgentOptions["streamFn"];
	getApiKey?: AgentOptions["getApiKey"];
	toolExecution?: AgentOptions["toolExecution"];
	sessionId?: string;
	plannerValidator?: PlannerValidatorOptions | false;
}

function createDefaultInitialState(options: CreateAgentRuntimeOptions): AgentRuntimeInitialState {
	return {
		systemPrompt: options.systemPrompt,
		model: options.model,
		thinkingLevel: options.thinkingLevel ?? DEFAULT_AGENT_THINKING_LEVEL,
		messages: [],
		tools: [],
	};
}

export function createAgentRuntime(options: CreateAgentRuntimeOptions): AgentSessionContext {
	const initialState = options.initialState ?? createDefaultInitialState(options);
	const plannerValidatorHooks = options.plannerValidator
		? createPlannerValidatorHooks(options.plannerValidator)
		: undefined;
	const agent = new Agent({
		initialState: initialState,
		convertToLlm: options.convertToLlm,
		toolExecution: options.toolExecution ?? "sequential",
		streamFn: options.streamFn,
		getApiKey: options.getApiKey,
		transformContext:
			plannerValidatorHooks?.transformContext || options.transformContext
				? async (messages, signal) => {
						const planned = plannerValidatorHooks?.transformContext
							? await plannerValidatorHooks.transformContext(messages, signal)
							: messages;
						return options.transformContext ? await options.transformContext(planned, signal) : planned;
					}
				: undefined,
		beforeToolCall:
			plannerValidatorHooks?.beforeToolCall || options.beforeToolCall
				? async (context, signal) => {
						const plannerResult = await plannerValidatorHooks?.beforeToolCall?.(context, signal);
						if (plannerResult?.block) return plannerResult;
						return await options.beforeToolCall?.(context, signal);
					}
				: undefined,
		afterToolCall:
			plannerValidatorHooks?.afterToolCall || options.afterToolCall
				? async (context, signal) => {
						const callerResult = await options.afterToolCall?.(context, signal);
						const plannerResult = await plannerValidatorHooks?.afterToolCall?.(context, signal);
						return callerResult ?? plannerResult;
					}
				: undefined,
		shouldStopAfterTurn:
			plannerValidatorHooks?.shouldStopAfterTurn || options.shouldStopAfterTurn
				? async (context) => {
						if (await plannerValidatorHooks?.shouldStopAfterTurn?.(context)) return true;
						return (await options.shouldStopAfterTurn?.(context)) ?? false;
					}
				: undefined,
		prepareNextTurn: options.prepareNextTurn,
		sessionId: options.sessionId,
	});

	return {
		agent,
		sessionId: options.sessionId,
		systemPrompt: agent.state.systemPrompt,
		model: agent.state.model,
		thinkingLevel: agent.state.thinkingLevel,
		plannerValidator: plannerValidatorHooks?.state,
	};
}
