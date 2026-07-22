// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sandboxMocks = vi.hoisted(() => ({
	execute: vi.fn(),
	remove: vi.fn(),
}));

vi.mock("@shuv1337/pi-web-ui/components/SandboxedIframe.js", () => ({
	SandboxIframe: class {
		style = { display: "" };
		sandboxUrlProvider?: () => string;
		execute = sandboxMocks.execute;
		remove = sandboxMocks.remove;
	},
}));

import { executeJavaScript } from "@shuvgeist/extension/tools/repl/repl";

describe("REPL activity overlay execution context", () => {
	beforeEach(() => {
		sandboxMocks.execute.mockReset().mockResolvedValue({
			success: true,
			console: [],
			files: [],
			returnValue: "ok",
		});
		sandboxMocks.remove.mockReset();
		vi.spyOn(document.body, "appendChild").mockImplementation((node) => node);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("passes the same exact execution signal to overlay show and hide", async () => {
		const signal = new AbortController().signal;
		const overlayController = {
			show: vi.fn(async () => {}),
			hide: vi.fn(async () => {}),
		};

		await executeJavaScript(
			"await browserjs(() => document.title)",
			[],
			signal,
			undefined,
			"Inspecting page",
			overlayController,
		);

		expect(overlayController.show).toHaveBeenCalledWith("Inspecting page", signal);
		expect(overlayController.hide).toHaveBeenCalledWith(signal);
	});
});
