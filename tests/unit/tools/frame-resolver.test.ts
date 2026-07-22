import { buildFrameTree, listFrames, MAIN_FRAME_ID, resolveFrameTarget } from "@shuvgeist/extension/tools/helpers/frame-resolver";

declare global {
	// biome-ignore lint/style/noVar: test-only global augmentation
	var chrome: {
		webNavigation: {
			getAllFrames: ReturnType<typeof vi.fn>;
		};
	};
}

describe("frame-resolver", () => {
	beforeEach(() => {
		globalThis.chrome = {
			webNavigation: {
				getAllFrames: vi.fn(),
			},
		};
	});

	it("builds a stable frame tree and marks orphans", () => {
		const tree = buildFrameTree([
			{ frameId: 2, parentFrameId: 0, url: "https://example.com/child" },
			{ frameId: 0, parentFrameId: -1, url: "https://example.com" },
			{ frameId: 9, parentFrameId: 99, url: "https://example.com/orphan" },
			{ frameId: 3, parentFrameId: 2, url: "https://example.com/grandchild" },
		]);

		expect(tree.roots.map((node) => node.frameId)).toEqual([0, 9]);
		expect(tree.orphans.map((node) => node.frameId)).toEqual([9]);
		expect(tree.byFrameId.get(3)?.path).toBe("0/2/3");
		expect(tree.byFrameId.get(3)?.depth).toBe(2);
	});

	it("resolves explicit frames and defaults to main frame", () => {
		const frames = [
			{ frameId: 0, parentFrameId: -1, url: "https://example.com" },
			{ frameId: 4, parentFrameId: 0, url: "https://example.com/frame" },
		];
		expect(resolveFrameTarget(frames)).toMatchObject({
			ok: true,
			reason: "default-main",
			frame: frames[0],
		});
		expect(resolveFrameTarget(frames, 4)).toMatchObject({
			ok: true,
			reason: "explicit",
			frame: frames[1],
		});
		expect(resolveFrameTarget(frames, 999)).toMatchObject({
			ok: false,
			reason: "frame-not-found",
			availableFrameIds: [MAIN_FRAME_ID, 4],
		});
	});

	it("lists frames from chrome.webNavigation.getAllFrames", async () => {
		chrome.webNavigation.getAllFrames.mockResolvedValue([
			{ frameId: 7, parentFrameId: 0, url: "https://example.com/child" },
			{ frameId: 0, parentFrameId: -1, url: "https://example.com" },
		]);
		await expect(listFrames(12)).resolves.toEqual([
			{ frameId: 0, parentFrameId: -1, url: "https://example.com", errorOccurred: false },
			{ frameId: 7, parentFrameId: 0, url: "https://example.com/child", errorOccurred: false },
		]);
		expect(chrome.webNavigation.getAllFrames).toHaveBeenCalledWith({ tabId: 12 });
	});
});
