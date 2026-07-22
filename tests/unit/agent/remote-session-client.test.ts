import { describe, expect, it, vi } from "vitest";
import {
	RemoteSessionClient,
	RemoteSessionError,
	type RemoteSessionTransport,
} from "@shuvgeist/extension/agent/remote-session-client";
import {
	isRuntimeRequestEnvelope,
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeAgentEvent,
	type RuntimeAgentEventEnvelope,
	type RuntimeAgentMessage,
	type RuntimeExecutionEventEnvelope,
	type RuntimeHelloEnvelope,
	type RuntimeRequestEnvelope,
	type RuntimeResponseEnvelope,
	type RuntimeSessionSnapshot,
	type RuntimeSnapshotEnvelope,
	type RuntimeStreamEnvelope,
	type RuntimeTargetIdentity,
	type RuntimeTraceContext,
	type RuntimeValue,
} from "@shuvgeist/extension/agent/runtime-protocol";

const target: RuntimeTargetIdentity = { kind: "electron-window", appRef: "code", windowRef: "w1" };
const trace: RuntimeTraceContext = {
	traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	spanId: "bbbbbbbbbbbbbbbb",
	traceFlags: "01",
};

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve: Deferred<T>["resolve"] = () => {};
	let reject: Deferred<T>["reject"] = () => {};
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function findLastItem<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item !== undefined && predicate(item)) return item;
	}
	return undefined;
}

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
		...(request.trace ? { trace: request.trace } : {}),
		ok: true,
		result,
	};
}

function failure(request: RuntimeRequestEnvelope, code: string, message: string): RuntimeResponseEnvelope {
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
		...(request.trace ? { trace: request.trace } : {}),
		ok: false,
		error: { code, message, retryable: false },
	};
}

class TestTransport implements RemoteSessionTransport {
	readonly requests: RuntimeRequestEnvelope[] = [];
	unsubscribeCount = 0;
	sendImplementation: (request: RuntimeRequestEnvelope) => Promise<RuntimeResponseEnvelope> = async (request) =>
		success(request);
	private readonly listeners = new Set<(envelope: RuntimeStreamEnvelope) => void>();

	async send(request: RuntimeRequestEnvelope): Promise<RuntimeResponseEnvelope> {
		this.requests.push(request);
		return this.sendImplementation(request);
	}

	subscribe(listener: (envelope: RuntimeStreamEnvelope) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
			this.unsubscribeCount++;
		};
	}

	emit(envelope: RuntimeStreamEnvelope): void {
		for (const listener of this.listeners) listener(envelope);
	}

	get subscriberCount(): number {
		return this.listeners.size;
	}
}

function hello(runtimeEpoch = "epoch-1", overrides: Partial<RuntimeHelloEnvelope> = {}): RuntimeHelloEnvelope {
	return {
		kind: "stream",
		streamType: "hello",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch,
		clientId: "client-1",
		windowId: 1,
		trace,
		recovery: { mode: "fresh", sessions: [] },
		...overrides,
	};
}

function snapshot(overrides: Partial<RuntimeSessionSnapshot> = {}): RuntimeSessionSnapshot {
	return {
		sessionId: "session-1",
		target,
		revision: 3,
		systemPrompt: "Be precise.",
		model: { provider: "openai", id: "model-a" },
		thinkingLevel: "medium",
		messages: [{ role: "assistant", content: "ready" }],
		tools: [{ name: "navigate", label: "Navigate" }],
		pendingToolCallIds: ["tool-1"],
		isStreaming: false,
		activeExecutions: [],
		artifacts: [],
		...overrides,
	};
}

function snapshotEnvelope(
	eventSeq: number,
	revision = 3,
	overrides: Partial<RuntimeSnapshotEnvelope> = {},
): RuntimeSnapshotEnvelope {
	return {
		kind: "stream",
		streamType: "session-snapshot",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "client-1",
		windowId: 1,
		sessionId: "session-1",
		target,
		trace,
		revision,
		eventSeq,
		snapshot: snapshot({ revision }),
		...overrides,
	};
}

function agentEventEnvelope(
	eventSeq: number,
	revision: number,
	agentEvent: RuntimeAgentEvent,
	overrides: Partial<RuntimeAgentEventEnvelope> = {},
): RuntimeAgentEventEnvelope {
	return {
		kind: "stream",
		streamType: "agent-event",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "client-1",
		windowId: 1,
		sessionId: "session-1",
		target,
		trace,
		revision,
		eventSeq,
		agentEvent,
		...overrides,
	};
}

function executionEnvelope(
	eventSeq: number,
	status: RuntimeExecutionEventEnvelope["execution"]["status"],
	overrides: Partial<RuntimeExecutionEventEnvelope> = {},
): RuntimeExecutionEventEnvelope {
	return {
		kind: "stream",
		streamType: "execution",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "client-1",
		windowId: 1,
		sessionId: "session-1",
		target,
		trace,
		revision: 3,
		eventSeq,
		execution: {
			executionId: "execution-1",
			requestId: "prompt-1",
			kind: "prompt",
			status,
		},
		...overrides,
	};
}

function createClient(transport: TestTransport, initialRuntimeEpoch?: string): RemoteSessionClient {
	return new RemoteSessionClient({
		transport,
		clientId: "client-1",
		windowId: 1,
		sessionId: "session-1",
		target,
		trace,
		...(initialRuntimeEpoch ? { initialRuntimeEpoch } : {}),
		createRequestId: (operation, sequence) => `${operation}-${sequence}`,
		createExecutionId: (_kind, sequence) => `execution-${sequence}`,
		now: () => 123,
	});
}

async function connectWithSnapshot(
	client: RemoteSessionClient,
	transport: TestTransport,
	snapshotEvent = snapshotEnvelope(1),
): Promise<void> {
	const previous = transport.sendImplementation;
	transport.sendImplementation = async (request) => {
		if (request.operation.type === "attach") transport.emit(snapshotEvent);
		return previous(request);
	};
	const connecting = client.connect();
	transport.emit(hello(snapshotEvent.runtimeEpoch));
	await connecting;
}

async function connectFromKnownEpoch(client: RemoteSessionClient, transport: TestTransport): Promise<void> {
	const previous = transport.sendImplementation;
	transport.sendImplementation = async (request) => {
		if (request.operation.type === "attach") transport.emit(snapshotEnvelope(1));
		return previous(request);
	};
	await client.connect();
}

describe("RemoteSessionClient", () => {
	it("attaches after hello, reconstructs state, and fans events out to independent listeners", async () => {
		const transport = new TestTransport();
		const client = createClient(transport);
		const connecting = client.connect();
		expect(transport.requests).toHaveLength(0);
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "attach") transport.emit(snapshotEnvelope(1));
			return success(request);
		};
		transport.emit(hello());
		await connecting;

		expect(transport.requests[0]?.operation).toMatchObject({ type: "attach" });
		expect(client.state.systemPrompt).toBe("Be precise.");
		expect(client.state.model?.id).toBe("model-a");
		expect(client.state.pendingToolCalls).toEqual(new Set(["tool-1"]));
		expect(client.state.toolDescriptors).toEqual([{ name: "navigate", label: "Navigate" }]);

		const first: string[] = [];
		const second: string[] = [];
		const unsubscribeFirst = client.subscribe((event) => {
			first.push(event.type);
		});
		client.subscribe((event) => {
			second.push(event.type);
		});
		transport.emit(agentEventEnvelope(2, 4, { type: "agent_start" }));
		await client.waitForIdle();
		unsubscribeFirst();
		transport.emit(agentEventEnvelope(3, 5, { type: "agent_end", messages: [] }));
		await client.waitForIdle();
		expect(first).toEqual(["agent_start"]);
		expect(second).toEqual(["agent_start", "agent_end"]);
		expect(client.state.isStreaming).toBe(false);

		transport.emit(agentEventEnvelope(4, 6, { type: "agent_start" }, { windowId: 2 }));
		transport.emit(agentEventEnvelope(4, 6, { type: "agent_start" }, { sessionId: "session-2" }));
		await client.waitForIdle();
		expect(second).toHaveLength(2);
	});

	it("routes presentation page intents through a correlated offscreen-owned execution", async () => {
		const transport = new TestTransport();
		const client = createClient(transport);
		await connectWithSnapshot(client, transport);
		transport.sendImplementation = async (request) =>
			success(request, { url: "https://example.com", entries: [] });

		await expect(
			client.executePageOperation("page-snapshot", { tabId: 42, maxEntries: 60 }),
		).resolves.toEqual({ url: "https://example.com", entries: [] });
		expect(transport.requests.at(-1)).toMatchObject({
			requestId: "page-operation-2",
			operation: {
				type: "page-operation",
				executionId: "execution-1",
				operation: "page-snapshot",
				params: { tabId: 42, maxEntries: 60 },
			},
		});
	});

	it("bootstraps missing sessions with create or load and attaches when hello advertises the session", async () => {
		const createTransport = new TestTransport();
		createTransport.sendImplementation = async (request) => {
			if (request.operation.type === "create") {
				createTransport.emit(snapshotEnvelope(1, 1, { snapshot: snapshot({ revision: 1 }) }));
			}
			return success(request);
		};
		const createClient = new RemoteSessionClient({
			transport: createTransport,
			clientId: "client-1",
			windowId: 1,
			sessionId: "session-1",
			target,
			bootstrap: {
				mode: "create",
				systemPrompt: "Create remotely.",
				model: { provider: "openai", id: "model-create" },
				thinkingLevel: "high",
				initialMessages: [{ role: "assistant", content: "welcome" }],
			},
		});
		const creating = createClient.connect();
		createTransport.emit(hello());
		await creating;
		expect(createTransport.requests[0]?.operation).toEqual({
			type: "create",
			systemPrompt: "Create remotely.",
			model: { provider: "openai", id: "model-create" },
			thinkingLevel: "high",
			initialMessages: [{ role: "assistant", content: "welcome" }],
		});

		const loadTransport = new TestTransport();
		loadTransport.sendImplementation = async (request) => {
			if (request.operation.type === "load") loadTransport.emit(snapshotEnvelope(1));
			return success(request);
		};
		const loadClient = new RemoteSessionClient({
			transport: loadTransport,
			clientId: "client-1",
			windowId: 1,
			sessionId: "session-1",
			target,
			bootstrap: { mode: "load" },
		});
		const loading = loadClient.connect();
		loadTransport.emit(hello());
		await loading;
		expect(loadTransport.requests[0]?.operation).toEqual({ type: "load" });

		const attachTransport = new TestTransport();
		attachTransport.sendImplementation = async (request) => {
			if (request.operation.type === "attach") attachTransport.emit(snapshotEnvelope(4));
			return success(request);
		};
		const attachClient = new RemoteSessionClient({
			transport: attachTransport,
			clientId: "client-1",
			windowId: 1,
			sessionId: "session-1",
			target,
			bootstrap: { mode: "create", systemPrompt: "must not recreate" },
		});
		const attaching = attachClient.connect();
		attachTransport.emit(
			hello("epoch-1", {
				recovery: { mode: "resumed", sessions: [{ sessionId: "session-1", target, revision: 3, eventSeq: 3 }] },
			}),
		);
		await attaching;
		expect(attachTransport.requests[0]?.operation.type).toBe("attach");

		createClient.dispose();
		loadClient.dispose();
		attachClient.dispose();
	});

	it("recovers an observed session with load when a replacement host has no checkpoint cursor", async () => {
		const transport = new TestTransport();
		const client = createClient(transport);
		await connectWithSnapshot(client, transport);
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "load") {
				transport.emit(
					snapshotEnvelope(1, 3, {
						runtimeEpoch: "epoch-2",
						snapshot: snapshot({ revision: 3 }),
					}),
				);
			}
			return success(request);
		};
		transport.emit(hello("epoch-2", { recovery: { mode: "restarted", previousRuntimeEpoch: "epoch-1", sessions: [] } }));
		await client.waitForIdle();

		expect(transport.requests.at(-1)?.operation.type).toBe("load");
		client.dispose();
	});

	it("appends message_end events and treats agent_end messages as run-local rather than a transcript replacement", async () => {
		const transport = new TestTransport();
		const client = createClient(transport);
		const priorMessages: RuntimeAgentMessage[] = [
			{ role: "user", content: "earlier question" },
			{ role: "assistant", content: "earlier answer" },
		];
		await connectWithSnapshot(client, transport, snapshotEnvelope(1, 3, { snapshot: snapshot({ messages: priorMessages }) }));

		const currentRun: RuntimeAgentMessage[] = [
			{ role: "user", content: "new question" },
			{ role: "assistant", content: "new answer" },
		];
		transport.emit(agentEventEnvelope(2, 4, { type: "agent_start" }));
		transport.emit(agentEventEnvelope(3, 5, { type: "message_end", message: currentRun[0]! }));
		transport.emit(agentEventEnvelope(4, 6, { type: "message_end", message: currentRun[1]! }));
		transport.emit(agentEventEnvelope(5, 7, { type: "agent_end", messages: currentRun }));

		expect(client.state.messages).toEqual([...priorMessages, ...currentRun]);
		expect(client.state.isStreaming).toBe(false);
	});

	it("keeps executable tools local and sends an exact abort for the active prompt", async () => {
		const transport = new TestTransport();
		const client = createClient(transport, "epoch-1");
		await connectFromKnownEpoch(client, transport);
		const execute = (): string => "local";
		const localTool = { name: "local-only", execute };
		client.state.tools = [localTool];

		const promptResponse = deferred<RuntimeResponseEnvelope>();
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "prompt") return promptResponse.promise;
			return success(request);
		};
		const prompting = client.prompt("hello");
		await Promise.resolve();
		await Promise.resolve();
		const prompt = findLastItem(transport.requests, (request) => request.operation.type === "prompt");
		if (!prompt || prompt.operation.type !== "prompt") throw new Error("missing prompt request");
		transport.emit(
			executionEnvelope(2, "running", {
				execution: {
					executionId: prompt.operation.executionId,
					requestId: prompt.requestId,
					kind: "prompt",
					status: "running",
				},
			}),
		);
		transport.emit(
			executionEnvelope(3, "failed", {
				execution: {
					executionId: "rejected-execution",
					requestId: "rejected-prompt",
					kind: "prompt",
					status: "failed",
					error: { code: "SESSION_BUSY", message: "busy", retryable: true },
				},
			}),
		);

		await client.abortActive();
		const abort = findLastItem(transport.requests, (request) => request.operation.type === "abort");
		expect(abort?.operation).toEqual({
			type: "abort",
			executionId: prompt.operation.executionId,
			targetRequestId: prompt.requestId,
			reason: "remote-client-abort",
		});
		for (const wireRequest of transport.requests) {
			expect(isRuntimeRequestEnvelope(wireRequest)).toBe(true);
			expect(JSON.stringify(wireRequest)).not.toContain("local-only");
			expect(JSON.stringify(wireRequest)).not.toContain("execute");
		}
		expect(client.state.tools[0]).toBe(localTool);

		transport.emit(
			executionEnvelope(4, "succeeded", {
				execution: {
					executionId: prompt.operation.executionId,
					requestId: prompt.requestId,
					kind: "prompt",
					status: "succeeded",
				},
			}),
		);
		promptResponse.resolve(success(prompt));
		await prompting;
	});

	it("uses a successful prompt response as a terminal fallback when streams are delayed", async () => {
		const transport = new TestTransport();
		const client = createClient(transport, "epoch-1");
		await connectFromKnownEpoch(client, transport);
		await client.prompt("first");
		await client.prompt("second");
		expect(transport.requests.filter((request) => request.operation.type === "prompt")).toHaveLength(2);
	});

	it("applies optimistic model and thinking changes with token-safe rollback", async () => {
		const transport = new TestTransport();
		const client = createClient(transport);
		await connectWithSnapshot(client, transport);
		const modelResponse = deferred<RuntimeResponseEnvelope>();
		const thinkingResponse = deferred<RuntimeResponseEnvelope>();
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "set-model") return modelResponse.promise;
			if (request.operation.type === "set-thinking") return thinkingResponse.promise;
			return success(request);
		};

		const settingModel = client.setModel({ provider: "anthropic", id: "model-b" });
		await flushMicrotasks();
		expect(client.state.model?.id).toBe("model-b");
		const modelRequest = findLastItem(transport.requests, (request) => request.operation.type === "set-model");
		if (!modelRequest) throw new Error("missing model request");
		modelResponse.resolve(failure(modelRequest, "MODEL_REJECTED", "model rejected"));
		await expect(settingModel).rejects.toMatchObject({ code: "MODEL_REJECTED" });
		expect(client.state.model?.id).toBe("model-a");

		const settingThinking = client.setThinkingLevel("high");
		await flushMicrotasks();
		expect(client.state.thinkingLevel).toBe("high");
		const thinkingRequest = findLastItem(transport.requests, (request) => request.operation.type === "set-thinking");
		if (!thinkingRequest) throw new Error("missing thinking request");
		thinkingResponse.resolve(success(thinkingRequest));
		await settingThinking;
		expect(client.state.thinkingLevel).toBe("high");
	});

	it("coalesces stream gaps into one resync and applies the recovery snapshot", async () => {
		const transport = new TestTransport();
		const client = createClient(transport);
		const initialSnapshot = snapshotEnvelope(1);
		delete initialSnapshot.trace;
		await connectWithSnapshot(client, transport, initialSnapshot);
		const resyncResponse = deferred<RuntimeResponseEnvelope>();
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "resync") return resyncResponse.promise;
			return success(request);
		};

		const gap = agentEventEnvelope(3, 4, { type: "agent_start" });
		delete gap.trace;
		transport.emit(gap);
		transport.emit(agentEventEnvelope(4, 5, { type: "turn_start" }));
		await Promise.resolve();
		const resyncs = transport.requests.filter((request) => request.operation.type === "resync");
		expect(resyncs).toHaveLength(1);
		expect(resyncs[0]?.operation).toMatchObject({ type: "resync", knownRevision: 3, lastEventSeq: 1, reason: "gap" });
		expect(resyncs[0]?.trace).toEqual(trace);

		const resync = resyncs[0];
		if (!resync) throw new Error("missing resync request");
		resyncResponse.resolve(success(resync));
		await flushMicrotasks();
		transport.emit(agentEventEnvelope(5, 6, { type: "turn_start" }));
		expect(transport.requests.filter((request) => request.operation.type === "resync")).toHaveLength(1);
		transport.emit(snapshotEnvelope(6, 7, { snapshot: snapshot({ revision: 7, systemPrompt: "Recovered." }) }));
		await client.waitForIdle();
		expect(client.state.systemPrompt).toBe("Recovered.");
	});

	it("reattaches and resynchronizes after a runtime restart", async () => {
		const transport = new TestTransport();
		const client = createClient(transport);
		await connectWithSnapshot(client, transport);
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "attach" && request.runtimeEpoch === "epoch-2") {
				transport.emit(snapshotEnvelope(1, 8, { runtimeEpoch: "epoch-2", snapshot: snapshot({ revision: 8 }) }));
			}
			return success(request);
		};

		transport.emit(
			hello("epoch-2", {
				recovery: {
					mode: "restarted",
					previousRuntimeEpoch: "epoch-1",
					sessions: [{ sessionId: "session-1", target, revision: 8, eventSeq: 0 }],
				},
			}),
		);
		await client.waitForIdle();
		const attach = findLastItem(
			transport.requests,
			(request) => request.operation.type === "attach" && request.runtimeEpoch === "epoch-2",
		);
		expect(attach?.operation).toMatchObject({ type: "attach", knownRuntimeEpoch: "epoch-1" });
		expect(client.state.model?.id).toBe("model-a");
	});

	it("rejects uncorrelated responses and releases transport and listeners on dispose", async () => {
		const transport = new TestTransport();
		const client = createClient(transport, "epoch-1");
		await connectFromKnownEpoch(client, transport);
		transport.sendImplementation = async (request) => ({ ...success(request), requestId: "wrong-request" });
		await expect(client.prompt("hello")).rejects.toBeInstanceOf(RemoteSessionError);
		const ambiguousPrompt = findLastItem(transport.requests, (request) => request.operation.type === "prompt");
		if (!ambiguousPrompt || ambiguousPrompt.operation.type !== "prompt") throw new Error("missing ambiguous prompt");
		transport.sendImplementation = async (request) => success(request);
		await client.abortActive();
		expect(findLastItem(transport.requests, (request) => request.operation.type === "abort")?.operation).toMatchObject({
			executionId: ambiguousPrompt.operation.executionId,
			targetRequestId: ambiguousPrompt.requestId,
		});

		let observed = 0;
		client.subscribe(() => {
			observed++;
		});
		client.dispose();
		expect(transport.unsubscribeCount).toBe(1);
		expect(transport.subscriberCount).toBe(0);
		transport.emit(agentEventEnvelope(1, 1, { type: "agent_start" }));
		expect(observed).toBe(0);
		expect(() => client.subscribe(() => {})).toThrow(RemoteSessionError);
		await expect(client.prompt("after dispose")).rejects.toMatchObject({ code: "DISPOSED" });
	});

	it("isolates listener failures so every subscriber receives each event", async () => {
		const errors: unknown[] = [];
		const transport = new TestTransport();
		const client = new RemoteSessionClient({
			transport,
			clientId: "client-1",
			windowId: 1,
			sessionId: "session-1",
			target,
			trace,
			onError: (error) => errors.push(error),
		});
		await connectWithSnapshot(client, transport);
		let healthyCalls = 0;
		client.subscribe(() => {
			throw new Error("listener failed");
		});
		client.subscribe(() => {
			healthyCalls++;
		});
		transport.emit(agentEventEnvelope(2, 4, { type: "agent_start" }));
		await client.waitForIdle();
		expect(healthyCalls).toBe(1);
		expect(errors).toHaveLength(1);
	});

	it("serializes overlapping optimistic writes and rolls both fields back to confirmed state", async () => {
		const transport = new TestTransport();
		const client = createClient(transport);
		await connectWithSnapshot(client, transport);
		const modelResponses = [deferred<RuntimeResponseEnvelope>(), deferred<RuntimeResponseEnvelope>()];
		const thinkingResponses = [deferred<RuntimeResponseEnvelope>(), deferred<RuntimeResponseEnvelope>()];
		let modelIndex = 0;
		let thinkingIndex = 0;
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "set-model") {
				const response = modelResponses[modelIndex++];
				if (!response) throw new Error("unexpected model request");
				return response.promise;
			}
			if (request.operation.type === "set-thinking") {
				const response = thinkingResponses[thinkingIndex++];
				if (!response) throw new Error("unexpected thinking request");
				return response.promise;
			}
			return success(request);
		};

		const firstModel = client.setModel({ provider: "openai", id: "model-b" });
		const secondModel = client.setModel({ provider: "openai", id: "model-c" });
		const firstModelRejected = expect(firstModel).rejects.toMatchObject({ code: "MODEL_REJECTED" });
		const secondModelRejected = expect(secondModel).rejects.toMatchObject({ code: "MODEL_REJECTED" });
		await flushMicrotasks();
		expect(client.state.model?.id).toBe("model-c");
		expect(modelIndex).toBe(1);
		const firstModelRequest = transport.requests.find((request) => request.operation.type === "set-model");
		if (!firstModelRequest) throw new Error("missing first model request");
		modelResponses[0]?.resolve(failure(firstModelRequest, "MODEL_REJECTED", "first rejected"));
		await firstModelRejected;
		await flushMicrotasks();
		expect(modelIndex).toBe(2);
		const modelRequests = transport.requests.filter((request) => request.operation.type === "set-model");
		const secondModelRequest = modelRequests[1];
		if (!secondModelRequest) throw new Error("missing second model request");
		modelResponses[1]?.resolve(failure(secondModelRequest, "MODEL_REJECTED", "second rejected"));
		await secondModelRejected;
		expect(client.state.model?.id).toBe("model-a");

		const firstThinking = client.setThinkingLevel("high");
		const secondThinking = client.setThinkingLevel("xhigh");
		const firstThinkingRejected = expect(firstThinking).rejects.toMatchObject({ code: "THINKING_REJECTED" });
		const secondThinkingRejected = expect(secondThinking).rejects.toMatchObject({ code: "THINKING_REJECTED" });
		await flushMicrotasks();
		expect(client.state.thinkingLevel).toBe("xhigh");
		expect(thinkingIndex).toBe(1);
		const firstThinkingRequest = transport.requests.find((request) => request.operation.type === "set-thinking");
		if (!firstThinkingRequest) throw new Error("missing first thinking request");
		thinkingResponses[0]?.resolve(failure(firstThinkingRequest, "THINKING_REJECTED", "first rejected"));
		await firstThinkingRejected;
		await flushMicrotasks();
		expect(thinkingIndex).toBe(2);
		const thinkingRequests = transport.requests.filter((request) => request.operation.type === "set-thinking");
		const secondThinkingRequest = thinkingRequests[1];
		if (!secondThinkingRequest) throw new Error("missing second thinking request");
		thinkingResponses[1]?.resolve(failure(secondThinkingRequest, "THINKING_REJECTED", "second rejected"));
		await secondThinkingRejected;
		expect(client.state.thinkingLevel).toBe("medium");
	});

	it("rolls rejected writes back to an authoritative snapshot received while optimistic", async () => {
		const transport = new TestTransport();
		const client = createClient(transport);
		await connectWithSnapshot(client, transport);
		const modelResponse = deferred<RuntimeResponseEnvelope>();
		const thinkingResponse = deferred<RuntimeResponseEnvelope>();
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "set-model") return modelResponse.promise;
			if (request.operation.type === "set-thinking") return thinkingResponse.promise;
			return success(request);
		};
		const settingModel = client.setModel({ provider: "openai", id: "optimistic-model" });
		const settingThinking = client.setThinkingLevel("high");
		const modelRejected = expect(settingModel).rejects.toMatchObject({ code: "MODEL_REJECTED" });
		const thinkingRejected = expect(settingThinking).rejects.toMatchObject({ code: "THINKING_REJECTED" });
		await flushMicrotasks();
		transport.emit(
			snapshotEnvelope(2, 4, {
				snapshot: snapshot({
					revision: 4,
					model: { provider: "openai", id: "external-model" },
					thinkingLevel: "low",
				}),
			}),
		);
		expect(client.state.model?.id).toBe("optimistic-model");
		expect(client.state.thinkingLevel).toBe("high");
		const modelRequest = transport.requests.find((request) => request.operation.type === "set-model");
		const thinkingRequest = transport.requests.find((request) => request.operation.type === "set-thinking");
		if (!modelRequest || !thinkingRequest) throw new Error("missing optimistic requests");
		modelResponse.resolve(failure(modelRequest, "MODEL_REJECTED", "model rejected"));
		thinkingResponse.resolve(failure(thinkingRequest, "THINKING_REJECTED", "thinking rejected"));
		await Promise.all([modelRejected, thinkingRejected]);
		expect(client.state.model?.id).toBe("external-model");
		expect(client.state.thinkingLevel).toBe("low");

		const successfulModelResponse = deferred<RuntimeResponseEnvelope>();
		const successfulThinkingResponse = deferred<RuntimeResponseEnvelope>();
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "set-model") return successfulModelResponse.promise;
			if (request.operation.type === "set-thinking") return successfulThinkingResponse.promise;
			return success(request);
		};
		const successfulModel = client.setModel({ provider: "openai", id: "second-optimistic-model" });
		const successfulThinking = client.setThinkingLevel("xhigh");
		await flushMicrotasks();
		transport.emit(
			snapshotEnvelope(3, 5, {
				snapshot: snapshot({
					revision: 5,
					model: { provider: "openai", id: "newer-external-model" },
					thinkingLevel: "minimal",
				}),
			}),
		);
		const successfulModelRequest = findLastItem(
			transport.requests,
			(request) => request.operation.type === "set-model",
		);
		const successfulThinkingRequest = findLastItem(
			transport.requests,
			(request) => request.operation.type === "set-thinking",
		);
		if (!successfulModelRequest || !successfulThinkingRequest) throw new Error("missing successful mutations");
		successfulModelResponse.resolve(success(successfulModelRequest));
		successfulThinkingResponse.resolve(success(successfulThinkingRequest));
		await Promise.all([successfulModel, successfulThinking]);
		expect(client.state.model?.id).toBe("newer-external-model");
		expect(client.state.thinkingLevel).toBe("minimal");
	});

	it("retries a resync that receives a response but no repairing snapshot", async () => {
		vi.useFakeTimers();
		try {
			const transport = new TestTransport();
			const client = new RemoteSessionClient({
				transport,
				clientId: "client-1",
				windowId: 1,
				sessionId: "session-1",
				target,
				trace,
				resyncTimeoutMs: 10,
			});
			await connectWithSnapshot(client, transport);
			transport.sendImplementation = async (request) => success(request);
			transport.emit(agentEventEnvelope(3, 4, { type: "agent_start" }));
			await flushMicrotasks();
			expect(transport.requests.filter((request) => request.operation.type === "resync")).toHaveLength(1);
			await vi.advanceTimersByTimeAsync(11);
			expect(transport.requests.filter((request) => request.operation.type === "resync")).toHaveLength(2);
			transport.emit(snapshotEnvelope(4, 5, { snapshot: snapshot({ revision: 5 }) }));
			await flushMicrotasks();
			client.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("supersedes stale recovery and ignores late mutations from an old runtime epoch", async () => {
		const transport = new TestTransport();
		const errors: unknown[] = [];
		const client = new RemoteSessionClient({
			transport,
			clientId: "client-1",
			windowId: 1,
			sessionId: "session-1",
			target,
			trace,
			onError: (error) => errors.push(error),
		});
		const epochOneAttach = deferred<RuntimeResponseEnvelope>();
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "attach" && request.runtimeEpoch === "epoch-1") return epochOneAttach.promise;
			if (request.operation.type === "attach" && request.runtimeEpoch === "epoch-2") {
				transport.emit(
					snapshotEnvelope(1, 8, {
						runtimeEpoch: "epoch-2",
						snapshot: snapshot({ revision: 8, model: { provider: "openai", id: "epoch-2-model" } }),
					}),
				);
			}
			return success(request);
		};
		const connecting = client.connect();
		transport.emit(hello("epoch-1"));
		await flushMicrotasks();
		transport.emit(
			hello("epoch-2", {
				recovery: { mode: "restarted", previousRuntimeEpoch: "epoch-1", sessions: [] },
			}),
		);
		await connecting;
		expect(
			transport.requests.filter((request) => request.operation.type === "attach").map((request) => request.runtimeEpoch),
		).toEqual(["epoch-1", "epoch-2"]);
		const oldAttachRequest = transport.requests.find(
			(request) => request.operation.type === "attach" && request.runtimeEpoch === "epoch-1",
		);
		if (!oldAttachRequest) throw new Error("missing old attach");
		epochOneAttach.resolve(success(oldAttachRequest));
		await flushMicrotasks();
		expect(client.state.model?.id).toBe("epoch-2-model");

		const oldMutation = deferred<RuntimeResponseEnvelope>();
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "set-model") return oldMutation.promise;
			if (request.operation.type === "load" && request.runtimeEpoch === "epoch-3") {
				transport.emit(
					snapshotEnvelope(1, 9, {
						runtimeEpoch: "epoch-3",
						snapshot: snapshot({ revision: 9, model: { provider: "openai", id: "epoch-3-model" } }),
					}),
				);
			}
			return success(request);
		};
		const settingModel = client.setModel({ provider: "openai", id: "obsolete-model" });
		const staleMutation = expect(settingModel).rejects.toMatchObject({ code: "STALE_REQUEST_EPOCH" });
		await flushMicrotasks();
		const oldMutationRequest = findLastItem(
			transport.requests,
			(request) => request.operation.type === "set-model",
		);
		if (!oldMutationRequest) throw new Error("missing old mutation");
		transport.emit(
			hello("epoch-3", {
				recovery: { mode: "restarted", previousRuntimeEpoch: "epoch-2", sessions: [] },
			}),
		);
		await flushMicrotasks();
		expect(client.state.model?.id).toBe("epoch-3-model");
		oldMutation.resolve(success(oldMutationRequest));
		await staleMutation;
		expect(client.state.model?.id).toBe("epoch-3-model");
		expect(errors.filter((error) => error instanceof RemoteSessionError && error.code === "STALE_REQUEST_EPOCH")).toHaveLength(
			0,
		);
	});

	it("sends an opt-in disposal abort before transport teardown and validates both wire directions", async () => {
		const errors: unknown[] = [];
		const transport = new TestTransport();
		const client = new RemoteSessionClient({
			transport,
			clientId: "client-1",
			windowId: 1,
			sessionId: "session-1",
			target,
			trace,
			initialRuntimeEpoch: "epoch-1",
			onError: (error) => errors.push(error),
		});
		await connectFromKnownEpoch(client, transport);
		const promptResponse = deferred<RuntimeResponseEnvelope>();
		let abortObservedSubscriberCount = 0;
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "prompt") return promptResponse.promise;
			if (request.operation.type === "abort") abortObservedSubscriberCount = transport.subscriberCount;
			return success(request);
		};
		const prompting = client.prompt("active");
		const disposedPrompt = expect(prompting).rejects.toMatchObject({ code: "DISPOSED" });
		await flushMicrotasks();
		const promptRequest = findLastItem(transport.requests, (request) => request.operation.type === "prompt");
		if (!promptRequest) throw new Error("missing prompt");
		client.dispose({ abortActive: true });
		expect(abortObservedSubscriberCount).toBe(1);
		expect(findLastItem(transport.requests, (request) => request.operation.type === "abort")?.operation).toMatchObject({
			type: "abort",
			targetRequestId: promptRequest.requestId,
			reason: "remote-client-dispose",
		});
		promptResponse.resolve(success(promptRequest));
		await disposedPrompt;
		await flushMicrotasks();
		expect(errors).toHaveLength(0);

		const wireTransport = new TestTransport();
		const wireErrors: unknown[] = [];
		const wireClient = new RemoteSessionClient({
			transport: wireTransport,
			clientId: "client-1",
			windowId: 1,
			sessionId: "session-1",
			target,
			trace,
			initialRuntimeEpoch: "epoch-1",
			onError: (error) => wireErrors.push(error),
		});
		await connectFromKnownEpoch(wireClient, wireTransport);
		await expect(wireClient.prompt({ role: "user", score: Number.NaN })).rejects.toMatchObject({
			code: "NON_SERIALIZABLE_REQUEST",
		});
		expect(wireTransport.requests.filter((request) => request.operation.type === "prompt")).toHaveLength(0);
		wireTransport.sendImplementation = async (request) => ({ ...success(request), result: Number.NaN });
		await expect(wireClient.prompt("malformed response")).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
		const malformed = { ...agentEventEnvelope(1, 1, { type: "agent_start" }), eventSeq: Number.NaN };
		wireTransport.emit(malformed as unknown as RuntimeStreamEnvelope);
		expect(wireErrors.some((error) => error instanceof RemoteSessionError && error.code === "MALFORMED_STREAM")).toBe(
			true,
		);
		wireClient.dispose();
	});

	it("detaches presentation without aborting offscreen work by default", async () => {
		const transport = new TestTransport();
		const client = createClient(transport, "epoch-1");
		await connectFromKnownEpoch(client, transport);
		const promptResponse = deferred<RuntimeResponseEnvelope>();
		transport.sendImplementation = async (request) =>
			request.operation.type === "prompt" ? promptResponse.promise : success(request);
		const prompting = client.prompt("continue while closed");
		const detachedPrompt = expect(prompting).rejects.toMatchObject({ code: "DISPOSED" });
		await flushMicrotasks();
		const promptRequest = findLastItem(transport.requests, (request) => request.operation.type === "prompt");
		if (!promptRequest) throw new Error("missing prompt");

		client.dispose();

		expect(transport.requests.some((request) => request.operation.type === "abort")).toBe(false);
		promptResponse.resolve(success(promptRequest));
		await detachedPrompt;
	});

	it("preserves exact running prompt identity across an ambiguous response failure", async () => {
		const transport = new TestTransport();
		const client = createClient(transport, "epoch-1");
		await connectFromKnownEpoch(client, transport);
		const promptResponse = deferred<RuntimeResponseEnvelope>();
		transport.sendImplementation = async (request) =>
			request.operation.type === "prompt" ? promptResponse.promise : success(request);
		const prompting = client.prompt("ambiguous");
		await flushMicrotasks();
		const prompt = findLastItem(transport.requests, (candidate) => candidate.operation.type === "prompt");
		if (!prompt || prompt.operation.type !== "prompt") throw new Error("missing prompt");
		transport.emit(
			executionEnvelope(2, "running", {
				execution: {
					executionId: prompt.operation.executionId,
					requestId: prompt.requestId,
					kind: "prompt",
					status: "running",
				},
			}),
		);
		const rejected = expect(prompting).rejects.toMatchObject({ code: "UNCORRELATED_RESPONSE" });
		promptResponse.resolve({ ...success(prompt), requestId: "another-request" });
		await rejected;
		await client.abortActive();
		expect(findLastItem(transport.requests, (candidate) => candidate.operation.type === "abort")?.operation).toEqual({
			type: "abort",
			executionId: prompt.operation.executionId,
			targetRequestId: prompt.requestId,
			reason: "remote-client-abort",
		});
		client.dispose();
	});

	it("sends navigation steering as a distinct remote queue intent", async () => {
		const transport = new TestTransport();
		const client = createClient(transport, "epoch-1");
		await connectFromKnownEpoch(client, transport);
		const message: RuntimeAgentMessage = {
			role: "user",
			content: "The active tab changed.",
			timestamp: 4,
		};

		await client.steer(message);

		expect(transport.requests.at(-1)?.operation).toEqual({ type: "steer", message });
		client.dispose();
	});

	it("releases a session only through an explicit scoped operation", async () => {
		const transport = new TestTransport();
		const client = createClient(transport, "epoch-1");
		await connectFromKnownEpoch(client, transport);

		await client.release({ force: true, reason: "window-removed" });

		expect(transport.requests.at(-1)?.operation).toEqual({
			type: "release",
			force: true,
			reason: "window-removed",
		});
		client.dispose();
	});

	it("keeps a locally queued prompt across snapshots and clears it on a correlated terminal response", async () => {
		const transport = new TestTransport();
		const client = createClient(transport, "epoch-1");
		await connectFromKnownEpoch(client, transport);
		const promptResponse = deferred<RuntimeResponseEnvelope>();
		let promptCount = 0;
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "prompt" && ++promptCount === 1) return promptResponse.promise;
			return success(request);
		};
		const prompting = client.prompt("queued");
		await flushMicrotasks();
		const prompt = findLastItem(transport.requests, (candidate) => candidate.operation.type === "prompt");
		if (!prompt || prompt.operation.type !== "prompt") throw new Error("missing prompt");
		transport.emit(snapshotEnvelope(2, 4, { snapshot: snapshot({ revision: 4, activeExecutions: [] }) }));
		await client.abortActive();
		expect(findLastItem(transport.requests, (candidate) => candidate.operation.type === "abort")?.operation).toMatchObject({
			executionId: prompt.operation.executionId,
			targetRequestId: prompt.requestId,
		});
		transport.emit(
			executionEnvelope(3, "running", {
				revision: 4,
				execution: {
					executionId: prompt.operation.executionId,
					requestId: prompt.requestId,
					kind: "prompt",
					status: "running",
				},
			}),
		);
		const rejected = expect(prompting).rejects.toMatchObject({ code: "ABORTED" });
		promptResponse.resolve(failure(prompt, "ABORTED", "cancelled"));
		await rejected;
		await client.prompt("next");
		expect(promptCount).toBe(2);
		client.dispose();
	});

	it("reconciles ambiguously settled queued prompts through snapshots and terminal abort results", async () => {
		const transport = new TestTransport();
		const client = createClient(transport, "epoch-1");
		await connectFromKnownEpoch(client, transport);
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "prompt") return { ...success(request), requestId: "uncorrelated" };
			return success(request);
		};
		await expect(client.prompt("ambiguous")).rejects.toMatchObject({ code: "UNCORRELATED_RESPONSE" });
		await expect(client.prompt("still blocked")).rejects.toMatchObject({ code: "SESSION_BUSY" });
		transport.emit(snapshotEnvelope(2, 4, { snapshot: snapshot({ revision: 4, activeExecutions: [] }) }));
		transport.sendImplementation = async (request) => success(request);
		await client.prompt("after snapshot");
		client.dispose();

		const abortTransport = new TestTransport();
		const abortClient = createClient(abortTransport, "epoch-1");
		await connectFromKnownEpoch(abortClient, abortTransport);
		let promptCount = 0;
		abortTransport.sendImplementation = async (request) => {
			if (request.operation.type === "prompt" && ++promptCount === 1) {
				return { ...success(request), requestId: "uncorrelated" };
			}
			if (request.operation.type === "abort") return success(request, { status: "already-terminal" });
			return success(request);
		};
		await expect(abortClient.prompt("ambiguous abort")).rejects.toMatchObject({ code: "UNCORRELATED_RESPONSE" });
		await abortClient.abortActive();
		await abortClient.prompt("after terminal abort");
		expect(promptCount).toBe(2);
		abortClient.dispose();
	});

	it("captures event subscribers at emission time without cross-listener head-of-line blocking", async () => {
		const transport = new TestTransport();
		const client = createClient(transport, "epoch-1");
		await connectFromKnownEpoch(client, transport);
		const releaseSlow = deferred<void>();
		const slow: string[] = [];
		const fast: string[] = [];
		const late: string[] = [];
		const slowListener = async (event: RuntimeAgentEvent): Promise<void> => {
			slow.push(event.type);
			if (event.type === "agent_start") await releaseSlow.promise;
		};
		client.subscribe(slowListener);
		client.subscribe((event) => {
			fast.push(event.type);
		});
		transport.emit(agentEventEnvelope(2, 4, { type: "agent_start" }));
		await flushMicrotasks();
		client.subscribe(slowListener);
		transport.emit(
			agentEventEnvelope(3, 5, { type: "message_end", message: { role: "assistant", content: "done" } }),
		);
		client.subscribe((event) => {
			late.push(event.type);
		});
		await flushMicrotasks();
		expect(fast).toEqual(["agent_start", "message_end"]);
		expect(slow).toEqual(["agent_start"]);
		expect(late).toEqual([]);
		releaseSlow.resolve();
		await client.waitForIdle();
		expect(slow).toEqual(["agent_start", "message_end"]);
		transport.emit(agentEventEnvelope(4, 6, { type: "agent_end", messages: [] }));
		await client.waitForIdle();
		expect(late).toEqual(["agent_end"]);
		client.dispose();
	});

	it("requires both attach response and configured-target snapshot, then retries a failed attach", async () => {
		const transport = new TestTransport();
		const errors: unknown[] = [];
		const client = new RemoteSessionClient({
			transport,
			clientId: "client-1",
			windowId: 1,
			sessionId: "session-1",
			target,
			trace,
			onError: (error) => errors.push(error),
		});
		let connected = false;
		const connecting = client.connect().then(() => {
			connected = true;
		});
		transport.emit(hello());
		await flushMicrotasks();
		expect(connected).toBe(false);
		const wrongTarget: RuntimeTargetIdentity = { kind: "chrome-tab", tabId: 99 };
		transport.emit(
			snapshotEnvelope(1, 3, {
				target: wrongTarget,
				snapshot: snapshot({ target: wrongTarget, systemPrompt: "intruder" }),
			}),
		);
		await flushMicrotasks();
		expect(connected).toBe(false);
		expect(client.state.systemPrompt).toBe("");
		transport.emit(snapshotEnvelope(1));
		await connecting;
		expect(client.state.systemPrompt).toBe("Be precise.");
		expect(errors.some((error) => error instanceof RemoteSessionError && error.code === "TARGET_MISMATCH")).toBe(true);

		const retryTransport = new TestTransport();
		let attachCount = 0;
		retryTransport.sendImplementation = async (request) => {
			if (request.operation.type === "attach") {
				attachCount++;
				if (attachCount === 1) return failure(request, "ATTACH_FAILED", "not ready");
				retryTransport.emit(snapshotEnvelope(1));
			}
			return success(request);
		};
		const retryClient = createClient(retryTransport, "epoch-1");
		await expect(retryClient.connect()).rejects.toMatchObject({ code: "ATTACH_FAILED" });
		await retryClient.prompt("retry");
		expect(attachCount).toBe(2);
		expect(retryTransport.requests.map((candidate) => candidate.operation.type)).toEqual([
			"attach",
			"attach",
			"prompt",
		]);
		client.dispose();
		retryClient.dispose();
	});

	it("invalidates held epoch work immediately and never aborts a replacement prompt identity", async () => {
		const transport = new TestTransport();
		const client = createClient(transport, "epoch-1");
		await connectFromKnownEpoch(client, transport);
		const heldModel = deferred<RuntimeResponseEnvelope>();
		const heldRecovery = deferred<RuntimeResponseEnvelope>();
		const heldPrompt = deferred<RuntimeResponseEnvelope>();
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "set-model" && request.runtimeEpoch === "epoch-1") return heldModel.promise;
			if (request.operation.type === "prompt") return heldPrompt.promise;
			if (request.operation.type === "attach" && request.runtimeEpoch === "epoch-1") return heldRecovery.promise;
			if (request.operation.type === "attach" && request.runtimeEpoch === "epoch-2") {
				transport.emit(
					snapshotEnvelope(1, 4, {
						runtimeEpoch: "epoch-2",
						snapshot: snapshot({
							revision: 4,
							activeExecutions: [
								{
									executionId: "replacement-execution",
									requestId: "replacement-request",
									kind: "prompt",
									status: "running",
								},
							],
						}),
					}),
				);
			}
			return success(request);
		};
		const prompting = client.prompt("active");
		const stalePrompt = expect(prompting).rejects.toMatchObject({ code: "STALE_REQUEST_EPOCH" });
		await flushMicrotasks();
		const activeRequest = findLastItem(transport.requests, (candidate) => candidate.operation.type === "prompt");
		if (!activeRequest || activeRequest.operation.type !== "prompt") throw new Error("missing active prompt");
		transport.emit(
			executionEnvelope(2, "running", {
				execution: {
					executionId: activeRequest.operation.executionId,
					requestId: activeRequest.requestId,
					kind: "prompt",
					status: "running",
				},
			}),
		);
		const settingModel = client.setModel({ provider: "openai", id: "obsolete" });
		await flushMicrotasks();
		transport.emit(hello("epoch-1"));
		await flushMicrotasks();
		const aborting = client.abortActive();
		const staleAbort = expect(aborting).rejects.toMatchObject({ code: "STALE_REQUEST_EPOCH" });
		transport.emit(
			hello("epoch-2", {
				recovery: { mode: "restarted", previousRuntimeEpoch: "epoch-1", sessions: [] },
			}),
		);
		await expect(settingModel).rejects.toMatchObject({ code: "STALE_REQUEST_EPOCH" });
		await stalePrompt;
		await staleAbort;
		expect(
			transport.requests.some(
				(candidate) => candidate.operation.type === "abort" && candidate.runtimeEpoch === "epoch-2",
			),
		).toBe(false);
		client.dispose();
	});

	it("rejects a held attach on dispose without surfacing recovery noise", async () => {
		const transport = new TestTransport();
		const heldAttach = deferred<RuntimeResponseEnvelope>();
		const errors: unknown[] = [];
		transport.sendImplementation = async (request) =>
			request.operation.type === "attach" ? heldAttach.promise : success(request);
		const client = new RemoteSessionClient({
			transport,
			clientId: "client-1",
			windowId: 1,
			sessionId: "session-1",
			target,
			initialRuntimeEpoch: "epoch-1",
			onError: (error) => errors.push(error),
		});
		const connecting = client.connect();
		client.dispose();
		await expect(connecting).rejects.toMatchObject({ code: "DISPOSED" });
		await flushMicrotasks();
		expect(errors).toEqual([]);
	});

	it("owns constructor, method, transport, stream, and per-listener data", async () => {
		const transport = new TestTransport();
		const constructorTarget = structuredClone(target);
		const constructorTrace = structuredClone(trace);
		transport.sendImplementation = async (request) => {
			if (request.operation.type === "attach") transport.emit(snapshotEnvelope(1));
			const response = success(request);
			request.requestId = "transport-mutated-request";
			return response;
		};
		const client = new RemoteSessionClient({
			transport,
			clientId: "client-1",
			windowId: 1,
			sessionId: "session-1",
			target: constructorTarget,
			trace: constructorTrace,
			createRequestId: (operation, sequence) => `${operation}-${sequence}`,
			createExecutionId: (_kind, sequence) => `execution-${sequence}`,
		});
		const mutableMessage: RuntimeAgentMessage = { role: "user", content: "original" };
		const prompting = client.prompt(mutableMessage);
		mutableMessage.content = "caller-mutated";
		if (constructorTarget.kind === "electron-window") constructorTarget.windowRef = "caller-mutated";
		constructorTrace.spanId = "cccccccccccccccc";
		transport.emit(hello());
		await prompting;
		const sentPrompt = transport.requests.find((request) => request.operation.type === "prompt");
		if (!sentPrompt || sentPrompt.operation.type !== "prompt") throw new Error("missing owned prompt");
		expect(sentPrompt.operation.message.content).toBe("original");
		expect(sentPrompt.target).toEqual(target);
		expect(sentPrompt.trace).toEqual(trace);

		const firstSeen: string[] = [];
		const secondSeen: string[] = [];
		client.subscribe((event) => {
			if (event.type !== "message_start") return;
			firstSeen.push(String(event.message.content));
			event.message.content = "listener-mutated";
		});
		client.subscribe((event) => {
			if (event.type === "message_start") secondSeen.push(String(event.message.content));
		});
		const inbound = agentEventEnvelope(2, 4, {
			type: "message_start",
			message: { role: "assistant", content: "transport-original" },
		});
		transport.emit(inbound);
		if (inbound.agentEvent.type !== "message_start") throw new Error("expected message start");
		inbound.agentEvent.message.content = "transport-mutated";
		await client.waitForIdle();
		expect(firstSeen).toEqual(["transport-original"]);
		expect(secondSeen).toEqual(["transport-original"]);
		expect(client.state.streamingMessage?.content).toBe("transport-original");
		client.dispose();
	});
});
