import { sameRuntimeTarget } from "../agent/runtime-identity.js";
import type { AgentRuntimeConnectionDescriptor } from "../bridge/internal-messages.js";

export interface RemoteDescriptorSelection {
	descriptor: AgentRuntimeConnectionDescriptor;
	staleAccepted?: AgentRuntimeConnectionDescriptor;
}

/** Preserve an accepted descriptor verbatim only when it owns this exact route. */
export function selectRemoteDescriptor(
	desired: AgentRuntimeConnectionDescriptor,
	accepted?: AgentRuntimeConnectionDescriptor,
): RemoteDescriptorSelection {
	if (
		accepted &&
		accepted.clientId === desired.clientId &&
		accepted.windowId === desired.windowId &&
		accepted.sessionId === desired.sessionId &&
		sameRuntimeTarget(accepted.target, desired.target)
	) {
		return { descriptor: accepted };
	}
	return {
		descriptor: desired,
		...(accepted ? { staleAccepted: accepted } : {}),
	};
}

export interface RemotePresentationResources {
	agentUnsubscribe?: () => void;
	stateUnsubscribe?: () => void;
	facade?: { dispose(): void };
	transport?: { dispose(): void };
}

/** Presentation detach deliberately has no session abort or release capability. */
export function detachRemotePresentation(resources: RemotePresentationResources): void {
	resources.agentUnsubscribe?.();
	resources.stateUnsubscribe?.();
	resources.facade?.dispose();
	resources.transport?.dispose();
}
