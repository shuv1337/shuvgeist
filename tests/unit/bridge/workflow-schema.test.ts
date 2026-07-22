import {
	WORKFLOW_MAX_LOOP_ITERATIONS,
	formatWorkflowValidationErrors,
	validateWorkflowDefinition,
} from "@shuvgeist/protocol/workflow-schema";

describe("workflow schema", () => {
	it("accepts valid command, repeat, and each workflows", () => {
		const workflow = {
			name: "valid-workflow",
			target: {
				mode: "new-tab",
			},
			args: {
				urls: {
					required: true,
				},
			},
			defaultWait: {
				type: "dom_stable",
				timeoutMs: 3_000,
			},
			steps: [
				{
					method: "navigate",
					params: {
						url: "%{startUrl}",
					},
					onError: "stop",
				},
				{
					assert: {
						kind: "text",
						text: "Welcome",
						timeoutMs: 5000,
					},
					as: "welcome",
				},
				{
					repeat: 2,
					steps: [
						{
							method: "repl",
							params: {
								title: "loop",
								code: "return 1;",
							},
						},
					],
				},
				{
					each: "%{urls}",
					item: "url",
					steps: [
						{
							method: "navigate",
							params: {
								url: "%{url}",
							},
							onError: "continue",
						},
					],
				},
			],
		};

		const result = validateWorkflowDefinition(workflow);
		expect(result.ok).toBe(true);
	});

	it("rejects repeat loops above the hard cap", () => {
		const result = validateWorkflowDefinition({
			steps: [
				{
					repeat: WORKFLOW_MAX_LOOP_ITERATIONS + 1,
					steps: [{ method: "navigate", params: { url: "https://example.com" } }],
				},
			],
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			const messages = formatWorkflowValidationErrors(result.errors).join("\n");
			expect(messages).toContain("Expected union value");
		}
	});

	it("rejects invalid step objects", () => {
		const result = validateWorkflowDefinition({
			steps: [
				{
					params: { url: "https://example.com" },
				},
			],
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.length).toBeGreaterThan(0);
		}
	});
});
