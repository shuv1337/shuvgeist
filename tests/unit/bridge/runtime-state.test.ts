import { describe, expect, it } from "vitest";
import {
	BRIDGE_RUNTIME_STATE_KEYS,
	readBridgeRuntimeState,
	writeBridgeRuntimeState,
	writeBridgeRuntimeStates,
	type BridgeRuntimeStateStorageArea,
} from "@shuvgeist/extension/bridge/runtime-state";

const runtimeCheckpoint = {
	runtimeEpoch: "epoch-1",
	sessions: [],
	requests: [],
};

function createStorage(): BridgeRuntimeStateStorageArea & { values: Map<string, unknown> } {
	const values = new Map<string, unknown>();
	return {
		values,
		async get(keys) {
			const requested = Array.isArray(keys) ? keys : [keys];
			return Object.fromEntries(requested.filter((key) => values.has(key)).map((key) => [key, values.get(key)]));
		},
		async set(items) {
			for (const [key, value] of Object.entries(items)) values.set(key, value);
		},
	};
}

describe("bridge runtime state", () => {
	it("round-trips each transient domain through typed keys", async () => {
		const storage = createStorage();
		await writeBridgeRuntimeState(
			BRIDGE_RUNTIME_STATE_KEYS.bridge,
			{ state: "connected", detail: "ready" },
			storage,
		);
		await writeBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.sessionLocks, { session: 42 }, storage);
		await writeBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.agentRuntime, runtimeCheckpoint, storage);
		await writeBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.agentRuntimeConnections, {}, storage);

		await expect(readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.bridge, storage)).resolves.toEqual({
			state: "connected",
			detail: "ready",
		});
		await expect(readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.sessionLocks, storage)).resolves.toEqual({
			session: 42,
		});
		await expect(readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.agentRuntime, storage)).resolves.toEqual(
			runtimeCheckpoint,
		);
		await expect(readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.agentRuntimeConnections, storage)).resolves.toEqual({});
	});

	it("persists related sidepanel state in one storage update", async () => {
		const storage = createStorage();
		await writeBridgeRuntimeStates(
			{
				[BRIDGE_RUNTIME_STATE_KEYS.openSidepanels]: [7],
				[BRIDGE_RUNTIME_STATE_KEYS.sessionLocks]: { alpha: 7 },
			},
			storage,
		);

		expect(storage.values.get(BRIDGE_RUNTIME_STATE_KEYS.openSidepanels)).toEqual([7]);
		expect(storage.values.get(BRIDGE_RUNTIME_STATE_KEYS.sessionLocks)).toEqual({ alpha: 7 });
	});
});
