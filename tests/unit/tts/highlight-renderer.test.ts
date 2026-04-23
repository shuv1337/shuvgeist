// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRectHighlightRenderer } from "../../../src/tts/highlight-renderer.js";
import type { TokenMapEntry } from "../../../src/tts/reading-surface.js";

describe("highlight-renderer", () => {
	beforeEach(() => {
		document.body.innerHTML = `<p id="copy">Alpha beta</p>`;
	});

	it("renders fallback rect overlays for a token", () => {
		const textNode = document.querySelector("#copy")?.firstChild;
		if (!(textNode instanceof Text)) {
			throw new Error("expected text node");
		}

		const createRangeMock = vi.spyOn(document, "createRange").mockReturnValue({
			setStart: vi.fn(),
			setEnd: vi.fn(),
			getClientRects: () => [{ left: 10, top: 20, width: 30, height: 12 }] as unknown as DOMRectList,
		} as unknown as Range);

		const renderer = createRectHighlightRenderer(document.body);
		const token: TokenMapEntry = {
			blockId: 0,
			tokenIndex: 0,
			charStart: 0,
			charEnd: 5,
			startNode: textNode,
			startOffset: 0,
			endNode: textNode,
			endOffset: 5,
			dirty: false,
		};

		renderer.highlight(token);
		const overlayRect = Array.from(document.body.querySelectorAll("div")).find(
			(element) => (element as HTMLDivElement).style.position === "absolute",
		);
		expect(overlayRect).toBeTruthy();
		renderer.clear();
		createRangeMock.mockRestore();
	});
});
