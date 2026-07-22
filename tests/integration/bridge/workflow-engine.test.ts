import { WorkflowEngine } from "@shuvgeist/extension/tools/workflow-engine";

describe("workflow engine integration", () => {
	it("executes sequential, repeat, and each steps through dispatch", async () => {
		const callOrder: string[] = [];
		const dispatch = vi.fn(async (method: string, params: Record<string, unknown> | undefined) => {
			callOrder.push(`${method}:${JSON.stringify(params ?? {})}`);
			if (method === "repl") {
				return { urls: ["https://a.test", "https://b.test"] };
			}
			return { ok: true };
		});
		const engine = new WorkflowEngine({ dispatch });

		const result = await engine.run({
			steps: [
				{
					method: "repl",
					params: { title: "seed", code: "return ['https://a.test', 'https://b.test']" },
					as: "seed",
				},
				{
					repeat: 2,
					steps: [
						{
							each: "%{seed.urls}",
							item: "url",
							steps: [
								{
									method: "navigate",
									params: {
										url: "%{url}",
										label: "visit %{url}",
									},
								},
							],
						},
					],
				},
			],
		});

		expect(result.ok).toBe(true);
		expect(result.aborted).toBe(false);
		expect(result.errors).toEqual([]);
		expect(callOrder.length).toBe(5);
		expect(callOrder[0]).toContain("repl:");
		expect(callOrder[1]).toContain("navigate:");
		expect(callOrder[4]).toContain("navigate:");
	});
});
