import type { PageAssertParams, PageAssertResult } from "../bridge/protocol.js";
import { executePageFunction } from "./helpers/page-execution.js";

const PAGE_ASSERT_WORLD_ID = "shuvgeist-page-assert";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_INTERVAL_MS = 100;

interface PageAssertCheckResult {
	ok: boolean;
	message: string;
	actual?: unknown;
	expected?: unknown;
}

export async function runPageAssert(
	params: PageAssertParams,
	target: { tabId: number; frameId?: number },
	signal?: AbortSignal,
): Promise<PageAssertResult> {
	const startedAt = Date.now();
	const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const intervalMs = params.intervalMs ?? DEFAULT_INTERVAL_MS;
	const deadline = startedAt + timeoutMs;
	let attempts = 0;
	let lastResult: PageAssertCheckResult | undefined;

	do {
		if (signal?.aborted) {
			throw new Error("Page assertion aborted");
		}
		attempts += 1;
		const execution = await executePageFunction<PageAssertCheckResult>(target, pageAssertInPage, {
			worldId: PAGE_ASSERT_WORLD_ID,
			args: [params],
			signal,
			timeoutMs: Math.max(1, deadline - Date.now()),
		});
		lastResult = execution.success
			? execution.value
			: {
					ok: false,
					message: execution.error ?? "Page assertion script failed",
				};
		if (lastResult?.ok) {
			return buildPageAssertResult(params, target, true, attempts, startedAt, timeoutMs, lastResult);
		}
		if (Date.now() >= deadline) {
			break;
		}
		await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
	} while (Date.now() < deadline);

	return buildPageAssertResult(
		params,
		target,
		false,
		attempts,
		startedAt,
		timeoutMs,
		lastResult ?? { ok: false, message: "Page assertion timed out before executing" },
	);
}

export function buildMainWorldExpressionAssertCode(expression: string): string {
	return `
(async () => {
	const __started = Date.now();
	try {
		const __value = await (async () => (${expression}))();
		return {
			ok: Boolean(__value),
			message: Boolean(__value) ? "Expression assertion passed" : "Expression assertion failed",
			actual: __value,
			durationMs: Date.now() - __started,
		};
	} catch (__err) {
		return {
			ok: false,
			message: __err && __err.message ? __err.message : String(__err),
			actual: undefined,
			durationMs: Date.now() - __started,
		};
	}
})()
`;
}

export function buildPageAssertResult(
	params: PageAssertParams,
	target: { tabId: number; frameId?: number },
	ok: boolean,
	attempts: number,
	startedAt: number,
	timeoutMs: number,
	check: PageAssertCheckResult,
): PageAssertResult {
	return {
		ok,
		kind: params.kind,
		message: check.message,
		actual: check.actual,
		expected: check.expected,
		attempts,
		durationMs: Date.now() - startedAt,
		timeoutMs,
		tabId: target.tabId,
		frameId: target.frameId ?? 0,
	};
}

function pageAssertInPage(params: PageAssertParams): PageAssertCheckResult {
	const isVisible = (element: Element): boolean => {
		const style = window.getComputedStyle(element);
		const rect = element.getBoundingClientRect();
		return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
	};
	const isEnabled = (element: Element): boolean => {
		return (
			!(
				element instanceof HTMLButtonElement ||
				element instanceof HTMLInputElement ||
				element instanceof HTMLSelectElement ||
				element instanceof HTMLTextAreaElement
			) || !element.disabled
		);
	};
	const matchesText = (actual: string | null | undefined, expected: string): boolean => {
		const value = actual ?? "";
		return params.exact ? value.trim() === expected : value.toLowerCase().includes(expected.toLowerCase());
	};
	const filterElements = (elements: Element[]): Element[] => {
		return elements.filter((element) => {
			if (params.visible === true && !isVisible(element)) return false;
			if (params.enabled === true && !isEnabled(element)) return false;
			return true;
		});
	};
	const checkCount = (count: number, label: string): PageAssertCheckResult => {
		if (typeof params.count === "number") {
			return {
				ok: count === params.count,
				message:
					count === params.count
						? `${label} count matched`
						: `${label} count ${count} did not equal ${params.count}`,
				actual: count,
				expected: params.count,
			};
		}
		if (typeof params.minCount === "number" && count < params.minCount) {
			return {
				ok: false,
				message: `${label} count ${count} was below ${params.minCount}`,
				actual: count,
				expected: params.minCount,
			};
		}
		if (typeof params.maxCount === "number" && count > params.maxCount) {
			return {
				ok: false,
				message: `${label} count ${count} was above ${params.maxCount}`,
				actual: count,
				expected: params.maxCount,
			};
		}
		return {
			ok: count > 0,
			message: count > 0 ? `${label} matched` : `${label} did not match`,
			actual: count,
			expected: ">= 1",
		};
	};

	if (params.kind === "expression") {
		if (!params.expression) {
			return { ok: false, message: "Expression assertion requires expression" };
		}
		const evaluator = new Function(`return (${params.expression});`) as () => unknown;
		const value = evaluator();
		return {
			ok: Boolean(value),
			message: value ? "Expression assertion passed" : "Expression assertion failed",
			actual: value,
			expected: true,
		};
	}

	if (params.kind === "url") {
		const expected = params.url ?? params.urlPattern;
		if (!expected) return { ok: false, message: "URL assertion requires url or urlPattern" };
		const actual = window.location.href;
		const ok = params.urlPattern ? new RegExp(params.urlPattern).test(actual) : actual === expected;
		return {
			ok,
			message: ok ? "URL assertion passed" : `URL '${actual}' did not match '${expected}'`,
			actual,
			expected,
		};
	}

	if (params.kind === "text") {
		if (!params.text) return { ok: false, message: "Text assertion requires text" };
		const actual = document.body?.innerText ?? document.body?.textContent ?? "";
		const ok = matchesText(actual, params.text);
		return {
			ok,
			message: ok ? "Text assertion passed" : `Text '${params.text}' was not found`,
			actual,
			expected: params.text,
		};
	}

	if (params.kind === "selector") {
		if (!params.selector) return { ok: false, message: "Selector assertion requires selector" };
		const elements = filterElements(Array.from(document.querySelectorAll(params.selector)));
		return checkCount(elements.length, `Selector '${params.selector}'`);
	}

	if (params.kind === "role") {
		if (!params.role) return { ok: false, message: "Role assertion requires role" };
		const role = params.role.toLowerCase();
		const explicit = Array.from(document.querySelectorAll(`[role="${CSS.escape(params.role)}"]`));
		const native =
			role === "button"
				? Array.from(
						document.querySelectorAll("button,input[type='button'],input[type='submit'],input[type='reset']"),
					)
				: role === "link"
					? Array.from(document.querySelectorAll("a[href]"))
					: role === "textbox"
						? Array.from(
								document.querySelectorAll(
									"input:not([type]),input[type='text'],input[type='email'],input[type='search'],textarea",
								),
							)
						: [];
		const elements = filterElements([...explicit, ...native]).filter(
			(element, index, all) => all.indexOf(element) === index,
		);
		const named = params.name
			? elements.filter((element) =>
					matchesText(element.textContent || element.getAttribute("aria-label"), params.name ?? ""),
				)
			: elements;
		return checkCount(named.length, `Role '${params.role}'`);
	}

	if (params.kind === "label") {
		if (!params.label) return { ok: false, message: "Label assertion requires label" };
		const labels = filterElements(Array.from(document.querySelectorAll("label"))).filter((label) =>
			matchesText(label.textContent, params.label ?? ""),
		);
		return checkCount(labels.length, `Label '${params.label}'`);
	}

	return { ok: false, message: `Unsupported assertion kind '${String(params.kind)}'` };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Page assertion aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new Error("Page assertion aborted"));
			},
			{ once: true },
		);
	});
}
