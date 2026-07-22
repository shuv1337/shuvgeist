import { MCP_TOOL_DEFINITIONS, mcpToolCallToBridgeRequest } from "@shuvgeist/server/mcp/tool-adapter";

describe("mcp tool adapter", () => {
	it("exposes observe, act, extract, and agent tools", () => {
		expect(MCP_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
			"shuvgeist_observe",
			"shuvgeist_act",
			"shuvgeist_extract",
			"shuvgeist_agent",
		]);
	});

	it("maps observe calls to filtered page snapshots", () => {
		expect(
			mcpToolCallToBridgeRequest(1, "shuvgeist_observe", {
				query: "billing",
				maxEntries: 20,
				target: { kind: "chrome-tab", tabRef: "window:7" },
			}),
		).toEqual({
			id: 1,
			method: "page_snapshot",
			params: { query: "billing", maxEntries: 20 },
			target: { kind: "chrome-tab", tabRef: "window:7" },
		});
	});

	it("maps act, extract, and agent calls to bridge methods", () => {
		expect(mcpToolCallToBridgeRequest(2, "shuvgeist_act", { action: "click", refId: "e1" })).toMatchObject({
			method: "ref_click",
			params: { refId: "e1" },
		});
		expect(mcpToolCallToBridgeRequest(3, "shuvgeist_act", { action: "fill", refId: "e2", value: "hello" })).toMatchObject({
			method: "ref_fill",
			params: { refId: "e2", value: "hello" },
		});
		expect(mcpToolCallToBridgeRequest(4, "shuvgeist_extract", { code: "document.title" })).toMatchObject({
			method: "repl",
			params: { code: "document.title", title: "MCP extract" },
		});
		expect(mcpToolCallToBridgeRequest(5, "shuvgeist_agent", { workflow: { steps: [] } })).toMatchObject({
			method: "workflow_run",
			params: { workflow: { steps: [] } },
		});
	});
});
