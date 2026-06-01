import { RefMap, rankLocatorCandidates } from "../../../src/tools/helpers/ref-map.js";

describe("ref-map", () => {
	it("creates refs and invalidates by frame or tab", () => {
		const refMap = new RefMap();
		const a = refMap.createRef({
			tabId: 1,
			frameId: 0,
			locator: {
				selectorCandidates: ["#login"],
				semantic: { role: "button", name: "Sign in" },
				tagName: "button",
			},
		});
		const b = refMap.createRef({
			tabId: 1,
			frameId: 4,
			locator: {
				selectorCandidates: ["input[name='email']"],
				semantic: { role: "textbox", label: "Email" },
				tagName: "input",
			},
		});
		const c = refMap.createRef({
			tabId: 2,
			frameId: 0,
			locator: {
				selectorCandidates: ["a[href='/docs']"],
				semantic: { role: "link", name: "Docs" },
				tagName: "a",
			},
		});

		expect(refMap.listRefs().map((ref) => ref.refId)).toEqual([a.refId, b.refId, c.refId]);
		expect(refMap.invalidateOnNavigation(1, 4)).toBe(1);
		expect(refMap.getRef(b.refId)).toBeUndefined();
		expect(refMap.getRef(a.refId)).toBeDefined();

		expect(refMap.invalidateOnNavigation(1)).toBe(1);
		expect(refMap.getRef(a.refId)).toBeUndefined();
		expect(refMap.getRef(c.refId)).toBeDefined();
	});

	it("resolves refs with stale reasons when needed", () => {
		const refMap = new RefMap();
		const ref = refMap.createRef({
			refId: "ref_login",
			tabId: 7,
			frameId: 0,
			locator: {
				selectorCandidates: ["#login-button", "button.primary"],
				semantic: { role: "button", name: "Sign in", text: "Sign in" },
				tagName: "button",
				ordinalPath: [0, 2, 1],
				lastKnownBoundingBox: { x: 30, y: 100, width: 120, height: 36 },
			},
		});

		expect(
			refMap.resolveRef(ref.refId, [
				{
					candidateId: "a",
					tabId: 7,
					frameId: 3,
					selectorCandidates: ["#login-button"],
				},
			]),
		).toMatchObject({
			ok: false,
			reason: "frame_mismatch",
		});

		expect(
			refMap.resolveRef(ref.refId, [
				{
					candidateId: "weak",
					tabId: 7,
					frameId: 0,
					selectorCandidates: ["#other"],
					role: "button",
					name: "Continue",
				},
			]),
		).toMatchObject({
			ok: false,
			reason: "low_confidence",
		});

		expect(
			refMap.resolveRef(
				ref.refId,
				[
					{
						candidateId: "first",
						tabId: 7,
						frameId: 0,
						selectorCandidates: ["#login-button"],
						role: "button",
						name: "Sign in",
						text: "Sign in",
					},
					{
						candidateId: "second",
						tabId: 7,
						frameId: 0,
						selectorCandidates: ["#login-button"],
						role: "button",
						name: "Sign in",
						text: "Sign in",
					},
				],
				{ ambiguousDelta: 0.08 },
			),
		).toMatchObject({
			ok: false,
			reason: "ambiguous_match",
		});

		expect(
			refMap.resolveRef(
				ref.refId,
				[
					{
						candidateId: "winner",
						tabId: 7,
						frameId: 0,
						selectorCandidates: ["#login-button", "button.primary"],
						role: "button",
						name: "Sign in",
						text: "Sign in",
						tagName: "button",
						ordinalPath: [0, 2, 1],
						boundingBox: { x: 32, y: 102, width: 118, height: 35 },
					},
					{
						candidateId: "other",
						tabId: 7,
						frameId: 0,
						selectorCandidates: ["button.secondary"],
						role: "button",
						name: "Cancel",
					},
				],
				{ ambiguousDelta: 0.01 },
			),
		).toMatchObject({
			ok: true,
			match: { candidateId: "winner" },
		});
	});

	it("rejects generation-stale refs before matching candidates", () => {
		const refMap = new RefMap();
		const ref = refMap.createRef({
			refId: "ref_save",
			tabId: 7,
			frameId: 0,
			navigationGeneration: 2,
			locator: {
				selectorCandidates: ["#save"],
				semantic: { role: "button", name: "Save" },
				tagName: "button",
			},
		});

		expect(
			refMap.resolveRef(
				ref.refId,
				[
					{
						candidateId: "same-node",
						tabId: 7,
						frameId: 0,
						selectorCandidates: ["#save"],
						role: "button",
						name: "Save",
					},
				],
				{ currentNavigationGeneration: 3 },
			),
		).toMatchObject({
			ok: false,
			reason: "stale_generation",
			message: "Reference ref_save is stale after navigation",
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
