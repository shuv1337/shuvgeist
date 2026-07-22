import { sameRuntimeTarget } from "../agent/runtime-identity.js";
import type { RuntimeAgentMessage, RuntimeSessionSnapshot } from "../agent/runtime-protocol.js";
import type { AgentRuntimeConnectionDescriptor } from "./internal-messages.js";

export interface AgentRuntimeNavigationTab {
	id?: number;
	windowId: number;
	active?: boolean;
	url?: string;
	title?: string;
	favIconUrl?: string;
}

export interface AgentRuntimeNavigationSteeringOptions {
	getDescriptorsForWindow(windowId: number): Promise<AgentRuntimeConnectionDescriptor[]>;
	getLatestSnapshot(descriptor: AgentRuntimeConnectionDescriptor): RuntimeSessionSnapshot | undefined;
	createMessage(
		descriptor: AgentRuntimeConnectionDescriptor,
		tab: AgentRuntimeNavigationTab,
	): Promise<RuntimeAgentMessage | undefined>;
	steer(descriptor: AgentRuntimeConnectionDescriptor, message: RuntimeAgentMessage): Promise<void>;
	isProtectedUrl(url: string): boolean;
	reportError?(error: unknown, context: string): void;
}

function sameDescriptor(left: AgentRuntimeConnectionDescriptor, right: AgentRuntimeConnectionDescriptor): boolean {
	return (
		left.clientId === right.clientId &&
		left.windowId === right.windowId &&
		left.sessionId === right.sessionId &&
		sameRuntimeTarget(left.target, right.target)
	);
}

/**
 * Serializes background-owned navigation steering by browser window. It does
 * not depend on an attached sidepanel port, so an accepted offscreen session
 * keeps receiving navigation context after the UI closes.
 */
export class AgentRuntimeNavigationSteering {
	private readonly windowTails = new Map<number, Promise<void>>();

	constructor(private readonly options: AgentRuntimeNavigationSteeringOptions) {}

	handleTab(tabValue: AgentRuntimeNavigationTab): Promise<boolean> {
		const tab = structuredClone(tabValue);
		if (
			!Number.isSafeInteger(tab.windowId) ||
			tab.windowId < 0 ||
			!tab.active ||
			!tab.url ||
			this.options.isProtectedUrl(tab.url)
		) {
			return Promise.resolve(false);
		}

		const previous = this.windowTails.get(tab.windowId) ?? Promise.resolve();
		const work = previous
			.catch(() => undefined)
			.then(() => this.steerForTab(tab))
			.catch((error: unknown) => {
				this.options.reportError?.(error, `navigation-window-${tab.windowId}`);
				return false;
			});
		const tail = work.then(() => undefined);
		this.windowTails.set(tab.windowId, tail);
		void tail.finally(() => {
			if (this.windowTails.get(tab.windowId) === tail) this.windowTails.delete(tab.windowId);
		});
		return work;
	}

	private async steerForTab(tab: AgentRuntimeNavigationTab): Promise<boolean> {
		const descriptors = await this.options.getDescriptorsForWindow(tab.windowId);
		if (descriptors.length !== 1) return false;
		const descriptor = descriptors[0];
		if (!descriptor || !this.options.getLatestSnapshot(descriptor)?.isStreaming) return false;

		const message = await this.options.createMessage(descriptor, tab);
		if (!message) return false;

		// Message construction may involve a page snapshot and IndexedDB reads.
		// Re-resolve both ownership and streaming state before mutating the agent.
		const currentDescriptors = await this.options.getDescriptorsForWindow(tab.windowId);
		const current = currentDescriptors.length === 1 ? currentDescriptors[0] : undefined;
		if (!current || !sameDescriptor(current, descriptor)) return false;
		if (!this.options.getLatestSnapshot(current)?.isStreaming) return false;

		await this.options.steer(current, message);
		return true;
	}
}
