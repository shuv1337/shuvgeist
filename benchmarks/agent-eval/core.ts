import { AGENT_EVAL_SCENARIOS, type AgentEvalScenario } from "./scenarios.js";

export const DEFAULT_AGENT_EVAL_RUNS = 8;

export interface AgentEvalAttempt {
	scenarioId: string;
	run: number;
	passed: boolean;
	tokens: {
		input: number;
		output: number;
		total: number;
	};
	durationMs: number;
	message?: string;
}

export interface AgentEvalScenarioReport {
	scenarioId: string;
	title: string;
	attempts: number;
	passed: number;
	failed: number;
	passRate: number;
	tokens: {
		input: number;
		output: number;
		total: number;
		averageTotal: number;
	};
	durationMs: number;
}

export interface AgentEvalReport {
	generatedAt: string;
	runsPerScenario: number;
	scenarios: AgentEvalScenarioReport[];
	summary: {
		scenarios: number;
		attempts: number;
		passed: number;
		failed: number;
		passRate: number;
		tokens: {
			input: number;
			output: number;
			total: number;
			averageTotal: number;
		};
		durationMs: number;
	};
}

export interface AgentEvalExecutor {
	execute(scenario: AgentEvalScenario, run: number): Promise<AgentEvalAttempt>;
}

export interface RunAgentEvalOptions {
	scenarios?: AgentEvalScenario[];
	runsPerScenario?: number;
	executor?: AgentEvalExecutor;
	now?: () => Date;
}

export function assertValidRunsPerScenario(runsPerScenario: number): void {
	if (!Number.isInteger(runsPerScenario) || runsPerScenario < DEFAULT_AGENT_EVAL_RUNS) {
		throw new Error(`agent eval requires at least ${DEFAULT_AGENT_EVAL_RUNS} runs per scenario`);
	}
}

export async function runAgentEval(options: RunAgentEvalOptions = {}): Promise<AgentEvalReport> {
	const scenarios = options.scenarios ?? AGENT_EVAL_SCENARIOS;
	const runsPerScenario = options.runsPerScenario ?? DEFAULT_AGENT_EVAL_RUNS;
	assertValidRunsPerScenario(runsPerScenario);
	const executor = options.executor ?? createDeterministicAgentEvalExecutor();
	const attempts: AgentEvalAttempt[] = [];

	for (const scenario of scenarios) {
		for (let run = 1; run <= runsPerScenario; run++) {
			attempts.push(await executor.execute(scenario, run));
		}
	}

	return buildAgentEvalReport({
		generatedAt: (options.now ?? (() => new Date()))().toISOString(),
		runsPerScenario,
		scenarios,
		attempts,
	});
}

export function buildAgentEvalReport(input: {
	generatedAt: string;
	runsPerScenario: number;
	scenarios: AgentEvalScenario[];
	attempts: AgentEvalAttempt[];
}): AgentEvalReport {
	const scenarioReports = input.scenarios.map((scenario) => {
		const attempts = input.attempts.filter((attempt) => attempt.scenarioId === scenario.id);
		const passed = attempts.filter((attempt) => attempt.passed).length;
		const tokenTotals = sumTokens(attempts);
		return {
			scenarioId: scenario.id,
			title: scenario.title,
			attempts: attempts.length,
			passed,
			failed: attempts.length - passed,
			passRate: ratio(passed, attempts.length),
			tokens: {
				...tokenTotals,
				averageTotal: ratio(tokenTotals.total, attempts.length),
			},
			durationMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
		} satisfies AgentEvalScenarioReport;
	});
	const allAttempts = input.attempts;
	const passed = allAttempts.filter((attempt) => attempt.passed).length;
	const tokenTotals = sumTokens(allAttempts);
	return {
		generatedAt: input.generatedAt,
		runsPerScenario: input.runsPerScenario,
		scenarios: scenarioReports,
		summary: {
			scenarios: input.scenarios.length,
			attempts: allAttempts.length,
			passed,
			failed: allAttempts.length - passed,
			passRate: ratio(passed, allAttempts.length),
			tokens: {
				...tokenTotals,
				averageTotal: ratio(tokenTotals.total, allAttempts.length),
			},
			durationMs: allAttempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
		},
	};
}

export function renderAgentEvalMarkdown(report: AgentEvalReport): string {
	const rows = report.scenarios
		.map(
			(scenario) =>
				`| ${scenario.scenarioId} | ${scenario.passed}/${scenario.attempts} | ${formatPercent(scenario.passRate)} | ${scenario.tokens.total} | ${Math.round(scenario.tokens.averageTotal)} |`,
		)
		.join("\n");
	return [
		"# Agent Eval Report",
		"",
		`Generated: ${report.generatedAt}`,
		`Runs per scenario: ${report.runsPerScenario}`,
		"",
		`Overall pass rate: ${formatPercent(report.summary.passRate)} (${report.summary.passed}/${report.summary.attempts})`,
		`Total tokens: ${report.summary.tokens.total}`,
		`Average tokens per attempt: ${Math.round(report.summary.tokens.averageTotal)}`,
		"",
		"| Scenario | Passed | Pass rate | Tokens | Avg tokens |",
		"| --- | ---: | ---: | ---: | ---: |",
		rows,
		"",
	].join("\n");
}

export function createDeterministicAgentEvalExecutor(): AgentEvalExecutor {
	return {
		async execute(scenario, run) {
			const input = scenario.baselineTokenBudget + scenario.instruction.length + run;
			const output = Math.ceil(scenario.validator.expected.length / 2) + 40;
			return {
				scenarioId: scenario.id,
				run,
				passed: true,
				tokens: { input, output, total: input + output },
				durationMs: 25 + run,
				message: "deterministic baseline",
			};
		},
	};
}

function sumTokens(attempts: AgentEvalAttempt[]): { input: number; output: number; total: number } {
	return attempts.reduce(
		(sum, attempt) => ({
			input: sum.input + attempt.tokens.input,
			output: sum.output + attempt.tokens.output,
			total: sum.total + attempt.tokens.total,
		}),
		{ input: 0, output: 0, total: 0 },
	);
}

function ratio(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : numerator / denominator;
}

function formatPercent(value: number): string {
	return (value * 100).toFixed(1) + "%";
}
