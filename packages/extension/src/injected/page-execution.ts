import type {
	PageExecutionConsoleEntry,
	PageExecutionConsoleMethod,
	PageExecutionInjectionConfig,
	PageExecutionInjectionResult,
} from "@shuvgeist/driver/injected-contracts";

type PageFunction = (...args: unknown[]) => unknown;

export async function run(
	config: PageExecutionInjectionConfig,
	pageFunction: PageFunction,
): Promise<PageExecutionInjectionResult> {
	const consoleLogs: PageExecutionConsoleEntry[] = [];
	const originalConsole = {
		log: console.log.bind(console),
		warn: console.warn.bind(console),
		error: console.error.bind(console),
		info: console.info.bind(console),
	};
	const capture =
		(method: PageExecutionConsoleMethod) =>
		(...args: unknown[]) => {
			let text: string;
			try {
				text = args.map((value) => (typeof value === "object" ? JSON.stringify(value) : String(value))).join(" ");
			} catch {
				text = args.map((value) => String(value)).join(" ");
			}
			consoleLogs.push({ type: method, text });
			originalConsole[method](...args);
		};

	if (config.includeConsole) {
		console.log = capture("log");
		console.warn = capture("warn");
		console.error = capture("error");
		console.info = capture("info");
	}

	try {
		const value = await pageFunction(...config.args);
		return { success: true, value, console: consoleLogs };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error && error.stack ? error.stack : "",
			console: consoleLogs,
		};
	} finally {
		if (config.includeConsole) {
			console.log = originalConsole.log;
			console.warn = originalConsole.warn;
			console.error = originalConsole.error;
			console.info = originalConsole.info;
		}
	}
}
