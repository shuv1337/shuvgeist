import {
	type LocatorResolutionCandidate,
	type RefLocatorBundle,
	resolveLocatorCandidates,
} from "../locator-scoring.js";
import { type PageActionRuntimeElement, shuvgeistPageActionScript } from "../page-action-runtime.js";
import { type SnapshotHTMLElement, shuvgeistSnapshotPageScript } from "../snapshot-page-script.js";
import type {
	PageActionRuntimeRequest,
	PageRefActionInjectionRequest,
	PageRefActionInjectionResult,
	PageRefInjectionCandidate,
	SnapshotInjectionEntry,
} from "./contracts.js";

const DEFAULT_STABLE_ELEMENT_ID_ATTRIBUTE = "data-shuvgeist-stable-id";

/**
 * Resolve and perform DOM actions synchronously inside one page-world call.
 * Resolve-only mode is used when the host must dispatch trusted CDP input.
 */
export function run(request: PageRefActionInjectionRequest): PageRefActionInjectionResult {
	if (request.storedEntry.frameId !== request.frameId) {
		return {
			ok: false,
			operation: request.operation,
			reason: "frame_mismatch",
			message: `Stored reference frame ${request.storedEntry.frameId} does not match frame ${request.frameId}`,
		};
	}

	const elementsBySnapshotId = new Map<string, SnapshotHTMLElement>();
	const snapshotResponse = shuvgeistSnapshotPageScript(
		{
			frameId: request.frameId,
			maxEntries: Number.MAX_SAFE_INTEGER,
			includeHidden: false,
			snapshotIdPrefix: request.snapshotIdPrefix,
			stableElementIdAttribute: request.stableElementIdAttribute,
		},
		{
			onEntry(entry, element) {
				elementsBySnapshotId.set(entry.snapshotId, element);
			},
		},
	);
	if (!snapshotResponse.success || !snapshotResponse.result) {
		return {
			ok: false,
			operation: request.operation,
			reason: "action_failed",
			message: snapshotResponse.error || "Fresh reference snapshot failed",
		};
	}

	const entriesBySnapshotId = new Map(
		snapshotResponse.result.entries.map((entry) => [entry.snapshotId, entry] as const),
	);
	const resolution = resolveLocatorCandidates(
		locatorFromEntry(request.storedEntry),
		snapshotResponse.result.entries.map(candidateFromEntry),
		{
			minScore: request.minScore,
			ambiguousDelta: request.ambiguousDelta,
			subject: `Reference ${request.storedEntry.snapshotId}`,
		},
	);
	if (!resolution.ok) {
		return {
			ok: false,
			operation: request.operation,
			reason: resolution.reason,
			message: resolution.message,
			...(resolution.candidates
				? { candidates: diagnosticsFromCandidates(resolution.candidates, entriesBySnapshotId) }
				: {}),
		};
	}

	const matchedEntry = entriesBySnapshotId.get(resolution.match.candidateId);
	const matchedElement = elementsBySnapshotId.get(resolution.match.candidateId);
	if (!matchedEntry || !matchedElement) {
		return {
			ok: false,
			operation: request.operation,
			reason: "not_found",
			message: `Resolved candidate disappeared for ${request.storedEntry.snapshotId}`,
		};
	}
	const match: PageRefInjectionCandidate = {
		entry: matchedEntry,
		score: resolution.match.score,
		reasons: [...resolution.match.reasons],
	};
	if (request.operation === "resolve") return { ok: true, operation: "resolve", match };

	const runtimeRequest: PageActionRuntimeRequest = {
		target: targetFromEntry(matchedEntry, request.stableElementIdAttribute),
		action: request.action,
	};
	const execution = shuvgeistPageActionScript(runtimeRequest, matchedElement as unknown as PageActionRuntimeElement);
	if (!execution.ok) {
		return {
			ok: false,
			operation: "dom-action",
			reason: execution.reason === "beforeinput_canceled" ? "beforeinput_canceled" : "action_failed",
			message: execution.message,
			candidates: [match],
		};
	}
	return { ok: true, operation: "dom-action", match, execution };
}

function locatorFromEntry(entry: SnapshotInjectionEntry): RefLocatorBundle {
	return {
		selectorCandidates: scoringSelectors(entry),
		semantic: { role: entry.role, name: entry.name, text: entry.text, label: entry.label },
		tagName: entry.tagName,
		attributes: { ...entry.attributes },
		ordinalPath: [...entry.ordinalPath],
		lastKnownBoundingBox: { ...entry.boundingBox },
	};
}

function candidateFromEntry(entry: SnapshotInjectionEntry): LocatorResolutionCandidate {
	return {
		candidateId: entry.snapshotId,
		selectorCandidates: scoringSelectors(entry),
		role: entry.role,
		name: entry.name,
		text: entry.text,
		label: entry.label,
		tagName: entry.tagName,
		attributes: { ...entry.attributes },
		ordinalPath: [...entry.ordinalPath],
		boundingBox: { ...entry.boundingBox },
	};
}

function scoringSelectors(entry: SnapshotInjectionEntry): string[] {
	const stableSignal = entry.stableElementId ? [`shuvgeist-stable-id:${entry.stableElementId}`] : [];
	return [...stableSignal, ...entry.selectorCandidates];
}

function diagnosticsFromCandidates(
	candidates: Array<LocatorResolutionCandidate & { score: number; reasons: string[] }>,
	entriesBySnapshotId: Map<string, SnapshotInjectionEntry>,
): PageRefInjectionCandidate[] {
	return candidates.flatMap((candidate) => {
		const entry = entriesBySnapshotId.get(candidate.candidateId);
		return entry ? [{ entry, score: candidate.score, reasons: [...candidate.reasons] }] : [];
	});
}

function targetFromEntry(
	entry: SnapshotInjectionEntry,
	stableElementIdAttribute: string | undefined,
): PageActionRuntimeRequest["target"] {
	return {
		stableElementId: entry.stableElementId,
		stableElementIdAttribute: stableElementIdAttribute ?? DEFAULT_STABLE_ELEMENT_ID_ATTRIBUTE,
		selectorCandidates: [...entry.selectorCandidates],
		tagName: entry.tagName,
		role: entry.role,
		name: entry.name,
		attributes: { ...entry.attributes },
		ordinalPath: [...entry.ordinalPath],
	};
}
