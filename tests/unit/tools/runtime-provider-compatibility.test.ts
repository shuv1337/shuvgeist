import { describe, expect, it } from "vitest";
import {
	OffscreenBrowserJsRuntimeProvider,
	OffscreenNavigateRuntimeProvider,
} from "@shuvgeist/extension/agent/offscreen-tool-environment";
import {
	BrowserJsRuntimeProvider,
	NavigateRuntimeProvider,
} from "@shuvgeist/extension/tools/repl/runtime-providers";

describe("legacy runtime provider compatibility", () => {
	it("inherits the canonical browserjs provider instead of carrying another runtime body", () => {
		expect(Object.getPrototypeOf(BrowserJsRuntimeProvider.prototype)).toBe(
			OffscreenBrowserJsRuntimeProvider.prototype,
		);
		expect(Object.hasOwn(BrowserJsRuntimeProvider.prototype, "getRuntime")).toBe(false);
		expect(Object.hasOwn(BrowserJsRuntimeProvider.prototype, "handleMessage")).toBe(false);
		expect(Object.hasOwn(BrowserJsRuntimeProvider.prototype, "getDescription")).toBe(false);
	});

	it("inherits the canonical navigate provider instead of carrying another runtime body", () => {
		expect(Object.getPrototypeOf(NavigateRuntimeProvider.prototype)).toBe(OffscreenNavigateRuntimeProvider.prototype);
		expect(Object.hasOwn(NavigateRuntimeProvider.prototype, "getRuntime")).toBe(false);
		expect(Object.hasOwn(NavigateRuntimeProvider.prototype, "handleMessage")).toBe(false);
		expect(Object.hasOwn(NavigateRuntimeProvider.prototype, "getDescription")).toBe(false);
	});
});
