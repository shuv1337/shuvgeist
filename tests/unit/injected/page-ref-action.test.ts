// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageRefActionInjectionRequest, SnapshotInjectionEntry } from "@shuvgeist/driver/injected-contracts";
import { run } from "@shuvgeist/driver/injected-page-ref-action";
import { shuvgeistSnapshotPageScript } from "@shuvgeist/driver/snapshot-page-script";

describe("generated page ref action runtime", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			const element = this;
			return {
				x: Number(element.dataset.x ?? "10"),
				y: Number(element.dataset.y ?? "20"),
				width: Number(element.dataset.width ?? "100"),
				height: Number(element.dataset.height ?? "30"),
				left: 10,
				top: 20,
				right: 110,
				bottom: 50,
				toJSON: () => ({}),
			};
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves a reordered semantic match and acts on its captured element without a second target query", () => {
		document.body.innerHTML = '<button class="shared">Search</button>';
		const storedEntry = captureOnlyEntry("stored");
		document.body.innerHTML = '<button class="shared">Settings</button><button class="shared">Search</button>';
		const buttons = Array.from(document.querySelectorAll("button"));
		const clicked = vi.fn();
		buttons.forEach((button) => button.addEventListener("click", clicked));
		const querySelectorAll = vi.spyOn(document, "querySelectorAll");

		const result = run(domRequest(storedEntry, { kind: "click" }));

		expect(result).toMatchObject({
			ok: true,
			operation: "dom-action",
			match: { entry: { name: "Search" } },
			execution: { strategy: "fresh-snapshot" },
		});
		expect(clicked).toHaveBeenCalledOnce();
		expect(querySelectorAll).not.toHaveBeenCalledWith("[data-shuvgeist-stable-id]");
		expect(querySelectorAll).not.toHaveBeenCalledWith("button.shared");
	});

	it("fails closed on ambiguous fresh candidates and performs no action", () => {
		document.body.innerHTML = '<button class="shared">Search</button>';
		const storedEntry = {
			...captureOnlyEntry("stored"),
			stableElementId: undefined,
			ordinalPath: [],
		};
		document.body.innerHTML = '<button class="shared">Search</button><button class="shared">Search</button>';
		const clicked = vi.fn();
		document.querySelectorAll("button").forEach((button) => button.addEventListener("click", clicked));

		const result = run(domRequest(storedEntry, { kind: "click" }));

		expect(result).toMatchObject({ ok: false, operation: "dom-action", reason: "ambiguous_match" });
		expect(result.ok === false ? result.candidates : undefined).toHaveLength(2);
		expect(clicked).not.toHaveBeenCalled();
	});

	it("fails closed when one generic-selector replacement has different semantics", () => {
		document.body.innerHTML = '<button class="shared">Search</button>';
		const storedEntry = captureOnlyEntry("stored");
		document.body.innerHTML = '<button class="shared">Settings</button>';
		const replacement = document.querySelector("button");
		const clicked = vi.fn();
		replacement?.addEventListener("click", clicked);

		const result = run(domRequest(storedEntry, { kind: "click" }));

		expect(result).toMatchObject({ ok: false, operation: "dom-action", reason: "low_confidence" });
		expect(clicked).not.toHaveBeenCalled();
	});

	it("resolve-only mode returns fresh coordinates without mutating the page", () => {
		document.body.innerHTML = '<button class="shared" data-x="40" data-y="60">Search</button>';
		const storedEntry = captureOnlyEntry("stored");
		const clicked = vi.fn();
		document.querySelector("button")?.addEventListener("click", clicked);
		const request: PageRefActionInjectionRequest = {
			operation: "resolve",
			frameId: 0,
			snapshotIdPrefix: "fresh",
			storedEntry,
		};

		const result = run(request);

		expect(result).toMatchObject({
			ok: true,
			operation: "resolve",
			match: { entry: { boundingBox: { x: 40, y: 60, width: 100, height: 30 } } },
		});
		expect(clicked).not.toHaveBeenCalled();
	});

	it.each(["true", "", "plaintext-only"])(
		"fills contenteditable=%s through the exact fresh element",
		(contenteditable) => {
			document.body.innerHTML = `<div contenteditable="${contenteditable}" aria-label="Editor"><strong>Old</strong></div>`;
			const storedEntry = captureOnlyEntry("stored");
			const editor = document.querySelector("div");
			if (!(editor instanceof HTMLElement)) throw new Error("Missing editor fixture");
			const events: string[] = [];
			editor.addEventListener("beforeinput", () => events.push("beforeinput"));
			editor.addEventListener("input", () => events.push("input"));

			const result = run(domRequest(storedEntry, { kind: "fill", value: "Updated" }));

			expect(result).toMatchObject({ ok: true, execution: { strategy: "fresh-snapshot" } });
			expect(editor.textContent).toBe("Updated");
			expect(events).toEqual(["beforeinput", "input"]);
		},
	);

	it("rejects a stored entry from another frame before scanning or acting", () => {
		document.body.innerHTML = "<button>Search</button>";
		const storedEntry = { ...captureOnlyEntry("stored"), frameId: 2 };

		expect(run(domRequest(storedEntry, { kind: "click" }))).toMatchObject({
			ok: false,
			reason: "frame_mismatch",
		});
	});
});

function captureOnlyEntry(prefix: string): SnapshotInjectionEntry {
	const response = shuvgeistSnapshotPageScript({
		frameId: 0,
		maxEntries: 20,
		includeHidden: false,
		snapshotIdPrefix: prefix,
	});
	const entry = response.result?.entries[0];
	if (!entry) throw new Error("Snapshot fixture returned no entry");
	return entry;
}

function domRequest(
	storedEntry: SnapshotInjectionEntry,
	action: Extract<PageRefActionInjectionRequest, { operation: "dom-action" }>["action"],
): PageRefActionInjectionRequest {
	return {
		operation: "dom-action",
		frameId: 0,
		snapshotIdPrefix: "fresh",
		storedEntry,
		action,
	};
}
