import type { RuntimeTargetIdentity, RuntimeValue } from "./runtime-protocol.js";

/** Stable wire-data identity independent of object property insertion order. */
export function canonicalRuntimeValue(value: RuntimeValue): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalRuntimeValue).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalRuntimeValue(value[key])}`)
		.join(",")}}`;
}

export function sameRuntimeTarget(left: RuntimeTargetIdentity, right: RuntimeTargetIdentity): boolean {
	return (
		canonicalRuntimeValue(left as unknown as RuntimeValue) === canonicalRuntimeValue(right as unknown as RuntimeValue)
	);
}

/** Storage/coordinator key for the one accepted runtime route owned by a client window. */
export function runtimeClientRouteKey(clientId: string, windowId: number): string {
	return JSON.stringify([clientId, windowId]);
}
