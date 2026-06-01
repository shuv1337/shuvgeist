import type { CdpSessionDomain, CdpSessionEnsureDomainOptions } from "../../tools/helpers/cdp-session.js";
import type { BridgeScreenshotResult, PageAssertParams, PageAssertResult } from "../protocol.js";
import type { BridgeSkillSnapshotStatus } from "../skill-snapshot.js";

interface PageAssertCheckResult {
	ok: boolean;
	message: string;
	actual?: unknown;
	expected?: unknown;
}

export interface ElectronPageCdpClient {
	send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
	ensureDomain?(domain: CdpSessionDomain, options?: CdpSessionEnsureDomainOptions): Promise<void>;
	close(): void;
}

export interface ElectronEvaluateOptions {
	code: string;
	skillLibrary?: string;
	skillsSnapshotStatus?: BridgeSkillSnapshotStatus;
	includeSkillsSnapshot?: boolean;
}

export async function evaluateElectronWindow(client: ElectronPageCdpClient, options: ElectronEvaluateOptions) {
	const response = await client.send<{
		result?: { type?: string; value?: unknown; description?: string };
		exceptionDetails?: { text?: string; exception?: { description?: string } };
	}>("Runtime.evaluate", {
		expression: (options.skillLibrary ?? "") + options.code,
		awaitPromise: true,
		returnByValue: true,
	});
	if (response.exceptionDetails) {
		throw new Error(
			response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Evaluation failed",
		);
	}
	const value = response.result?.value ?? response.result?.description ?? null;
	return {
		output: typeof value === "string" ? value : JSON.stringify(value),
		result: value,
		skillsSnapshot: options.includeSkillsSnapshot ? options.skillsSnapshotStatus : undefined,
	};
}

export async function captureElectronWindowScreenshot(
	client: ElectronPageCdpClient,
	maxWidth?: number,
): Promise<BridgeScreenshotResult> {
	await ensureElectronCdpDomain(client, "Page");
	const viewport = await client.send<{
		result?: {
			value?: { innerWidth?: number; innerHeight?: number; devicePixelRatio?: number };
		};
	}>("Runtime.evaluate", {
		expression: "({ innerWidth, innerHeight, devicePixelRatio })",
		returnByValue: true,
	});
	const cssWidth = viewport.result?.value?.innerWidth ?? 0;
	const cssHeight = viewport.result?.value?.innerHeight ?? 0;
	const devicePixelRatio = viewport.result?.value?.devicePixelRatio ?? 1;
	const capture = await client.send<{ data: string }>("Page.captureScreenshot", {
		format: "png",
		captureBeyondViewport: false,
	});
	const imageWidth = maxWidth && cssWidth > maxWidth ? maxWidth : Math.round(cssWidth * devicePixelRatio);
	const imageHeight = Math.round(cssHeight * (imageWidth / Math.max(cssWidth, 1)));
	return {
		mimeType: "image/png",
		dataUrl: "data:image/png;base64," + capture.data,
		cssWidth,
		cssHeight,
		imageWidth,
		imageHeight,
		devicePixelRatio,
		scale: cssWidth > 0 ? imageWidth / cssWidth : 1,
	};
}

async function ensureElectronCdpDomain(client: ElectronPageCdpClient, domain: CdpSessionDomain): Promise<void> {
	if (client.ensureDomain) {
		await client.ensureDomain(domain);
		return;
	}
	await client.send(domain + ".enable");
}

export async function assertElectronWindow(
	client: ElectronPageCdpClient,
	params: PageAssertParams,
): Promise<PageAssertResult> {
	const startedAt = Date.now();
	const timeoutMs = params.timeoutMs ?? 5_000;
	const intervalMs = params.intervalMs ?? 100;
	const deadline = startedAt + timeoutMs;
	let attempts = 0;
	let lastResult: PageAssertCheckResult | undefined;
	do {
		attempts += 1;
		lastResult = await checkElectronWindowAssertion(client, params, Math.max(1, deadline - Date.now()));
		if (lastResult.ok) {
			return buildElectronPageAssertResult(params, true, attempts, startedAt, timeoutMs, lastResult);
		}
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
	} while (Date.now() < deadline);
	return buildElectronPageAssertResult(
		params,
		false,
		attempts,
		startedAt,
		timeoutMs,
		lastResult ?? { ok: false, message: "Page assertion timed out before executing" },
	);
}

async function checkElectronWindowAssertion(
	client: ElectronPageCdpClient,
	params: PageAssertParams,
	timeoutMs: number,
): Promise<PageAssertCheckResult> {
	const response = await client.send<{
		result?: { value?: PageAssertCheckResult };
		exceptionDetails?: { text?: string; exception?: { description?: string } };
	}>("Runtime.evaluate", {
		expression: `(${ELECTRON_PAGE_ASSERT_SCRIPT})(${JSON.stringify(params)})`,
		awaitPromise: true,
		returnByValue: true,
		timeout: timeoutMs,
	});
	if (response.exceptionDetails) {
		return {
			ok: false,
			message:
				response.exceptionDetails.exception?.description ??
				response.exceptionDetails.text ??
				"Page assertion failed",
		};
	}
	return response.result?.value ?? { ok: false, message: "Page assertion script returned no result" };
}

function buildElectronPageAssertResult(
	params: PageAssertParams,
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
		tabId: -1,
		frameId: 0,
	};
}

const ELECTRON_PAGE_ASSERT_SCRIPT = String.raw`function electronPageAssertScript(params) {
	const isVisible = (element) => {
		const style = window.getComputedStyle(element);
		const rect = element.getBoundingClientRect();
		return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
	};
	const isEnabled = (element) => !("disabled" in element) || !element.disabled;
	const matchesText = (actual, expected) => {
		const value = actual || "";
		return params.exact ? value.trim() === expected : value.toLowerCase().includes(expected.toLowerCase());
	};
	const filterElements = (elements) =>
		elements.filter((element) => {
			if (params.visible === true && !isVisible(element)) return false;
			if (params.enabled === true && !isEnabled(element)) return false;
			return true;
		});
	const checkCount = (count, label) => {
		if (typeof params.count === "number") {
			return {
				ok: count === params.count,
				message: count === params.count ? label + " count matched" : label + " count " + count + " did not equal " + params.count,
				actual: count,
				expected: params.count,
			};
		}
		if (typeof params.minCount === "number" && count < params.minCount) {
			return { ok: false, message: label + " count " + count + " was below " + params.minCount, actual: count, expected: params.minCount };
		}
		if (typeof params.maxCount === "number" && count > params.maxCount) {
			return { ok: false, message: label + " count " + count + " was above " + params.maxCount, actual: count, expected: params.maxCount };
		}
		return { ok: count > 0, message: count > 0 ? label + " matched" : label + " did not match", actual: count, expected: ">= 1" };
	};
	if (params.kind === "expression") {
		if (!params.expression) return { ok: false, message: "Expression assertion requires expression" };
		const value = new Function("return (" + params.expression + ");")();
		return { ok: Boolean(value), message: value ? "Expression assertion passed" : "Expression assertion failed", actual: value, expected: true };
	}
	if (params.kind === "url") {
		const expected = params.url || params.urlPattern;
		if (!expected) return { ok: false, message: "URL assertion requires url or urlPattern" };
		const actual = window.location.href;
		const ok = params.urlPattern ? new RegExp(params.urlPattern).test(actual) : actual === expected;
		return { ok, message: ok ? "URL assertion passed" : "URL '" + actual + "' did not match '" + expected + "'", actual, expected };
	}
	if (params.kind === "text") {
		if (!params.text) return { ok: false, message: "Text assertion requires text" };
		const actual = (document.body && (document.body.innerText || document.body.textContent)) || "";
		const ok = matchesText(actual, params.text);
		return { ok, message: ok ? "Text assertion passed" : "Text '" + params.text + "' was not found", actual, expected: params.text };
	}
	if (params.kind === "selector") {
		if (!params.selector) return { ok: false, message: "Selector assertion requires selector" };
		return checkCount(filterElements(Array.from(document.querySelectorAll(params.selector))).length, "Selector '" + params.selector + "'");
	}
	if (params.kind === "role") {
		if (!params.role) return { ok: false, message: "Role assertion requires role" };
		const role = params.role.toLowerCase();
		const escapedRole = window.CSS && CSS.escape ? CSS.escape(params.role) : String(params.role).replace(/["\\]/g, "\\$&");
		const explicit = Array.from(document.querySelectorAll('[role="' + escapedRole + '"]'));
		const native =
			role === "button"
				? Array.from(document.querySelectorAll("button,input[type='button'],input[type='submit'],input[type='reset']"))
				: role === "link"
					? Array.from(document.querySelectorAll("a[href]"))
					: role === "textbox"
						? Array.from(document.querySelectorAll("input:not([type]),input[type='text'],input[type='email'],input[type='search'],textarea"))
						: [];
		const elements = filterElements([...explicit, ...native]).filter((element, index, all) => all.indexOf(element) === index);
		const named = params.name ? elements.filter((element) => matchesText(element.textContent || element.getAttribute("aria-label"), params.name)) : elements;
		return checkCount(named.length, "Role '" + params.role + "'");
	}
	if (params.kind === "label") {
		if (!params.label) return { ok: false, message: "Label assertion requires label" };
		const labels = filterElements(Array.from(document.querySelectorAll("label"))).filter((label) => matchesText(label.textContent, params.label));
		return checkCount(labels.length, "Label '" + params.label + "'");
	}
	return { ok: false, message: "Unsupported assertion kind '" + String(params.kind) + "'" };
}`;
