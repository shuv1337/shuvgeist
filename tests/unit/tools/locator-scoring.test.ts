import {
	rankLocatorCandidates,
	resolveLocatorCandidates,
} from "@shuvgeist/driver/locator-scoring";

describe("target-neutral locator scoring", () => {
	it("fails closed when equally strong candidates are ambiguous", () => {
		const locator = {
			selectorCandidates: ["button.shared"],
			semantic: { role: "button", name: "Search", text: "Search" },
			tagName: "button",
		};
		const resolution = resolveLocatorCandidates(
			locator,
			[
				{ candidateId: "a", selectorCandidates: ["button.shared"], role: "button", name: "Search", text: "Search" },
				{ candidateId: "b", selectorCandidates: ["button.shared"], role: "button", name: "Search", text: "Search" },
			],
			{ subject: "Reference stored" },
		);

		expect(resolution).toMatchObject({ ok: false, reason: "ambiguous_match" });
	});

	it("does not let generic selector and position signals outweigh a semantic mismatch", () => {
		const resolution = resolveLocatorCandidates(
			{
				selectorCandidates: ["button.shared", "button"],
				semantic: { role: "button", name: "Search", text: "Search" },
				tagName: "button",
				ordinalPath: [0],
				lastKnownBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
			},
			[
				{
					candidateId: "settings",
					selectorCandidates: ["button.shared", "button"],
					role: "button",
					name: "Settings",
					text: "Settings",
					tagName: "button",
					ordinalPath: [0],
					boundingBox: { x: 0, y: 0, width: 100, height: 20 },
				},
			],
		);

		expect(resolution).toMatchObject({
			ok: false,
			reason: "low_confidence",
			candidates: [{ candidateId: "settings", score: 0.56 }],
		});
	});

	it("ranks locator candidates for role, text, and label queries", () => {
		const candidates = [
			{
				candidateId: "c1",
				role: "button",
				name: "Save settings",
				text: "Save",
				label: "Save settings",
			},
			{
				candidateId: "c2",
				role: "textbox",
				name: "Email",
				label: "Work email",
				attributes: { placeholder: "name@example.com" },
			},
			{
				candidateId: "c3",
				role: "link",
				name: "Learn more",
				text: "Learn more",
			},
		];

		expect(rankLocatorCandidates(candidates, { kind: "role", value: "button", name: "save" })[0].candidate.candidateId).toBe(
			"c1",
		);
		expect(rankLocatorCandidates(candidates, { kind: "text", value: "learn more" })[0].candidate.candidateId).toBe(
			"c3",
		);
		expect(rankLocatorCandidates(candidates, { kind: "label", value: "work email" })[0].candidate.candidateId).toBe(
			"c2",
		);
	});
});
