import { getFaviconUrl } from "../../../src/utils/favicon.js";

describe("getFaviconUrl", () => {
	it("normalizes wildcard and path patterns", () => {
		expect(getFaviconUrl("github.com/*")).toBe("https://www.google.com/s2/favicons?domain=github.com&sz=32");
		expect(getFaviconUrl("*.google.com/search", 64)).toBe(
			"https://www.google.com/s2/favicons?domain=.google.com&sz=64",
		);
	});
});
