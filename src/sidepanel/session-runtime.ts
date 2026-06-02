import type { Agent, AgentMessage } from "@shuv1337/pi-agent-core";
import type { Model } from "@shuv1337/pi-ai";
import {
	type AgentRuntimeHooks,
	type AgentRuntimeInitialState,
	type AgentRuntimeThinkingLevel,
	DEFAULT_AGENT_THINKING_LEVEL,
} from "../agent/runtime.js";
import {
	ErrorCodes,
	type SessionArtifactsResult,
	type SessionInjectParams,
	type SessionInjectResult,
	type SessionNewParams,
	type SessionNewResult,
	type SessionSetModelParams,
	type SessionSetModelResult,
} from "../bridge/protocol.js";
import {
	projectSessionMessage,
	projectSessionMessages,
	type SessionBridgeAdapter,
	type SessionSnapshot,
} from "../bridge/session-bridge.js";
import { generateSessionTitle, shouldSaveSession } from "./session-metadata.js";

export interface SidepanelSessionRuntimeDeps {
	getAgent(): Agent;
	getSessionId(): string | undefined;
	setSessionId(sessionId: string | undefined): void;
	getTitle(): string;
	setTitle(title: string): void;
	systemPrompt: string;
	saveSession(): Promise<void>;
	render(): void;
	emitSessionChanged(): void;
	emitSessionMessage(message: AgentMessage, messageIndex?: number): void;
	updateUrl(sessionId: string): void;
	createAgent(options?: SidepanelCreateAgentOptions): Promise<void>;
	resolveModelSpec(spec: string, providerHint?: string): Promise<Model<any>>;
	normalizeModelForRuntime(model: Model<any>): Model<any>;
	requestModelUiUpdate(): void;
	setLastUsedModel(model: Model<any>): Promise<void>;
	updateAuthLabel(): Promise<void>;
	getArtifactsResult(): SessionArtifactsResult;
	logSessionIdleWait(durationMs: number): void;
	createSessionId(): string;
}

export interface SidepanelCreateAgentOptions extends AgentRuntimeHooks {
	initialState?: AgentRuntimeInitialState;
	model?: Model<any>;
	thinkingLevel?: AgentRuntimeThinkingLevel;
}

export class SidepanelSessionRuntime implements Omit<SessionBridgeAdapter, "subscribe"> {
	constructor(private readonly deps: SidepanelSessionRuntimeDeps) {}

	getSnapshot(): SessionSnapshot {
		const agent = this.deps.getAgent();
		const messages = agent?.state.messages || [];
		return {
			sessionId: this.deps.getSessionId(),
			persisted: Boolean(this.deps.getSessionId()),
			title: this.deps.getTitle(),
			model: agent?.state.model ? { provider: agent.state.model.provider, id: agent.state.model.id } : undefined,
			isStreaming: Boolean(agent?.state.isStreaming),
			messageCount: messages.length,
			lastMessageIndex: messages.length > 0 ? messages.length - 1 : -1,
			messages: projectSessionMessages(messages),
		};
	}

	waitForIdle(): Promise<void> {
		return this.deps.getAgent().waitForIdle();
	}

	async appendInjectedMessage(params: SessionInjectParams): Promise<SessionInjectResult> {
		const currentSessionId = this.deps.getSessionId();
		const agent = this.deps.getAgent();
		if (!currentSessionId) {
			const error = new Error("No active persisted session");
			(error as Error & { code?: number }).code = ErrorCodes.NO_ACTIVE_SESSION;
			throw error;
		}
		if (params.expectedSessionId !== currentSessionId) {
			const error = new Error("Active session changed");
			(error as Error & { code?: number }).code = ErrorCodes.SESSION_MISMATCH;
			throw error;
		}
		if (agent.state.isStreaming) {
			if (params.waitForIdle === false) {
				const error = new Error("Session is busy");
				(error as Error & { code?: number }).code = ErrorCodes.SESSION_BUSY;
				throw error;
			}
			const waitStartedAt = Date.now();
			await agent.waitForIdle();
			this.deps.logSessionIdleWait(Date.now() - waitStartedAt);
		}

		const timestamp = Date.now();
		const message =
			params.role === "assistant"
				? {
						role: "assistant" as const,
						content: [{ type: "text" as const, text: params.content }],
						api: agent.state.model.api,
						provider: agent.state.model.provider,
						model: agent.state.model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop" as const,
						timestamp,
					}
				: {
						role: "user" as const,
						content: params.content,
						timestamp,
					};

		const messageIndex = agent.state.messages.length;
		if (params.role === "assistant") {
			agent.state.messages = [...agent.state.messages, message];
		} else {
			agent.prompt(message).catch((err) => {
				console.error("[Bridge] Injected prompt failed:", err);
			});
		}

		if (!this.deps.getTitle() && shouldSaveSession(agent.state.messages)) {
			this.deps.setTitle(generateSessionTitle(agent.state.messages));
		}
		await this.deps.saveSession();
		this.deps.render();
		this.deps.emitSessionMessage(message, messageIndex);
		this.deps.emitSessionChanged();
		return {
			ok: true,
			sessionId: currentSessionId,
			messageIndex,
		};
	}

	async newSession(params: SessionNewParams): Promise<SessionNewResult> {
		const agent = this.deps.getAgent();
		if (agent.state.isStreaming) {
			await agent.waitForIdle();
		}

		const model = params.model ? await this.deps.resolveModelSpec(params.model) : undefined;
		this.deps.setSessionId(undefined);
		this.deps.setTitle("");
		await this.deps.createAgent(
			model
				? {
						model,
						thinkingLevel: DEFAULT_AGENT_THINKING_LEVEL,
					}
				: undefined,
		);

		const sessionId = this.deps.createSessionId();
		this.deps.setSessionId(sessionId);
		this.deps.updateUrl(sessionId);
		this.deps.emitSessionChanged();
		this.deps.render();

		const nextAgent = this.deps.getAgent();
		return {
			ok: true,
			sessionId,
			model: nextAgent.state.model
				? { provider: nextAgent.state.model.provider, id: nextAgent.state.model.id }
				: undefined,
		};
	}

	async setModel(params: SessionSetModelParams): Promise<SessionSetModelResult> {
		const model = await this.deps.resolveModelSpec(params.model, params.provider);
		const normalizedModel = this.deps.normalizeModelForRuntime(model);
		this.deps.getAgent().state.model = normalizedModel;
		this.deps.requestModelUiUpdate();
		await this.deps.setLastUsedModel(normalizedModel);
		this.deps.updateAuthLabel().catch(() => {});
		this.deps.emitSessionChanged();
		this.deps.render();
		return {
			ok: true,
			model: { provider: normalizedModel.provider, id: normalizedModel.id },
		};
	}

	getArtifacts(): SessionArtifactsResult {
		return this.deps.getArtifactsResult();
	}
}

export function projectRuntimeSessionMessage(message: AgentMessage, messageIndex: number) {
	return projectSessionMessage(message, messageIndex);
}
