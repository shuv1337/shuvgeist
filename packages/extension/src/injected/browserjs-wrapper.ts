import type { BrowserJsWrapperConfig, BrowserJsWrapperResult } from "@shuvgeist/driver/injected-contracts";

declare global {
	interface Window {
		__completionCallbacks?: Array<(success: boolean) => unknown>;
	}
}

type BrowserJsUserFunction = (...args: unknown[]) => unknown;
type BrowserJsUserFunctionFactory = () => BrowserJsUserFunction;

async function runCompletionCallbacks(success: boolean): Promise<void> {
	const callbacks = window.__completionCallbacks;
	if (!callbacks || callbacks.length === 0) return;
	try {
		await Promise.race([
			Promise.all(callbacks.map((callback) => callback(success))),
			new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error("Completion timeout")), 5_000);
			}),
		]);
	} catch (error) {
		console.error("Completion callback error:", error);
	}
}

export async function run(
	config: BrowserJsWrapperConfig,
	createUserFunction: BrowserJsUserFunctionFactory,
): Promise<BrowserJsWrapperResult> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		const userFunction = createUserFunction();
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeoutId = setTimeout(() => {
				reject(new Error(`Execution timeout: Code did not complete within ${config.timeoutMs / 1_000} seconds`));
			}, config.timeoutMs);
		});
		const lastValue = await Promise.race([Promise.resolve(userFunction(...config.args)), timeoutPromise]);
		await runCompletionCallbacks(true);
		return { success: true, lastValue };
	} catch (error) {
		await runCompletionCallbacks(false);
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error && error.stack ? error.stack : "",
		};
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
