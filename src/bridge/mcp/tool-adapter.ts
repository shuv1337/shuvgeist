import type { BridgeMethod, BridgeRequest } from "../protocol.js";
import type { BridgeTarget } from "../target.js";

export interface McpToolDefinition {
	name: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		additionalProperties: boolean;
	};
}

export interface McpToolBridgePlan {
	method: BridgeMethod;
	params: Record<string, unknown>;
	target?: BridgeTarget;
}

const targetSchema = {
	type: "object",
	properties: {
		kind: { type: "string", enum: ["chrome-tab", "electron-window"] },
		tabId: { type: "number" },
		tabRef: { type: "string" },
		windowId: { type: "number" },
		sessionId: { type: "string" },
		windowRef: { type: "string" },
		targetId: { type: "string" },
	},
	additionalProperties: true,
};

export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
	{
		name: "shuvgeist_observe",
		description: "Capture a semantic page snapshot for the selected browser target.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				maxEntries: { type: "number" },
				includeHidden: { type: "boolean" },
				target: targetSchema,
			},
			additionalProperties: false,
		},
	},
	{
		name: "shuvgeist_act",
		description: "Act on a semantic ref by clicking it or filling it with text.",
		inputSchema: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["click", "fill"] },
				refId: { type: "string" },
				value: { type: "string" },
				native: { type: "boolean" },
				target: targetSchema,
			},
			additionalProperties: false,
		},
	},
	{
		name: "shuvgeist_extract",
		description: "Run JavaScript extraction against the selected browser target.",
		inputSchema: {
			type: "object",
			properties: {
				code: { type: "string" },
				title: { type: "string" },
				target: targetSchema,
			},
			additionalProperties: false,
		},
	},
	{
		name: "shuvgeist_agent",
		description: "Run a Shuvgeist browser workflow through the bridge.",
		inputSchema: {
			type: "object",
			properties: {
				workflow: {},
				args: { type: "object" },
				dryRun: { type: "boolean" },
				target: targetSchema,
			},
			additionalProperties: false,
		},
	},
];

export function mcpToolCallToBridgeRequest(id: number, name: string, args: Record<string, unknown>): BridgeRequest {
	const plan = mcpToolCallToBridgePlan(name, args);
	return {
		id,
		method: plan.method,
		params: plan.params,
		...(plan.target ? { target: plan.target } : {}),
	};
}

export function mcpToolCallToBridgePlan(name: string, args: Record<string, unknown>): McpToolBridgePlan {
	const target = parseTarget(args.target);
	switch (name) {
		case "shuvgeist_observe":
			return {
				method: "page_snapshot",
				params: compactParams({
					query: stringArg(args, "query"),
					maxEntries: numberArg(args, "maxEntries"),
					includeHidden: booleanArg(args, "includeHidden"),
				}),
				target,
			};
		case "shuvgeist_act": {
			const action = stringArg(args, "action") || "click";
			const refId = requiredStringArg(args, "refId");
			if (action === "fill") {
				return {
					method: "ref_fill",
					params: compactParams({
						refId,
						value: requiredStringArg(args, "value"),
						native: booleanArg(args, "native"),
					}),
					target,
				};
			}
			if (action !== "click") throw new Error("shuvgeist_act action must be 'click' or 'fill'");
			return { method: "ref_click", params: compactParams({ refId, native: booleanArg(args, "native") }), target };
		}
		case "shuvgeist_extract":
			return {
				method: "repl",
				params: { code: requiredStringArg(args, "code"), title: stringArg(args, "title") || "MCP extract" },
				target,
			};
		case "shuvgeist_agent":
			return {
				method: "workflow_run",
				params: compactParams({
					workflow: args.workflow,
					args: typeof args.args === "object" && args.args !== null ? args.args : undefined,
					dryRun: booleanArg(args, "dryRun"),
				}),
				target,
			};
		default:
			throw new Error("Unknown MCP tool '" + name + "'");
	}
}

function compactParams(params: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
	return typeof args[key] === "string" ? args[key] : undefined;
}

function requiredStringArg(args: Record<string, unknown>, key: string): string {
	const value = stringArg(args, key);
	if (!value) throw new Error("Missing required string argument '" + key + "'");
	return value;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
	return typeof args[key] === "number" ? args[key] : undefined;
}

function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
	return typeof args[key] === "boolean" ? args[key] : undefined;
}

function parseTarget(value: unknown): BridgeTarget | undefined {
	if (!value || typeof value !== "object") return undefined;
	const target = value as Partial<BridgeTarget>;
	if (target.kind === "electron-window") return target as BridgeTarget;
	if (target.kind === "chrome-tab") return target as BridgeTarget;
	throw new Error("MCP target.kind must be chrome-tab or electron-window");
}
