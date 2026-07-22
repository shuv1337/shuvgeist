import { describe, expect, it } from "vitest";
import {
	OffscreenRuntimeHost,
	type OffscreenRuntimeHostState,
	type OffscreenRuntimeOperationContext,
	type OffscreenRuntimeSessionAdapter,
	type OffscreenRuntimeSessionFactory,
	type OffscreenRuntimeSessionState,
} from "@shuvgeist/extension/agent/offscreen-runtime-host";
import {
	isRuntimeResponseEnvelope,
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeAgentEvent,
	type RuntimeAgentMessage,
	type RuntimeRequestEnvelope,
	type RuntimeRequestOperation,
	type RuntimeResponseEnvelope,
	type RuntimeStreamEnvelope,
	type RuntimeTargetIdentity,
	type RuntimeTraceContext,
	type RuntimeValue,
} from "@shuvgeist/extension/agent/runtime-protocol";

const target: RuntimeTargetIdentity = { kind: "chrome-tab", tabId: 7, frameId: 0 };
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

function findLastItem<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (item !== undefined && predicate(item)) return item;
	}
	return undefined;
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function abortError(): Error {
	const error = new Error("aborted");
	error.name = "AbortError";
	return error;
}

function rejectWhenAborted(signal: AbortSignal, message: string): Promise<never> {
	return new Promise((_, reject) => {
		const rejectForAbort = (): void => {
			const error = new Error(message);
			error.name = "AbortError";
			reject(error);
		};
		if (signal.aborted) rejectForAbort();
		else signal.addEventListener("abort", rejectForAbort, { once: true });
	});
}

function initialState(overrides: Partial<OffscreenRuntimeSessionState> = {}): OffscreenRuntimeSessionState {
	return {
		systemPrompt: "Be precise.",
		model: { provider: "openai", id: "model-a" },
		thinkingLevel: "medium",
		messages: [],
		tools: [{ name: "navigate", label: "Navigate" }],
		pendingToolCallIds: [],
		isStreaming: false,
		artifacts: [],
		...overrides,
	};
}

class TestSessionAdapter implements OffscreenRuntimeSessionAdapter {
	state = initialState();
	readonly promptCalls: RuntimeAgentMessage[] = [];
	readonly abortCalls: string[] = [];
	readonly setModelCalls: string[] = [];
	readonly steerCalls: RuntimeAgentMessage[] = [];
	readonly replaceCalls: RuntimeAgentMessage[] = [];
	unsubscribeCount = 0;
	disposeCount = 0;
	lastSubscribedListener?: (event: RuntimeAgentEvent) => void;
	promptImplementation: (message: RuntimeAgentMessage, context: OffscreenRuntimeOperationContext) => Promise<void> =
		async () => {};
	setModelImplementation: (signal: AbortSignal) => Promise<void> | void = () => {};
	replaceImplementation: (signal: AbortSignal) => Promise<void> | void = () => {};
	disposeImplementation: () => Promise<void> | void = () => {};
	private readonly listeners = new Set<(event: RuntimeAgentEvent) => void>();

	getState(): OffscreenRuntimeSessionState {
		return this.state;
	}

	subscribe(listener: (event: RuntimeAgentEvent) => void): () => void {
		this.lastSubscribedListener = listener;
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
			this.unsubscribeCount++;
		};
	}

	emit(event: RuntimeAgentEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	get listenerCount(): number {
		return this.listeners.size;
	}

	async prompt(message: RuntimeAgentMessage, context: OffscreenRuntimeOperationContext): Promise<void> {
		this.promptCalls.push(message);
		await this.promptImplementation(message, context);
	}

	abort(executionId: string): void {
		this.abortCalls.push(executionId);
	}

	async setModel(model: OffscreenRuntimeSessionState["model"] & {}, signal: AbortSignal): Promise<void> {
		this.setModelCalls.push(model.id);
		await this.setModelImplementation(signal);
		this.state = { ...this.state, model };
	}

	setThinkingLevel(thinkingLevel: OffscreenRuntimeSessionState["thinkingLevel"]): void {
		this.state = { ...this.state, thinkingLevel };
	}

	steer(message: RuntimeAgentMessage): void {
		this.steerCalls.push(message);
	}

	async replaceOrAppendMessage(
		message: RuntimeAgentMessage,
		messageIndex: number | undefined,
		signal: AbortSignal,
	): Promise<void> {
		this.replaceCalls.push(message);
		await this.replaceImplementation(signal);
		const messages = this.state.messages.slice();
		if (messageIndex === undefined || messageIndex >= messages.length) messages.push(message);
		else messages[messageIndex] = message;
		this.state = { ...this.state, messages };
	}

	async dispose(): Promise<void> {
		this.disposeCount++;
		await this.disposeImplementation();
	}
}

class TestSessionFactory implements OffscreenRuntimeSessionFactory {
	readonly created: TestSessionAdapter[] = [];
	readonly restored: TestSessionAdapter[] = [];

	async create(): Promise<TestSessionAdapter> {
		const adapter = new TestSessionAdapter();
		this.created.push(adapter);
		return adapter;
	}

	async load(): Promise<TestSessionAdapter> {
		return this.create();
	}

	async restore(input: Parameters<NonNullable<OffscreenRuntimeSessionFactory["restore"]>>[0]): Promise<TestSessionAdapter> {
		const adapter = new TestSessionAdapter();
		adapter.state = {
			systemPrompt: input.snapshot.systemPrompt,
			model: input.snapshot.model,
			thinkingLevel: input.snapshot.thinkingLevel,
			messages: input.snapshot.messages,
			tools: input.snapshot.tools,
			pendingToolCallIds: input.snapshot.pendingToolCallIds,
			isStreaming: input.snapshot.isStreaming,
			...(input.snapshot.streamingMessage ? { streamingMessage: input.snapshot.streamingMessage } : {}),
			artifacts: input.snapshot.artifacts,
			...(input.snapshot.errorMessage ? { errorMessage: input.snapshot.errorMessage } : {}),
		};
		this.restored.push(adapter);
		return adapter;
	}
}

function request(
	operation: RuntimeRequestOperation,
	overrides: Partial<Omit<RuntimeRequestEnvelope, "operation">> = {},
): RuntimeRequestEnvelope {
	return {
		kind: "request",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "client-1",
		windowId: 1,
		sessionId: "session-1",
		target,
		requestId: `request-${operation.type}`,
		trace,
		operation,
		...overrides,
	};
}

function createRequest(overrides: Partial<Omit<RuntimeRequestEnvelope, "operation">> = {}): RuntimeRequestEnvelope {
	return request({ type: "create", systemPrompt: "Be precise." }, overrides);
}

function promptRequest(requestId = "request-prompt", executionId = "execution-prompt"): RuntimeRequestEnvelope {
	return request(
		{
			type: "prompt",
			executionId,
			message: { role: "user", content: "hello", timestamp: 1 },
		},
		{ requestId },
	);
}

function errorCode(response: RuntimeResponseEnvelope): string | undefined {
	return response.ok ? undefined : response.error.code;
}

describe("OffscreenRuntimeHost", () => {
	it("isolates equal session and request ids by client window", async () => {
		const factory = new TestSessionFactory();
		const host = new OffscreenRuntimeHost({ runtimeEpoch: "epoch-1", sessionFactory: factory, emit: () => {} });

		const first = await host.handle(createRequest({ requestId: "same", windowId: 1 }));
		const second = await host.handle(createRequest({ requestId: "same", windowId: 2 }));
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(factory.created).toHaveLength(2);
		const conflict = await host.handle(
			request({ type: "create", systemPrompt: "Different." }, { requestId: "same", windowId: 1 }),
		);
		expect(errorCode(conflict)).toBe("REQUEST_ID_CONFLICT");
		const stale = await host.handle(createRequest({ requestId: "same", windowId: 1, runtimeEpoch: "epoch-0" }));
		expect(errorCode(stale)).toBe("STALE_RUNTIME_EPOCH");

		await host.handle(
			request(
				{ type: "set-model", model: { provider: "anthropic", id: "model-window-1" } },
				{ requestId: "set", windowId: 1 },
			),
		);
		expect(factory.created[0]?.state.model?.id).toBe("model-window-1");
		expect(factory.created[1]?.state.model?.id).toBe("model-a");
	});

	it("streams prompt lifecycle and Agent events in sequence before resolving the response", async () => {
		const factory = new TestSessionFactory();
		const streams: RuntimeStreamEnvelope[] = [];
		const order: string[] = [];
		const host = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: factory,
			emit: (envelope) => {
				streams.push(envelope);
				if (envelope.streamType === "execution") order.push(`execution:${envelope.execution.status}`);
				else order.push(envelope.streamType);
			},
			now: () => 1_000,
		});
		await host.handle(createRequest());
		streams.length = 0;
		order.length = 0;
		const adapter = factory.created[0];
		if (!adapter) throw new Error("missing adapter");
		adapter.promptImplementation = async (_message, _signal) => {
			adapter.emit({ type: "agent_start" });
			adapter.emit({ type: "message_end", message: { role: "assistant", content: "done" } });
			adapter.emit({ type: "agent_end", messages: [{ role: "assistant", content: "done" }] });
		};

		const response = await host.handle(promptRequest()).then((value) => {
			order.push("response");
			return value;
		});

		expect(response.ok).toBe(true);
		expect(order).toEqual([
			"execution:running",
			"agent-event",
			"agent-event",
			"agent-event",
			"execution:succeeded",
			"session-snapshot",
			"response",
		]);
		expect(streams.map((envelope) => (envelope.streamType === "hello" ? 0 : envelope.eventSeq))).toEqual([
			2, 3, 4, 5, 6, 7,
		]);
		for (const envelope of streams) {
			expect(envelope.trace).toEqual(trace);
			if (envelope.streamType !== "hello") expect(envelope.target).toEqual(target);
		}
	});

	it("persists background-prepared navigation context before prompting", async () => {
		const factory = new TestSessionFactory();
		const streams: RuntimeStreamEnvelope[] = [];
		let preparationContext: OffscreenRuntimeOperationContext | undefined;
		const navigation: RuntimeAgentMessage = {
			role: "navigation",
			url: "https://example.test/current",
			title: "Current page",
			tabId: 71,
			snapshot: { url: "https://example.test/current", entries: [{ snapshotId: "e1" }] },
			skillsOutput: "full skill context",
		};
		const host = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: factory,
			emit: (envelope) => streams.push(envelope),
			promptPreparation: {
				async prepare(context) {
					preparationContext = context;
					return navigation;
				},
			},
		});
		await host.handle(createRequest());
		const adapter = factory.created[0];
		if (!adapter) throw new Error("missing adapter");

		const response = await host.handle(promptRequest());
		expect(response.ok).toBe(true);
		expect(preparationContext).toMatchObject({
			clientId: "client-1",
			windowId: 1,
			sessionId: "session-1",
			requestId: "request-prompt",
			executionId: "execution-prompt",
			target,
		});
		expect(adapter.replaceCalls).toEqual([navigation]);
		expect(adapter.promptCalls).toEqual([{ role: "user", content: "hello", timestamp: 1 }]);
		expect(
			streams.some(
				(envelope) =>
					envelope.streamType === "session-snapshot" &&
					envelope.snapshot.messages.some(
						(message) =>
							message.role === "navigation" &&
							message.skillsOutput === "full skill context" &&
							message.snapshot !== undefined,
					),
			),
		).toBe(true);
	});

	it("deduplicates a prompt, rejects a concurrent prompt, and aborts only an exact execution", async () => {
		const factory = new TestSessionFactory();
		const host = new OffscreenRuntimeHost({ runtimeEpoch: "epoch-1", sessionFactory: factory, emit: () => {} });
		await host.handle(createRequest());
		const adapter = factory.created[0];
		if (!adapter) throw new Error("missing adapter");
		const promptDone = deferred<void>();
		let promptSignal: AbortSignal | undefined;
		adapter.promptImplementation = async (_message, context) => {
			promptSignal = context.signal;
			await Promise.race([
				promptDone.promise,
				new Promise<void>((_resolve, reject) =>
					context.signal.addEventListener("abort", () => reject(abortError()), { once: true }),
				),
			]);
		};

		const first = host.handle(promptRequest());
		const duplicate = host.handle(promptRequest());
		await Promise.resolve();
		expect(duplicate).toBe(first);
		expect(adapter.promptCalls).toHaveLength(1);

		const busy = await host.handle(promptRequest("request-prompt-2", "execution-prompt-2"));
		expect(errorCode(busy)).toBe("SESSION_BUSY");
		const mismatch = await host.handle(
			request(
				{
					type: "abort",
					executionId: "wrong-execution",
					targetRequestId: "request-prompt",
				},
				{ requestId: "abort-wrong" },
			),
		);
		expect(errorCode(mismatch)).toBe("EXECUTION_IDENTITY_MISMATCH");
		expect(promptSignal?.aborted).toBe(false);

		const cancelled = await host.handle(
			request(
				{
					type: "abort",
					executionId: "execution-prompt",
					targetRequestId: "request-prompt",
				},
				{ requestId: "abort-exact" },
			),
		);
		expect(cancelled.ok).toBe(true);
		expect(promptSignal?.aborted).toBe(true);
		expect(adapter.abortCalls).toEqual(["execution-prompt"]);
		expect(errorCode(await first)).toBe("ABORTED");
	});

	it("queues steering through the concrete session while a prompt is active", async () => {
		const factory = new TestSessionFactory();
		const streams: RuntimeStreamEnvelope[] = [];
		const host = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: factory,
			emit: (envelope) => streams.push(envelope),
		});
		await host.handle(createRequest());
		const adapter = factory.created[0];
		if (!adapter) throw new Error("missing adapter");
		adapter.promptImplementation = async (_message, context) =>
			rejectWhenAborted(context.signal, "prompt aborted");

		const prompting = host.handle(promptRequest());
		await flushMicrotasks();
		const steeringMessage: RuntimeAgentMessage = {
			role: "user",
			content: "The active tab changed.",
			timestamp: 2,
		};
		const steered = await host.handle(
			request({ type: "steer", message: steeringMessage }, { requestId: "request-steer" }),
		);

		expect(steered.ok).toBe(true);
		expect(adapter.steerCalls).toEqual([steeringMessage]);
		expect(
			streams.some(
				(envelope) =>
					envelope.streamType === "session-snapshot" && envelope.snapshot.revision === 2,
			),
		).toBe(true);

		await host.handle(
			request(
				{ type: "abort", executionId: "execution-prompt", targetRequestId: "request-prompt" },
				{ requestId: "abort-steered-prompt" },
			),
		);
		expect(errorCode(await prompting)).toBe("ABORTED");
	});

	it("retains a busy session until an explicit forced release", async () => {
		const factory = new TestSessionFactory();
		const host = new OffscreenRuntimeHost({ runtimeEpoch: "epoch-1", sessionFactory: factory, emit: () => {} });
		await host.handle(createRequest());
		const adapter = factory.created[0];
		if (!adapter) throw new Error("missing adapter");
		adapter.promptImplementation = async (_message, context) => rejectWhenAborted(context.signal, "released");
		const prompting = host.handle(promptRequest());
		await flushMicrotasks();

		const refused = await host.handle(request({ type: "release" }, { requestId: "release-busy" }));
		expect(errorCode(refused)).toBe("SESSION_BUSY");
		expect(adapter.disposeCount).toBe(0);

		const released = await host.handle(
			request(
				{ type: "release", force: true, reason: "window-removed" },
				{ requestId: "release-forced" },
			),
		);
		expect(released.ok ? released.result : undefined).toEqual({ released: true, reason: "window-removed" });
		expect(adapter.disposeCount).toBe(1);
		expect(errorCode(await prompting)).toBe("ABORTED");
		expect(
			errorCode(await host.handle(request({ type: "attach" }, { requestId: "attach-after-release" }))),
		).toBe("SESSION_NOT_FOUND");
	});

	it("prevents an exactly cancelled queued execution from starting", async () => {
		const factory = new TestSessionFactory();
		const streams: RuntimeStreamEnvelope[] = [];
		const host = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: factory,
			emit: (envelope) => streams.push(envelope),
		});
		await host.handle(createRequest());
		const queued = promptRequest("queued-request", "queued-execution");
		const promptResponse = host.handle(queued);
		const abortResponse = host.handle(
			request(
				{
					type: "abort",
					executionId: "queued-execution",
					targetRequestId: "queued-request",
				},
				{ requestId: "abort-queued" },
			),
		);
		const aborted = await abortResponse;
		expect(aborted.ok ? aborted.result : undefined).toEqual({ status: "cancelled-before-start" });
		expect(errorCode(await promptResponse)).toBe("ABORTED");
		expect(factory.created[0]?.promptCalls).toHaveLength(0);
		expect(
			streams.some(
				(envelope) =>
					envelope.streamType === "execution" &&
					envelope.execution.executionId === "queued-execution" &&
					envelope.execution.status === "cancelled",
			),
		).toBe(true);
	});

	it("serializes adapter and privileged page failures while propagating context", async () => {
		const factory = new TestSessionFactory();
		const streams: RuntimeStreamEnvelope[] = [];
		let capturedContext: OffscreenRuntimeOperationContext | undefined;
		const host = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: factory,
			emit: (envelope) => streams.push(envelope),
			pageOperations: {
				async execute(_operation, _params, context): Promise<RuntimeValue> {
					capturedContext = context;
					throw new Error("page failed");
				},
			},
		});
		await host.handle(createRequest());
		const adapter = factory.created[0];
		if (!adapter) throw new Error("missing adapter");
		adapter.setModelImplementation = () => {
			throw new Error("adapter failed");
		};
		const modelFailure = await host.handle(
			request({ type: "set-model", model: { provider: "openai", id: "bad" } }, { requestId: "set-bad" }),
		);
		expect(errorCode(modelFailure)).toBe("RUNTIME_OPERATION_FAILED");
		if (modelFailure.ok) throw new Error("expected model failure");
		expect(modelFailure.error.message).toBe("adapter failed");

		streams.length = 0;
		const pageFailure = await host.handle(
			request(
				{ type: "page-operation", executionId: "page-1", operation: "click", params: { ref: "e1" } },
				{ requestId: "page-request" },
			),
		);
		expect(errorCode(pageFailure)).toBe("EXECUTION_FAILED");
		expect(capturedContext).toMatchObject({
			clientId: "client-1",
			windowId: 1,
			sessionId: "session-1",
			requestId: "page-request",
			executionId: "page-1",
			target,
			trace,
		});
		expect(
			streams.some(
				(envelope) => envelope.streamType === "execution" && envelope.execution.status === "failed",
			),
		).toBe(true);
	});

	it("exports and restores sessions across a new runtime epoch", async () => {
		const firstFactory = new TestSessionFactory();
		const firstHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: firstFactory,
			emit: () => {},
		});
		await firstHost.handle(createRequest());
		const persisted: OffscreenRuntimeHostState = firstHost.exportState();

		const streams: RuntimeStreamEnvelope[] = [];
		const secondFactory = new TestSessionFactory();
		const secondHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-2",
			sessionFactory: secondFactory,
			emit: (envelope) => streams.push(envelope),
		});
		await secondHost.restoreState(persisted);
		const hello = secondHost.emitHello("client-1", 1, "restarted");
		expect(hello.streamType).toBe("hello");
		if (hello.streamType !== "hello") throw new Error("expected hello");
		expect(hello.recovery.previousRuntimeEpoch).toBe("epoch-1");
		expect(hello.recovery.sessions[0]?.eventSeq).toBe(0);

		const attached = await secondHost.handle(
			request(
				{ type: "attach", knownRuntimeEpoch: "epoch-1", lastRevision: 1, lastEventSeq: 1 },
				{ runtimeEpoch: "epoch-2", requestId: "attach-2" },
			),
		);
		expect(attached.ok).toBe(true);
		const snapshot = findLastItem(streams, (envelope) => envelope.streamType === "session-snapshot");
		expect(snapshot?.streamType === "session-snapshot" ? snapshot.eventSeq : undefined).toBe(1);
	});

	it("preserves complete model execution metadata in snapshots and checkpoints", async () => {
		const factory = new TestSessionFactory();
		const host = new OffscreenRuntimeHost({ runtimeEpoch: "epoch-1", sessionFactory: factory, emit: () => {} });
		await host.handle(createRequest());
		const adapter = factory.created[0];
		if (!adapter) throw new Error("missing adapter");
		const model = {
			provider: "custom",
			id: "model-a",
			name: "Custom A",
			api: "openai-completions",
			baseUrl: "https://custom.test/v1",
			reasoning: true,
			thinkingLevelMap: { off: null, high: "high" },
			input: ["text", "image"] as Array<"text" | "image">,
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			contextWindow: 64_000,
			maxTokens: 8_000,
			headers: { "x-affinity": "session" },
			compat: { supportsStore: false, maxTokensField: "max_tokens" },
		};
		adapter.state = { ...adapter.state, model };

		expect(host.exportState().sessions[0]?.snapshot.model).toEqual(model);
	});

	it("aborts active work and releases subscriptions and adapters on dispose", async () => {
		const factory = new TestSessionFactory();
		const streams: RuntimeStreamEnvelope[] = [];
		const host = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: factory,
			emit: (envelope) => streams.push(envelope),
		});
		await host.handle(createRequest());
		const adapter = factory.created[0];
		if (!adapter) throw new Error("missing adapter");
		let signal: AbortSignal | undefined;
		adapter.promptImplementation = async (_message, context) => {
			signal = context.signal;
			await new Promise<void>((_resolve, reject) =>
				context.signal.addEventListener("abort", () => reject(abortError()), { once: true }),
			);
		};
		const pending = host.handle(promptRequest());
		await Promise.resolve();
		await host.dispose();
		expect(signal?.aborted).toBe(true);
		expect(adapter.unsubscribeCount).toBe(1);
		expect(adapter.disposeCount).toBe(1);
		const streamCount = streams.length;
		adapter.emit({ type: "agent_start" });
		expect(streams).toHaveLength(streamCount);
		expect(errorCode(await pending)).toBe("ABORTED");
		expect(errorCode(await host.handle(request({ type: "load" }, { requestId: "after-dispose" })))).toBe(
			"HOST_DISPOSED",
		);
	});

	it("serializes concurrent session acquisition and disposes a factory result that arrives after shutdown", async () => {
		const createResult = deferred<TestSessionAdapter>();
		let createCalls = 0;
		const factory: OffscreenRuntimeSessionFactory = {
			async create() {
				createCalls++;
				return createResult.promise;
			},
			async load() {
				throw new Error("not used");
			},
		};
		const host = new OffscreenRuntimeHost({ runtimeEpoch: "epoch-1", sessionFactory: factory, emit: () => {} });
		const first = host.handle(createRequest({ requestId: "create-1" }));
		const second = host.handle(createRequest({ requestId: "create-2" }));
		await Promise.resolve();
		await Promise.resolve();
		expect(createCalls).toBe(1);
		const adapter = new TestSessionAdapter();
		createResult.resolve(adapter);
		expect((await first).ok).toBe(true);
		expect(errorCode(await second)).toBe("SESSION_EXISTS");
		expect(createCalls).toBe(1);
		expect(adapter.listenerCount).toBe(1);

		const loadResult = deferred<TestSessionAdapter>();
		let loadCalls = 0;
		const loadFactory: OffscreenRuntimeSessionFactory = {
			async create() {
				throw new Error("not used");
			},
			async load() {
				loadCalls++;
				return loadResult.promise;
			},
		};
		const loadHost = new OffscreenRuntimeHost({ runtimeEpoch: "epoch-1", sessionFactory: loadFactory, emit: () => {} });
		const firstLoad = loadHost.handle(request({ type: "load" }, { requestId: "load-1" }));
		const secondLoad = loadHost.handle(request({ type: "load" }, { requestId: "load-2" }));
		await Promise.resolve();
		await Promise.resolve();
		expect(loadCalls).toBe(1);
		loadResult.resolve(new TestSessionAdapter());
		expect((await firstLoad).ok).toBe(true);
		expect((await secondLoad).ok).toBe(true);
		expect(loadCalls).toBe(1);

		const lateResult = deferred<TestSessionAdapter>();
		const lateFactory: OffscreenRuntimeSessionFactory = {
			async create() {
				return lateResult.promise;
			},
			async load() {
				throw new Error("not used");
			},
		};
		const lateHost = new OffscreenRuntimeHost({ runtimeEpoch: "epoch-1", sessionFactory: lateFactory, emit: () => {} });
		const lateCreate = lateHost.handle(createRequest({ requestId: "late-create" }));
		await Promise.resolve();
		await Promise.resolve();
		const disposing = lateHost.dispose();
		const lateAdapter = new TestSessionAdapter();
		lateResult.resolve(lateAdapter);
		await disposing;
		expect(errorCode(await lateCreate)).toBe("ABORTED");
		expect(lateAdapter.disposeCount).toBe(1);
		expect(lateAdapter.listenerCount).toBe(0);
		expect(lateHost.exportState().sessions).toHaveLength(0);
	});

	it("rolls back invalid create and load adapters before publishing the session", async () => {
		const invalidCreate = new TestSessionAdapter();
		invalidCreate.state = {
			...invalidCreate.state,
			thinkingLevel: "bogus" as unknown as OffscreenRuntimeSessionState["thinkingLevel"],
		};
		const validCreate = new TestSessionAdapter();
		let createCalls = 0;
		const createFactory: OffscreenRuntimeSessionFactory = {
			async create() {
				createCalls++;
				return createCalls === 1 ? invalidCreate : validCreate;
			},
			async load() {
				throw new Error("not used");
			},
		};
		const createHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: createFactory,
			emit: () => {},
		});
		expect(errorCode(await createHost.handle(createRequest({ requestId: "invalid-create" })))).toBe(
			"INVALID_SESSION_STATE",
		);
		expect(invalidCreate.disposeCount).toBe(1);
		expect(invalidCreate.listenerCount).toBe(0);
		expect((await createHost.handle(createRequest({ requestId: "valid-create" }))).ok).toBe(true);
		expect(createCalls).toBe(2);

		const invalidLoad = new TestSessionAdapter();
		invalidLoad.state = {
			...invalidLoad.state,
			thinkingLevel: "bogus" as unknown as OffscreenRuntimeSessionState["thinkingLevel"],
		};
		const validLoad = new TestSessionAdapter();
		let loadCalls = 0;
		const loadFactory: OffscreenRuntimeSessionFactory = {
			async create() {
				throw new Error("not used");
			},
			async load() {
				loadCalls++;
				return loadCalls === 1 ? invalidLoad : validLoad;
			},
		};
		const loadHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: loadFactory,
			emit: () => {},
		});
		expect(errorCode(await loadHost.handle(request({ type: "load" }, { requestId: "invalid-load" })))).toBe(
			"INVALID_SESSION_STATE",
		);
		expect(invalidLoad.disposeCount).toBe(1);
		expect(invalidLoad.listenerCount).toBe(0);
		expect((await loadHost.handle(request({ type: "load" }, { requestId: "valid-load" }))).ok).toBe(true);
		expect(loadCalls).toBe(2);
	});

	it("registers in-flight work before streams and clears prompt ownership before terminal callbacks", async () => {
		const factory = new TestSessionFactory();
		let host: OffscreenRuntimeHost;
		let duplicate: Promise<RuntimeResponseEnvelope> | undefined;
		let reentrant: Promise<RuntimeResponseEnvelope> | undefined;
		const firstRequest = promptRequest("prompt-reentrant-1", "execution-reentrant-1");
		const secondRequest = promptRequest("prompt-reentrant-2", "execution-reentrant-2");
		host = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: factory,
			emit: (envelope) => {
				if (
					envelope.streamType === "execution" &&
					envelope.execution.executionId === "execution-reentrant-1" &&
					envelope.execution.status === "running"
				) {
					duplicate = host.handle(firstRequest);
				}
				if (
					envelope.streamType === "execution" &&
					envelope.execution.executionId === "execution-reentrant-1" &&
					envelope.execution.status === "succeeded"
				) {
					reentrant = host.handle(secondRequest);
				}
			},
		});
		await host.handle(createRequest());
		const first = host.handle(firstRequest);
		const firstResponse = await first;
		expect(firstResponse.ok).toBe(true);
		expect(duplicate).toBe(first);
		expect(duplicate ? (await duplicate).ok : false).toBe(true);
		expect(reentrant).toBeDefined();
		expect(reentrant ? (await reentrant).ok : false).toBe(true);
		expect(factory.created[0]?.promptCalls).toHaveLength(2);
	});

	it("terminalizes long-operation preflight failures", async () => {
		const factory = new TestSessionFactory();
		const streams: RuntimeStreamEnvelope[] = [];
		const host = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: factory,
			emit: (envelope) => streams.push(envelope),
		});
		await host.handle(createRequest());
		const pageRequest = request(
			{ type: "page-operation", executionId: "unsupported-page", operation: "click", params: {} },
			{ requestId: "unsupported-page-request" },
		);
		const failureResponse = await host.handle(pageRequest);
		expect(errorCode(failureResponse)).toBe("UNSUPPORTED");
		expect(
			streams.some(
				(envelope) =>
					envelope.streamType === "execution" &&
					envelope.execution.executionId === "unsupported-page" &&
					envelope.execution.status === "failed",
			),
		).toBe(true);
		expect(await host.handle(pageRequest)).toEqual(failureResponse);
		const abort = await host.handle(
			request(
				{
					type: "abort",
					executionId: "unsupported-page",
					targetRequestId: "unsupported-page-request",
				},
				{ requestId: "abort-failed-page" },
			),
		);
		expect(abort.ok ? abort.result : undefined).toEqual({ status: "already-terminal" });
	});

	it("restores same-epoch dedup history and settles orphaned executions", async () => {
		const firstFactory = new TestSessionFactory();
		const firstHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: firstFactory,
			emit: () => {},
		});
		await firstHost.handle(createRequest());
		const modelRequest = request(
			{ type: "set-model", model: { provider: "openai", id: "restored-model" } },
			{ requestId: "persisted-model" },
		);
		const originalModelResponse = await firstHost.handle(modelRequest);
		const persisted = firstHost.exportState();
		const secondFactory = new TestSessionFactory();
		const secondHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: secondFactory,
			emit: () => {},
		});
		await secondHost.restoreState(persisted);
		expect(await secondHost.handle(modelRequest)).toEqual(originalModelResponse);
		expect(secondFactory.restored[0]?.setModelCalls).toHaveLength(0);

		const orphanDone = deferred<void>();
		const activeAdapter = firstFactory.created[0];
		if (!activeAdapter) throw new Error("missing active adapter");
		activeAdapter.promptImplementation = async (_message, context) => {
			await Promise.race([
				orphanDone.promise,
				new Promise<void>((_resolve, reject) =>
					context.signal.addEventListener("abort", () => reject(abortError()), { once: true }),
				),
			]);
		};
		const orphanRequest = promptRequest("orphan-request", "orphan-execution");
		const orphanResponse = firstHost.handle(orphanRequest);
		await Promise.resolve();
		await Promise.resolve();
		const activeState = firstHost.exportState();
		expect(activeState.sessions[0]?.snapshot.activeExecutions).toHaveLength(1);
		const restoredStreams: RuntimeStreamEnvelope[] = [];
		const thirdFactory = new TestSessionFactory();
		const thirdHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: thirdFactory,
			emit: (envelope) => restoredStreams.push(envelope),
		});
		await thirdHost.restoreState(activeState);
		expect(
			restoredStreams.some(
				(envelope) =>
					envelope.streamType === "execution" &&
					envelope.execution.executionId === "orphan-execution" &&
					envelope.execution.status === "cancelled",
			),
		).toBe(true);
		const restoredSnapshot = thirdHost.exportState().sessions[0]?.snapshot;
		expect(restoredSnapshot?.activeExecutions).toHaveLength(0);
		expect(restoredSnapshot?.isStreaming).toBe(false);
		expect(errorCode(await thirdHost.handle(orphanRequest))).toBe("RUNTIME_RESTORED");
		await firstHost.dispose();
		expect(errorCode(await orphanResponse)).toBe("ABORTED");
	});

	it("rejects non-wire delegate results and malformed persisted session state", async () => {
		const factory = new TestSessionFactory();
		const streams: RuntimeStreamEnvelope[] = [];
		let pageCalls = 0;
		const host = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: factory,
			emit: (envelope) => streams.push(envelope),
			pageOperations: {
				async execute(): Promise<RuntimeValue> {
					pageCalls++;
					return Number.NaN;
				},
			},
		});
		await host.handle(createRequest());
		const response = await host.handle(
			request(
				{ type: "page-operation", executionId: "nan-execution", operation: "measure", params: {} },
				{ requestId: "nan-request" },
			),
		);
		expect(errorCode(response)).toBe("NON_SERIALIZABLE_RESULT");
		expect(isRuntimeResponseEnvelope(response)).toBe(true);
		expect(pageCalls).toBe(1);
		expect(
			streams.some(
				(envelope) =>
					envelope.streamType === "execution" &&
					envelope.execution.executionId === "nan-execution" &&
					envelope.execution.status === "failed",
			),
		).toBe(true);
		const malformedRequest = request(
			{
				type: "page-operation",
				executionId: "malformed-execution",
				operation: "measure",
				params: { value: Number.NaN },
			},
			{ requestId: "malformed-request" },
		);
		const malformedResponse = await host.handle(malformedRequest);
		expect(errorCode(malformedResponse)).toBe("MALFORMED_REQUEST");
		expect(isRuntimeResponseEnvelope(malformedResponse)).toBe(true);
		expect(pageCalls).toBe(1);
		let rejectedMalformed: Promise<RuntimeResponseEnvelope> | undefined;
		expect(() => {
			rejectedMalformed = host.handle({} as unknown as RuntimeRequestEnvelope);
		}).not.toThrow();
		if (!rejectedMalformed) throw new Error("malformed call did not return a promise");
		await expect(rejectedMalformed).rejects.toMatchObject({ code: "MALFORMED_REQUEST" });
		expect(pageCalls).toBe(1);

		const adapter = factory.created[0];
		if (!adapter) throw new Error("missing adapter");
		class ConcreteMessage {
			role = "assistant";
			content = "not plain";
		}
		adapter.state = {
			...adapter.state,
			messages: [new ConcreteMessage() as unknown as RuntimeAgentMessage],
		};
		expect(() => host.exportState()).toThrow("Session messages is not plain runtime data");
		adapter.state = {
			...adapter.state,
			messages: [],
			model: { provider: "openai", id: "bad-model", contextWindow: Number.NaN },
		};
		expect(() => host.exportState()).toThrow("Session model is not plain runtime data");
		adapter.state = {
			...adapter.state,
			model: { provider: "openai", id: "valid-model" },
			thinkingLevel: "bogus" as unknown as OffscreenRuntimeSessionState["thinkingLevel"],
		};
		expect(() => host.exportState()).toThrow("Session snapshot violates the runtime protocol");
	});

	it("uses collision-free scope keys and owns request, response, stream, and hello data", async () => {
		const factory = new TestSessionFactory();
		const host = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: factory,
			emit: (envelope) => {
				if (envelope.streamType !== "hello" && envelope.target.kind === "chrome-tab") envelope.target.tabId = 999;
				if (envelope.streamType === "execution" && envelope.execution.status === "running") {
					envelope.execution.status = "failed";
				}
			},
		});
		const firstScope = createRequest({
			clientId: "a",
			windowId: 1,
			sessionId: "b\u00002\u0000c",
			requestId: "same",
		});
		const secondScope = createRequest({
			clientId: "a\u00001\u0000b",
			windowId: 2,
			sessionId: "c",
			requestId: "same",
		});
		expect((await host.handle(firstScope)).ok).toBe(true);
		expect((await host.handle(secondScope)).ok).toBe(true);
		expect(factory.created).toHaveLength(2);
		expect(host.exportState().sessions.map((session) => session.target)).toEqual([target, target]);

		let capturedSystemPrompt = "";
		let capturedTarget: RuntimeTargetIdentity | undefined;
		const aliasAdapter = new TestSessionAdapter();
		const aliasFactory: OffscreenRuntimeSessionFactory = {
			async create(input) {
				capturedSystemPrompt = input.systemPrompt;
				capturedTarget = input.target;
				if (input.target.kind === "chrome-tab") input.target.tabId = 1234;
				return aliasAdapter;
			},
			async load() {
				throw new Error("not used");
			},
		};
		const aliasHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: aliasFactory,
			emit: (envelope) => {
				if (envelope.streamType !== "hello" && envelope.target.kind === "chrome-tab") envelope.target.tabId = 777;
				if (envelope.streamType === "execution") envelope.execution.requestId = "external-mutation";
			},
		});
		const mutableRequest = createRequest({ target: structuredClone(target) });
		const pending = aliasHost.handle(mutableRequest);
		if (mutableRequest.operation.type !== "create") throw new Error("expected create");
		mutableRequest.operation.systemPrompt = "caller mutation";
		if (mutableRequest.target.kind === "chrome-tab") mutableRequest.target.tabId = 404;
		const firstResponse = await pending;
		expect(capturedSystemPrompt).toBe("Be precise.");
		expect(capturedTarget).toEqual({ kind: "chrome-tab", tabId: 1234, frameId: 0 });
		expect(firstResponse.target).toEqual(target);
		firstResponse.requestId = "mutated-response";
		const replay = await aliasHost.handle(createRequest());
		expect(replay.requestId).toBe("request-create");
		expect(aliasHost.exportState().requests[0]?.response?.requestId).toBe("request-create");
		const helloEnvelope = aliasHost.emitHello("client-1", 1);
		if (helloEnvelope.streamType !== "hello") throw new Error("expected hello");
		const cursorTarget = helloEnvelope.recovery.sessions[0]?.target;
		if (cursorTarget?.kind === "chrome-tab") cursorTarget.tabId = 88;
		const update = await aliasHost.handle(
			request({ type: "set-thinking", thinkingLevel: "high" }, { requestId: "after-hello-mutation" }),
		);
		expect(update.ok).toBe(true);
		aliasAdapter.promptImplementation = async (_message, context) => {
			await new Promise<void>((_resolve, reject) =>
				context.signal.addEventListener("abort", () => reject(abortError()), { once: true }),
			);
		};
		const prompt = promptRequest("alias-prompt", "alias-execution");
		const prompting = aliasHost.handle(prompt);
		await flushMicrotasks();
		const abort = await aliasHost.handle(
			request(
				{ type: "abort", executionId: "alias-execution", targetRequestId: "alias-prompt" },
				{ requestId: "alias-abort" },
			),
		);
		expect(abort.ok).toBe(true);
		expect(errorCode(await prompting)).toBe("ABORTED");
	});

	it("serializes revision CAS and ignores malformed adapter events without advancing sequence", async () => {
		const factory = new TestSessionFactory();
		const streams: RuntimeStreamEnvelope[] = [];
		const host = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: factory,
			emit: (envelope) => streams.push(envelope),
		});
		await host.handle(createRequest());
		const adapter = factory.created[0];
		if (!adapter) throw new Error("missing adapter");
		const beforeInvalid = host.exportState().sessions[0];
		adapter.emit({ type: "bogus" } as unknown as RuntimeAgentEvent);
		await flushMicrotasks();
		const afterInvalid = host.exportState().sessions[0];
		expect(afterInvalid?.revision).toBe(beforeInvalid?.revision);
		expect(afterInvalid?.eventSeq).toBe(beforeInvalid?.eventSeq);
		adapter.emit({ type: "agent_start" });
		await flushMicrotasks();
		const afterValid = host.exportState().sessions[0];
		expect(afterValid?.revision).toBe((beforeInvalid?.revision ?? 0) + 1);
		expect(afterValid?.eventSeq).toBe((beforeInvalid?.eventSeq ?? 0) + 1);

		const replaceDone = deferred<void>();
		adapter.replaceImplementation = async () => replaceDone.promise;
		const expectedRevision = afterValid?.revision ?? 0;
		const first = host.handle(
			request(
				{
					type: "replace-or-append-message",
					message: { role: "assistant", content: "first" },
					expectedRevision,
				},
				{ requestId: "replace-first" },
			),
		);
		const second = host.handle(
			request(
				{
					type: "replace-or-append-message",
					message: { role: "assistant", content: "second" },
					expectedRevision,
				},
				{ requestId: "replace-second" },
			),
		);
		await flushMicrotasks();
		expect(adapter.replaceCalls).toHaveLength(1);
		replaceDone.resolve();
		expect((await first).ok).toBe(true);
		expect(errorCode(await second)).toBe("REVISION_CONFLICT");
		expect(adapter.replaceCalls).toHaveLength(1);
		expect(streams.filter((envelope) => envelope.streamType === "agent-event")).toHaveLength(1);
	});

	it("waits for an existing session mutation before loading its snapshot", async () => {
		const factory = new TestSessionFactory();
		const streams: RuntimeStreamEnvelope[] = [];
		const host = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: factory,
			emit: (envelope) => streams.push(envelope),
		});
		await host.handle(createRequest());
		const adapter = factory.created[0];
		if (!adapter) throw new Error("missing adapter");
		const modelDone = deferred<void>();
		adapter.setModel = async (model) => {
			adapter.state = { ...adapter.state, model };
			await modelDone.promise;
		};
		const settingModel = host.handle(
			request({ type: "set-model", model: { provider: "openai", id: "new-model" } }, { requestId: "slow-model" }),
		);
		await flushMicrotasks();
		expect(() => host.exportState()).toThrow("while a session mutation is pending");
		let loadSettled = false;
		const loading = host.handle(request({ type: "load" }, { requestId: "load-during-model" })).then((response) => {
			loadSettled = true;
			return response;
		});
		await flushMicrotasks();
		expect(loadSettled).toBe(false);
		expect(
			streams.some(
				(envelope) =>
					envelope.streamType === "session-snapshot" &&
					envelope.revision === 1 &&
					envelope.snapshot.model?.id === "new-model",
			),
		).toBe(false);
		modelDone.resolve();
		expect((await settingModel).ok).toBe(true);
		expect((await loading).ok).toBe(true);
		const postMutationSnapshots = streams.filter(
			(envelope) => envelope.streamType === "session-snapshot" && envelope.snapshot.model?.id === "new-model",
		);
		expect(postMutationSnapshots).toHaveLength(2);
		expect(
			postMutationSnapshots.every(
				(envelope) => envelope.streamType === "session-snapshot" && envelope.revision === 2,
			),
		).toBe(true);
		expect(host.exportState().sessions[0]?.snapshot.model?.id).toBe("new-model");
	});

	it("honors queued exact cancellation before session and busy preflight", async () => {
		const emptyFactory = new TestSessionFactory();
		const emptyHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: emptyFactory,
			emit: () => {},
		});
		const missing = promptRequest("missing-request", "missing-execution");
		const missingResponse = emptyHost.handle(missing);
		const missingAbort = emptyHost.handle(
			request(
				{ type: "abort", executionId: "missing-execution", targetRequestId: "missing-request" },
				{ requestId: "abort-missing" },
			),
		);
		expect((await missingAbort).ok).toBe(true);
		expect(errorCode(await missingResponse)).toBe("ABORTED");

		const factory = new TestSessionFactory();
		const streams: RuntimeStreamEnvelope[] = [];
		const host = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: factory,
			emit: (envelope) => streams.push(envelope),
		});
		await host.handle(createRequest());
		const adapter = factory.created[0];
		if (!adapter) throw new Error("missing adapter");
		const activeDone = deferred<void>();
		adapter.promptImplementation = async () => activeDone.promise;
		const active = host.handle(promptRequest("active-request", "active-execution"));
		await flushMicrotasks();
		const queued = host.handle(promptRequest("queued-request-2", "queued-execution-2"));
		const queuedAbort = host.handle(
			request(
				{ type: "abort", executionId: "queued-execution-2", targetRequestId: "queued-request-2" },
				{ requestId: "abort-queued-2" },
			),
		);
		expect((await queuedAbort).ok).toBe(true);
		expect(errorCode(await queued)).toBe("ABORTED");
		expect(adapter.promptCalls).toHaveLength(1);
		expect(
			streams.some(
				(envelope) =>
					envelope.streamType === "execution" &&
					envelope.execution.executionId === "queued-execution-2" &&
					envelope.execution.status === "cancelled",
			),
		).toBe(true);
		activeDone.resolve();
		expect((await active).ok).toBe(true);
	});

	it("prevalidates restore atomically, rejects correlated-history damage, and excludes concurrent work", async () => {
		const sourceFactory = new TestSessionFactory();
		const sourceHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: sourceFactory,
			emit: () => {},
		});
		await sourceHost.handle(createRequest());
		await sourceHost.handle(
			createRequest({ sessionId: "session-2", requestId: "create-session-2", target: { kind: "chrome-tab", tabId: 8 } }),
		);
		const goodState = sourceHost.exportState();

		const validationFactory = new TestSessionFactory();
		const validationHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: validationFactory,
			emit: () => {},
		});
		const invalidThinking = structuredClone(goodState);
		const invalidSession = invalidThinking.sessions[1];
		if (!invalidSession) throw new Error("missing second session");
		invalidSession.snapshot.thinkingLevel = "bogus" as unknown as OffscreenRuntimeSessionState["thinkingLevel"];
		await expect(validationHost.restoreState(invalidThinking)).rejects.toThrow();
		expect(validationFactory.restored).toHaveLength(0);
		const invalidSequence = structuredClone(goodState);
		if (!invalidSequence.sessions[0]) throw new Error("missing first session");
		invalidSequence.sessions[0].eventSeq = -1;
		await expect(validationHost.restoreState(invalidSequence)).rejects.toThrow();
		expect(validationFactory.restored).toHaveLength(0);
		const invalidRevision = structuredClone(goodState);
		if (!invalidRevision.sessions[0]) throw new Error("missing first session");
		invalidRevision.sessions[0].revision++;
		await expect(validationHost.restoreState(invalidRevision)).rejects.toThrow();
		expect(validationFactory.restored).toHaveLength(0);
		await validationHost.restoreState(goodState);
		expect(validationFactory.restored).toHaveLength(2);

		const activeSourceFactory = new TestSessionFactory();
		const activeSource = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: activeSourceFactory,
			emit: () => {},
		});
		await activeSource.handle(createRequest());
		const activeSourceAdapter = activeSourceFactory.created[0];
		if (!activeSourceAdapter) throw new Error("missing active source adapter");
		const activeDone = deferred<void>();
		activeSourceAdapter.promptImplementation = async () => activeDone.promise;
		const activePrompt = activeSource.handle(promptRequest("checkpoint-prompt", "checkpoint-execution"));
		await flushMicrotasks();
		const ownerlessState = activeSource.exportState();
		ownerlessState.requests = ownerlessState.requests.filter(
			(record) => record.request.requestId !== "checkpoint-prompt",
		);
		const ownerlessFactory = new TestSessionFactory();
		const ownerlessHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: ownerlessFactory,
			emit: () => {},
		});
		await expect(ownerlessHost.restoreState(ownerlessState)).rejects.toThrow("no unfinished request owner");
		expect(ownerlessFactory.restored).toHaveLength(0);
		const duplicateActiveState = activeSource.exportState();
		const activeExecutions = duplicateActiveState.sessions[0]?.snapshot.activeExecutions;
		if (!activeExecutions?.[0]) throw new Error("missing active execution");
		activeExecutions.push(structuredClone(activeExecutions[0]));
		const duplicateFactory = new TestSessionFactory();
		const duplicateHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: duplicateFactory,
			emit: () => {},
		});
		await expect(duplicateHost.restoreState(duplicateActiveState)).rejects.toThrow("identity is duplicated");
		expect(duplicateFactory.restored).toHaveLength(0);
		activeDone.resolve();
		await activePrompt;

		const correlationFactory = new TestSessionFactory();
		const correlationHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: correlationFactory,
			emit: () => {},
		});
		const damagedHistory = structuredClone(goodState);
		const damagedResponse = damagedHistory.requests[0]?.response;
		if (!damagedResponse) throw new Error("missing persisted response");
		damagedResponse.requestId = "wrong-request";
		await expect(correlationHost.restoreState(damagedHistory)).rejects.toThrow("not correlated");
		expect(correlationFactory.restored).toHaveLength(0);
		await correlationHost.restoreState(goodState);
		const persistedRequest = goodState.requests[0]?.request;
		if (!persistedRequest) throw new Error("missing persisted request");
		const replay = await correlationHost.handle(persistedRequest);
		expect(replay.requestId).toBe(persistedRequest.requestId);

		const replacementFactory: OffscreenRuntimeSessionFactory = {
			async create() {
				throw new Error("not used");
			},
			async load() {
				throw new Error("pre-restore load failed");
			},
			async restore() {
				return new TestSessionAdapter();
			},
		};
		const replacementHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: replacementFactory,
			emit: () => {},
		});
		expect(errorCode(await replacementHost.handle(request({ type: "load" }, { requestId: "stale-local-failure" })))).toBe(
			"RUNTIME_OPERATION_FAILED",
		);
		await replacementHost.restoreState(goodState);
		expect(replacementHost.exportState().requests.some((record) => record.request.requestId === "stale-local-failure")).toBe(
			false,
		);

		let rollbackLoadCalls = 0;
		let rollbackRestoreCalls = 0;
		const rollbackFactory: OffscreenRuntimeSessionFactory = {
			async create() {
				throw new Error("not used");
			},
			async load() {
				rollbackLoadCalls++;
				throw new Error("prior local failure");
			},
			async restore() {
				rollbackRestoreCalls++;
				if (rollbackRestoreCalls === 2) throw new Error("second restore failed");
				return new TestSessionAdapter();
			},
		};
		const rollbackHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: rollbackFactory,
			emit: () => {},
		});
		const priorFailureRequest = request({ type: "load" }, { requestId: "prior-failure" });
		const priorFailureResponse = await rollbackHost.handle(priorFailureRequest);
		await expect(rollbackHost.restoreState(goodState)).rejects.toThrow("second restore failed");
		expect(await rollbackHost.handle(priorFailureRequest)).toEqual(priorFailureResponse);
		expect(rollbackLoadCalls).toBe(1);
		expect(rollbackHost.exportState().requests.map((record) => record.request.requestId)).toEqual(["prior-failure"]);

		const restoreGate = deferred<void>();
		let restoreCalls = 0;
		const gatedFactory: OffscreenRuntimeSessionFactory = {
			async create() {
				throw new Error("not used");
			},
			async load() {
				throw new Error("not used");
			},
			async restore() {
				restoreCalls++;
				if (restoreCalls === 1) await restoreGate.promise;
				return new TestSessionAdapter();
			},
		};
		const gatedHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: gatedFactory,
			emit: () => {},
		});
		const restoring = gatedHost.restoreState(goodState);
		await flushMicrotasks();
		await expect(gatedHost.restoreState(goodState)).rejects.toThrow("already in progress");
		expect(() => gatedHost.exportState()).toThrow("while restoration is in progress");
		expect(() => gatedHost.emitHello("client-1", 1)).toThrow("while state is restoring");
		expect(errorCode(await gatedHost.handle(request({ type: "load" }, { requestId: "during-restore" })))).toBe(
			"HOST_RESTORING",
		);
		restoreGate.resolve();
		await restoring;
		expect(gatedHost.exportState().sessions).toHaveLength(2);
	});

	it("does not publish adapter events from an uncommitted restore and snapshots committed mid-restore changes", async () => {
		const sourceFactory = new TestSessionFactory();
		const sourceHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: sourceFactory,
			emit: () => {},
		});
		await sourceHost.handle(createRequest());
		await sourceHost.handle(
			createRequest({ sessionId: "session-2", requestId: "create-session-2", target: { kind: "chrome-tab", tabId: 8 } }),
		);
		const persisted = sourceHost.exportState();

		const failedGate = deferred<void>();
		const failedAdapters: TestSessionAdapter[] = [];
		let failedCalls = 0;
		const failedFactory: OffscreenRuntimeSessionFactory = {
			async create() {
				throw new Error("not used");
			},
			async load() {
				throw new Error("not used");
			},
			async restore() {
				failedCalls++;
				if (failedCalls === 2) {
					await failedGate.promise;
					throw new Error("second restore failed");
				}
				const adapter = new TestSessionAdapter();
				failedAdapters.push(adapter);
				return adapter;
			},
		};
		const failedStreams: RuntimeStreamEnvelope[] = [];
		const failedHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: failedFactory,
			emit: (envelope) => failedStreams.push(envelope),
		});
		const failedRestore = failedHost.restoreState(persisted);
		await flushMicrotasks();
		expect(failedCalls).toBe(2);
		failedAdapters[0]?.emit({ type: "agent_start" });
		await flushMicrotasks();
		expect(failedStreams).toEqual([]);
		failedGate.resolve();
		await expect(failedRestore).rejects.toThrow("second restore failed");
		expect(failedStreams).toEqual([]);

		const committedGate = deferred<void>();
		const committedAdapters: TestSessionAdapter[] = [];
		let committedCalls = 0;
		const committedFactory: OffscreenRuntimeSessionFactory = {
			async create() {
				throw new Error("not used");
			},
			async load() {
				throw new Error("not used");
			},
			async restore() {
				committedCalls++;
				if (committedCalls === 2) await committedGate.promise;
				const adapter = new TestSessionAdapter();
				committedAdapters.push(adapter);
				return adapter;
			},
		};
		const committedStreams: RuntimeStreamEnvelope[] = [];
		const committedHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: committedFactory,
			emit: (envelope) => committedStreams.push(envelope),
		});
		const committedRestore = committedHost.restoreState(persisted);
		await flushMicrotasks();
		expect(committedCalls).toBe(2);
		const firstCommittedAdapter = committedAdapters[0];
		if (!firstCommittedAdapter) throw new Error("missing first committed adapter");
		firstCommittedAdapter.state = {
			...firstCommittedAdapter.state,
			messages: [{ role: "assistant", content: "changed during restore" }],
		};
		firstCommittedAdapter.emit({ type: "agent_start" });
		await flushMicrotasks();
		expect(committedStreams).toEqual([]);
		committedGate.resolve();
		await committedRestore;
		expect(committedStreams).toHaveLength(1);
		const committedSnapshot = committedStreams[0];
		expect(committedSnapshot?.streamType).toBe("session-snapshot");
		if (committedSnapshot?.streamType !== "session-snapshot") throw new Error("missing committed snapshot");
		expect(committedSnapshot.sessionId).toBe("session-1");
		expect(committedSnapshot.revision).toBe(2);
		expect(committedSnapshot.snapshot.messages).toEqual([
			{ role: "assistant", content: "changed during restore" },
		]);
	});

	it("captures restore changes announced synchronously while subscribing to the adapter", async () => {
		const sourceFactory = new TestSessionFactory();
		const sourceHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: sourceFactory,
			emit: () => {},
		});
		await sourceHost.handle(createRequest());
		const persisted = sourceHost.exportState();

		class SynchronousRestoreAdapter extends TestSessionAdapter {
			override subscribe(listener: (event: RuntimeAgentEvent) => void): () => void {
				const unsubscribe = super.subscribe(listener);
				this.state = {
					...this.state,
					messages: [{ role: "assistant", content: "synchronous restore change" }],
				};
				listener({ type: "agent_start" });
				return unsubscribe;
			}
		}

		const factory: OffscreenRuntimeSessionFactory = {
			async create() {
				throw new Error("not used");
			},
			async load() {
				throw new Error("not used");
			},
			async restore() {
				return new SynchronousRestoreAdapter();
			},
		};
		const streams: RuntimeStreamEnvelope[] = [];
		const host = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: factory,
			emit: (envelope) => streams.push(envelope),
		});
		await host.restoreState(persisted);
		expect(streams).toHaveLength(1);
		const restoredSnapshot = streams[0];
		expect(restoredSnapshot?.streamType).toBe("session-snapshot");
		if (restoredSnapshot?.streamType !== "session-snapshot") throw new Error("missing restored snapshot");
		expect(restoredSnapshot.revision).toBe(2);
		expect(restoredSnapshot.snapshot.messages).toEqual([
			{ role: "assistant", content: "synchronous restore change" },
		]);
		expect(host.exportState().sessions[0]?.revision).toBe(2);
	});

	it("normalizes adapter and factory abort rejections when disposal cancels their operations", async () => {
		const modelFactory = new TestSessionFactory();
		const modelHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: modelFactory,
			emit: () => {},
		});
		await modelHost.handle(createRequest());
		const modelAdapter = modelFactory.created[0];
		if (!modelAdapter) throw new Error("missing model adapter");
		modelAdapter.setModelImplementation = (signal) => rejectWhenAborted(signal, "adapter aborted");
		const modelUpdate = modelHost.handle(
			request({ type: "set-model", model: { provider: "openai", id: "cancelled-model" } }, { requestId: "abort-model" }),
		);
		await flushMicrotasks();
		const modelDisposal = modelHost.dispose();
		expect(errorCode(await modelUpdate)).toBe("ABORTED");
		await modelDisposal;

		const createFactory: OffscreenRuntimeSessionFactory = {
			async create(input) {
				return rejectWhenAborted(input.signal, "create factory aborted");
			},
			async load() {
				throw new Error("not used");
			},
		};
		const createHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: createFactory,
			emit: () => {},
		});
		const creating = createHost.handle(createRequest({ requestId: "abort-create" }));
		await flushMicrotasks();
		const createDisposal = createHost.dispose();
		expect(errorCode(await creating)).toBe("ABORTED");
		await createDisposal;

		const loadFactory: OffscreenRuntimeSessionFactory = {
			async create() {
				throw new Error("not used");
			},
			async load(input) {
				return rejectWhenAborted(input.signal, "load factory aborted");
			},
		};
		const loadHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: loadFactory,
			emit: () => {},
		});
		const loading = loadHost.handle(request({ type: "load" }, { requestId: "abort-load" }));
		await flushMicrotasks();
		const loadDisposal = loadHost.dispose();
		expect(errorCode(await loading)).toBe("ABORTED");
		await loadDisposal;
	});

	it("shares disposal completion and rejects operations that finish after shutdown", async () => {
		const factory = new TestSessionFactory();
		const host = new OffscreenRuntimeHost({ runtimeEpoch: "epoch-1", sessionFactory: factory, emit: () => {} });
		await host.handle(createRequest());
		const adapter = factory.created[0];
		if (!adapter) throw new Error("missing adapter");
		const modelDone = deferred<void>();
		adapter.setModelImplementation = async () => modelDone.promise;
		const settingModel = host.handle(
			request({ type: "set-model", model: { provider: "openai", id: "late" } }, { requestId: "late-model" }),
		);
		await flushMicrotasks();
		const disposalDone = deferred<void>();
		adapter.disposeImplementation = async () => disposalDone.promise;
		const firstDispose = host.dispose();
		let secondFinished = false;
		const secondDispose = host.dispose().then(() => {
			secondFinished = true;
		});
		await flushMicrotasks();
		expect(secondFinished).toBe(false);
		modelDone.resolve();
		expect(["ABORTED", "HOST_DISPOSED"]).toContain(errorCode(await settingModel));
		disposalDone.resolve();
		await Promise.all([firstDispose, secondDispose]);
		expect(adapter.disposeCount).toBe(1);

		const raceFactory = new TestSessionFactory();
		const raceHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: raceFactory,
			emit: () => {},
		});
		await raceHost.handle(createRequest());
		const racedPrompt = raceHost.handle(promptRequest("dispose-race-request", "dispose-race-execution"));
		const racedDisposal = raceHost.dispose();
		expect(["ABORTED", "HOST_DISPOSED"]).toContain(errorCode(await racedPrompt));
		await racedDisposal;

		const abortFactory = new TestSessionFactory();
		const abortHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: abortFactory,
			emit: () => {},
		});
		await abortHost.handle(createRequest());
		const abortAdapter = abortFactory.created[0];
		if (!abortAdapter) throw new Error("missing abort adapter");
		const promptDone = deferred<void>();
		abortAdapter.promptImplementation = async () => promptDone.promise;
		const activePrompt = abortHost.handle(promptRequest("dispose-abort-request", "dispose-abort-execution"));
		await flushMicrotasks();
		const exactAbort = abortHost.handle(
			request(
				{
					type: "abort",
					executionId: "dispose-abort-execution",
					targetRequestId: "dispose-abort-request",
				},
				{ requestId: "dispose-exact-abort" },
			),
		);
		const abortDisposal = abortHost.dispose();
		promptDone.resolve();
		expect(errorCode(await activePrompt)).toBe("ABORTED");
		const exactAbortResponse = await exactAbort;
		expect(exactAbortResponse.ok || errorCode(exactAbortResponse) === "HOST_DISPOSED").toBe(true);
		await abortDisposal;
	});

	it("keeps existing sessions after failed load snapshots and ignores callbacks from removed sessions", async () => {
		const factory = new TestSessionFactory();
		const host = new OffscreenRuntimeHost({ runtimeEpoch: "epoch-1", sessionFactory: factory, emit: () => {} });
		const create = createRequest();
		expect((await host.handle(create)).ok).toBe(true);
		const adapter = factory.created[0];
		if (!adapter) throw new Error("missing adapter");
		adapter.state = {
			...adapter.state,
			thinkingLevel: "bogus" as unknown as OffscreenRuntimeSessionState["thinkingLevel"],
		};
		expect(errorCode(await host.handle(request({ type: "load" }, { requestId: "bad-existing-load" })))).toBe(
			"INVALID_SESSION_STATE",
		);
		adapter.state = { ...adapter.state, thinkingLevel: "medium" };
		expect((await host.handle(create)).ok).toBe(true);
		expect(
			(
				await host.handle(
					request({ type: "set-thinking", thinkingLevel: "high" }, { requestId: "after-load-failure" }),
				)
			).ok,
		).toBe(true);
		expect(adapter.disposeCount).toBe(0);

		const ghostAdapter = new TestSessionAdapter();
		let emitted = 0;
		const ghostFactory: OffscreenRuntimeSessionFactory = {
			async create() {
				return ghostAdapter;
			},
			async load() {
				throw new Error("not used");
			},
		};
		const ghostHost = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: ghostFactory,
			emit: () => {
				emitted++;
				throw new Error("transport unavailable");
			},
		});
		expect(errorCode(await ghostHost.handle(createRequest()))).toBe("RUNTIME_OPERATION_FAILED");
		const emittedAfterRemoval = emitted;
		ghostAdapter.lastSubscribedListener?.({ type: "agent_start" });
		await flushMicrotasks();
		expect(emitted).toBe(emittedAfterRemoval);
		expect(ghostHost.exportState().sessions).toHaveLength(0);
	});

	it("marks terminal ownership before reentrant abort callbacks", async () => {
		const factory = new TestSessionFactory();
		let host: OffscreenRuntimeHost;
		let reentrantAbort: Promise<RuntimeResponseEnvelope> | undefined;
		host = new OffscreenRuntimeHost({
			runtimeEpoch: "epoch-1",
			sessionFactory: factory,
			emit: (envelope) => {
				if (envelope.streamType === "execution" && envelope.execution.status === "succeeded") {
					reentrantAbort = host.handle(
						request(
							{
								type: "abort",
								executionId: envelope.execution.executionId,
								targetRequestId: envelope.execution.requestId,
							},
							{ requestId: "reentrant-terminal-abort" },
						),
					);
				}
			},
		});
		await host.handle(createRequest());
		expect((await host.handle(promptRequest())).ok).toBe(true);
		if (!reentrantAbort) throw new Error("missing reentrant abort");
		const abortResponse = await reentrantAbort;
		expect(abortResponse.ok ? abortResponse.result : undefined).toEqual({ status: "already-terminal" });
	});
});
