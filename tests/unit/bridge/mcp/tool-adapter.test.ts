import { MCP_TOOL_DEFINITIONS, mcpToolCallToBridgeRequest } from "@shuvgeist/server/mcp/tool-adapter";

describe("mcp tool adapter", () => {
	it("exposes observe, act, extract, agent, and handoff tools", () => {
		expect(MCP_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
			"shuvgeist_observe",
			"shuvgeist_act",
			"shuvgeist_extract",
			"shuvgeist_agent",
			"shuvgeist_handoff",
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

	it("maps observe storage and semantic diff modes through the same capability-gated surface", () => {
		expect(mcpToolCallToBridgeRequest(2, "shuvgeist_observe", { store: true, maxEntries: 50 })).toMatchObject({
			method: "snapshot_store",
			params: { maxEntries: 50 },
		});
		expect(
			mcpToolCallToBridgeRequest(3, "shuvgeist_observe", {
				baselineId: "chrome:7:frame:0:generation:1:snapshot:100",
				query: "billing",
			}),
		).toMatchObject({
			method: "snapshot_diff",
			params: {
				baselineId: "chrome:7:frame:0:generation:1:snapshot:100",
				query: "billing",
			},
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

	it("maps a target-bound handoff without leaking its message into metadata", () => {
		expect(
			mcpToolCallToBridgeRequest(6, "shuvgeist_handoff", {
				taskId: "task-1",
				sessionId: "session-1",
				kind: "browser-native",
				message: "Complete the passkey prompt",
				timeoutMs: 45_000,
				triggerRefId: "sign-in",
				triggerMode: "cdp-trusted",
				target: { kind: "chrome-tab", tabId: 42, frameId: 0 },
			}),
		).toEqual({
			id: 6,
			method: "handoff_start",
			params: {
				taskId: "task-1",
				sessionId: "session-1",
				kind: "browser-native",
				message: "Complete the passkey prompt",
				timeoutMs: 45_000,
				trigger: { refId: "sign-in", mode: "cdp-trusted" },
			},
			target: { kind: "chrome-tab", tabId: 42, frameId: 0 },
		});
	});
});
