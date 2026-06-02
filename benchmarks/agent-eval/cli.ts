import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderAgentEvalMarkdown, runAgentEval } from "./core.js";

interface CliOptions {
	runsPerScenario?: number;
	jsonOut?: string;
	markdownOut?: string;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const report = await runAgentEval({ runsPerScenario: options.runsPerScenario });
	const jsonOut = options.jsonOut ?? "benchmarks/agent-eval/reports/latest.json";
	const markdownOut = options.markdownOut ?? "benchmarks/agent-eval/reports/latest.md";
	writeText(jsonOut, JSON.stringify(report, null, 2) + "\n");
	writeText(markdownOut, renderAgentEvalMarkdown(report));
	console.log(
		`Agent eval complete: ${report.summary.passed}/${report.summary.attempts} passed, ${report.summary.tokens.total} tokens`,
	);
	console.log(`JSON: ${jsonOut}`);
	console.log(`Markdown: ${markdownOut}`);
}

export function parseArgs(args: string[]): CliOptions {
	const options: CliOptions = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--runs") {
			options.runsPerScenario = Number.parseInt(requireValue(args, ++index, arg), 10);
		} else if (arg === "--json-out") {
			options.jsonOut = requireValue(args, ++index, arg);
		} else if (arg === "--markdown-out") {
			options.markdownOut = requireValue(args, ++index, arg);
		} else if (arg === "--help") {
			printHelp();
			process.exit(0);
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

function requireValue(args: string[], index: number, flag: string): string {
	const value = args[index];
	if (!value) throw new Error(`${flag} requires a value`);
	return value;
}

function writeText(path: string, contents: string): void {
	const absolute = resolve(path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

function printHelp(): void {
	console.log(`Usage: npm run bench:agent-eval -- [options]

Options:
  --runs <n>             Runs per scenario. Must be at least 8.
  --json-out <path>      JSON report path. Defaults to benchmarks/agent-eval/reports/latest.json.
  --markdown-out <path>  Markdown report path. Defaults to benchmarks/agent-eval/reports/latest.md.
`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
