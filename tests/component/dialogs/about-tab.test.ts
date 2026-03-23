class StorageMock {
	getItem() {
		return null;
	}
	setItem() {}
	removeItem() {}
	clear() {}
	key() {
		return null;
	}
	get length() {
		return 0;
	}
}

Object.defineProperty(globalThis, "localStorage", {
	value: new StorageMock(),
	configurable: true,
});

import { AboutTab } from "../../../src/dialogs/AboutTab.js";

declare global {
	var chrome: {
		runtime: { getManifest: () => { version: string } };
	};
}

globalThis.chrome = {
	runtime: {
		getManifest: () => ({ version: "9.9.9" }),
	},
};

describe("AboutTab", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
	});

	it("renders version, update state, and theme controls", async () => {
		const tab = new AboutTab();
		document.body.appendChild(tab);
		await tab.updateComplete;
		await Promise.resolve();
		await tab.updateComplete;

		expect(tab.textContent).toContain("Shuvgeist");
		expect(tab.textContent).toContain("9.9.9");
		expect(tab.textContent).toContain("You're up to date");
		expect(tab.querySelector("theme-toggle")).toBeTruthy();
		tab.remove();
	});
});
