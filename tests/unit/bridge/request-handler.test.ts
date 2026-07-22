import { BridgeRequestHandler, type BridgeRequestTargetHandle } from "@shuvgeist/server/request-handler";
import { ErrorCodes, type BridgeRequest } from "@shuvgeist/protocol/protocol";
import type { BridgeTarget } from "@shuvgeist/protocol/target";

function request(method: BridgeRequest["method"], target?: BridgeTarget, params?: Record<string, unknown>): BridgeRequest {
	return { id: 1, method, target, params };
}

function handle(overrides: Partial<BridgeRequestTargetHandle> = {}): BridgeRequestTargetHandle {
	return {
		key: "chrome-window:1",
		isOpen: true,
		capabilities: undefined,
		acquireWriteLock: () => ({ ok: true }),
		...overrides,
	};
}

describe("BridgeRequestHandler", () => {
	it("rejects unknown methods before resolving targets", () => {
		const handler = new BridgeRequestHandler<BridgeRequestTargetHandle>();
		const plan = handler.plan({ id: 1, method: "bogus" } as unknown as BridgeRequest, {
			cliConnectionId: "cli-1",
			resolveTarget: () => {
				throw new Error("target should not resolve");
			},
		});

		expect(plan).toMatchObject({
			type: "error",
			reason: "invalid-method",
			error: { code: ErrorCodes.INVALID_METHOD, message: "Unknown method: bogus" },
		});
	});

	it("plans server-local and direct Electron target requests without extension handles", () => {
		const handler = new BridgeRequestHandler<BridgeRequestTargetHandle>();
		const context = {
			cliConnectionId: "cli-1",
			resolveTarget: () => undefined,
		};

		expect(handler.plan(request("electron_list"), context)).toMatchObject({
			type: "server-local",
			target: { kind: "chrome-tab" },
		});
		expect(
			handler.plan(request("page_snapshot", { kind: "electron-window", sessionId: "e1", windowRef: "w1" }), context),
		).toMatchObject({
			type: "electron-target",
			target: { kind: "electron-window", sessionId: "e1", windowRef: "w1" },
		});
	});

	it("normalizes omitted no-parameter commands and rejects invalid method parameters", () => {
		const handler = new BridgeRequestHandler<BridgeRequestTargetHandle>();
		const statusRequest = request("status");
		const context = {
			cliConnectionId: "cli-1",
			resolveTarget: () => handle({ capabilities: ["status"] }),
		};

		expect(handler.plan(statusRequest, context)).toMatchObject({ type: "extension" });
		expect(statusRequest.params).toEqual({});
		expect(handler.plan(request("eval", undefined, {}), context)).toMatchObject({
			type: "error",
			reason: "invalid-params",
			error: { code: ErrorCodes.INVALID_PARAMS },
		});
	});

	it("returns target support and missing extension errors", () => {
		const handler = new BridgeRequestHandler<BridgeRequestTargetHandle>();
		const context = {
			cliConnectionId: "cli-1",
			resolveTarget: () => undefined,
		};

		expect(handler.plan(request("session_history", { kind: "electron-window", sessionId: "e1" }), context)).toMatchObject({
			type: "error",
			reason: "unsupported-target",
			error: { code: ErrorCodes.INVALID_TARGET },
		});
		expect(handler.plan(request("status"), context)).toMatchObject({
			type: "error",
			reason: "missing-extension-target",
			error: { code: ErrorCodes.NO_EXTENSION_TARGET },
		});
	});

	it("rejects disabled capabilities on the active extension target", () => {
		const handler = new BridgeRequestHandler<BridgeRequestTargetHandle>();
		const plan = handler.plan(request("cookies"), {
			cliConnectionId: "cli-1",
			resolveTarget: () => handle({ capabilities: ["status"] }),
		});

		expect(plan).toMatchObject({
			type: "error",
			reason: "capability-disabled",
			error: { code: ErrorCodes.CAPABILITY_DISABLED },
		});
	});

	it("acquires writer locks for write methods and reports lock holders", () => {
		const handler = new BridgeRequestHandler<BridgeRequestTargetHandle>();
		const acquired = handler.plan(
			request("session_inject", undefined, { expectedSessionId: "s1", role: "user", content: "hello" }),
			{
			cliConnectionId: "cli-1",
			resolveTarget: () => handle({ capabilities: ["session_inject"] }),
			},
		);

		expect(acquired).toMatchObject({
			type: "extension",
			expectedSessionId: "s1",
			writeLockAcquired: true,
		});

		const locked = handler.plan(
			request("session_inject", undefined, { expectedSessionId: "s1", role: "user", content: "hello" }),
			{
			cliConnectionId: "cli-2",
			resolveTarget: () =>
				handle({
					capabilities: ["session_inject"],
					acquireWriteLock: () => ({ ok: false, holder: { cliConnectionId: "cli-1", sessionId: "s1" } }),
				}),
			},
		);

		expect(locked).toMatchObject({
			type: "error",
			reason: "write-locked",
			error: { code: ErrorCodes.WRITE_LOCKED },
			writeLockHolder: { cliConnectionId: "cli-1", sessionId: "s1" },
		});
	});

	it("plans extension relay requests with the resolved target handle", () => {
		const handler = new BridgeRequestHandler<BridgeRequestTargetHandle>();
		const resolvedHandle = handle({ capabilities: ["status"] });
		const plan = handler.plan(request("status", { kind: "chrome-tab", tabId: 4 }), {
			cliConnectionId: "cli-1",
			resolveTarget: () => resolvedHandle,
		});

		expect(plan).toMatchObject({
			type: "extension",
			target: { kind: "chrome-tab", tabId: 4 },
			handle: resolvedHandle,
			writeLockAcquired: false,
		});
	});
});
