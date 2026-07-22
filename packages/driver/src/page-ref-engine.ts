import type { PageDomAction, PageRefActionInjectionResult, SnapshotInjectionEntry } from "./injected/contracts.js";
import type { PageDriverScope } from "./page-driver-identity.js";
import { PageDriverTargetChangedError, samePageDriverScope, samePageIdentity } from "./page-driver-identity.js";
import type {
	PageRefActionFailure,
	PageRefActionFailureReason,
	PageRefActionRequest,
	PageRefActionResult,
	PageRefDiagnosticCandidate,
	PageSnapshotResult,
} from "./page-driver-results.js";
import type { PageTrustedInputDriver } from "./page-trusted-input.js";

interface StoredPageRef {
	scope: PageDriverScope;
	entry: SnapshotInjectionEntry;
}

export type PageRefEngineRuntimeRequest =
	| {
			operation: "resolve";
			storedEntry: SnapshotInjectionEntry;
			minScore?: number;
			ambiguousDelta?: number;
	  }
	| {
			operation: "dom-action";
			storedEntry: SnapshotInjectionEntry;
			action: PageDomAction;
			minScore?: number;
			ambiguousDelta?: number;
	  };

export interface PageRefEngineRuntimeResult {
	scope: PageDriverScope;
	result: PageRefActionInjectionResult;
}

export interface PageRefEngineOptions {
	getScope: () => PageDriverScope;
	supportsFrame?: (frameId: number) => boolean;
	runRefAction: (request: PageRefEngineRuntimeRequest, signal?: AbortSignal) => Promise<PageRefEngineRuntimeResult>;
	trustedInput: PageTrustedInputDriver;
	authorizeCdpInput?: (scope: PageDriverScope) => boolean | Promise<boolean>;
	resolveTrustedInputPoint?: (
		scope: PageDriverScope,
		entry: SnapshotInjectionEntry,
		point: { x: number; y: number },
		signal?: AbortSignal,
	) => Promise<{ x: number; y: number }>;
}

export interface PageRefEngine {
	remember(snapshot: PageSnapshotResult): void;
	actOnRef(request: PageRefActionRequest): Promise<PageRefActionResult>;
}

class TargetNeutralPageRefEngine implements PageRefEngine {
	private readonly stored = new Map<string, StoredPageRef>();

	constructor(private readonly options: PageRefEngineOptions) {}

	remember(result: PageSnapshotResult): void {
		const currentScope = this.options.getScope();
		if (!samePageDriverScope(result.scope, currentScope)) {
			throw new Error("Cannot remember a snapshot from another page or navigation generation");
		}
		for (const entry of result.snapshot.entries) {
			this.stored.set(entry.snapshotId, { scope: result.scope, entry: cloneEntry(entry) });
		}
	}

	async actOnRef(request: PageRefActionRequest): Promise<PageRefActionResult> {
		const scope = this.options.getScope();
		if (request.signal?.aborted) return failure(scope, request, "aborted", "Reference action was aborted");
		const stored = this.stored.get(request.refId);
		if (!stored) return failure(scope, request, "missing_ref", `Reference ${request.refId} does not exist`);
		if (!samePageIdentity(stored.scope.page, scope.page)) {
			return failure(scope, request, "target_mismatch", `Reference ${request.refId} belongs to another page`);
		}
		if (stored.scope.navigationGeneration !== scope.navigationGeneration) {
			return failure(scope, request, "stale_generation", `Reference ${request.refId} is stale after navigation`);
		}
		if (stored.entry.frameId !== 0 && this.options.supportsFrame?.(stored.entry.frameId) !== true) {
			return failure(
				scope,
				request,
				"frame_mismatch",
				`PageDriver cannot act on non-top-frame reference ${request.refId}`,
			);
		}

		let runtime: PageRefEngineRuntimeResult;
		try {
			runtime = await this.options.runRefAction(toRuntimeRequest(request, stored.entry), request.signal);
		} catch (error) {
			const reason = request.signal?.aborted
				? "aborted"
				: error instanceof PageDriverTargetChangedError
					? "target_changed"
					: "action_failed";
			return failure(scope, request, reason, errorMessage(error));
		}
		if (!samePageDriverScope(runtime.scope, stored.scope)) {
			return failure(
				runtime.scope,
				request,
				"target_changed",
				`Page changed while resolving reference ${request.refId}`,
			);
		}
		if (!runtime.result.ok) {
			return failure(
				runtime.scope,
				request,
				runtime.result.reason,
				runtime.result.message,
				runtime.result.candidates?.map(cloneDiagnostic),
			);
		}

		const match = cloneDiagnostic(runtime.result.match);
		if (runtime.result.operation === "dom-action") {
			return {
				ok: true,
				scope: runtime.scope,
				refId: request.refId,
				action: request.action,
				match,
				execution: runtime.result.execution,
			};
		}

		try {
			if (request.action.mode !== "cdp-trusted") {
				throw new Error("Resolve-only page runtime returned for a DOM action");
			}
			const execution = await this.performAuthorizedTrustedAction(runtime.scope, request, match.entry);
			return {
				ok: true,
				scope: runtime.scope,
				refId: request.refId,
				action: request.action,
				match,
				execution,
			};
		} catch (error) {
			const reason = request.signal?.aborted
				? "aborted"
				: error instanceof PageCapabilityError
					? "capability_denied"
					: error instanceof PageDriverTargetChangedError
						? "target_changed"
						: "action_failed";
			return failure(runtime.scope, request, reason, errorMessage(error), [match]);
		}
	}

	private async performAuthorizedTrustedAction(
		scope: PageDriverScope,
		request: PageRefActionRequest,
		entry: SnapshotInjectionEntry,
	): Promise<Awaited<ReturnType<PageTrustedInputDriver["click"]>>> {
		const assertScope = () => {
			if (!samePageDriverScope(this.options.getScope(), scope)) {
				throw new PageDriverTargetChangedError("Page changed during CDP trusted input");
			}
		};
		assertScope();
		if (!this.options.authorizeCdpInput) {
			throw new PageCapabilityError("CDP trusted input is disabled for this page target");
		}
		if (!(await this.options.authorizeCdpInput(scope))) {
			throw new PageCapabilityError("CDP trusted input is denied by target policy");
		}
		assertScope();
		let point = centerPoint(entry);
		if (this.options.resolveTrustedInputPoint) {
			point = await this.options.resolveTrustedInputPoint(scope, entry, point, request.signal);
			assertScope();
		}
		if (request.action.kind === "fill") {
			return this.options.trustedInput.fill(point, request.action.value, {
				selectAllModifier: request.action.selectAllModifier,
				assertScope,
				signal: request.signal,
			});
		}
		return this.options.trustedInput.click(point, {
			button: request.action.button,
			clickCount: request.action.clickCount,
			assertScope,
			signal: request.signal,
		});
	}
}

class PageCapabilityError extends Error {}

export function createPageRefEngine(options: PageRefEngineOptions): PageRefEngine {
	return new TargetNeutralPageRefEngine(options);
}

function toRuntimeRequest(
	request: PageRefActionRequest,
	storedEntry: SnapshotInjectionEntry,
): PageRefEngineRuntimeRequest {
	const resolution = {
		storedEntry: cloneEntry(storedEntry),
		minScore: request.minScore,
		ambiguousDelta: request.ambiguousDelta,
	};
	if (request.action.mode === "cdp-trusted") return { operation: "resolve", ...resolution };
	return {
		operation: "dom-action",
		...resolution,
		action:
			request.action.kind === "fill"
				? { kind: "fill", value: request.action.value }
				: { kind: "click", button: request.action.button, clickCount: request.action.clickCount },
	};
}

function centerPoint(entry: SnapshotInjectionEntry): { x: number; y: number } {
	const { x, y, width, height } = entry.boundingBox;
	const point = { x: x + width / 2, y: y + height / 2 };
	if (width <= 0 || height <= 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
		throw new Error(`Reference ${entry.snapshotId} has no usable viewport coordinates`);
	}
	return point;
}

function cloneEntry(entry: SnapshotInjectionEntry): SnapshotInjectionEntry {
	return {
		...entry,
		attributes: { ...entry.attributes },
		selectorCandidates: [...entry.selectorCandidates],
		ordinalPath: [...entry.ordinalPath],
		boundingBox: { ...entry.boundingBox },
	};
}

function cloneDiagnostic(candidate: PageRefDiagnosticCandidate): PageRefDiagnosticCandidate {
	return { entry: cloneEntry(candidate.entry), score: candidate.score, reasons: [...candidate.reasons] };
}

function failure(
	scope: PageDriverScope,
	request: PageRefActionRequest,
	reason: PageRefActionFailureReason,
	message: string,
	candidates?: PageRefDiagnosticCandidate[],
): PageRefActionFailure {
	return {
		ok: false,
		scope,
		refId: request.refId,
		action: request.action,
		reason,
		message,
		...(candidates && candidates.length > 0 ? { candidates } : {}),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
