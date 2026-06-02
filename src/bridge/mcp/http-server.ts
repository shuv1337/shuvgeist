import type { IncomingMessage, ServerResponse } from "node:http";
import type { BridgeResponse } from "../protocol.js";
import type { TaskHandle, TaskRegistry } from "../task-registry.js";
import { MCP_TOOL_DEFINITIONS, mcpToolCallToBridgeRequest } from "./tool-adapter.js";

export interface McpBridgeExecutor {
	execute(request: {
		method: string;
		params?: Record<string, unknown>;
		target?: unknown;
		traceparent?: string;
		tracestate?: string;
	}): Promise<BridgeResponse>;
}

export interface McpHttpHandlerOptions {
	taskRegistry: TaskRegistry;
	executor: McpBridgeExecutor;
	readRequestBody(req: IncomingMessage): Promise<string>;
}

interface JsonRpcRequest {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

interface McpToolCallResult {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

export class McpHttpHandler {
	private nextRequestId = 1;

	constructor(private readonly options: McpHttpHandlerOptions) {}

	async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.method !== "POST") {
			this.writeJson(res, 405, { error: "MCP endpoint requires POST" });
			return;
		}
		let message: JsonRpcRequest;
		try {
			message = JSON.parse(await this.options.readRequestBody(req)) as JsonRpcRequest;
		} catch (error) {
			this.writeJson(
				res,
				400,
				this.errorResponse(null, -32700, error instanceof Error ? error.message : String(error)),
			);
			return;
		}

		try {
			const result = await this.dispatch(message);
			this.writeJson(res, 200, { jsonrpc: "2.0", id: message.id ?? null, result });
		} catch (error) {
			this.writeJson(
				res,
				200,
				this.errorResponse(message.id ?? null, -32000, error instanceof Error ? error.message : String(error)),
			);
		}
	}

	private async dispatch(message: JsonRpcRequest): Promise<unknown> {
		switch (message.method) {
			case "initialize":
				return {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "shuvgeist-bridge", version: "1.0.0" },
				};
			case "tools/list":
				return { tools: MCP_TOOL_DEFINITIONS };
			case "tools/call":
				return await this.callTool(message.params ?? {});
			case "tasks/list":
				return { tasks: this.options.taskRegistry.list() };
			default:
				throw new Error("Unsupported MCP method '" + String(message.method) + "'");
		}
	}

	private async callTool(params: Record<string, unknown>): Promise<McpToolCallResult> {
		const name = typeof params.name === "string" ? params.name : undefined;
		if (!name) throw new Error("tools/call requires params.name");
		const args =
			params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
		const bridgeRequest = mcpToolCallToBridgeRequest(this.nextRequestId++, name, args);
		const task = this.options.taskRegistry.create({
			kind: name,
			metadata: { bridgeMethod: bridgeRequest.method, target: bridgeRequest.target ?? { kind: "chrome-tab" } },
		});
		this.options.taskRegistry.start(task.id);
		const response = await this.options.executor.execute({
			method: bridgeRequest.method,
			params: bridgeRequest.params,
			target: bridgeRequest.target,
		});
		if (response.error) {
			const failed = this.options.taskRegistry.fail(task.id, response.error.message);
			return this.toolResult({ task: failed, error: response.error }, true);
		}
		const succeeded = this.options.taskRegistry.succeed(task.id, response.result);
		return this.toolResult({ task: succeeded, result: response.result }, false);
	}

	private toolResult(
		payload: { task: TaskHandle; result?: unknown; error?: unknown },
		isError: boolean,
	): McpToolCallResult {
		return {
			content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
			structuredContent: payload as Record<string, unknown>,
			...(isError ? { isError: true } : {}),
		};
	}

	private errorResponse(id: string | number | null, code: number, message: string): Record<string, unknown> {
		return { jsonrpc: "2.0", id, error: { code, message } };
	}

	private writeJson(res: ServerResponse, status: number, value: unknown): void {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(value));
	}
}
