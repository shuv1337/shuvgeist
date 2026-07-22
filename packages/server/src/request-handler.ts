import {
	type BridgeError,
	type BridgeMethod,
	BridgeMethods,
	type BridgeRequest,
	ErrorCodes,
	formatBridgeCommandValidationErrors,
	isWriteMethod,
	validateBridgeCommandParams,
} from "@shuvgeist/protocol/protocol";
import { type BridgeTarget, requestTarget } from "@shuvgeist/protocol/target";
import { missingExtensionTargetError, resolveBridgeExecution } from "./target-execution.js";

export interface BridgeRequestTargetHandle {
	key: string;
	isOpen: boolean;
	capabilities?: readonly string[];
	acquireWriteLock(cliConnectionId: string, expectedSessionId?: string): BridgeWriteLockResult;
}

export type BridgeWriteLockResult =
	| { ok: true }
	| { ok: false; holder: { cliConnectionId: string; sessionId?: string } };

export interface BridgeRequestHandlerContext<THandle extends BridgeRequestTargetHandle> {
	cliConnectionId: string;
	resolveTarget(target: BridgeTarget): THandle | undefined;
}

export type BridgeRequestPlan<THandle extends BridgeRequestTargetHandle> =
	| { type: "server-local"; target: BridgeTarget }
	| { type: "electron-target"; target: BridgeTarget }
	| {
			type: "extension";
			target: BridgeTarget;
			handle: THandle;
			expectedSessionId?: string;
			writeLockAcquired: boolean;
	  }
	| {
			type: "error";
			target?: BridgeTarget;
			error: BridgeError;
			reason: BridgeRequestPlanErrorReason;
			writeLockHolder?: { cliConnectionId: string; sessionId?: string };
	  };

export type BridgeRequestPlanErrorReason =
	| "invalid-method"
	| "invalid-params"
	| "unsupported-target"
	| "missing-extension-target"
	| "capability-disabled"
	| "write-locked";

export class BridgeRequestHandler<THandle extends BridgeRequestTargetHandle> {
	plan(req: BridgeRequest, context: BridgeRequestHandlerContext<THandle>): BridgeRequestPlan<THandle> {
		if (!BridgeMethods.includes(req.method as BridgeMethod)) {
			return {
				type: "error",
				reason: "invalid-method",
				error: { code: ErrorCodes.INVALID_METHOD, message: "Unknown method: " + req.method },
			};
		}

		const paramsValidation = validateBridgeCommandParams(req.method, req.params);
		if (!paramsValidation.ok) {
			return {
				type: "error",
				reason: "invalid-params",
				error: {
					code: ErrorCodes.INVALID_PARAMS,
					message: `Invalid parameters for '${req.method}': ${formatBridgeCommandValidationErrors(paramsValidation.errors)}`,
				},
			};
		}
		req.params = paramsValidation.value;

		const target = requestTarget(req);
		const execution = resolveBridgeExecution(req.method, target);
		if (execution.adapter === "server-local") {
			return { type: "server-local", target };
		}
		if (execution.adapter === "electron-target") {
			return { type: "electron-target", target };
		}
		if (execution.adapter === "unsupported-target" && execution.error) {
			return { type: "error", reason: "unsupported-target", target, error: execution.error };
		}

		const handle = context.resolveTarget(target);
		if (!handle?.isOpen) {
			return { type: "error", reason: "missing-extension-target", target, error: missingExtensionTargetError() };
		}

		if (handle.capabilities && !handle.capabilities.includes(req.method)) {
			return {
				type: "error",
				reason: "capability-disabled",
				target,
				error: {
					code: ErrorCodes.CAPABILITY_DISABLED,
					message: `Method '${req.method}' is disabled on the active extension target`,
				},
			};
		}

		const expectedSessionId =
			req.params && typeof req.params.expectedSessionId === "string" ? req.params.expectedSessionId : undefined;
		let writeLockAcquired = false;
		if (isWriteMethod(req.method)) {
			const lease = handle.acquireWriteLock(context.cliConnectionId, expectedSessionId);
			if (!lease.ok) {
				return {
					type: "error",
					reason: "write-locked",
					target,
					error: { code: ErrorCodes.WRITE_LOCKED, message: "Another CLI currently holds the session write lock" },
					writeLockHolder: lease.holder,
				};
			}
			writeLockAcquired = true;
		}

		return { type: "extension", target, handle, expectedSessionId, writeLockAcquired };
	}
}
