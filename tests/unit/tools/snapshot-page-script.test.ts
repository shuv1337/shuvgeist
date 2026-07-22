import { Window } from "happy-dom";
import { filterSnapshotByKeywords } from "@shuvgeist/extension/tools/helpers/snapshot-filter";
import { shuvgeistSnapshotPageScript } from "@shuvgeist/driver/snapshot-page-script";

function installSnapshotDom(): Window {
	const browserWindow = new Window({ url: "https://snapshot.test" });
	Object.defineProperty(browserWindow, "innerWidth", { configurable: true, value: 1024 });
	Object.defineProperty(browserWindow, "innerHeight", { configurable: true, value: 768 });
	Object.defineProperty(browserWindow.HTMLElement.prototype, "getBoundingClientRect", {
		configurable: true,
		value(this: { getAttribute(name: string): string | null }) {
			const x = Number(this.getAttribute("data-x") ?? "10");
			const y = Number(this.getAttribute("data-y") ?? "10");
			const width = Number(this.getAttribute("data-width") ?? "100");
			const height = Number(this.getAttribute("data-height") ?? "24");
			return { x, y, width, height };
		},
	});
	vi.stubGlobal("window", browserWindow);
	vi.stubGlobal("document", browserWindow.document);
	vi.stubGlobal("location", browserWindow.location);
	vi.stubGlobal("HTMLElement", browserWindow.HTMLElement);
	vi.stubGlobal("HTMLInputElement", browserWindow.HTMLInputElement);
	vi.stubGlobal("HTMLTextAreaElement", browserWindow.HTMLTextAreaElement);
	vi.stubGlobal("HTMLSelectElement", browserWindow.HTMLSelectElement);
	return browserWindow;
}

function appendButton(browserWindow: Window, name: string, y = 10): HTMLButtonElement {
	const button = browserWindow.document.createElement("button");
	button.textContent = name;
	button.setAttribute("data-y", String(y));
	browserWindow.document.body.appendChild(button);
	return button as unknown as HTMLButtonElement;
}

describe("snapshot page script candidate budgeting", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps a focused composer after a 250-item sidebar exhausts the entry budget", () => {
		const browserWindow = installSnapshotDom();
		const navigation = browserWindow.document.createElement("nav");
		navigation.setAttribute("aria-label", "Threads");
		for (let index = 0; index < 250; index++) {
			const button = browserWindow.document.createElement("button");
			button.textContent = `Thread ${index}`;
			button.setAttribute("data-y", "1200");
			navigation.appendChild(button);
		}
		browserWindow.document.body.appendChild(navigation);
		const composer = browserWindow.document.createElement("textarea");
		composer.setAttribute("aria-label", "Focused composer");
		composer.setAttribute("data-y", "40");
		browserWindow.document.body.appendChild(composer);
		composer.focus();

		const response = shuvgeistSnapshotPageScript({ frameId: 0, maxEntries: 120, includeHidden: false });

		expect(response.result?.totalCandidates).toBe(252);
		expect(response.result?.entries).toHaveLength(120);
		expect(response.result?.entries).toEqual(
			expect.arrayContaining([expect.objectContaining({ role: "textbox", name: "Focused composer" })]),
		);
		expect(response.result?.omissions).toEqual({
			total: 132,
			budgetOmitted: 132,
			queryFiltered: 0,
			byCategory: { "role:button": 132 },
			byRegion: { "navigation:threads": 132 },
		});
	});

	it("uses viewport relevance within a homogeneous run", () => {
		const browserWindow = installSnapshotDom();
		for (let index = 0; index < 20; index++) appendButton(browserWindow, `Offscreen ${index}`, 1200);
		appendButton(browserWindow, "Visible action", 40);

		const response = shuvgeistSnapshotPageScript({ frameId: 0, maxEntries: 1, includeHidden: false });

		expect(response.result?.entries.map((entry) => entry.name)).toEqual(["Visible action"]);
	});

	it("uses focus relevance within a homogeneous run", () => {
		const browserWindow = installSnapshotDom();
		for (let index = 0; index < 20; index++) appendButton(browserWindow, `Button ${index}`, 40);
		const focused = appendButton(browserWindow, "Focused action", 40);
		focused.focus();

		const response = shuvgeistSnapshotPageScript({ frameId: 0, maxEntries: 1, includeHidden: false });

		expect(response.result?.entries.map((entry) => entry.name)).toEqual(["Focused action"]);
	});

	it("prioritizes high-value interactive roles when other relevance is equal", () => {
		const browserWindow = installSnapshotDom();
		appendButton(browserWindow, "Secondary action", 40);
		const textbox = browserWindow.document.createElement("textarea");
		textbox.setAttribute("aria-label", "Primary editor");
		textbox.setAttribute("data-y", "40");
		browserWindow.document.body.appendChild(textbox);

		const response = shuvgeistSnapshotPageScript({ frameId: 0, maxEntries: 1, includeHidden: false });

		expect(response.result?.entries).toEqual([
			expect.objectContaining({ role: "textbox", name: "Primary editor" }),
		]);
	});

	it("captures all supported contenteditable forms while preserving explicit roles", () => {
		const browserWindow = installSnapshotDom();
		browserWindow.document.body.innerHTML = [
			'<div id="true-editor" contenteditable="true">True editor</div>',
			'<div id="empty-editor" contenteditable>Empty editor</div>',
			'<div id="plain-editor" contenteditable="plaintext-only">Plain editor</div>',
			'<div id="explicit-editor" contenteditable="true" role="button">Explicit role</div>',
			'<div id="disabled-editor" contenteditable="false">Disabled editor</div>',
		].join("");

		const response = shuvgeistSnapshotPageScript({ frameId: 0, maxEntries: 20, includeHidden: false });
		const byId = new Map(response.result?.entries.map((entry) => [entry.attributes.id, entry]));

		expect(byId.get("true-editor")).toMatchObject({ role: "textbox", interactive: true });
		expect(byId.get("true-editor")?.attributes.contenteditable).toBe("true");
		expect(byId.get("empty-editor")).toMatchObject({ role: "textbox", interactive: true });
		expect(byId.get("empty-editor")?.attributes.contenteditable).toBe("");
		expect(byId.get("plain-editor")).toMatchObject({ role: "textbox", interactive: true });
		expect(byId.get("plain-editor")?.attributes.contenteditable).toBe("plaintext-only");
		expect(byId.get("explicit-editor")).toMatchObject({ role: "button", interactive: true });
		expect(byId.has("disabled-editor")).toBe(false);
	});

	it("fairly samples groups within the same relevance tier", () => {
		const browserWindow = installSnapshotDom();
		for (let index = 0; index < 20; index++) appendButton(browserWindow, `Button ${index}`);
		for (let index = 0; index < 20; index++) {
			const divButton = browserWindow.document.createElement("div");
			divButton.setAttribute("role", "button");
			divButton.textContent = `Div button ${index}`;
			browserWindow.document.body.appendChild(divButton);
		}

		const response = shuvgeistSnapshotPageScript({ frameId: 0, maxEntries: 6, includeHidden: false });
		const tagCounts = response.result?.entries.reduce<Record<string, number>>((counts, entry) => {
			counts[entry.tagName] = (counts[entry.tagName] ?? 0) + 1;
			return counts;
		}, {});

		expect(tagCounts).toEqual({ button: 3, div: 3 });
	});

	it("samples across a long homogeneous DOM run instead of taking only its prefix", () => {
		const browserWindow = installSnapshotDom();
		for (let index = 0; index < 100; index++) appendButton(browserWindow, `Button ${index}`);

		const response = shuvgeistSnapshotPageScript({ frameId: 0, maxEntries: 6, includeHidden: false });
		const names = response.result?.entries.map((entry) => entry.name);

		expect(names).toContain("Button 0");
		expect(names).toContain("Button 49");
		expect(names).toContain("Button 99");
	});

	it("applies query relevance before the cap and composes with keyword filtering", () => {
		const browserWindow = installSnapshotDom();
		for (let index = 0; index < 250; index++) appendButton(browserWindow, `Thread ${index}`);
		appendButton(browserWindow, "Open billing composer");

		const response = shuvgeistSnapshotPageScript({
			frameId: 0,
			maxEntries: 5,
			includeHidden: false,
			query: "billing composer",
		});
		if (!response.result) throw new Error("Snapshot fixture returned no result");
		const filtered = filterSnapshotByKeywords(response.result, { query: "billing composer", limit: 5 });

		expect(response.result.entries).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "Open billing composer" })]),
		);
		expect(filtered.entries.map((entry) => entry.name)).toEqual(["Open billing composer"]);
		expect(filtered.truncated).toBe(false);
		expect(filtered.omissions).toEqual({
			total: 250,
			budgetOmitted: 0,
			queryFiltered: 250,
			byCategory: { "role:button": 250 },
			byRegion: { unscoped: 250 },
		});
		expect(filtered.totalCandidates - filtered.entries.length).toBe(filtered.omissions.total);
	});

	it("never spends a query budget on unrelated groups while matches remain", () => {
		const browserWindow = installSnapshotDom();
		for (let index = 0; index < 20; index++) appendButton(browserWindow, `Billing match ${index}`);
		for (let index = 0; index < 100; index++) {
			const unrelated = browserWindow.document.createElement(index % 2 === 0 ? "a" : "div");
			if (unrelated.tagName.toLowerCase() === "a") unrelated.setAttribute("href", `/unrelated/${index}`);
			else unrelated.setAttribute("role", "button");
			unrelated.textContent = `Unrelated item ${index}`;
			browserWindow.document.body.appendChild(unrelated);
		}

		const response = shuvgeistSnapshotPageScript({
			frameId: 0,
			maxEntries: 10,
			includeHidden: false,
			query: "billing",
		});

		expect(response.result?.entries).toHaveLength(10);
		expect(response.result?.entries.every((entry) => entry.name?.startsWith("Billing match"))).toBe(true);
		expect(response.result?.omissions).toMatchObject({
			total: 110,
			budgetOmitted: 10,
			queryFiltered: 100,
		});
	});

	it("keeps snapshot IDs stable across query and cap changes", () => {
		const browserWindow = installSnapshotDom();
		for (let index = 0; index < 9; index++) appendButton(browserWindow, `Unrelated ${index}`);
		appendButton(browserWindow, "Durable target");

		const queried = shuvgeistSnapshotPageScript({
			frameId: 0,
			maxEntries: 1,
			includeHidden: false,
			query: "durable target",
		});
		const unfiltered = shuvgeistSnapshotPageScript({ frameId: 0, maxEntries: 20, includeHidden: false });

		expect(queried.result?.entries).toEqual([expect.objectContaining({ snapshotId: "e10", name: "Durable target" })]);
		expect(unfiltered.result?.entries.find((entry) => entry.name === "Durable target")?.snapshotId).toBe("e10");
	});

	it("bounds omitted region metadata with a deterministic other bucket", () => {
		const browserWindow = installSnapshotDom();
		for (let index = 0; index < 30; index++) {
			const region = browserWindow.document.createElement("section");
			region.setAttribute("aria-label", `Region ${String(index).padStart(2, "0")}`);
			const button = browserWindow.document.createElement("button");
			button.textContent = `Action ${index}`;
			region.appendChild(button);
			browserWindow.document.body.appendChild(region);
		}

		const first = shuvgeistSnapshotPageScript({ frameId: 0, maxEntries: 1, includeHidden: false });
		const second = shuvgeistSnapshotPageScript({ frameId: 0, maxEntries: 1, includeHidden: false });
		const byRegion = first.result?.omissions.byRegion ?? {};

		expect(Object.keys(byRegion)).toHaveLength(20);
		expect(byRegion.other).toBeGreaterThan(0);
		expect(Object.values(byRegion).reduce((total, count) => total + count, 0)).toBe(
			first.result?.omissions.total,
		);
		expect(second.result?.omissions.byRegion).toEqual(byRegion);
	});
});
