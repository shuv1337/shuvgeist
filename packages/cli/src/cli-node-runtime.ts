import {
	type BridgeConnectionOverrides,
	type BridgeServeOverrides,
	createNodeConfigOwner,
	type NodeConfigOwner,
} from "@shuvgeist/server/node-config";
import { type EnsureBridgeServerOptions, ensureBridgeServer } from "./bridge-autostart.js";

export type EnsureCliBridgeServer = typeof ensureBridgeServer;

export interface CliNodeRuntimeDependencies {
	owner?: NodeConfigOwner;
	ensureServer?: EnsureCliBridgeServer;
}

/**
 * Composition boundary for every Node-side CLI config consumer. Keeping the
 * owner here prevents individual command paths from taking independent
 * environment or config-file snapshots.
 */
export function createCliNodeRuntime(dependencies: CliNodeRuntimeDependencies = {}) {
	const owner = dependencies.owner ?? createNodeConfigOwner();
	const ensureServer = dependencies.ensureServer ?? ensureBridgeServer;
	return {
		owner,
		resolveConnection(flags: BridgeConnectionOverrides = {}) {
			return owner.resolveBridgeConnection(flags);
		},
		requireConnection(flags: BridgeConnectionOverrides = {}) {
			const resolved = owner.resolveBridgeConnection(flags);
			if (!resolved.token) {
				throw Object.assign(
					new Error(
						[
							"bridge token is required.",
							"",
							"Set it via:",
							"  --token <token>",
							"  SHUVGEIST_BRIDGE_TOKEN env var",
							`  ${resolved.configPath}`,
						].join("\n"),
					),
					{ code: "EAUTH" },
				);
			}
			return resolved;
		},
		resolveServeBinding(flags: BridgeServeOverrides = {}) {
			return owner.resolveBridgeServeBinding(flags);
		},
		resolveOtelConfig() {
			return owner.resolveOtelConfig();
		},
		ensureServer(flags: BridgeConnectionOverrides = {}, options: Omit<EnsureBridgeServerOptions, "owner"> = {}) {
			return ensureServer(flags, { ...options, owner });
		},
	};
}

export type CliNodeRuntime = ReturnType<typeof createCliNodeRuntime>;
