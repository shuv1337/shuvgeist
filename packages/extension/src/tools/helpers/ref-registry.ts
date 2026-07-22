import type {
	CreateRefParams,
	ListRefOptions,
	RefEntry,
	RefMap,
	RefResolutionCandidate,
	RefResolutionResult,
	ResolveRefOptions,
} from "./ref-map.js";
import { RefMap as DefaultRefMap } from "./ref-map.js";

export interface NavigationEvent {
	tabId: number;
	frameId?: number;
}

export type NavigationEventListener = (event: NavigationEvent) => void;

export interface NavigationEventSource {
	subscribe(listener: NavigationEventListener): () => void;
}

export class RefRegistry {
	private readonly refMap: RefMap;
	private readonly unsubscribeNavigation?: () => void;

	constructor(options: { refMap?: RefMap; navigationEventSource?: NavigationEventSource } = {}) {
		this.refMap = options.refMap ?? new DefaultRefMap();
		this.unsubscribeNavigation = options.navigationEventSource?.subscribe((event) => {
			this.onNavigated(event);
		});
	}

	createRef(params: CreateRefParams): RefEntry {
		return this.refMap.createRef(params);
	}

	getRef(refId: string): RefEntry | undefined {
		return this.refMap.getRef(refId);
	}

	listRefs(options: ListRefOptions = {}): RefEntry[] {
		return this.refMap.listRefs(options);
	}

	resolveRef(
		refId: string,
		candidates: ReadonlyArray<RefResolutionCandidate>,
		options: ResolveRefOptions = {},
	): RefResolutionResult {
		return this.refMap.resolveRef(refId, candidates, options);
	}

	invalidateOnNavigation(tabId: number, frameId?: number): number {
		return this.refMap.invalidateOnNavigation(tabId, frameId);
	}

	markNavigated(tabId: number): number {
		return this.refMap.markNavigated(tabId);
	}

	onNavigated(event: NavigationEvent): number {
		return this.invalidateOnNavigation(event.tabId, event.frameId);
	}

	dispose(): void {
		this.unsubscribeNavigation?.();
	}
}
