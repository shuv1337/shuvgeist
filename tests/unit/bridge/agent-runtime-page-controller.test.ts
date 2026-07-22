import { describe, expect, it, vi } from "vitest";

import type { RuntimeTargetIdentity, RuntimeValue } from "@shuvgeist/extension/agent/runtime-protocol";
import {
	AgentRuntimePageController,
	type AgentRuntimePageDelegateInput,
	type AgentRuntimePageOperationDelegate,
} from "@shuvgeist/extension/bridge/agent-runtime-page-controller";
import type {
	AgentRuntimePageCancelMessage,
	AgentRuntimePageOperationMessage,
} from "@shuvgeist/extension/bridge/internal-messages";

class Deferred<T> {
	readonly promise: Promise<T>;
	resolve!: (value: T) => void;
	reject!: (error: unknown) => void;

	constructor() {
		this.promise = new Promise<T>((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}
}

const target7: RuntimeTargetIdentity = { kind: "chrome-tab", tabRef: "window:7" };

function operationMessage(
	overrides: Partial<AgentRuntimePageOperationMessage> = {},
): AgentRuntimePageOperationMessage {
	return {
		type: "agent-runtime-page-operation",
		operationId: "operation-1",
		runtimeEpoch: "epoch-1",
		clientId: "client-1",
		windowId: 7,
		sessionId: "session-7",
		target: target7,
		operation: "navigate",
		payload: { url: "https://example.com" },
		executionId: "execution-1",
		executionRequestId: "request-1",
		...overrides,
	};
}

function cancelMessage(
	operationId: string,
	overrides: Partial<AgentRuntimePageCancelMessage> = {},
): AgentRuntimePageCancelMessage {
	return {
		type: "agent-runtime-page-cancel",
		operationId,
		runtimeEpoch: "epoch-1",
		clientId: "client-1",
		windowId: 7,
		sessionId: "session-7",
		target: target7,
		executionId: "execution-1",
		executionRequestId: "request-1",
		...overrides,
	};
}

function delegate(execute: (input: AgentRuntimePageDelegateInput) => Promise<unknown> | unknown) {
	return { execute } satisfies AgentRuntimePageOperationDelegate;
}

describe("AgentRuntimePageController", () => {
	it.each([
		"browser-js",
		"navigate",
		"native-input",
		"navigation-context",
		"page-snapshot",
		"select-element",
		"screenshot",
		"extract-image-source",
		"debugger",
	] as const)("routes the %s operation through the narrow delegate", async (operation) => {
		const execute = vi.fn(async (input: AgentRuntimePageDelegateInput) => ({
			operation: input.operation,
			windowId: input.windowId,
		}));
		const controller = new AgentRuntimePageController({ createDelegate: () => delegate(execute) });

		await expect(controller.handle(operationMessage({ operation }))).resolves.toEqual({
			ok: true,
			result: { operation, windowId: 7 },
		});
		expect(execute).toHaveBeenCalledWith(
			expect.objectContaining({
				operation,
				operationId: "operation-1",
				windowId: 7,
				target: { kind: "chrome-tab", tabRef: "window:7" },
			}),
		);
	});

	it("keeps logical targets isolated by window and rejects concrete or mismatched targets", async () => {
		const scopes: Array<{ windowId: number; tabRef: string }> = [];
		const controller = new AgentRuntimePageController({
			createDelegate: (scope) => {
				scopes.push({ windowId: scope.windowId, tabRef: scope.target.tabRef });
				return delegate(async (input) => ({ windowId: input.windowId }));
			},
		});

		await expect(controller.execute(operationMessage())).resolves.toEqual({ ok: true, result: { windowId: 7 } });
		await expect(
			controller.execute(
				operationMessage({
					operationId: "operation-2",
					windowId: 8,
					sessionId: "session-8",
					target: { kind: "chrome-tab", tabRef: "active" },
				}),
			),
		).resolves.toEqual({ ok: true, result: { windowId: 8 } });
		await expect(
			controller.execute(operationMessage({ operationId: "wrong-window", target: { kind: "chrome-tab", tabRef: "window:8" } })),
		).resolves.toEqual({ ok: false, error: "Page operation target must be 'active' or 'window:7'" });
		await expect(
			controller.execute(
				operationMessage({ operationId: "concrete-tab", target: { kind: "chrome-tab", tabRef: "window:7", tabId: 42 } }),
			),
		).resolves.toEqual({
			ok: false,
			error: "Page operation target must be logical and cannot contain a concrete tabId",
		});
		expect(scopes).toEqual([
			{ windowId: 7, tabRef: "window:7" },
			{ windowId: 8, tabRef: "active" },
		]);
	});

	it("authorizes concrete payload targets before creating a privileged delegate", async () => {
		const execute = vi.fn(async () => ({ complete: true }));
		const createDelegate = vi.fn(() => delegate(execute));
		const authorize = vi.fn(async (input: AgentRuntimePageDelegateInput) => {
			if (input.payload.tabId === 81) {
				throw new Error("Tab 81 belongs to window 8, not authorized window 7");
			}
		});
		const controller = new AgentRuntimePageController({ authorize, createDelegate });

		await expect(controller.execute(operationMessage({ payload: { tabId: 81 } }))).resolves.toEqual({
			ok: false,
			error: "Tab 81 belongs to window 8, not authorized window 7",
		});
		expect(authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				windowId: 7,
				operation: "navigate",
				payload: { tabId: 81 },
			}),
		);
		expect(createDelegate).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});

	it("rejects duplicate active operation IDs", async () => {
		const deferred = new Deferred<RuntimeValue>();
		const execute = vi.fn(() => deferred.promise);
		const controller = new AgentRuntimePageController({ createDelegate: () => delegate(execute) });
		const first = controller.execute(operationMessage());
		await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

		await expect(controller.execute(operationMessage())).resolves.toEqual({
			ok: false,
			error: "Page operation 'operation-1' is already active",
		});
		deferred.resolve({ complete: true });
		await expect(first).resolves.toEqual({ ok: true, result: { complete: true } });
		expect(controller.activeOperationCount).toBe(0);
	});

	it("cancels only the exact operation and leaves other windows running", async () => {
		const operations = new Map<string, { deferred: Deferred<RuntimeValue>; signal: AbortSignal }>();
		const controller = new AgentRuntimePageController({
			createDelegate: () =>
				delegate((input) => {
					const deferred = new Deferred<RuntimeValue>();
					operations.set(input.operationId, { deferred, signal: input.signal });
					return deferred.promise;
				}),
		});
		const first = controller.execute(operationMessage({ operationId: "window-7-operation" }));
		const second = controller.execute(
			operationMessage({
				operationId: "window-8-operation",
				windowId: 8,
				sessionId: "session-8",
				target: { kind: "chrome-tab", tabRef: "window:8" },
			}),
		);
		await vi.waitFor(() => expect(operations.size).toBe(2));

		expect(controller.cancel(cancelMessage("missing"))).toEqual({
			ok: false,
			error: "Page operation 'missing' is not active",
		});
		expect(
			controller.cancel(cancelMessage("window-7-operation", { executionRequestId: "forged-request" })),
		).toEqual({
			ok: false,
			error: "Page operation 'window-7-operation' cancellation correlation does not match",
		});
		expect(operations.get("window-7-operation")?.signal.aborted).toBe(false);
		expect(controller.cancel(cancelMessage("window-7-operation"))).toEqual({
			ok: true,
			result: { operationId: "window-7-operation", cancelled: true },
		});
		expect(operations.get("window-7-operation")?.signal.aborted).toBe(true);
		expect(operations.get("window-8-operation")?.signal.aborted).toBe(false);
		await expect(first).resolves.toEqual({
			ok: false,
			error: "Page operation 'window-7-operation' was cancelled",
		});
		operations.get("window-8-operation")?.deferred.resolve({ complete: true });
		await expect(second).resolves.toEqual({ ok: true, result: { complete: true } });
	});

	it("cleans up successful and failed terminal operations", async () => {
		let shouldFail = false;
		const controller = new AgentRuntimePageController({
			createDelegate: () =>
				delegate(async () => {
					if (shouldFail) throw new Error("page failed");
					return { complete: true };
				}),
		});

		await expect(controller.execute(operationMessage())).resolves.toEqual({ ok: true, result: { complete: true } });
		expect(controller.activeOperationCount).toBe(0);
		shouldFail = true;
		await expect(controller.execute(operationMessage({ operationId: "operation-2" }))).resolves.toEqual({
			ok: false,
			error: "page failed",
		});
		expect(controller.activeOperationCount).toBe(0);
	});

	it("never re-executes a completed operation after response loss", async () => {
		const result = { complete: true };
		const execute = vi.fn(async () => result);
		const controller = new AgentRuntimePageController({ createDelegate: () => delegate(execute) });

		await expect(controller.execute(operationMessage())).resolves.toEqual({ ok: true, result });
		await expect(controller.execute(operationMessage())).resolves.toEqual({ ok: true, result });
		await expect(
			controller.execute(operationMessage({ payload: { url: "https://different.example" } })),
		).resolves.toEqual({
			ok: false,
			error: "Page operation 'operation-1' already completed with different correlation data",
		});
		expect(execute).toHaveBeenCalledOnce();
		expect(controller.completedOperationCount).toBe(1);
	});

	it("never re-executes a duplicate operation after cancellation", async () => {
		const deferreds: Array<Deferred<RuntimeValue>> = [];
		const controller = new AgentRuntimePageController({
			createDelegate: () =>
				delegate(() => {
					const deferred = new Deferred<RuntimeValue>();
					deferreds.push(deferred);
					return deferred.promise;
				}),
		});
		const first = controller.execute(operationMessage());
		await vi.waitFor(() => expect(deferreds).toHaveLength(1));
		controller.cancel(cancelMessage("operation-1"));
		await expect(first).resolves.toEqual({
			ok: false,
			error: "Page operation 'operation-1' was cancelled",
		});

		await expect(controller.execute(operationMessage())).resolves.toEqual({
			ok: false,
			error: "Page operation 'operation-1' was cancelled",
		});
		expect(deferreds).toHaveLength(1);
		deferreds[0].resolve({ stale: true });
		await Promise.resolve();
		expect(controller.hasActiveOperation("operation-1")).toBe(false);
		expect(controller.completedOperationCount).toBe(1);
	});

	it("rejects attempted ID reuse so a delayed cancel cannot affect a new operation", async () => {
		const operations = new Map<string, { deferred: Deferred<RuntimeValue>; signal: AbortSignal }>();
		const controller = new AgentRuntimePageController({
			createDelegate: () =>
				delegate((input) => {
					const deferred = new Deferred<RuntimeValue>();
					operations.set(input.operationId, { deferred, signal: input.signal });
					return deferred.promise;
				}),
		});
		const original = controller.execute(operationMessage());
		await vi.waitFor(() => expect(operations.has("operation-1")).toBe(true));
		controller.cancel(cancelMessage("operation-1"));
		await expect(original).resolves.toEqual({
			ok: false,
			error: "Page operation 'operation-1' was cancelled",
		});
		await expect(
			controller.execute(operationMessage({ payload: { url: "https://reuse.example" } })),
		).resolves.toEqual({
			ok: false,
			error: "Page operation 'operation-1' already completed with different correlation data",
		});

		const next = controller.execute(operationMessage({ operationId: "operation-2" }));
		await vi.waitFor(() => expect(operations.has("operation-2")).toBe(true));
		expect(controller.cancel(cancelMessage("operation-1"))).toEqual({
			ok: false,
			error: "Page operation 'operation-1' already completed",
		});
		expect(operations.get("operation-2")?.signal.aborted).toBe(false);
		operations.get("operation-2")?.deferred.resolve({ complete: true });
		await expect(next).resolves.toEqual({ ok: true, result: { complete: true } });
	});

	it("bounds retained terminal responses", async () => {
		const controller = new AgentRuntimePageController({
			maxCompletedOperations: 2,
			createDelegate: () => delegate(async (input) => ({ operationId: input.operationId })),
		});

		for (const operationId of ["operation-1", "operation-2", "operation-3"]) {
			await controller.execute(operationMessage({ operationId }));
		}
		expect(controller.completedOperationCount).toBe(2);
	});

	it("accepts and clones only plain wire data", async () => {
		const result = { nested: { count: 1 }, list: [true, null, "value"] };
		const execute = vi.fn(async () => result);
		const controller = new AgentRuntimePageController({ createDelegate: () => delegate(execute) });
		const response = await controller.execute(operationMessage());
		expect(response).toEqual({ ok: true, result });
		if (response.ok && typeof response.result === "object" && response.result !== null) {
			expect(response.result).not.toBe(result);
		}

		const invalidPayload = operationMessage({ operationId: "bad-payload" }) as unknown as {
			payload: { execute: () => void };
		};
		invalidPayload.payload = { execute: () => {} };
		await expect(
			controller.execute(invalidPayload as unknown as AgentRuntimePageOperationMessage),
		).resolves.toEqual({ ok: false, error: "Page operation message must contain only plain wire data" });
		expect(execute).toHaveBeenCalledOnce();

		const nonPlainController = new AgentRuntimePageController({
			createDelegate: () => delegate(async () => new Date("2026-01-01T00:00:00.000Z")),
		});
		await expect(nonPlainController.execute(operationMessage())).resolves.toEqual({
			ok: false,
			error: "Page operation 'operation-1' returned non-wire data",
		});
	});
});
