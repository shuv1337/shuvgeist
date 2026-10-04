// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
	FOREIGN_EXTENSION_FRAME_ERROR,
	isForeignExtensionFrameAccessError,
	removeForeignExtensionFrames,
} from "@shuvgeist/extension/tools/helpers/foreign-extension-frames";

const OWN_EXTENSION_ID = "ownextensionid";

describe("foreign extension frame fallback", () => {
	afterEach(() => {
		document.body.replaceChildren();
		Reflect.deleteProperty(globalThis, "chrome");
	});

	it("recognizes Chrome's cross-extension debugger error", () => {
		expect(isForeignExtensionFrameAccessError(new Error(FOREIGN_EXTENSION_FRAME_ERROR))).toBe(true);
		expect(isForeignExtensionFrameAccessError(new Error(`attach failed: ${FOREIGN_EXTENSION_FRAME_ERROR}`))).toBe(
			true,
		);
		expect(isForeignExtensionFrameAccessError(new Error("Another debugger is already attached"))).toBe(false);
		expect(isForeignExtensionFrameAccessError(FOREIGN_EXTENSION_FRAME_ERROR)).toBe(true);
	});

	it("removes foreign extension frames from the top document and leaves the page's own frames", () => {
		const foreign = frame("iframe", "chrome-extension://otherextension/panel.html");
		const own = frame("iframe", `chrome-extension://${OWN_EXTENSION_ID}/overlay.html`);
		const page = frame("iframe", "https://watcher.fyi/embed");
		const bare = frame("iframe", "chrome-extension://");
		const embed = frame("embed", "chrome-extension://otherextension/widget");
		const object = frame("object", "chrome-extension://otherextension/object.html");
		document.body.append(foreign, own, page, bare, embed, object);

		expect(removeForeignExtensionFrames(OWN_EXTENSION_ID)).toBe(3);
		expect(foreign.isConnected).toBe(false);
		expect(embed.isConnected).toBe(false);
		expect(object.isConnected).toBe(false);
		expect(own.isConnected).toBe(true);
		expect(page.isConnected).toBe(true);
		expect(bare.isConnected).toBe(true);
	});

	it("removes a foreign frame whose URL is only exposed by the src property", () => {
		const foreign = document.createElement("iframe");
		Object.defineProperty(foreign, "src", {
			configurable: true,
			get: () => "chrome-extension://otherextension/from-property.html",
		});
		document.body.append(foreign);

		expect(removeForeignExtensionFrames(OWN_EXTENSION_ID)).toBe(1);
		expect(foreign.isConnected).toBe(false);
	});

	it("removes foreign frames inside open and closed shadow roots", () => {
		const openHost = document.createElement("div");
		const openShadow = openHost.attachShadow({ mode: "open" });
		const openFrame = frame("iframe", "chrome-extension://otherextension/open.html");
		openShadow.append(openFrame);

		const closedHost = document.createElement("div");
		const closedShadow = closedHost.attachShadow({ mode: "closed" });
		const closedFrame = frame("iframe", "chrome-extension://otherextension/closed.html");
		closedShadow.append(closedFrame);
		const closedRoots = new WeakMap<Element, ShadowRoot>([[closedHost, closedShadow]]);
		Object.assign(globalThis, {
			chrome: {
				dom: {
					openOrClosedShadowRoot(element: HTMLElement): ShadowRoot | null {
						return closedRoots.get(element) ?? element.shadowRoot;
					},
				},
			},
		});
		document.body.append(openHost, closedHost);

		expect(removeForeignExtensionFrames(OWN_EXTENSION_ID)).toBe(2);
		expect(openFrame.isConnected).toBe(false);
		expect(closedFrame.isConnected).toBe(false);
		expect(openHost.isConnected).toBe(true);
		expect(closedHost.isConnected).toBe(true);
	});
});

function frame(tagName: "iframe" | "frame" | "embed" | "object", src: string): HTMLElement {
	const element = document.createElement(tagName);
	element.setAttribute("src", src);
	return element;
}
