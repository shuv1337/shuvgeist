// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { buildReadingSurface, disposeReadingSurface, findTokenAtCharIndex, findTokenForWord } from "../../../src/tts/reading-surface.js";

describe("reading-surface", () => {
	it("builds a selection-bounded surface across multiple blocks", () => {
		document.body.innerHTML = `
			<p id="a">Alpha beta</p>
			<p id="b">Gamma delta</p>
		`;

		const firstText = document.querySelector("#a")?.firstChild;
		const secondText = document.querySelector("#b")?.firstChild;
		if (!(firstText instanceof Text) || !(secondText instanceof Text)) {
			throw new Error("expected text nodes");
		}

		const range = document.createRange();
		range.setStart(firstText, 6);
		range.setEnd(secondText, 5);
		const selection = window.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);

		const surface = buildReadingSurface({ sessionId: "session-1", selection });
		expect(surface?.text).toBe("beta Gamma");
		expect(surface?.tokens).toHaveLength(2);
		expect(findTokenAtCharIndex(surface!, 0)?.charStart).toBe(0);
		expect(findTokenForWord(surface!, "Gamma", 0)?.charStart).toBe(5);

		disposeReadingSurface(surface!);
	});

	it("marks observed block tokens dirty after mutation", async () => {
		document.body.innerHTML = `<p id="copy">Alpha beta</p>`;
		const block = document.getElementById("copy");
		if (!(block instanceof HTMLElement)) {
			throw new Error("expected block");
		}

		const surface = buildReadingSurface({ sessionId: "session-2", blocks: [block] });
		expect(surface?.tokens.some((token) => token.dirty)).toBe(false);

		block.textContent = "Changed text";
		await Promise.resolve();

		expect(surface?.tokens.some((token) => token.dirty)).toBe(true);
		disposeReadingSurface(surface!);
	});
});
