// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { resolveTtsTextTarget } from "../../../src/tts/text-targeting.js";

describe("tts text targeting", () => {
	it("prefers the current text selection", () => {
		document.body.innerHTML = `<p id="copy">Selected text wins</p>`;
		const target = document.getElementById("copy");
		const selection = {
			toString: () => "Selected text wins",
		} as Selection;

		expect(resolveTtsTextTarget(target, { selection })?.text).toBe("Selected text wins");
	});

	it("resolves the nearest readable block from a clicked element", () => {
		document.body.innerHTML = `<article><p id="copy"><span>Readable sentence here.</span></p></article>`;
		const target = document.querySelector("span");
		expect(resolveTtsTextTarget(target)?.text).toBe("Readable sentence here.");
	});

	it("ignores content inside the TTS overlay itself", () => {
		document.body.innerHTML = `<div id="shuvgeist-tts-overlay"><button id="btn">Ignore me</button></div>`;
		const target = document.getElementById("btn");
		expect(resolveTtsTextTarget(target)).toBeNull();
	});
});
