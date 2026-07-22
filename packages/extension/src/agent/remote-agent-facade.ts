import type { Agent, AgentEvent, AgentMessage, AgentState } from "@shuv1337/pi-agent-core";
import type {
	RemoteSessionClient,
	RemoteSessionListener,
	RemoteSessionStateListener,
} from "./remote-session-client.js";
import type { RuntimeModelDescriptor, RuntimeSessionSnapshot, RuntimeThinkingLevel } from "./runtime-protocol.js";

/**
 * Compatibility boundary for pi-web-ui 0.78.
 *
 * ChatPanel is typed against the concrete Agent class, but its rendered UI only
 * consumes state, prompt/abort/subscribe and its setup probes streamFn/getApiKey.
 * This facade implements that structural surface while all execution remains in
 * the offscreen RemoteSessionClient. The one nominal cast belongs at the
 * ChatPanel.setAgent call site, never inside runtime code.
 */
export class RemoteAgentFacade {
	readonly streamFn: Agent["streamFn"];
	readonly getApiKey: NonNullable<Agent["getApiKey"]> = () => undefined;

	constructor(
		readonly client: RemoteSessionClient,
		private readonly onError?: (error: unknown) => void,
	) {
		this.streamFn = (() => {
			throw new Error("RemoteAgentFacade never executes a local provider stream");
		}) as Agent["streamFn"];
	}

	get state(): AgentState {
		return this.client.state as unknown as AgentState;
	}

	prompt(input: string | AgentMessage): Promise<void> {
		return this.client.prompt(input as unknown as Parameters<RemoteSessionClient["prompt"]>[0]);
	}

	abort(): void {
		this.client.abort();
	}

	abortActive(): Promise<void> {
		return this.client.abortActive();
	}

	waitForIdle(): Promise<void> {
		return this.client.waitForIdle();
	}

	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		const remoteListener: RemoteSessionListener = (event, signal) => listener(event as unknown as AgentEvent, signal);
		return this.client.subscribe(remoteListener);
	}

	subscribeState(listener: (snapshot: RuntimeSessionSnapshot) => void): () => void {
		const stateListener: RemoteSessionStateListener = (snapshot) => listener(snapshot);
		return this.client.subscribeState(stateListener);
	}

	setModel(model: RuntimeModelDescriptor): Promise<void> {
		return this.client.setModel(model);
	}

	setThinkingLevel(thinkingLevel: RuntimeThinkingLevel): Promise<void> {
		return this.client.setThinkingLevel(thinkingLevel);
	}

	replaceOrAppendMessage(message: AgentMessage, messageIndex?: number): Promise<void> {
		return this.client.replaceOrAppendMessage(
			message as unknown as Parameters<RemoteSessionClient["replaceOrAppendMessage"]>[0],
			messageIndex,
		);
	}

	steer(message: AgentMessage): void {
		void this.client
			.steer(message as unknown as Parameters<RemoteSessionClient["steer"]>[0])
			.catch((error: unknown) => this.onError?.(error));
	}

	dispose(): void {
		this.client.dispose();
	}
}

/** The only nominal bridge needed by installed pi-web-ui 0.78. */
export function asPiWebUiAgent(facade: RemoteAgentFacade): Agent {
	return facade as unknown as Agent;
}
