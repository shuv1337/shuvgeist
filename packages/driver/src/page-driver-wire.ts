import type { BridgeCommandResult, ResolvedPageTarget } from "@shuvgeist/protocol/command-schemas";
import type { SnapshotInjectionEntry } from "./injected/contracts.js";
import type { PageDriverScope } from "./page-driver-identity.js";
import type { PageRefActionResult, PageRefDiagnosticCandidate, PageSnapshotResult } from "./page-driver-results.js";
import type {
	PageNetworkBodyResult,
	PageNetworkCurlResult,
	PageNetworkGetResult,
	PageNetworkListResult,
	PageNetworkStats,
} from "./page-network-engine.js";

export interface PageDriverWireSnapshotOptions {
	query?: string;
}

export function pageDriverSnapshotToWire(
	result: PageSnapshotResult,
	target: ResolvedPageTarget,
	options: PageDriverWireSnapshotOptions = {},
): BridgeCommandResult<"page_snapshot"> {
	const scope = pageDriverScopeToWire(result.scope, target);
	return {
		...scope,
		...(options.query ? { query: options.query } : {}),
		...result.snapshot,
		entries: result.snapshot.entries.map((entry) => ({
			...entry,
			...(target.kind === "chrome-tab" ? { tabId: target.tabId, frameId: entry.frameId } : {}),
		})),
	};
}

export function pageDriverRefActionToWire(
	result: PageRefActionResult,
	target: ResolvedPageTarget,
	options: {
		wait?: Extract<BridgeCommandResult<"ref_click">, { ok: true }>["wait"];
		native?: boolean;
	} = {},
): BridgeCommandResult<"ref_click"> {
	const scope = pageDriverScopeToWire(result.scope, target);
	const mode = result.action.mode ?? "dom";
	if (!result.ok) {
		return {
			...scope,
			ok: false,
			refId: result.refId,
			action: result.action.kind,
			mode,
			reason: result.reason,
			message: result.message,
			...(result.candidates ? { candidates: result.candidates.map(diagnosticToWire) } : {}),
		};
	}
	return {
		...scope,
		ok: true,
		refId: result.refId,
		action: result.action.kind,
		mode,
		...(options.native ? { native: true as const } : {}),
		match: diagnosticToWire(result.match),
		execution: {
			kind: result.execution.kind,
			...("strategy" in result.execution ? { strategy: result.execution.strategy } : {}),
			...("inputStrategy" in result.execution && result.execution.inputStrategy
				? { inputStrategy: result.execution.inputStrategy }
				: {}),
			...("methods" in result.execution ? { methods: [...result.execution.methods] } : {}),
			...(typeof result.execution.textLength === "number" ? { textLength: result.execution.textLength } : {}),
		},
		...(options.wait ? { wait: options.wait } : {}),
	};
}

export interface PageDriverLocatorMatch {
	entry: SnapshotInjectionEntry;
	score: number;
	reasons: string[];
}

export function pageDriverLocatorMatchesToWire(
	target: ResolvedPageTarget,
	matches: PageDriverLocatorMatch[],
): BridgeCommandResult<"locate_by_role"> {
	return matches.map((match) => ({
		refId: match.entry.snapshotId,
		score: match.score,
		reasons: [...match.reasons],
		entry: {
			...match.entry,
			attributes: { ...match.entry.attributes },
			selectorCandidates: [...match.entry.selectorCandidates],
			ordinalPath: [...match.entry.ordinalPath],
			boundingBox: { ...match.entry.boundingBox },
			...(target.kind === "chrome-tab" ? { tabId: target.tabId, frameId: match.entry.frameId } : {}),
		},
	}));
}

export function pageDriverNetworkStatsToWire(
	result: PageNetworkStats,
	target: ResolvedPageTarget,
): BridgeCommandResult<"network_stats"> {
	return {
		...pageDriverScopeToWire(result.scope, target),
		active: result.active,
		requestCount: result.requestCount,
		storedBodyBytes: result.storedBodyBytes,
		evictedRequests: result.evictedRequests,
	};
}

export function pageDriverNetworkListToWire(
	result: PageNetworkListResult,
	target: ResolvedPageTarget,
): BridgeCommandResult<"network_list"> {
	return {
		...pageDriverScopeToWire(result.scope, target),
		requests: result.requests.map((request) => ({ ...request, id: request.requestId })),
	};
}

export function pageDriverNetworkGetToWire(
	result: PageNetworkGetResult,
	target: ResolvedPageTarget,
): BridgeCommandResult<"network_get"> {
	return {
		...pageDriverScopeToWire(result.scope, target),
		request: { ...result.request, id: result.request.requestId },
	};
}

export function pageDriverNetworkBodyToWire(
	result: PageNetworkBodyResult,
	target: ResolvedPageTarget,
): BridgeCommandResult<"network_body"> {
	return {
		...pageDriverScopeToWire(result.scope, target),
		requestId: result.requestId,
		...(result.requestBody !== undefined ? { requestBody: result.requestBody } : {}),
		...(result.responseBody !== undefined ? { responseBody: result.responseBody } : {}),
		requestBodyTruncated: result.requestBodyTruncated,
		responseBodyTruncated: result.responseBodyTruncated,
	};
}

export function pageDriverNetworkCurlToWire(
	result: PageNetworkCurlResult,
	target: ResolvedPageTarget,
): BridgeCommandResult<"network_curl"> {
	return {
		...pageDriverScopeToWire(result.scope, target),
		requestId: result.requestId,
		command: result.command,
		redactedHeaders: [...result.redactedHeaders],
	};
}

export function pageDriverScopeToWire(
	scope: PageDriverScope,
	target: ResolvedPageTarget,
): {
	target: ResolvedPageTarget;
	navigationGeneration: number;
	tabId?: number;
	frameId?: number;
} {
	assertScopeMatchesTarget(scope, target);
	return {
		target: { ...target },
		navigationGeneration: scope.navigationGeneration,
		...(target.kind === "chrome-tab" ? { tabId: target.tabId, frameId: target.frameId ?? 0 } : {}),
	};
}

function diagnosticToWire(candidate: PageRefDiagnosticCandidate): {
	score: number;
	reasons: string[];
	stableElementId?: string;
	tagName: string;
	role?: string;
	name?: string;
} {
	return {
		score: candidate.score,
		reasons: [...candidate.reasons],
		tagName: candidate.entry.tagName,
		...(candidate.entry.stableElementId ? { stableElementId: candidate.entry.stableElementId } : {}),
		...(candidate.entry.role ? { role: candidate.entry.role } : {}),
		...(candidate.entry.name ? { name: candidate.entry.name } : {}),
	};
}

function assertScopeMatchesTarget(scope: PageDriverScope, target: ResolvedPageTarget): void {
	if (target.kind === "chrome-tab") {
		if (scope.page.transport !== "chrome-debugger" || scope.page.pageId !== String(target.tabId)) {
			throw new Error("Page driver scope does not match the resolved Chrome target");
		}
		return;
	}
	if (
		scope.page.transport !== "websocket-cdp" ||
		scope.page.sessionId !== target.sessionId ||
		scope.page.windowId !== target.windowRef ||
		scope.page.pageId !== target.targetId
	) {
		throw new Error("Page driver scope does not match the resolved Electron target");
	}
}
