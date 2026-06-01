import { RefRegistry, type NavigationEventListener } from "../../../src/tools/helpers/ref-registry.js";

class ManualNavigationSource {
	private listener?: NavigationEventListener;

	subscribe(listener: NavigationEventListener): () => void {
		this.listener = listener;
		return () => {
			this.listener = undefined;
		};
	}

	emit(tabId: number, frameId?: number): void {
		this.listener?.({ tabId, frameId });
	}
}

describe("RefRegistry", () => {
	it("wraps RefMap and invalidates refs from an injected navigation source", () => {
		const source = new ManualNavigationSource();
		const registry = new RefRegistry({ navigationEventSource: source });
		const mainRef = registry.createRef({
			refId: "main",
			tabId: 7,
			frameId: 0,
			locator: { selectorCandidates: ["#main"] },
		});
		const frameRef = registry.createRef({
			refId: "frame",
			tabId: 7,
			frameId: 4,
			locator: { selectorCandidates: ["#frame"] },
		});

		expect(registry.getRef(mainRef.refId)).toBeDefined();
		expect(registry.getRef(frameRef.refId)).toBeDefined();

		source.emit(7, 4);
		expect(registry.getRef(mainRef.refId)).toBeDefined();
		expect(registry.getRef(frameRef.refId)).toBeUndefined();

		source.emit(7);
		expect(registry.getRef(mainRef.refId)).toBeUndefined();
	});
});
