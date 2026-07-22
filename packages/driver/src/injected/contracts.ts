export const INJECTED_ARTIFACT_VERSION = 1;

export interface InjectedArtifactDescriptor {
	readonly version: typeof INJECTED_ARTIFACT_VERSION;
	readonly globalName: string;
	readonly contentHash: string;
	readonly source: string;
}

export interface BrowserJsWrapperConfig {
	args: unknown[];
	timeoutMs: number;
}

export interface BrowserJsWrapperSuccess {
	success: true;
	lastValue: unknown;
}

export interface BrowserJsWrapperFailure {
	success: false;
	error: string;
	stack: string;
}

export type BrowserJsWrapperResult = BrowserJsWrapperSuccess | BrowserJsWrapperFailure;

export type PageExecutionConsoleMethod = "log" | "warn" | "error" | "info";

export interface PageExecutionConsoleEntry {
	type: PageExecutionConsoleMethod;
	text: string;
}

export interface PageExecutionInjectionConfig {
	args: unknown[];
	includeConsole: boolean;
}

export interface PageExecutionInjectionResult {
	success: boolean;
	value?: unknown;
	error?: string;
	stack?: string;
	console: PageExecutionConsoleEntry[];
}

export interface SnapshotInjectionConfig {
	frameId: number;
	maxEntries: number;
	includeHidden: boolean;
	query?: string;
	snapshotIdPrefix?: string;
	stableElementIdAttribute?: string;
}

export interface SnapshotInjectionBoundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface SnapshotInjectionEntry {
	snapshotId: string;
	stableElementId?: string;
	frameId: number;
	tagName: string;
	role?: string;
	name?: string;
	text?: string;
	label?: string;
	attributes: Record<string, string>;
	selectorCandidates: string[];
	ordinalPath: number[];
	boundingBox: SnapshotInjectionBoundingBox;
	interactive: boolean;
	headingLevel?: number;
	landmark?: string;
}

export interface SnapshotInjectionOmissions {
	total: number;
	budgetOmitted?: number;
	queryFiltered?: number;
	byCategory: Record<string, number>;
	byRegion: Record<string, number>;
}

export interface SnapshotInjectionResult {
	url: string;
	title: string;
	generatedAt: number;
	totalCandidates: number;
	truncated: boolean;
	omissions?: SnapshotInjectionOmissions;
	entries: SnapshotInjectionEntry[];
}

export interface SnapshotInjectionResponse {
	success: boolean;
	error?: string;
	result?: SnapshotInjectionResult;
}

export type PageDomAction =
	| { kind: "click"; button?: "left" | "middle" | "right"; clickCount?: number }
	| { kind: "fill"; value: string };

export interface PageActionTarget {
	stableElementId?: string;
	stableElementIdAttribute?: string;
	selectorCandidates: string[];
	tagName: string;
	role?: string;
	name?: string;
	attributes: Record<string, string>;
	ordinalPath: number[];
}

export interface PageActionRuntimeRequest {
	target: PageActionTarget;
	action: PageDomAction;
}

export interface PageActionExecutionSuccess {
	ok: true;
	kind: "click" | "fill";
	strategy: "stable-id" | "unique-selector" | "fresh-snapshot";
	selector?: string;
	textLength?: number;
	inputStrategy?:
		| "value"
		| "select"
		| "contenteditable-range"
		| "contenteditable-exec-command"
		| "contenteditable-fallback";
}

export interface PageActionExecutionFailure {
	ok: false;
	reason: "target_not_found" | "ambiguous_target" | "not_actionable" | "beforeinput_canceled";
	message: string;
}

export type PageActionExecutionResult = PageActionExecutionSuccess | PageActionExecutionFailure;

export interface PageRefActionInjectionBase {
	frameId: number;
	snapshotIdPrefix: string;
	stableElementIdAttribute?: string;
	storedEntry: SnapshotInjectionEntry;
	minScore?: number;
	ambiguousDelta?: number;
}

export interface PageRefResolveInjectionRequest extends PageRefActionInjectionBase {
	operation: "resolve";
}

export interface PageRefDomActionInjectionRequest extends PageRefActionInjectionBase {
	operation: "dom-action";
	action: PageDomAction;
}

export type PageRefActionInjectionRequest = PageRefResolveInjectionRequest | PageRefDomActionInjectionRequest;

export interface PageRefInjectionCandidate {
	entry: SnapshotInjectionEntry;
	score: number;
	reasons: string[];
}

export type PageRefInjectionFailureReason =
	| "frame_mismatch"
	| "not_found"
	| "ambiguous_match"
	| "low_confidence"
	| "action_failed"
	| "beforeinput_canceled";

export type PageRefActionInjectionResult =
	| {
			ok: true;
			operation: "resolve";
			match: PageRefInjectionCandidate;
	  }
	| {
			ok: true;
			operation: "dom-action";
			match: PageRefInjectionCandidate;
			execution: PageActionExecutionSuccess;
	  }
	| {
			ok: false;
			operation: PageRefActionInjectionRequest["operation"];
			reason: PageRefInjectionFailureReason;
			message: string;
			candidates?: PageRefInjectionCandidate[];
	  };

export interface ReplOverlayAbortIntent {
	clientId: string;
	windowId: number;
	sessionId: string;
	target: {
		kind: "chrome-tab";
		tabRef: "active" | `window:${number}`;
		tabId?: number;
		frameId?: number;
	};
	executionId: string;
	targetRequestId: string;
	reason: string;
}

export type ReplOverlayCommand =
	| { action: "show"; taskName: string; abortIntent: ReplOverlayAbortIntent }
	| { action: "remove" };

export interface ElementInfo {
	selector: string;
	xpath: string;
	html: string;
	tagName: string;
	attributes: Record<string, string>;
	text: string;
	boundingBox: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	computedStyles: Record<string, string>;
	parentChain: string[];
}

export type ElementPickerCommand = { action: "pick"; message?: string } | { action: "cancel" };
