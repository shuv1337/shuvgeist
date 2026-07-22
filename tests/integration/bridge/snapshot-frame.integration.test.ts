import { buildFrameTree, resolveFrameTarget } from "@shuvgeist/extension/tools/helpers/frame-resolver";
import { RefMap } from "@shuvgeist/extension/tools/helpers/ref-map";
import { buildRefLocatorBundle, locateByRole, type PageSnapshotResult } from "@shuvgeist/extension/tools/page-snapshot";

describe("snapshot/frame helper integration", () => {
	it("supports frame tree discovery and ref resolution from snapshot matches", () => {
		const frameTree = buildFrameTree([
			{ frameId: 0, parentFrameId: -1, url: "https://example.com" },
			{ frameId: 4, parentFrameId: 0, url: "https://example.com/embed" },
		]);
		expect(frameTree.byFrameId.get(4)?.path).toBe("0/4");
		expect(resolveFrameTarget([...frameTree.byFrameId.values()], 4)).toMatchObject({
			ok: true,
			reason: "explicit",
			frame: { frameId: 4 },
		});

		const snapshot: PageSnapshotResult = {
			tabId: 10,
			frameId: 4,
			url: "https://example.com/embed",
			title: "Embed",
			generatedAt: 100,
			totalCandidates: 1,
			truncated: false,
			entries: [
				{
					snapshotId: "e1",
					tabId: 10,
					frameId: 4,
					tagName: "button",
					role: "button",
					name: "Checkout",
					text: "Checkout",
					label: "Checkout",
					attributes: { id: "checkout" },
					selectorCandidates: ["#checkout", "button.primary"],
					ordinalPath: [0, 3, 0],
					boundingBox: { x: 20, y: 30, width: 100, height: 40 },
					interactive: true,
				},
			],
		};

		const match = locateByRole(snapshot, "button")[0];
		expect(match.entry.snapshotId).toBe("e1");

		const refMap = new RefMap();
		const ref = refMap.createRef({
			tabId: snapshot.tabId,
			frameId: snapshot.frameId,
			locator: buildRefLocatorBundle(match.entry),
		});

		expect(
			refMap.resolveRef(ref.refId, [
				{
					candidateId: "live-e1",
					tabId: snapshot.tabId,
					frameId: snapshot.frameId,
					selectorCandidates: ["#checkout"],
					role: "button",
					name: "Checkout",
					text: "Checkout",
					tagName: "button",
					ordinalPath: [0, 3, 0],
					boundingBox: { x: 22, y: 31, width: 100, height: 40 },
				},
			]),
		).toMatchObject({
			ok: true,
			match: { candidateId: "live-e1" },
		});
	});
});
