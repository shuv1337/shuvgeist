// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScrollController } from "../../../src/tts/scroll-controller.js";
import type { TokenMapEntry } from "../../../src/tts/reading-surface.js";

describe("scroll-controller", () => {
	beforeEach(() => {
		document.body.innerHTML = `<p id="copy">Alpha beta</p>`;
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
	});

	it("scrolls the page when the token leaves the center band", () => {
		const textNode = document.querySelector("#copy")?.firstChild;
		if (!(textNode instanceof Text)) {
			throw new Error("expected text node");
		}
		const rangeSpy = vi.spyOn(document, "createRange").mockReturnValue({
			setStart: vi.fn(),
			setEnd: vi.fn(),
			getBoundingClientRect: () => ({ left: 0, top: 900, width: 40, height: 20, right: 40, bottom: 920, x: 0, y: 900, toJSON: () => ({}) }) as DOMRect,
		} as unknown as Range);
		const scrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);

		const controller = createScrollController();
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

		controller.scrollToToken(token);
		expect(scrollSpy).toHaveBeenCalled();
		controller.dispose();
		rangeSpy.mockRestore();
		scrollSpy.mockRestore();
	});
});
