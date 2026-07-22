import { afterEach, describe, expect, it, vi } from "vitest";

import {
	OffscreenRuntimeController,
	type OffscreenRuntimeControllerHost,
	type OffscreenRuntimeControllerOptions,
	type OffscreenRuntimeControllerResult,
} from "@shuvgeist/extension/agent/offscreen-runtime-controller";
import type {
	OffscreenRuntimeHostOptions,
	OffscreenRuntimeHostState,
	OffscreenRuntimeOperationContext,
	OffscreenRuntimeSessionAdapter,
	OffscreenRuntimeSessionFactory,
	OffscreenRuntimeSessionState,
} from "@shuvgeist/extension/agent/offscreen-runtime-host";
import {
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeAgentEvent,
	type RuntimeAgentMessage,
	type RuntimeRequestEnvelope,
	type RuntimeRequestOperation,
	type RuntimeResponseEnvelope,
	type RuntimeStreamEnvelope,
	type RuntimeTargetIdentity,
} from "@shuvgeist/extension/agent/runtime-protocol";
import type {
	AgentRuntimeCheckpointMessage,
	AgentRuntimePageCancelMessage,
	AgentRuntimePageOperationMessage,
} from "@shuvgeist/extension/bridge/internal-messages";

const target: RuntimeTargetIdentity = { kind: "chrome-tab", tabRef: "window:7" };
const trace = {
	traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	spanId: "bbbbbbbbbbbbbbbb",
	traceFlags: "01",
};

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
}

function deferred<T>(): Deferred<T> {
	let resolve: Deferred<T>["resolve"] = () => {};
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function state(overrides: Partial<OffscreenRuntimeSessionState> = {}): OffscreenRuntimeSessionState {
	return {
		systemPrompt: "System prompt",
		model: { provider: "openai", id: "model-a" },
		thinkingLevel: "medium",
		messages: [],
		tools: [],
		pendingToolCallIds: [],
		isStreaming: false,
		artifacts: [],
		...overrides,
	};
}

class TestSessionAdapter implements OffscreenRuntimeSessionAdapter {
	state = state();
	promptImplementation?: (message: RuntimeAgentMessage, context: OffscreenRuntimeOperationContext) => Promise<void>;
	private readonly listeners = new Set<(event: RuntimeAgentEvent) => void>();

	getState(): OffscreenRuntimeSessionState {
		return this.state;
	}

	subscribe(listener: (event: RuntimeAgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	prompt(message: RuntimeAgentMessage, context: OffscreenRuntimeOperationContext): Promise<void> {
		this.state = { ...this.state, messages: [...this.state.messages, message] };
		return this.promptImplementation?.(message, context) ?? Promise.resolve();
	}

	setModel(model: NonNullable<OffscreenRuntimeSessionState["model"]>): void {
		this.state = { ...this.state, model };
	}

	setThinkingLevel(thinkingLevel: OffscreenRuntimeSessionState["thinkingLevel"]): void {
		this.state = { ...this.state, thinkingLevel };
	}

	steer(message: RuntimeAgentMessage): void {
		this.state = { ...this.state, messages: [...this.state.messages, message] };
	}

	replaceOrAppendMessage(message: RuntimeAgentMessage, messageIndex: number | undefined): void {
		const messages = this.state.messages.slice();
		if (messageIndex === undefined || messageIndex >= messages.length) messages.push(message);
		else messages[messageIndex] = message;
		this.state = { ...this.state, messages };
	}
}

class TestSessionFactory implements OffscreenRuntimeSessionFactory {
	readonly created: TestSessionAdapter[] = [];
	readonly restored: TestSessionAdapter[] = [];

	create(): Promise<TestSessionAdapter> {
		const adapter = new TestSessionAdapter();
		this.created.push(adapter);
		return Promise.resolve(adapter);
	}

	load(): Promise<TestSessionAdapter> {
		return this.create();
	}

	restore(input: Parameters<NonNullable<OffscreenRuntimeSessionFactory["restore"]>>[0]): Promise<TestSessionAdapter> {
		const adapter = new TestSessionAdapter();
		adapter.state = state({
			systemPrompt: input.snapshot.systemPrompt,
			model: input.snapshot.model,
			thinkingLevel: input.snapshot.thinkingLevel,
			messages: input.snapshot.messages,
			tools: input.snapshot.tools,
			pendingToolCallIds: input.snapshot.pendingToolCallIds,
			isStreaming: input.snapshot.isStreaming,
			artifacts: input.snapshot.artifacts,
		});
		this.restored.push(adapter);
		return Promise.resolve(adapter);
	}
}

function snapshot(sessionId = "session-1", revision = 3) {
	return {
		sessionId,
		target,
		revision,
		systemPrompt: "Restored prompt",
		model: { provider: "anthropic", id: "restored-model" },
		thinkingLevel: "high" as const,
		messages: [{ role: "user", content: "persisted" }],
		tools: [],
		pendingToolCallIds: [],
		isStreaming: false,
		activeExecutions: [],
		artifacts: [],
	};
}

function checkpoint(runtimeEpoch = "epoch-old"): OffscreenRuntimeHostState {
	return {
		runtimeEpoch,
		sessions: [
			{
				clientId: "client-1",
				windowId: 7,
				sessionId: "session-1",
				target,
				revision: 3,
				eventSeq: 9,
				snapshot: snapshot(),
			},
		],
		requests: [],
	};
}

function request(
	operation: RuntimeRequestOperation,
	requestId: string,
	overrides: Partial<RuntimeRequestEnvelope> = {},
): RuntimeRequestEnvelope {
	return {
		kind: "request",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-new",
		clientId: "client-1",
		windowId: 7,
		sessionId: "session-1",
		target,
		requestId,
		trace,
		operation,
		...overrides,
	};
}

function descriptor() {
	return {
		clientId: "client-1",
		windowId: 7,
		sessionId: "session-1",
		target,
		mode: "load" as const,
		systemPrompt: "System prompt",
	};
}

function required(result: Promise<OffscreenRuntimeControllerResult> | undefined): Promise<OffscreenRuntimeControllerResult> {
	if (!result) throw new Error("Expected the controller to recognize the message");
	return result;
}

function createController(
	factory: TestSessionFactory,
	sendToBackground: OffscreenRuntimeControllerOptions["sendToBackground"],
	overrides: Partial<OffscreenRuntimeControllerOptions> = {},
): OffscreenRuntimeController {
	return new OffscreenRuntimeController({
		runtimeEpoch: "epoch-new",
		sessionFactory: factory,
		sendToBackground,
		checkpointDelayMs: 60_000,
		...overrides,
	});
}

async function initializeAndConnect(controller: OffscreenRuntimeController): Promise<void> {
	await required(controller.handleMessage({ type: "agent-runtime-init" }));
	await required(controller.handleMessage({ type: "agent-runtime-connect", descriptor: descriptor() }));
}

afterEach(() => {
	vi.useRealTimers();
});

describe("OffscreenRuntimeController", () => {
	it("restores once into a fresh host and ignores duplicate init without overwriting live sessions", async () => {
		const factory = new TestSessionFactory();
		const outbound: unknown[] = [];
		const controller = createController(factory, async (message) => {
			outbound.push(structuredClone(message));
			return { ok: true };
		});

		expect(await required(controller.handleMessage({ type: "agent-runtime-init", state: checkpoint() }))).toMatchObject({
			kind: "init",
			initialized: true,
		});
		expect(
			await required(
				controller.handleMessage({ type: "agent-runtime-init", state: { runtimeEpoch: "other", sessions: [], requests: [] } }),
			),
		).toMatchObject({ kind: "init", initialized: false });
		expect(factory.restored).toHaveLength(1);
		await expect(
			required(
				controller.handleMessage({
					type: "agent-runtime-connect",
					descriptor: { ...descriptor(), target: { kind: "chrome-tab", tabRef: "window:other" } },
				}),
			),
		).rejects.toThrow("target does not match");

		const connected = await required(
			controller.handleMessage({ type: "agent-runtime-connect", descriptor: descriptor() }),
		);
		expect(connected).toMatchObject({ kind: "connect", recoveryMode: "restarted" });
		const helloMessage = outbound.find(
			(value): value is { type: "agent-runtime-host-stream"; envelope: RuntimeStreamEnvelope } =>
				typeof value === "object" && value !== null && "type" in value && value.type === "agent-runtime-host-stream",
		);
		expect(helloMessage?.envelope).toMatchObject({
			streamType: "hello",
			recovery: {
				mode: "restarted",
				previousRuntimeEpoch: "epoch-old",
				sessions: [{ sessionId: "session-1", revision: 3 }],
			},
		});
		await controller.dispose();
	});

	it("emits resumed recovery on a surviving-host reconnect", async () => {
		const controller = createController(new TestSessionFactory(), async () => ({ ok: true }));
		await initializeAndConnect(controller);
		const result = await required(
			controller.handleMessage({ type: "agent-runtime-connect", descriptor: descriptor() }),
		);
		expect(result).toMatchObject({ kind: "connect", recoveryMode: "resumed" });
		await controller.dispose();
	});

	it("rejects malformed runtime requests before they reach the host", async () => {
		const controller = createController(new TestSessionFactory(), async () => ({ ok: true }));
		await required(controller.handleMessage({ type: "agent-runtime-init" }));
		await expect(
			required(controller.handleMessage({ type: "agent-runtime-request", request: { requestId: "partial" } })),
		).rejects.toThrow("Malformed runtime request message");
		await controller.dispose();
	});

	it("waits for all terminal streams to reach background before returning the response", async () => {
		const streamAcknowledgement = deferred<unknown>();
		let delaySessionStream = false;
		const order: string[] = [];
		const controller = createController(new TestSessionFactory(), async (message) => {
			if (message.type === "agent-runtime-host-stream") {
				order.push(`stream:${message.envelope.streamType}`);
				if (delaySessionStream && message.envelope.streamType === "session-snapshot") {
					return streamAcknowledgement.promise;
				}
			}
			return { ok: true };
		});
		await initializeAndConnect(controller);
		delaySessionStream = true;

		let resolved = false;
		const responsePromise = required(
			controller.handleMessage({
				type: "agent-runtime-request",
				request: request({ type: "create", systemPrompt: "System prompt" }, "request-create"),
			}),
		).then((response) => {
			resolved = true;
			order.push("response");
			return response;
		});
		await vi.waitFor(() => expect(order).toContain("stream:session-snapshot"));
		expect(resolved).toBe(false);
		streamAcknowledgement.resolve({ ok: true });
		expect(await responsePromise).toMatchObject({ kind: "response", ok: true });
		expect(order.at(-1)).toBe("response");
		await controller.dispose();
	});

	it("retries checkpoint export after a pending-mutation failure without blocking runtime work", async () => {
		vi.useFakeTimers();
		let host: FakeHost | undefined;
		const checkpoints: AgentRuntimeCheckpointMessage[] = [];
		const controller = createController(new TestSessionFactory(), async (message) => {
			if (message.type === "agent-runtime-checkpoint") checkpoints.push(message);
			return { ok: true };
		}, {
			checkpointDelayMs: 0,
			checkpointRetryDelayMs: 10,
			createHost: (options) => {
				host = new FakeHost(options);
				return host;
			},
		});
		await required(controller.handleMessage({ type: "agent-runtime-init" }));
		if (!host) throw new Error("Expected fake host");
		host.exportFailures = 1;
		expect(
			await required(
				controller.handleMessage({
					type: "agent-runtime-request",
					request: request({ type: "load" }, "request-does-not-wait-for-checkpoint"),
				}),
			),
		).toMatchObject({ ok: true });
		expect(host.exportCalls).toBe(0);
		await vi.advanceTimersByTimeAsync(0);
		expect(host.exportCalls).toBe(1);
		expect(checkpoints).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(10);
		expect(host.exportCalls).toBe(2);
		expect(checkpoints).toHaveLength(1);
		await controller.dispose();
	});

	it("bounds completed request state and evicts the same identities from the replay ledger", async () => {
		vi.useFakeTimers();
		const checkpoints: AgentRuntimeCheckpointMessage[] = [];
		const controller = createController(new TestSessionFactory(), async (message) => {
			if (message.type === "agent-runtime-checkpoint") checkpoints.push(structuredClone(message));
			return { ok: true };
		}, {
			checkpointDelayMs: 0,
			maxCompletedRequests: 2,
		});
		await initializeAndConnect(controller);
		await required(
			controller.handleMessage({
				type: "agent-runtime-request",
				request: request({ type: "create", systemPrompt: "System prompt" }, "request-1"),
			}),
		);
		await required(
			controller.handleMessage({
				type: "agent-runtime-request",
				request: request({ type: "set-thinking", thinkingLevel: "low" }, "request-2"),
			}),
		);
		await required(
			controller.handleMessage({
				type: "agent-runtime-request",
				request: request({ type: "set-thinking", thinkingLevel: "high" }, "request-3"),
			}),
		);
		await vi.advanceTimersByTimeAsync(0);
		const persisted = checkpoints.at(-1)?.state;
		expect(persisted?.requests.map((entry) => entry.request.requestId)).toEqual(["request-2", "request-3"]);

		const replay = await required(
			controller.handleMessage({
				type: "agent-runtime-request",
				request: request({ type: "create", systemPrompt: "System prompt" }, "request-1"),
			}),
		);
		expect(replay).toMatchObject({ ok: false, error: { code: "SESSION_EXISTS" } });
		await controller.dispose();
	});

	it("correlates page operations to their parent and cancels the exact operation while ignoring a late result", async () => {
		const pageResult = deferred<unknown>();
		const pageMessages: AgentRuntimePageOperationMessage[] = [];
		const cancelMessages: AgentRuntimePageCancelMessage[] = [];
		const controller = createController(new TestSessionFactory(), async (message) => {
			if (message.type === "agent-runtime-page-operation") {
				pageMessages.push(structuredClone(message));
				return pageResult.promise;
			}
			if (message.type === "agent-runtime-page-cancel") cancelMessages.push(structuredClone(message));
			return { ok: true };
		}, {
			createId: () => "page-operation-1",
		});
		await initializeAndConnect(controller);
		await required(
			controller.handleMessage({
				type: "agent-runtime-request",
				request: request({ type: "create", systemPrompt: "System prompt" }, "request-create"),
			}),
		);

		const execution = required(
			controller.handleMessage({
				type: "agent-runtime-request",
				request: request(
					{ type: "page-operation", executionId: "execution-page", operation: "navigate", params: { url: "https://example.com" } },
					"request-page",
				),
			}),
		);
		await vi.waitFor(() => expect(pageMessages).toHaveLength(1));
		expect(pageMessages[0]).toMatchObject({
			operationId: "page-operation-1",
			clientId: "client-1",
			windowId: 7,
			sessionId: "session-1",
			executionId: "execution-page",
			executionRequestId: "request-page",
			trace,
		});

		const abort = required(
			controller.handleMessage({
				type: "agent-runtime-request",
				request: request(
					{
						type: "abort",
						executionId: "execution-page",
						targetRequestId: "request-page",
						reason: "user",
					},
					"request-abort",
				),
			}),
		);
		expect(await abort).toMatchObject({ ok: true });
		expect(await execution).toMatchObject({ ok: false, error: { code: "ABORTED" } });
		expect(cancelMessages).toEqual([
			{
				type: "agent-runtime-page-cancel",
				operationId: "page-operation-1",
				runtimeEpoch: "epoch-new",
				clientId: "client-1",
				windowId: 7,
				sessionId: "session-1",
				target,
				executionId: "execution-page",
				executionRequestId: "request-page",
			},
		]);
		pageResult.resolve({ ok: true, result: { ignored: true } });
		await Promise.resolve();
		expect(cancelMessages).toHaveLength(1);
		await controller.dispose();
	});

	it("correlates Agent tool page operations to the active prompt request", async () => {
		const factory = new TestSessionFactory();
		const pageMessages: AgentRuntimePageOperationMessage[] = [];
		const controller = createController(factory, async (message) => {
			if (message.type === "agent-runtime-page-operation") {
				pageMessages.push(structuredClone(message));
				return { ok: true, result: { navigated: true } };
			}
			return { ok: true };
		}, {
			createId: () => "tool-page-operation",
		});
		await initializeAndConnect(controller);
		await required(
			controller.handleMessage({
				type: "agent-runtime-request",
				request: request({ type: "create", systemPrompt: "System prompt" }, "request-create"),
			}),
		);
		const adapter = factory.created[0];
		if (!adapter) throw new Error("missing session adapter");
		adapter.promptImplementation = async (_message, context) => {
			if (!context.executionId) throw new Error("prompt context is missing execution identity");
			await expect(
				controller.executeToolPageOperation("navigate", { url: "https://example.com" }, {
					runtimeEpoch: context.runtimeEpoch,
					clientId: context.clientId,
					windowId: context.windowId,
					sessionId: context.sessionId,
					target: context.target,
					requestId: context.requestId,
					executionId: context.executionId,
					...(context.trace ? { trace: context.trace } : {}),
					signal: context.signal,
				}),
			).resolves.toEqual({ navigated: true });
		};

		await required(
			controller.handleMessage({
				type: "agent-runtime-request",
				request: request(
					{ type: "prompt", executionId: "prompt-execution", message: { role: "user", content: "go" } },
					"prompt-request",
				),
			}),
		);
		expect(pageMessages).toEqual([
			expect.objectContaining({
				executionId: "prompt-execution",
				executionRequestId: "prompt-request",
				operation: "navigate",
				trace,
			}),
		]);
		await expect(
			controller.pageOperations.execute("navigate", {}, {
				runtimeEpoch: "epoch-new",
				clientId: "client-1",
				windowId: 7,
				sessionId: "session-1",
				target,
				requestId: "unbound-request",
				signal: new AbortController().signal,
				session: adapter,
			}),
		).rejects.toThrow("no parent execution");
		await controller.dispose();
	});

	it("cancels outstanding privileged operations during disposal", async () => {
		const pending = deferred<unknown>();
		const cancels: AgentRuntimePageCancelMessage[] = [];
		const factory = new TestSessionFactory();
		const controller = createController(factory, async (message) => {
			if (message.type === "agent-runtime-page-operation") return pending.promise;
			if (message.type === "agent-runtime-page-cancel") cancels.push(message);
			return { ok: true };
		}, {
			createId: () => "dispose-page-operation",
		});
		await required(controller.handleMessage({ type: "agent-runtime-init" }));
		const signal = new AbortController();
		const context: OffscreenRuntimeOperationContext = {
			runtimeEpoch: "epoch-new",
			clientId: "client-1",
			windowId: 7,
			sessionId: "session-1",
			target,
			requestId: "request-parent",
			executionId: "execution-parent",
			trace,
			signal: signal.signal,
			session: new TestSessionAdapter(),
		};
		const operation = controller.pageOperations.execute("navigate", {}, context);
		await Promise.resolve();
		await controller.dispose();
		await expect(operation).rejects.toMatchObject({ name: "AbortError" });
		expect(cancels).toEqual([
			{
				type: "agent-runtime-page-cancel",
				operationId: "dispose-page-operation",
				runtimeEpoch: "epoch-new",
				clientId: "client-1",
				windowId: 7,
				sessionId: "session-1",
				target,
				executionId: "execution-parent",
				executionRequestId: "request-parent",
			},
		]);
		pending.resolve({ ok: true, result: null });
	});
});

class FakeHost implements OffscreenRuntimeControllerHost {
	readonly runtimeEpoch: string;
	exportCalls = 0;
	exportFailures = 0;

	constructor(private readonly options: OffscreenRuntimeHostOptions) {
		this.runtimeEpoch = options.runtimeEpoch;
	}

	handle(requestValue: RuntimeRequestEnvelope): Promise<RuntimeResponseEnvelope> {
		this.options.onStateChanged?.();
		const response: RuntimeResponseEnvelope = {
			kind: "response",
			protocolVersion: requestValue.protocolVersion,
			runtimeEpoch: requestValue.runtimeEpoch,
			clientId: requestValue.clientId,
			windowId: requestValue.windowId,
			sessionId: requestValue.sessionId,
			target: requestValue.target,
			requestId: requestValue.requestId,
			operation: requestValue.operation.type,
			...(requestValue.trace ? { trace: requestValue.trace } : {}),
			ok: true,
			result: { handled: true },
		};
		return Promise.resolve(response);
	}

	emitHello(
		clientId: string,
		windowId: number,
		mode: "fresh" | "resumed" | "restarted" = "fresh",
		previousRuntimeEpoch?: string,
	): RuntimeStreamEnvelope {
		const envelope: RuntimeStreamEnvelope = {
			kind: "stream",
			streamType: "hello",
			protocolVersion: RUNTIME_PROTOCOL_VERSION,
			runtimeEpoch: this.runtimeEpoch,
			clientId,
			windowId,
			recovery: {
				mode,
				...(previousRuntimeEpoch ? { previousRuntimeEpoch } : {}),
				sessions: [],
			},
		};
		this.options.emit(envelope);
		return envelope;
	}

	exportState(): OffscreenRuntimeHostState {
		this.exportCalls++;
		if (this.exportFailures > 0) {
			this.exportFailures--;
			throw new Error("Runtime state cannot be exported while a session mutation is pending");
		}
		return { runtimeEpoch: this.runtimeEpoch, sessions: [], requests: [] };
	}

	restoreState(): Promise<void> {
		return Promise.resolve();
	}

	dispose(): Promise<void> {
		return Promise.resolve();
	}
}
