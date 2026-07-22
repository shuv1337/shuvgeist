import { describe, expect, it } from "vitest";
import {
	createPageTrustedInputDriver,
	selectAllModifierForPlatform,
} from "@shuvgeist/driver/page-trusted-input";
import { FakePageCdpSession } from "./page-driver-fixture.js";

describe("CdpSession trusted input engine", () => {
	it("uses Meta for macOS select-all and Control elsewhere", () => {
		expect(selectAllModifierForPlatform("darwin")).toBe("Meta");
		expect(selectAllModifierForPlatform("MacIntel")).toBe("Meta");
		expect(selectAllModifierForPlatform("linux")).toBe("Control");
	});
	it("dispatches a moved/pressed/released trusted click and balances session ownership", async () => {
		const cdp = new FakePageCdpSession();
		const input = createPageTrustedInputDriver(cdp);

		await expect(input.click({ x: 12, y: 24 })).resolves.toMatchObject({
			ok: true,
			kind: "click",
			point: { x: 12, y: 24 },
		});
		expect(cdp.calls.map((call) => [call.method, call.params?.type])).toEqual([
			["Input.dispatchMouseEvent", "mouseMoved"],
			["Input.dispatchMouseEvent", "mousePressed"],
			["Input.dispatchMouseEvent", "mouseReleased"],
		]);
		expect(cdp.releases).toEqual(cdp.acquisitions);
	});

	it("uses platform-select-all, Backspace, and one Unicode-safe Input.insertText", async () => {
		const cdp = new FakePageCdpSession();
		const input = createPageTrustedInputDriver(cdp);

		await expect(
			input.fill({ x: 30, y: 40 }, "héllo 👋", { selectAllModifier: "Meta" }),
		).resolves.toMatchObject({ ok: true, kind: "fill", textLength: 8 });
		const keyCalls = cdp.calls.filter((call) => call.method === "Input.dispatchKeyEvent");
		expect(keyCalls.map((call) => [call.params?.type, call.params?.key, call.params?.modifiers])).toEqual([
			["keyDown", "Meta", 4],
			["keyDown", "a", 4],
			["keyUp", "a", 4],
			["keyUp", "Meta", 0],
			["keyDown", "Backspace", 0],
			["keyUp", "Backspace", 0],
		]);
		expect(cdp.calls.filter((call) => call.method === "Input.insertText")).toEqual([
			{ method: "Input.insertText", params: { text: "héllo 👋" } },
		]);
	});

	it("clears for an empty fill without sending an empty insertText command", async () => {
		const cdp = new FakePageCdpSession();
		const input = createPageTrustedInputDriver(cdp);
		await expect(input.fill({ x: 1, y: 2 }, "")).resolves.toMatchObject({ textLength: 0 });
		expect(cdp.calls.some((call) => call.method === "Input.insertText")).toBe(false);
		expect(cdp.calls.some((call) => call.method === "Input.dispatchKeyEvent" && call.params?.key === "Backspace")).toBe(
			true,
		);
	});

	it("releases a pressed mouse button when cancellation arrives mid-click", async () => {
		const controller = new AbortController();
		const cdp = new FakePageCdpSession();
		cdp.responseFor = (method, params) => {
			if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") controller.abort();
			return {};
		};
		const input = createPageTrustedInputDriver(cdp);

		await expect(input.click({ x: 4, y: 5 }, { signal: controller.signal })).rejects.toThrow("aborted");
		expect(cdp.calls.at(-1)).toMatchObject({ method: "Input.dispatchMouseEvent", params: { type: "mouseReleased" } });
		expect(cdp.releases).toEqual(cdp.acquisitions);
	});

	it("attempts modifier cleanup when select-all dispatch fails", async () => {
		const cdp = new FakePageCdpSession();
		cdp.responseFor = (method, params) => {
			if (method === "Input.dispatchKeyEvent" && params?.key === "a" && params.type === "keyDown") {
				throw new Error("target rejected key");
			}
			return {};
		};
		const input = createPageTrustedInputDriver(cdp);

		await expect(input.fill({ x: 4, y: 5 }, "text")).rejects.toThrow("target rejected key");
		expect(cdp.calls.at(-1)).toMatchObject({
			method: "Input.dispatchKeyEvent",
			params: { type: "keyUp", key: "Control", modifiers: 0 },
		});
		expect(cdp.releases).toEqual(cdp.acquisitions);
	});
});
