import { WorkflowEngine } from "@shuvgeist/extension/tools/workflow-engine";

describe("WorkflowEngine", () => {
	it("applies exact-token substitution with type preservation and string interpolation", async () => {
		const dispatch = vi
			.fn()
			.mockResolvedValueOnce({ items: [1, 2], nested: { value: "ok" } })
			.mockResolvedValueOnce({ ok: true });
		const engine = new WorkflowEngine({ dispatch });

		const result = await engine.run({
			args: {
				titlePayload: {
					default: { label: "hello" },
				},
				script: {
					default: "return 1;",
				},
			},
			steps: [
				{
					method: "repl",
					params: {
						title: "%{titlePayload}",
						code: "%{script}",
						note: "script: %{script}",
					},
					as: "first",
				},
				{
					method: "navigate",
					params: {
						url: "%{first.items.0}",
						label: "next %{first.items.1}",
					},
				},
			],
		});

		expect(result.ok).toBe(true);
		expect(dispatch).toHaveBeenCalledTimes(2);
		expect(dispatch.mock.calls[0][1]).toEqual({
			title: { label: "hello" },
			code: "return 1;",
			note: "script: return 1;",
		});
		expect(dispatch.mock.calls[1][1]).toEqual({
			url: 1,
			label: "next 2",
		});
	});

	it("fails dry-run validation when required variables are missing", async () => {
		const engine = new WorkflowEngine({ dispatch: vi.fn() });
		const result = await engine.run(
			{
				steps: [
					{
						method: "navigate",
						params: {
							url: "%{missingUrl}",
						},
					},
				],
			},
			{ dryRun: true },
		);

		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain("missing variable");
	});

	it("enforces hard loop ceilings for each loops", async () => {
		const engine = new WorkflowEngine({ dispatch: vi.fn() });
		const result = await engine.run(
			{
				args: {
					urls: {
						default: Array.from({ length: 101 }, (_v, i) => `https://example.com/${i}`),
					},
				},
				steps: [
					{
						each: "%{urls}",
						item: "url",
						steps: [
							{
								method: "navigate",
								params: { url: "%{url}" },
							},
						],
					},
				],
			},
			{ dryRun: true },
		);

		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain("ceiling");
	});

	it("rejects recursive workflow methods", async () => {
		const engine = new WorkflowEngine({ dispatch: vi.fn() });
		const result = await engine.run({
			steps: [
				{
					method: "workflow_run",
					params: {},
				},
			],
		});

		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain("disallowed workflow method");
	});

	it("supports onError continue while preserving failure state", async () => {
		const dispatch = vi
			.fn()
			.mockRejectedValueOnce(new Error("navigate failed"))
			.mockResolvedValueOnce({ ok: true });
		const engine = new WorkflowEngine({ dispatch });
		const result = await engine.run({
			steps: [
				{
					method: "navigate",
					params: { url: "https://example.com" },
					onError: "continue",
				},
				{
					method: "repl",
					params: { title: "ok", code: "return 1;" },
				},
			],
		});

		expect(result.ok).toBe(false);
		expect(dispatch).toHaveBeenCalledTimes(2);
		expect(result.steps.some((step) => step.status === "ok" && step.method === "repl")).toBe(true);
	});

	it("opens and pins a new tab target, then inherits tabId for targetable steps", async () => {
		const dispatch = vi.fn(async (method: string) => {
			if (method === "navigate") {
				return { finalUrl: "https://example.com", tabId: 123 };
			}
			return { ok: true };
		});
		const engine = new WorkflowEngine({ dispatch });
		const result = await engine.run({
			target: { mode: "new-tab" },
			steps: [
				{
					method: "navigate",
					params: { url: "https://example.com" },
				},
				{
					method: "screenshot",
					params: { maxWidth: 800 },
				},
			],
		});

		expect(result.ok).toBe(true);
		expect(result.warnings).toEqual([]);
		expect(dispatch.mock.calls[0][1]).toEqual({ url: "https://example.com", newTab: true });
		expect(dispatch.mock.calls[1][1]).toEqual({ maxWidth: 800, tabId: 123 });
	});

	it("records a non-fatal warning when new-tab targetable steps run before a tab is pinned", async () => {
		const dispatch = vi.fn().mockResolvedValue({ ok: true });
		const engine = new WorkflowEngine({ dispatch });
		const result = await engine.run({
			target: { mode: "new-tab" },
			steps: [
				{
					method: "screenshot",
					params: { maxWidth: 800 },
				},
			],
		});

		expect(result.ok).toBe(true);
		expect(result.warnings).toEqual([
			expect.objectContaining({
				path: "0",
				code: "target_unpinned",
			}),
		]);
		expect(dispatch).toHaveBeenCalledWith("screenshot", { maxWidth: 800 }, undefined);
	});

	it("inherits pinned tabId and frameId unless a step explicitly overrides them", async () => {
		const dispatch = vi.fn().mockResolvedValue({ ok: true });
		const engine = new WorkflowEngine({ dispatch });
		const result = await engine.run({
			target: { mode: "pinned-tab", tabId: 55, frameId: 9 },
			steps: [
				{
					method: "page_snapshot",
					params: {},
				},
				{
					method: "ref_click",
					params: { ref: "ref-1", tabId: 77 },
				},
			],
		});

		expect(result.ok).toBe(true);
		expect(dispatch.mock.calls[0][1]).toEqual({ tabId: 55, frameId: 9 });
		expect(dispatch.mock.calls[1][1]).toEqual({ ref: "ref-1", tabId: 77, frameId: 9 });
	});

	it("requires tabId for pinned-tab workflows", async () => {
		const engine = new WorkflowEngine({ dispatch: vi.fn() });
		const result = await engine.run({
			target: { mode: "pinned-tab" },
			steps: [{ method: "screenshot", params: {} }],
		});

		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toContain("pinned-tab requires target.tabId");
	});

	it("allows CI support methods while keeping session methods disallowed", async () => {
		const dispatch = vi.fn().mockResolvedValue({ ok: true });
		const engine = new WorkflowEngine({ dispatch });

		await expect(
			engine.run({
				steps: [
					{ method: "frame_list", params: {} },
					{ method: "network_start", params: {} },
					{ method: "device_reset", params: {} },
					{ method: "perf_metrics", params: {} },
					{ method: "record_status", params: {} },
				],
			}),
		).resolves.toMatchObject({ ok: true });

		const sessionResult = await engine.run({
			steps: [{ method: "session_history", params: {} }],
		});
		expect(sessionResult.ok).toBe(false);
		expect(sessionResult.errors.join("\n")).toContain("disallowed workflow method");
	});

	it("executes workflow assertion steps and captures passing results", async () => {
		const dispatch = vi.fn().mockResolvedValue({
			ok: true,
			kind: "text",
			message: "Text assertion passed",
			attempts: 1,
		});
		const engine = new WorkflowEngine({ dispatch });
		const result = await engine.run({
			target: { mode: "pinned-tab", tabId: 42, frameId: 3 },
			steps: [
				{
					assert: { kind: "text", text: "Welcome" },
					as: "welcome",
				},
			],
		});

		expect(result.ok).toBe(true);
		expect(dispatch).toHaveBeenCalledWith("page_assert", { kind: "text", text: "Welcome", tabId: 42, frameId: 3 }, undefined);
		expect(result.steps[0]).toMatchObject({ type: "assert", status: "ok", method: "page_assert", as: "welcome" });
		expect(result.captured.welcome).toMatchObject({ ok: true, kind: "text" });
	});

	it("halts by default on failing workflow assertions", async () => {
		const dispatch = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, kind: "text", message: "Text was not found", attempts: 3 })
			.mockResolvedValueOnce({ ok: true });
		const engine = new WorkflowEngine({ dispatch });
		const result = await engine.run({
			steps: [
				{
					assert: { kind: "text", text: "Missing" },
					as: "missing",
				},
				{
					method: "screenshot",
					params: {},
				},
			],
		});

		expect(result.ok).toBe(false);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(result.steps[0]).toMatchObject({ type: "assert", status: "error", error: "Text was not found" });
		expect(result.captured.missing).toMatchObject({ ok: false, kind: "text" });
	});

	it("continues after failing workflow assertions when onError is continue", async () => {
		const dispatch = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, kind: "text", message: "Text was not found", attempts: 3 })
			.mockResolvedValueOnce({ ok: true });
		const engine = new WorkflowEngine({ dispatch });
		const result = await engine.run({
			steps: [
				{
					assert: { kind: "text", text: "Missing" },
					as: "missing",
					onError: "continue",
				},
				{
					method: "screenshot",
					params: {},
				},
			],
		});

		expect(result.ok).toBe(false);
		expect(dispatch).toHaveBeenCalledTimes(2);
		expect(result.steps[0]).toMatchObject({ type: "assert", status: "error" });
		expect(result.steps[1]).toMatchObject({ type: "command", status: "ok", method: "screenshot" });
		expect(result.captured.missing).toMatchObject({ ok: false, kind: "text" });
	});

	it("returns partial results on abort", async () => {
		const controller = new AbortController();
		const dispatch = vi.fn(async (method: string) => {
			if (method === "navigate") {
				return { page: "ok" };
			}
			controller.abort();
			throw new Error("aborted");
		});
		const engine = new WorkflowEngine({ dispatch });
		const result = await engine.run(
			{
				steps: [
					{
						method: "navigate",
						params: { url: "https://example.com" },
						as: "page",
					},
					{
						method: "repl",
						params: { title: "next", code: "return 1;" },
					},
				],
			},
			{ signal: controller.signal },
		);

		expect(result.aborted).toBe(true);
		expect(result.steps.some((step) => step.method === "navigate" && step.status === "ok")).toBe(true);
		expect(result.steps.some((step) => step.method === "repl" && step.status === "aborted")).toBe(true);
		expect(result.captured.page).toEqual({ page: "ok" });
	});

	it("truncates oversized step payloads predictably", async () => {
		const dispatch = vi.fn().mockResolvedValue("x".repeat(40));
		const engine = new WorkflowEngine({
			dispatch,
			maxStepResultChars: 10,
		});
		const result = await engine.run({
			steps: [
				{
					method: "repl",
					params: { title: "t", code: "return 1;" },
				},
			],
		});

		expect(result.ok).toBe(true);
		const step = result.steps.find((entry) => entry.method === "repl");
		expect(typeof step?.result).toBe("string");
		expect(step?.result).toContain("[truncated");
	});

	it("normalizes recorded results to recursive JSON wire values", async () => {
		const dispatch = vi.fn().mockResolvedValue({
			finalUrl: "https://example.com",
			tabId: 42,
			optional: undefined,
			nested: { kept: true, missing: undefined },
			list: [1, undefined],
			bigint: 2n,
		});
		const engine = new WorkflowEngine({ dispatch });
		const result = await engine.run({
			steps: [{ method: "navigate", params: { url: "https://example.com" }, as: "navigation" }],
		});

		const expected = {
			finalUrl: "https://example.com",
			tabId: 42,
			nested: { kept: true },
			list: [1, null],
			bigint: "2",
		};
		expect(result.steps[0]?.result).toEqual(expected);
		expect(result.captured.navigation).toEqual(expected);
		expect(() => JSON.stringify(result)).not.toThrow();
	});
});
