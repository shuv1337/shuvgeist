const executePageFunction = vi.hoisted(() => vi.fn());

vi.mock("@shuvgeist/extension/tools/helpers/page-execution", () => ({
	executePageFunction,
}));

import { buildMainWorldExpressionAssertCode, runPageAssert } from "@shuvgeist/extension/tools/page-assert";

function chromeScope(tabId = 42, frameId = 0) {
	return {
		target: { kind: "chrome-tab" as const, tabId, frameId },
		navigationGeneration: 3,
		tabId,
		frameId,
	};
}

describe("page assertions", () => {
	beforeEach(() => {
		executePageFunction.mockReset();
	});

	it("auto-waits until a user-world assertion passes", async () => {
		executePageFunction
			.mockResolvedValueOnce({
				success: true,
				value: { ok: false, message: "not yet", actual: 0, expected: ">= 1" },
				console: [],
			})
			.mockResolvedValueOnce({
				success: true,
				value: { ok: true, message: "Selector matched", actual: 1, expected: ">= 1" },
				console: [],
			});

		await expect(
			runPageAssert(
				{ kind: "selector", selector: "#ready", timeoutMs: 100, intervalMs: 1 },
				chromeScope(42, 7),
			),
		).resolves.toMatchObject({
			ok: true,
			kind: "selector",
			message: "Selector matched",
			attempts: 2,
			tabId: 42,
			frameId: 7,
		});
		expect(executePageFunction).toHaveBeenCalledTimes(2);
	});

	it("returns structured assertion failures on timeout", async () => {
		executePageFunction.mockResolvedValue({
			success: true,
			value: { ok: false, message: "Text was not found", actual: "", expected: "Welcome" },
			console: [],
		});

		await expect(
			runPageAssert({ kind: "text", text: "Welcome", timeoutMs: 1, intervalMs: 1 }, chromeScope()),
		).resolves.toMatchObject({
			ok: false,
			kind: "text",
			message: "Text was not found",
			tabId: 42,
			frameId: 0,
			target: { kind: "chrome-tab", tabId: 42, frameId: 0 },
			navigationGeneration: 3,
		});
	});

	it("builds main-world expression code for the eval gate", () => {
		expect(buildMainWorldExpressionAssertCode("document.title === 'Ready'")).toContain("document.title === 'Ready'");
	});
});
