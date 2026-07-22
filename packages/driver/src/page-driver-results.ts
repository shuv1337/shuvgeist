import type {
	PageActionExecutionSuccess,
	PageRefInjectionCandidate,
	SnapshotInjectionResult,
} from "./injected/contracts.js";

export type {
	PageActionExecutionFailure,
	PageActionExecutionResult,
	PageActionExecutionSuccess,
	PageActionRuntimeRequest,
	PageActionTarget,
	PageDomAction,
} from "./injected/contracts.js";

import type { PageDriverScope } from "./page-driver-identity.js";

export interface PageEvaluateRequest {
	expression: string;
	awaitPromise?: boolean;
	returnByValue?: boolean;
	signal?: AbortSignal;
}

export interface PageEvaluateResult<T = unknown> {
	scope: PageDriverScope;
	value: T;
	type?: string;
	description?: string;
}

export interface PageSnapshotRequest {
	frameId?: number;
	maxEntries?: number;
	includeHidden?: boolean;
	query?: string;
	signal?: AbortSignal;
}

/** Canonical injected snapshot data plus the target generation that produced it. */
export interface PageSnapshotResult {
	scope: PageDriverScope;
	snapshot: SnapshotInjectionResult;
}

export interface PageInputPoint {
	x: number;
	y: number;
}

export type PageRefAction =
	| {
			kind: "click";
			mode?: "dom" | "cdp-trusted";
			button?: "left" | "middle" | "right";
			clickCount?: number;
	  }
	| {
			kind: "fill";
			mode?: "dom" | "cdp-trusted";
			value: string;
			selectAllModifier?: "Control" | "Meta";
	  };

export interface PageRefActionRequest {
	refId: string;
	action: PageRefAction;
	minScore?: number;
	ambiguousDelta?: number;
	signal?: AbortSignal;
}

export type PageRefDiagnosticCandidate = PageRefInjectionCandidate;

export type PageRefActionFailureReason =
	| "missing_ref"
	| "target_mismatch"
	| "frame_mismatch"
	| "not_found"
	| "ambiguous_match"
	| "low_confidence"
	| "stale_generation"
	| "target_changed"
	| "capability_denied"
	| "action_failed"
	| "beforeinput_canceled"
	| "aborted";

export interface PageRefActionSuccess {
	ok: true;
	scope: PageDriverScope;
	refId: string;
	action: PageRefAction;
	match: PageRefDiagnosticCandidate;
	execution: PageActionExecutionSuccess | PageTrustedInputResult;
}

export interface PageRefActionFailure {
	ok: false;
	scope: PageDriverScope;
	refId: string;
	action: PageRefAction;
	reason: PageRefActionFailureReason;
	message: string;
	candidates?: PageRefDiagnosticCandidate[];
}

export type PageRefActionResult = PageRefActionSuccess | PageRefActionFailure;

export interface PageTrustedInputResult {
	ok: true;
	kind: "click" | "fill";
	point: PageInputPoint;
	methods: string[];
	textLength?: number;
}
