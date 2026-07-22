// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { shuvgeistPageActionScript } from "@shuvgeist/driver/page-action-runtime";
import type { PageActionRuntimeRequest } from "@shuvgeist/driver/page-driver";

describe("shared page action runtime", () => {
	afterEach(() => {
		document.body.innerHTML = "";
		delete (document as Document & { execCommand?: unknown }).execCommand;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it.each(["true", "", "plaintext-only"])(
		"replaces nested contenteditable=%s contents and emits focus, beforeinput, input once",
		(contenteditable) => {
			document.body.innerHTML = `<div data-shuvgeist-stable-id="editor" contenteditable="${contenteditable}"><p>Old <strong>nested</strong> text</p></div>`;
			const editor = document.querySelector("[data-shuvgeist-stable-id='editor']");
			if (!(editor instanceof HTMLElement)) throw new Error("Missing editor fixture");
			const events: string[] = [];
			editor.addEventListener("focus", () => events.push("focus"));
			editor.addEventListener("beforeinput", () => events.push("beforeinput"));
			editor.addEventListener("input", () => events.push("input"));

			const result = shuvgeistPageActionScript(request("editor", { kind: "fill", value: "New text" }));

			expect(result).toMatchObject({
				ok: true,
				kind: "fill",
				strategy: "stable-id",
				inputStrategy: "contenteditable-range",
			});
			expect(editor.textContent).toBe("New text");
			expect(events).toEqual(["focus", "beforeinput", "input"]);
		},
	);

	it("honors canceled beforeinput without mutating or emitting input", () => {
		document.body.innerHTML =
			'<div data-shuvgeist-stable-id="editor" contenteditable="true"><p>Original</p></div>';
		const editor = document.querySelector("[data-shuvgeist-stable-id='editor']");
		if (!(editor instanceof HTMLElement)) throw new Error("Missing editor fixture");
		const input = vi.fn();
		editor.addEventListener("beforeinput", (event) => event.preventDefault());
		editor.addEventListener("input", input);

		const result = shuvgeistPageActionScript(request("editor", { kind: "fill", value: "Blocked" }));

		expect(result).toMatchObject({ ok: false, reason: "beforeinput_canceled" });
		expect(editor.textContent).toBe("Original");
		expect(input).not.toHaveBeenCalled();
	});

	it("falls back to Event when InputEvent construction is unavailable", () => {
		document.body.innerHTML = '<div data-shuvgeist-stable-id="editor" contenteditable="true">Old</div>';
		const editor = document.querySelector("[data-shuvgeist-stable-id='editor']");
		if (!(editor instanceof HTMLElement)) throw new Error("Missing editor fixture");
		vi.stubGlobal("InputEvent", undefined);
		const seen: Event[] = [];
		editor.addEventListener("input", (event) => seen.push(event));

		const result = shuvgeistPageActionScript(request("editor", { kind: "fill", value: "Fallback" }));

		expect(result).toMatchObject({ ok: true, kind: "fill" });
		expect(editor.textContent).toBe("Fallback");
		expect(seen).toHaveLength(1);
		expect(seen[0].type).toBe("input");
	});

	it("replaces content when execCommand claims success without touching the focused editor", () => {
		document.body.innerHTML = '<div data-shuvgeist-stable-id="editor" contenteditable="true">Old</div>';
		const editor = document.querySelector("[data-shuvgeist-stable-id='editor']");
		if (!(editor instanceof HTMLElement)) throw new Error("Missing editor fixture");
		vi.spyOn(document, "getSelection").mockReturnValue(null);
		const execCommand = vi.fn(() => true);
		Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

		const result = shuvgeistPageActionScript(request("editor", { kind: "fill", value: "New" }));

		expect(result).toMatchObject({ ok: true, inputStrategy: "contenteditable-fallback" });
		expect(execCommand).toHaveBeenCalledWith("insertText", false, "New");
		expect(editor.textContent).toBe("New");
	});

	it("preserves input and select value/input/change behavior", () => {
		document.body.innerHTML = [
			'<input data-shuvgeist-stable-id="input" value="old">',
			'<select data-shuvgeist-stable-id="select"><option value="one">One</option><option value="two">Two</option></select>',
		].join("");
		const input = document.querySelector("input");
		const select = document.querySelector("select");
		if (!(input instanceof HTMLInputElement) || !(select instanceof HTMLSelectElement)) {
			throw new Error("Missing form fixtures");
		}
		const inputEvents: string[] = [];
		const selectEvents: string[] = [];
		for (const type of ["input", "change"]) {
			input.addEventListener(type, () => inputEvents.push(type));
			select.addEventListener(type, () => selectEvents.push(type));
		}

		expect(shuvgeistPageActionScript(request("input", { kind: "fill", value: "new" }))).toMatchObject({
			ok: true,
			inputStrategy: "value",
		});
		expect(shuvgeistPageActionScript(request("select", { kind: "fill", value: "Two" }))).toMatchObject({
			ok: true,
			inputStrategy: "select",
		});
		expect(input.value).toBe("new");
		expect(select.value).toBe("two");
		expect(inputEvents).toEqual(["input", "change"]);
		expect(selectEvents).toEqual(["input", "change"]);
	});

	it("fails closed when a generic selector matches multiple elements", () => {
		document.body.innerHTML = '<button class="shared">First</button><button class="shared">Second</button>';
		const clicks = vi.fn();
		for (const button of document.querySelectorAll("button")) button.addEventListener("click", clicks);
		const generic = request(undefined, { kind: "click" });
		generic.target.selectorCandidates = ["button.shared"];

		expect(shuvgeistPageActionScript(generic)).toMatchObject({ ok: false, reason: "ambiguous_target" });
		expect(clicks).not.toHaveBeenCalled();
	});
});

function request(
	stableElementId: string | undefined,
	action: PageActionRuntimeRequest["action"],
): PageActionRuntimeRequest {
	return {
		target: {
			stableElementId,
			stableElementIdAttribute: "data-shuvgeist-stable-id",
			selectorCandidates: [],
			tagName: "div",
			attributes: {},
			ordinalPath: [],
		},
		action,
	};
}
