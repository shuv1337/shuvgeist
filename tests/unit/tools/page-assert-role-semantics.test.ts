import { Window } from "happy-dom";
import type { PageAssertParams, PageAssertResult } from "@shuvgeist/protocol/protocol";
import type {
	ElectronPageAssertScope,
	ElectronPageCdpClient,
} from "@shuvgeist/server/electron/window-executor";

const executePageFunction = vi.hoisted(() => vi.fn());

vi.mock("@shuvgeist/extension/tools/helpers/page-execution", () => ({
	executePageFunction,
}));

import { assertElectronWindow } from "@shuvgeist/server/electron/window-executor";
import { runPageAssert } from "@shuvgeist/extension/tools/page-assert";

interface AssertionCheckResult {
	ok: boolean;
	message: string;
	actual?: unknown;
	expected?: unknown;
}

const css = {
	escape(value: string): string {
		return value.replace(/["\\]/g, "\\$&");
	},
};

const electronPageScope: ElectronPageAssertScope = {
	target: {
		kind: "electron-window",
		sessionId: "e1",
		windowRef: "w1",
		targetId: "target-1",
	},
	navigationGeneration: 0,
};

function installBrowserGlobals(browserWindow: Window): void {
	Object.defineProperty(browserWindow, "CSS", { configurable: true, value: css });
	vi.stubGlobal("window", browserWindow);
	vi.stubGlobal("document", browserWindow.document);
	vi.stubGlobal("Element", browserWindow.Element);
	vi.stubGlobal("HTMLButtonElement", browserWindow.HTMLButtonElement);
	vi.stubGlobal("HTMLInputElement", browserWindow.HTMLInputElement);
	vi.stubGlobal("HTMLSelectElement", browserWindow.HTMLSelectElement);
	vi.stubGlobal("HTMLTextAreaElement", browserWindow.HTMLTextAreaElement);
	vi.stubGlobal("CSS", css);
}

function createEvaluatingElectronClient(browserWindow: Window): ElectronPageCdpClient {
	return {
		async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
			if (method !== "Runtime.evaluate" || typeof params?.expression !== "string") {
				throw new Error(`Unexpected Electron CDP call '${method}'`);
			}
			const evaluate = Function("window", "document", "CSS", `return ${params.expression}`);
			return {
				result: {
					value: evaluate(browserWindow, browserWindow.document, css),
				},
			} as T;
		},
		close: vi.fn(),
	};
}

function comparableResult(result: PageAssertResult): Pick<PageAssertResult, "ok" | "message" | "actual" | "expected"> {
	return {
		ok: result.ok,
		message: result.message,
		actual: result.actual,
		expected: result.expected,
	};
}

describe("page assertion textbox role semantics", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		executePageFunction.mockReset();
	});

	it("keeps Chrome and Electron aligned for native and contenteditable textboxes", async () => {
		const browserWindow = new Window({ url: "https://assertions.test" });
		browserWindow.document.body.innerHTML = `
			<input aria-label="Default input">
			<input type="text" aria-label="Text input">
			<input type="email" aria-label="Email input">
			<input type="search" aria-label="Search input">
			<textarea aria-label="Textarea"></textarea>
			<input type="text" contenteditable="false" aria-label="Text input editable false">
			<textarea contenteditable="false" aria-label="Textarea editable false"></textarea>
			<div contenteditable="true" aria-label="Editable true"></div>
			<div contenteditable="" aria-label="Editable empty"></div>
			<div contenteditable="plaintext-only" aria-label="Editable plaintext"></div>
			<div contenteditable="false" aria-label="Editable false"></div>
			<div contenteditable="true" role="button" aria-label="Editable button"></div>
			<input type="text" role="button" aria-label="Input button">
		`;
		installBrowserGlobals(browserWindow);
		executePageFunction.mockImplementation(async (...args: unknown[]) => {
			const target = args[0] as { tabId: number; frameId?: number };
			const pageFunction = args[1] as (params: PageAssertParams) => AssertionCheckResult;
			const options = args[2] as { args?: unknown[] };
			return {
				success: true,
				value: pageFunction(options.args?.[0] as PageAssertParams),
				console: [],
				tabId: target.tabId,
				frameId: target.frameId ?? 0,
				durationMs: 0,
			};
		});
		const electronClient = createEvaluatingElectronClient(browserWindow);
		const cases: Array<{ role: string; name: string; ok: boolean }> = [
			{ role: "textbox", name: "Default input", ok: true },
			{ role: "textbox", name: "Text input", ok: true },
			{ role: "textbox", name: "Email input", ok: true },
			{ role: "textbox", name: "Search input", ok: true },
			{ role: "textbox", name: "Textarea", ok: true },
			{ role: "textbox", name: "Text input editable false", ok: true },
			{ role: "textbox", name: "Textarea editable false", ok: true },
			{ role: "textbox", name: "Editable true", ok: true },
			{ role: "textbox", name: "Editable empty", ok: true },
			{ role: "textbox", name: "Editable plaintext", ok: true },
			{ role: "textbox", name: "Editable false", ok: false },
			{ role: "textbox", name: "Editable button", ok: false },
			{ role: "textbox", name: "Input button", ok: false },
			{ role: "button", name: "Editable button", ok: true },
			{ role: "button", name: "Input button", ok: true },
		];

		for (const testCase of cases) {
			const params: PageAssertParams = {
				kind: "role",
				role: testCase.role,
				name: testCase.name,
				exact: true,
				timeoutMs: 0,
			};
			const chromeResult = await runPageAssert(params, {
				target: { kind: "chrome-tab", tabId: 42, frameId: 0 },
				navigationGeneration: 0,
				tabId: 42,
				frameId: 0,
			});
			const electronResult = await assertElectronWindow(electronClient, params, electronPageScope);

			expect(comparableResult(electronResult)).toEqual(comparableResult(chromeResult));
			expect(chromeResult).toMatchObject({ ok: testCase.ok, actual: testCase.ok ? 1 : 0 });
		}

		browserWindow.close();
	});
});
