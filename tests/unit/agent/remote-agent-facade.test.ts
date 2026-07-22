import type { AgentMessage } from "@shuv1337/pi-agent-core";
import { describe, expect, it } from "vitest";
import { asPiWebUiAgent, RemoteAgentFacade } from "@shuvgeist/extension/agent/remote-agent-facade";
import { RemoteSessionClient, type RemoteSessionTransport } from "@shuvgeist/extension/agent/remote-session-client";
import {
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeRequestEnvelope,
	type RuntimeResponseEnvelope,
	type RuntimeSnapshotEnvelope,
	type RuntimeStreamEnvelope,
	type RuntimeTargetIdentity,
	type RuntimeValue,
} from "@shuvgeist/extension/agent/runtime-protocol";

const target: RuntimeTargetIdentity = { kind: "chrome-tab", tabRef: "active" };

function success(request: RuntimeRequestEnvelope, result: RuntimeValue = { ok: true }): RuntimeResponseEnvelope {
	return {
		kind: "response",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: request.runtimeEpoch,
		clientId: request.clientId,
		windowId: request.windowId,
		sessionId: request.sessionId,
		target: request.target,
		requestId: request.requestId,
		operation: request.operation.type,
		ok: true,
		result,
	};
}

function snapshotEnvelope(): RuntimeSnapshotEnvelope {
	return {
		kind: "stream",
		streamType: "session-snapshot",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "sidepanel",
		windowId: 4,
		sessionId: "session-1",
		target,
		revision: 1,
		eventSeq: 1,
		snapshot: {
			sessionId: "session-1",
			target,
			revision: 1,
			systemPrompt: "Remote only.",
			model: { provider: "openai", id: "model-a" },
			thinkingLevel: "medium",
			messages: [{ role: "assistant", content: "ready" }],
			tools: [{ name: "navigate", label: "Navigate" }],
			pendingToolCallIds: [],
			isStreaming: false,
			activeExecutions: [],
			artifacts: [],
		},
	};
}

class TestTransport implements RemoteSessionTransport {
	readonly requests: RuntimeRequestEnvelope[] = [];
	private readonly listeners = new Set<(envelope: RuntimeStreamEnvelope) => void>();

	async send(request: RuntimeRequestEnvelope): Promise<RuntimeResponseEnvelope> {
		this.requests.push(request);
		if (request.operation.type === "attach") this.emit(snapshotEnvelope());
		return success(request);
	}

	subscribe(listener: (envelope: RuntimeStreamEnvelope) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(envelope: RuntimeStreamEnvelope): void {
		for (const listener of this.listeners) listener(envelope);
	}
}

describe("RemoteAgentFacade", () => {
	it("is a render-only pi-web-ui 0.78 boundary and forwards every mutation remotely", async () => {
		const transport = new TestTransport();
		const client = new RemoteSessionClient({
			transport,
			clientId: "sidepanel",
			windowId: 4,
			sessionId: "session-1",
			target,
			createRequestId: (operation, sequence) => `${operation}-${sequence}`,
			createExecutionId: (_kind, sequence) => `execution-${sequence}`,
		});
		const errors: unknown[] = [];
		const facade = new RemoteAgentFacade(client, (error) => errors.push(error));
		const piAgent = asPiWebUiAgent(facade);
		const connecting = client.connect();
		transport.emit({
			kind: "stream",
			streamType: "hello",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: "epoch-1",
			clientId: "sidepanel",
			windowId: 4,
			recovery: { mode: "resumed", sessions: [{ sessionId: "session-1", target, revision: 1, eventSeq: 0 }] },
		});
		await connecting;

		expect(piAgent.state.model?.id).toBe("model-a");
		piAgent.state.tools = [{ name: "render-only" }];
		expect(client.state.tools).toEqual([{ name: "render-only" }]);
		expect(() => {
			piAgent.state.messages = [{ role: "user", content: "local mutation" } as AgentMessage];
		}).toThrow(TypeError);
		expect(client.state.messages).toEqual([{ role: "assistant", content: "ready" }]);

		piAgent.state.model = { provider: "anthropic", id: "model-b" };
		piAgent.state.thinkingLevel = "high";
		facade.steer({ role: "user", content: "tab changed", timestamp: 2 });
		await facade.waitForIdle();

		const operations = transport.requests.map((request) => request.operation.type);
		expect(operations[0]).toBe("attach");
		expect(new Set(operations.slice(1))).toEqual(new Set(["set-model", "set-thinking", "steer"]));
		expect(errors).toEqual([]);
		facade.dispose();
	});
});
