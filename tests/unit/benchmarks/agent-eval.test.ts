import {
	assertValidRunsPerScenario,
	buildAgentEvalReport,
	DEFAULT_AGENT_EVAL_RUNS,
	renderAgentEvalComparisonMarkdown,
	renderAgentEvalMarkdown,
	runAgentEval,
	runPlannerValidatorComparison,
} from "../../../benchmarks/agent-eval/core.js";

const scenarios = [
	{
		id: "a",
		title: "Scenario A",
		startUrl: "fixture://a",
		instruction: "Do A",
		validator: { kind: "text" as const, expected: "Done" },
		baselineTokenBudget: 100,
	},
	{
		id: "b",
		title: "Scenario B",
		startUrl: "fixture://b",
		instruction: "Do B",
		validator: { kind: "url" as const, expected: "fixture://b/done" },
		baselineTokenBudget: 200,
		driftEvery: 2,
	},
];

describe("agent eval harness", () => {
	it("requires at least eight runs per scenario", async () => {
		expect(() => assertValidRunsPerScenario(DEFAULT_AGENT_EVAL_RUNS - 1)).toThrow("at least 8 runs");
		await expect(runAgentEval({ scenarios, runsPerScenario: 7 })).rejects.toThrow("at least 8 runs");
	});

	it("reports pass rate and token totals", () => {
		const report = buildAgentEvalReport({
			generatedAt: "2026-06-01T00:00:00.000Z",
			runsPerScenario: 8,
			scenarios,
			attempts: [
				{ scenarioId: "a", run: 1, passed: true, tokens: { input: 10, output: 2, total: 12 }, durationMs: 5 },
				{ scenarioId: "a", run: 2, passed: false, tokens: { input: 8, output: 1, total: 9 }, durationMs: 4 },
				{ scenarioId: "b", run: 1, passed: true, tokens: { input: 20, output: 3, total: 23 }, durationMs: 7 },
			],
		});

		expect(report.summary).toMatchObject({
			scenarios: 2,
			attempts: 3,
			passed: 2,
			failed: 1,
			passRate: 2 / 3,
			tokens: { input: 38, output: 6, total: 44, averageTotal: 44 / 3 },
			durationMs: 16,
		});
		expect(report.scenarios[0]).toMatchObject({
			scenarioId: "a",
			attempts: 2,
			passed: 1,
			failed: 1,
			passRate: 0.5,
			tokens: { total: 21, averageTotal: 10.5 },
		});
	});

	it("runs the deterministic baseline and renders markdown", async () => {
		const report = await runAgentEval({
			scenarios,
			runsPerScenario: 8,
			now: () => new Date("2026-06-01T00:00:00.000Z"),
		});
		expect(report.summary.attempts).toBe(16);
		expect(report.summary.passRate).toBe(1);
		expect(report.summary.tokens.total).toBeGreaterThan(0);

		const markdown = renderAgentEvalMarkdown(report);
		expect(markdown).toContain("Agent Eval Report");
		expect(markdown).toContain("Overall pass rate: 100.0% (16/16)");
		expect(markdown).toContain("| a | 8/8 | 100.0%");
	});

	it("compares baseline against planner-validator recovery", async () => {
		const report = await runPlannerValidatorComparison({
			scenarios,
			runsPerScenario: 8,
			now: () => new Date("2026-06-01T00:00:00.000Z"),
		});

		expect(report.baseline.summary).toMatchObject({ attempts: 16, passed: 12, failed: 4, passRate: 0.75 });
		expect(report.plannerValidator.summary).toMatchObject({ attempts: 16, passed: 16, failed: 0, passRate: 1 });
		expect(report.improvement.passRateDelta).toBe(0.25);
		expect(report.improvement.passedDelta).toBe(4);
		expect(report.improvement.tokenDelta).toBeGreaterThan(0);

		const markdown = renderAgentEvalComparisonMarkdown(report);
		expect(markdown).toContain("Agent Eval Comparison Report");
		expect(markdown).toContain("| baseline | 12/16 | 75.0%");
		expect(markdown).toContain("| planner-validator | 16/16 | 100.0%");
		expect(markdown).toContain("Pass-rate delta: 25.0%");
	});
});
