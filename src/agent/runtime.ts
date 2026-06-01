import { Agent, type AgentOptions, type AgentState } from "@mariozechner/pi-agent-core";

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
	const agent = new Agent({
		initialState: initialState,
		convertToLlm: options.convertToLlm,
		toolExecution: options.toolExecution ?? "sequential",
		streamFn: options.streamFn,
		getApiKey: options.getApiKey,
		transformContext: options.transformContext,
		beforeToolCall: options.beforeToolCall,
		afterToolCall: options.afterToolCall,
		shouldStopAfterTurn: options.shouldStopAfterTurn,
		prepareNextTurn: options.prepareNextTurn,
		sessionId: options.sessionId,
	});

	return {
		agent,
		sessionId: options.sessionId,
		systemPrompt: agent.state.systemPrompt,
		model: agent.state.model,
		thinkingLevel: agent.state.thinkingLevel,
	};
}
