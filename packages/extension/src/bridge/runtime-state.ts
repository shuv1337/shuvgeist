import type { OffscreenRuntimeHostState } from "../agent/offscreen-runtime-host.js";
import { SESSION_LOCKS_KEY, SIDEPANEL_OPEN_KEY } from "../background-state.js";
import {
	AGENT_RUNTIME_CONNECTIONS_KEY,
	AGENT_RUNTIME_STATE_KEY,
	type AgentRuntimeConnectionRegistry,
	BRIDGE_ELECTRON_STATE_KEY,
	BRIDGE_OTEL_STATE_KEY,
	BRIDGE_STATE_KEY,
	type BridgeElectronStateData,
	type BridgeOtelStateData,
	type BridgeStateData,
} from "./internal-messages.js";

export const BRIDGE_RUNTIME_STATE_KEYS = {
	agentRuntimeConnections: AGENT_RUNTIME_CONNECTIONS_KEY,
	agentRuntime: AGENT_RUNTIME_STATE_KEY,
	bridge: BRIDGE_STATE_KEY,
	observability: BRIDGE_OTEL_STATE_KEY,
	electron: BRIDGE_ELECTRON_STATE_KEY,
	openSidepanels: SIDEPANEL_OPEN_KEY,
	sessionLocks: SESSION_LOCKS_KEY,
} as const;

export interface BridgeRuntimeStateSchema {
	[AGENT_RUNTIME_CONNECTIONS_KEY]: AgentRuntimeConnectionRegistry;
	[AGENT_RUNTIME_STATE_KEY]: OffscreenRuntimeHostState;
	[BRIDGE_STATE_KEY]: BridgeStateData;
	[BRIDGE_OTEL_STATE_KEY]: BridgeOtelStateData;
	[BRIDGE_ELECTRON_STATE_KEY]: BridgeElectronStateData;
	[SIDEPANEL_OPEN_KEY]: number[];
	[SESSION_LOCKS_KEY]: Record<string, number>;
}

export type BridgeRuntimeStateKey = keyof BridgeRuntimeStateSchema;

export interface BridgeRuntimeStateStorageArea {
	get(keys: string | string[]): Promise<Record<string, unknown>>;
	set(items: Record<string, unknown>): Promise<void>;
}

function defaultSessionStorage(): BridgeRuntimeStateStorageArea {
	return chrome.storage.session;
}

export async function readBridgeRuntimeState<K extends BridgeRuntimeStateKey>(
	key: K,
	storage: BridgeRuntimeStateStorageArea = defaultSessionStorage(),
): Promise<BridgeRuntimeStateSchema[K] | undefined> {
	const values = await storage.get(key);
	return values[key] as BridgeRuntimeStateSchema[K] | undefined;
}

export function writeBridgeRuntimeState<K extends BridgeRuntimeStateKey>(
	key: K,
	value: BridgeRuntimeStateSchema[K],
	storage: BridgeRuntimeStateStorageArea = defaultSessionStorage(),
): Promise<void> {
	return storage.set({ [key]: value });
}

export function writeBridgeRuntimeStates(
	values: Partial<BridgeRuntimeStateSchema>,
	storage: BridgeRuntimeStateStorageArea = defaultSessionStorage(),
): Promise<void> {
	return storage.set(values);
}
