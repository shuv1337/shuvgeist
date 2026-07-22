import { describe, expect, it, vi } from "vitest";
import type {
	AgentRuntimeConnectionDescriptor,
	AgentRuntimePortRequest,
} from "@shuvgeist/extension/bridge/internal-messages";
import {
	agentRuntimePortName,
	ChromeRuntimeSessionTransport as ProductionChromeRuntimeSessionTransport,
	ChromeRuntimeSessionTransportError,
	parseAgentRuntimePortName,
	type ChromeRuntimePortFactory,
	type ChromeRuntimePortLike,
	type ChromeRuntimeSessionTransportOptions,
} from "@shuvgeist/extension/agent/chrome-runtime-session-transport";
import {
	RUNTIME_PROTOCOL_VERSION,
	type RuntimeHelloEnvelope,
	type RuntimeRequestEnvelope,
	type RuntimeResponseEnvelope,
	type RuntimeStreamEnvelope,
	type RuntimeTargetIdentity,
	type RuntimeValue,
} from "@shuvgeist/extension/agent/runtime-protocol";

const target: RuntimeTargetIdentity = { kind: "chrome-tab", tabRef: "window:7" };
const documentNonce = "00000000-0000-4000-8000-000000000007";
const continuationToken = "a".repeat(64);
const transactionId = "00000000-0000-4000-8000-000000000017";
const leaseId = "00000000-0000-4000-8000-000000000027";
const portCapability = { continuationToken, transactionId, leaseId };

class ChromeRuntimeSessionTransport extends ProductionChromeRuntimeSessionTransport {
	constructor(
		options: Omit<
			ChromeRuntimeSessionTransportOptions,
			"documentNonce" | "continuationToken" | "transactionId" | "leaseId"
		> &
			Partial<
				Pick<
					ChromeRuntimeSessionTransportOptions,
					"documentNonce" | "continuationToken" | "transactionId" | "leaseId"
				>
			>,
	) {
		super({ documentNonce, ...portCapability, ...options });
	}
}

function descriptor(overrides: Partial<AgentRuntimeConnectionDescriptor> = {}): AgentRuntimeConnectionDescriptor {
	return {
		clientId: "sidepanel/client",
		windowId: 7,
		sessionId: "session-1",
		target,
		mode: "load",
		systemPrompt: "Be precise.",
		...overrides,
	};
}

function request(overrides: Partial<RuntimeRequestEnvelope> = {}): RuntimeRequestEnvelope {
	return {
		kind: "request",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "sidepanel/client",
		windowId: 7,
		sessionId: "session-1",
		target,
		requestId: "request-1",
		operation: { type: "load" },
		...overrides,
	};
}

function success(
	runtimeRequest: RuntimeRequestEnvelope,
	result: RuntimeValue = { loaded: true },
): RuntimeResponseEnvelope {
	return {
		kind: "response",
		protocolVersion: runtimeRequest.protocolVersion,
		runtimeEpoch: runtimeRequest.runtimeEpoch,
		clientId: runtimeRequest.clientId,
		windowId: runtimeRequest.windowId,
		sessionId: runtimeRequest.sessionId,
		target: runtimeRequest.target,
		requestId: runtimeRequest.requestId,
		operation: runtimeRequest.operation.type,
		...(runtimeRequest.trace ? { trace: runtimeRequest.trace } : {}),
		ok: true,
		result,
	};
}

function hello(overrides: Partial<RuntimeHelloEnvelope> = {}): RuntimeHelloEnvelope {
	return {
		kind: "stream",
		streamType: "hello",
		protocolVersion: RUNTIME_PROTOCOL_VERSION,
		runtimeEpoch: "epoch-1",
		clientId: "sidepanel/client",
		windowId: 7,
		recovery: {
			mode: "fresh",
			sessions: [{ sessionId: "session-1", target, revision: 0, eventSeq: 0 }],
		},
		...overrides,
	};
}

class FakePort implements ChromeRuntimePortLike {
	readonly sent: AgentRuntimePortRequest[] = [];
	disconnectCount = 0;
	private readonly messageListeners = new Set<(message: unknown) => void>();
	private readonly disconnectListeners = new Set<() => void>();
	readonly onMessage = {
		addListener: (listener: (message: unknown) => void): void => {
			this.messageListeners.add(listener);
		},
		removeListener: (listener: (message: unknown) => void): void => {
			this.messageListeners.delete(listener);
		},
	};
	readonly onDisconnect = {
		addListener: (listener: () => void): void => {
			this.disconnectListeners.add(listener);
		},
		removeListener: (listener: () => void): void => {
			this.disconnectListeners.delete(listener);
		},
	};

	constructor(
		readonly name: string,
		private readonly onPost?: (message: AgentRuntimePortRequest, port: FakePort) => void,
	) {}

	postMessage(message: AgentRuntimePortRequest): void {
		this.sent.push(structuredClone(message));
		this.onPost?.(message, this);
	}

	disconnect(): void {
		this.disconnectCount++;
	}

	emitMessage(message: unknown): void {
		for (const listener of this.messageListeners) listener(message);
	}

	emitDisconnect(): void {
		for (const listener of [...this.disconnectListeners]) listener();
	}

	get messageListenerCount(): number {
		return this.messageListeners.size;
	}

	get disconnectListenerCount(): number {
		return this.disconnectListeners.size;
	}
}

function factoryWithPorts(
	onCreate?: (port: FakePort, index: number) => void,
): { factory: ChromeRuntimePortFactory; ports: FakePort[] } {
	const ports: FakePort[] = [];
	const factory: ChromeRuntimePortFactory = ({ name }) => {
		const port = new FakePort(name, (message, currentPort) => {
			if (message.type === "agent-runtime-port-connect") onCreate?.(currentPort, ports.indexOf(currentPort));
		});
		ports.push(port);
		return port;
	};
	return { factory, ports };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function acknowledge(port: FakePort): void {
	port.emitMessage({ type: "agent-runtime-port-connected", ok: true });
}

function stream(port: FakePort, envelope: RuntimeStreamEnvelope): void {
	port.emitMessage({ type: "agent-runtime-port-stream", envelope });
}

describe("ChromeRuntimeSessionTransport", () => {
	it("uses one stable, parseable client/window port name and isolates windows", () => {
		const first = agentRuntimePortName({ clientId: "sidepanel/client", windowId: 7, documentNonce, ...portCapability });
		const second = agentRuntimePortName({ clientId: "sidepanel/client", windowId: 8, documentNonce, ...portCapability });

		expect(first).toBe(
			`agent-runtime:sidepanel%2Fclient:7:${documentNonce}:${continuationToken}:${transactionId}:${leaseId}`,
		);
		expect(parseAgentRuntimePortName(first)).toEqual({
			clientId: "sidepanel/client",
			windowId: 7,
			documentNonce,
			...portCapability,
		});
		expect(second).not.toBe(first);
		expect(
			parseAgentRuntimePortName(
				`agent-runtime:sidepanel%2fclient:7:${documentNonce}:${continuationToken}:${transactionId}:${leaseId}`,
			),
		).toBeUndefined();
		expect(
			parseAgentRuntimePortName(
				`agent-runtime:client:07:${documentNonce}:${continuationToken}:${transactionId}:${leaseId}`,
			),
		).toBeUndefined();
		expect(parseAgentRuntimePortName("agent-runtime:client:7")).toBeUndefined();
		expect(
			parseAgentRuntimePortName("agent-runtime:client:7:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
		).toBeUndefined();
	});

	it("strictly validates the connection descriptor before opening a port", () => {
		const portFactory = vi.fn<ChromeRuntimePortFactory>();

		expect(
			() =>
				new ChromeRuntimeSessionTransport({
					descriptor: descriptor({ windowId: -1 }),
					portFactory,
				}),
		).toThrowError(expect.objectContaining({ code: "INVALID_DESCRIPTOR" }));
		expect(portFactory).not.toHaveBeenCalled();
	});

	it("installs listeners before sending the descriptor and cannot lose an immediate hello", () => {
		const received: RuntimeStreamEnvelope[] = [];
		const { factory, ports } = factoryWithPorts((port) => {
			expect(port.messageListenerCount).toBe(1);
			expect(port.disconnectListenerCount).toBe(1);
			acknowledge(port);
			stream(port, hello());
		});
		const transport = new ChromeRuntimeSessionTransport({ descriptor: descriptor(), portFactory: factory });

		expect(ports).toHaveLength(0);
		transport.subscribe((envelope) => received.push(envelope));

		expect(ports).toHaveLength(1);
		expect(ports[0]?.sent).toEqual([
			{ type: "agent-runtime-port-connect", descriptor: descriptor() },
		]);
		expect(received).toEqual([hello()]);
	});

	it("waits for the handshake and correlates the exact response", async () => {
		const { factory, ports } = factoryWithPorts();
		const transport = new ChromeRuntimeSessionTransport({ descriptor: descriptor(), portFactory: factory });
		transport.subscribe(() => {});
		const runtimeRequest = request();

		const responsePromise = transport.send(runtimeRequest);
		await flushMicrotasks();
		expect(ports[0]?.sent).toHaveLength(1);

		const port = ports[0];
		expect(port).toBeDefined();
		acknowledge(port as FakePort);
		await flushMicrotasks();
		expect(port?.sent[1]).toEqual({ type: "agent-runtime-port-request", request: runtimeRequest });
		port?.emitMessage({ type: "agent-runtime-port-response", response: success(runtimeRequest) });

		await expect(responsePromise).resolves.toEqual(success(runtimeRequest));
	});

	it("never posts an operation across a descriptor rejection", async () => {
		const { factory, ports } = factoryWithPorts((port) => {
			port.emitMessage({ type: "agent-runtime-port-connected", ok: false, error: "target unavailable" });
		});
		const transport = new ChromeRuntimeSessionTransport({
			descriptor: descriptor(),
			portFactory: factory,
			reconnectDelayMs: 0,
			maxConnectRetries: 5,
		});
		transport.subscribe(() => {});

		await expect(transport.send(request())).rejects.toMatchObject({
			code: "PORT_CONNECT_REJECTED",
			retryable: false,
			requestMayHaveExecuted: false,
		});
		// Subscription and the later send are separate safe connection demands.
		// Neither rejected connection is allowed to carry the operation itself.
		expect(ports).toHaveLength(2);
		for (const port of ports) {
			expect(port.sent).toEqual([{ type: "agent-runtime-port-connect", descriptor: descriptor() }]);
		}
	});

	it("rejects invalid request data and cross-window scope before posting", async () => {
		const { factory, ports } = factoryWithPorts((port) => acknowledge(port));
		const transport = new ChromeRuntimeSessionTransport({ descriptor: descriptor(), portFactory: factory });
		transport.subscribe(() => {});
		await flushMicrotasks();

		await expect(transport.send(request({ windowId: 8 }))).rejects.toMatchObject({
			code: "REQUEST_SCOPE_MISMATCH",
		});
		await expect(
			transport.send(request({ operation: { type: "repl-execute", executionId: "", code: "1" } })),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
		expect(ports[0]?.sent).toHaveLength(1);
	});

	it("rejects a correlated response whose operation or scope differs", async () => {
		const { factory, ports } = factoryWithPorts((port) => acknowledge(port));
		const transport = new ChromeRuntimeSessionTransport({ descriptor: descriptor(), portFactory: factory });
		transport.subscribe(() => {});
		const runtimeRequest = request();
		const responsePromise = transport.send(runtimeRequest);
		await flushMicrotasks();
		const mismatched = { ...success(runtimeRequest), operation: "attach" as const };
		ports[0]?.emitMessage({ type: "agent-runtime-port-response", response: mismatched });

		await expect(responsePromise).rejects.toMatchObject({
			code: "RESPONSE_CORRELATION_FAILED",
			requestId: runtimeRequest.requestId,
			requestMayHaveExecuted: true,
		});
	});

	it("times out silent handshakes and finitely retries only before posting", async () => {
		vi.useFakeTimers();
		try {
			const { factory, ports } = factoryWithPorts();
			const transport = new ChromeRuntimeSessionTransport({
				descriptor: descriptor(),
				portFactory: factory,
				handshakeTimeoutMs: 10,
				reconnectDelayMs: 1_000,
				maxConnectRetries: 1,
			});
			transport.subscribe(() => {});
			const responsePromise = transport.send(request());
			const rejection = expect(responsePromise).rejects.toMatchObject({
				code: "PORT_HANDSHAKE_TIMEOUT",
				retryable: true,
				requestMayHaveExecuted: false,
			});

			await vi.advanceTimersByTimeAsync(10);
			expect(ports).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(10);
			await rejection;
			for (const port of ports) {
				expect(port.sent).toEqual([{ type: "agent-runtime-port-connect", descriptor: descriptor() }]);
			}
			transport.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("invalidates a malformed acknowledgement and reconnects before posting", async () => {
		const { factory, ports } = factoryWithPorts((port, index) => {
			if (index === 0) {
				port.emitMessage({ type: "agent-runtime-port-connected", ok: "yes" });
			} else {
				acknowledge(port);
			}
		});
		const transport = new ChromeRuntimeSessionTransport({ descriptor: descriptor(), portFactory: factory });
		const runtimeRequest = request();
		const responsePromise = transport.send(runtimeRequest);
		await flushMicrotasks();

		expect(ports).toHaveLength(2);
		expect(ports[0]?.sent).toEqual([{ type: "agent-runtime-port-connect", descriptor: descriptor() }]);
		expect(ports[1]?.sent).toEqual([
			{ type: "agent-runtime-port-connect", descriptor: descriptor() },
			{ type: "agent-runtime-port-request", request: runtimeRequest },
		]);
		ports[1]?.emitMessage({ type: "agent-runtime-port-response", response: success(runtimeRequest) });
		await expect(responsePromise).resolves.toEqual(success(runtimeRequest));
	});

	it("rejects a malformed correlated reply instead of leaving the request pending", async () => {
		const errors: ChromeRuntimeSessionTransportError[] = [];
		const { factory, ports } = factoryWithPorts((port) => acknowledge(port));
		const transport = new ChromeRuntimeSessionTransport({
			descriptor: descriptor(),
			portFactory: factory,
			onError: (error) => errors.push(error),
		});
		transport.subscribe(() => {});
		const responsePromise = transport.send(request());
		await flushMicrotasks();

		ports[0]?.emitMessage({
			type: "agent-runtime-port-response",
			response: { kind: "response", requestId: "request-1", protocolVersion: 999 },
		});

		await expect(responsePromise).rejects.toMatchObject({
			code: "MALFORMED_PORT_MESSAGE",
			requestId: "request-1",
			requestMayHaveExecuted: true,
		});
		expect(errors).toHaveLength(1);
	});

	it("drops malformed and out-of-scope streams without notifying subscribers", () => {
		const errors: ChromeRuntimeSessionTransportError[] = [];
		const received: RuntimeStreamEnvelope[] = [];
		const { factory, ports } = factoryWithPorts((port) => acknowledge(port));
		const transport = new ChromeRuntimeSessionTransport({
			descriptor: descriptor(),
			portFactory: factory,
			onError: (error) => errors.push(error),
		});
		transport.subscribe((envelope) => received.push(envelope));

		ports[0]?.emitMessage({ type: "agent-runtime-port-stream", envelope: hello(), extra: true });
		stream(ports[0] as FakePort, hello({ windowId: 8 }));

		expect(received).toEqual([]);
		expect(errors.map((error) => error.code)).toEqual([
			"MALFORMED_PORT_MESSAGE",
			"MALFORMED_PORT_MESSAGE",
		]);
	});

	it("reconnects with the descriptor but never replays an in-flight request", async () => {
		vi.useFakeTimers();
		try {
			const { factory, ports } = factoryWithPorts((port) => acknowledge(port));
			const transport = new ChromeRuntimeSessionTransport({
				descriptor: descriptor(),
				portFactory: factory,
				reconnectDelayMs: 1,
			});
			transport.subscribe(() => {});
			const firstRequest = request();
			const firstResponse = transport.send(firstRequest);
			await flushMicrotasks();
			expect(ports[0]?.sent).toContainEqual({ type: "agent-runtime-port-request", request: firstRequest });

			ports[0]?.emitDisconnect();
			await expect(firstResponse).rejects.toMatchObject({
				code: "PORT_DISCONNECTED_IN_FLIGHT",
				requestMayHaveExecuted: true,
				requestId: "request-1",
			});
			await vi.runAllTimersAsync();

			expect(ports).toHaveLength(2);
			expect(ports[1]?.sent).toEqual([
				{ type: "agent-runtime-port-connect", descriptor: descriptor() },
			]);
			expect(ports[1]?.sent).not.toContainEqual({
				type: "agent-runtime-port-request",
				request: firstRequest,
			});

			const secondRequest = request({ requestId: "request-2" });
			const secondResponse = transport.send(secondRequest);
			await flushMicrotasks();
			ports[1]?.emitMessage({ type: "agent-runtime-port-response", response: success(secondRequest) });
			await expect(secondResponse).resolves.toEqual(success(secondRequest));
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops automatic reconnect after the background rejects a superseded descriptor", async () => {
		vi.useFakeTimers();
		try {
			const errors: ChromeRuntimeSessionTransportError[] = [];
			const { factory, ports } = factoryWithPorts((port, index) => {
				if (index === 0) acknowledge(port);
				else {
					port.emitMessage({
						type: "agent-runtime-port-connected",
						ok: false,
						error: "Runtime route is owned by a different agent session",
					});
				}
			});
			const transport = new ChromeRuntimeSessionTransport({
				descriptor: descriptor(),
				portFactory: factory,
				reconnectDelayMs: 1,
				onError: (error) => errors.push(error),
			});
			transport.subscribe(() => {});
			expect(ports).toHaveLength(1);

			ports[0]?.emitDisconnect();
			await vi.advanceTimersByTimeAsync(1);
			expect(ports).toHaveLength(2);
			expect(ports[1]?.sent).toEqual([{ type: "agent-runtime-port-connect", descriptor: descriptor() }]);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(ports).toHaveLength(2);
			expect(errors).toContainEqual(
				expect.objectContaining({
					code: "PORT_CONNECT_REJECTED",
					retryable: false,
					requestMayHaveExecuted: false,
				}),
			);
			transport.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("safely retries only the connection when disconnect occurs before posting", async () => {
		const { factory, ports } = factoryWithPorts();
		const createDescriptor = descriptor({
			mode: "create",
			initialMessages: [{ role: "assistant", content: "already created" }],
		});
		const transport = new ChromeRuntimeSessionTransport({
			descriptor: createDescriptor,
			portFactory: factory,
			reconnectDelayMs: 60_000,
		});
		transport.subscribe(() => {});
		const runtimeRequest = request();
		const responsePromise = transport.send(runtimeRequest);
		await flushMicrotasks();

		ports[0]?.emitDisconnect();
		await flushMicrotasks();
		expect(ports).toHaveLength(2);
		expect(ports[0]?.sent).toEqual([{ type: "agent-runtime-port-connect", descriptor: createDescriptor }]);

		acknowledge(ports[1] as FakePort);
		await flushMicrotasks();
		expect(ports[1]?.sent).toEqual([
			{ type: "agent-runtime-port-connect", descriptor: createDescriptor },
			{ type: "agent-runtime-port-request", request: runtimeRequest },
		]);
		ports[1]?.emitMessage({ type: "agent-runtime-port-response", response: success(runtimeRequest) });
		await expect(responsePromise).resolves.toEqual(success(runtimeRequest));
	});

	it("removes port listeners, rejects pending work, and suppresses reconnect after dispose", async () => {
		vi.useFakeTimers();
		try {
			const { factory, ports } = factoryWithPorts((port) => acknowledge(port));
			const transport = new ChromeRuntimeSessionTransport({
				descriptor: descriptor(),
				portFactory: factory,
				reconnectDelayMs: 1,
			});
			transport.subscribe(() => {});
			const responsePromise = transport.send(request());
			await flushMicrotasks();

			transport.dispose();

			await expect(responsePromise).rejects.toMatchObject({
				code: "DISPOSED",
				requestId: "request-1",
				requestMayHaveExecuted: true,
			});
			expect(ports[0]?.messageListenerCount).toBe(0);
			expect(ports[0]?.disconnectListenerCount).toBe(0);
			expect(ports[0]?.disconnectCount).toBe(1);
			await vi.runAllTimersAsync();
			expect(ports).toHaveLength(1);
			await expect(transport.send(request({ requestId: "after-dispose" }))).rejects.toMatchObject({
				code: "DISPOSED",
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
