import type { CdpSession } from "./cdp-session.js";
import type {
	PageRefActionInjectionRequest,
	PageRefActionInjectionResult,
	SnapshotInjectionConfig,
	SnapshotInjectionEntry,
	SnapshotInjectionResponse,
} from "./injected/contracts.js";
import { PAGE_REF_ACTION_INJECTED_ARTIFACT } from "./injected/driver-artifacts.generated.js";
import { buildInjectedArtifactInvocation } from "./injected/invocation.js";
import {
	createPageDriverScope,
	type PageDriverScope,
	PageDriverTargetChangedError,
	type PageIdentity,
	pageIdentityKey,
} from "./page-driver-identity.js";
import type {
	PageEvaluateRequest,
	PageEvaluateResult,
	PageRefActionRequest,
	PageRefActionResult,
	PageSnapshotRequest,
	PageSnapshotResult,
} from "./page-driver-results.js";
import {
	type CreatePageNetworkEngineOptions,
	createPageNetworkEngine,
	type PageNetworkEngine,
} from "./page-network-engine.js";
import {
	createPageRefEngine,
	type PageRefEngine,
	type PageRefEngineRuntimeRequest,
	type PageRefEngineRuntimeResult,
} from "./page-ref-engine.js";
import {
	type CreatePageScreencastEngineOptions,
	createPageScreencastEngine,
	type PageScreencastEngine,
} from "./page-screencast-engine.js";
import { normalizeSnapshotResult } from "./page-snapshot-domain.js";
import { createPageTrustedInputDriver } from "./page-trusted-input.js";

export type { PageDriverScope, PageDriverTransport, PageIdentity } from "./page-driver-identity.js";
export {
	createPageDriverScope,
	createPageIdentity,
	pageIdentityKey,
	samePageDriverScope,
	samePageIdentity,
} from "./page-driver-identity.js";
export type * from "./page-driver-results.js";
export type * from "./page-network-engine.js";
export type * from "./page-screencast-engine.js";

export type PageSnapshotExpressionBuilder = (config: SnapshotInjectionConfig) => string;
export type PageRefActionExpressionBuilder = (request: PageRefActionInjectionRequest) => string;

/**
 * Optional transport binding for injected page-world artifacts. Chrome uses
 * this to target extension frame IDs through userScripts.execute; raw CDP
 * transports use Runtime.evaluate in the top-level renderer by default.
 */
export interface PageDriverInjectedRuntime {
	snapshot(config: SnapshotInjectionConfig, signal?: AbortSignal): Promise<SnapshotInjectionResponse>;
	refAction(request: PageRefActionInjectionRequest, signal?: AbortSignal): Promise<PageRefActionInjectionResult>;
	resolveTrustedInputPoint?(
		scope: PageDriverScope,
		entry: SnapshotInjectionEntry,
		point: { x: number; y: number },
		signal?: AbortSignal,
	): Promise<{ x: number; y: number }>;
}

export interface PageDriverFactoryOptions {
	identity: PageIdentity;
	buildSnapshotExpression: PageSnapshotExpressionBuilder;
	buildRefActionExpression?: PageRefActionExpressionBuilder;
	injectedRuntime?: PageDriverInjectedRuntime;
	authorizeCdpInput?: (scope: PageDriverScope) => boolean | Promise<boolean>;
	onClose?: (identity: PageIdentity, reason?: unknown) => void;
	network?: Omit<CreatePageNetworkEngineOptions, "cdp" | "getScope">;
	screencast?: Omit<CreatePageScreencastEngineOptions, "cdp" | "getScope">;
}

export interface PageDriver {
	readonly identity: PageIdentity;
	readonly scope: PageDriverScope;
	readonly closed: boolean;
	readonly ready: Promise<void>;
	readonly network: PageNetworkEngine;
	readonly screencast: PageScreencastEngine;
	evaluate<T = unknown>(request: PageEvaluateRequest): Promise<PageEvaluateResult<T>>;
	snapshot(request?: PageSnapshotRequest): Promise<PageSnapshotResult>;
	actOnRef(request: PageRefActionRequest): Promise<PageRefActionResult>;
	dispose(): Promise<void>;
}

interface RuntimeEvaluateResponse {
	result?: {
		value?: unknown;
		type?: string;
		description?: string;
	};
	exceptionDetails?: {
		text?: string;
		exception?: { description?: string };
	};
}

class CdpPageDriver implements PageDriver {
	readonly #cdp: CdpSession;
	readonly network: PageNetworkEngine;
	readonly screencast: PageScreencastEngine;
	private readonly refs: PageRefEngine;
	private readonly buildRefActionExpression: PageRefActionExpressionBuilder;
	private readonly lifetimeOwner: string;
	readonly ready: Promise<void>;
	private readonly removeCloseListener: () => void;
	private operationNumber = 0;
	private snapshotNumber = 0;
	private lifetimeAcquired = false;
	private disposed = false;
	private targetClosed = false;
	private closeReason?: unknown;

	constructor(
		readonly identity: PageIdentity,
		cdp: CdpSession,
		private readonly options: PageDriverFactoryOptions,
	) {
		this.#cdp = cdp;
		this.buildRefActionExpression = options.buildRefActionExpression ?? buildPageRefActionExpression;
		this.lifetimeOwner = `page-driver:lifetime:${pageIdentityKey(identity)}`;
		this.removeCloseListener = cdp.onClose((reason) => {
			this.targetClosed = true;
			this.closeReason = reason;
			// A detached transport has already discarded its ownership state. Never
			// release this stale owner into a later attachment.
			this.lifetimeAcquired = false;
			try {
				options.onClose?.(identity, reason);
			} catch {
				// Registry eviction callbacks must not interrupt CDP close propagation.
			}
		});
		this.ready = this.initializeLifetime();
		const getScope = () => this.scope;
		this.network = createPageNetworkEngine({ ...options.network, cdp, getScope });
		this.screencast = createPageScreencastEngine({ ...options.screencast, cdp, getScope });
		const trustedInput = createPageTrustedInputDriver(cdp);
		this.refs = createPageRefEngine({
			getScope,
			supportsFrame: (frameId) => frameId === 0 || options.injectedRuntime !== undefined,
			runRefAction: (request, signal) => this.runRefAction(request, signal),
			trustedInput,
			authorizeCdpInput: options.authorizeCdpInput,
			resolveTrustedInputPoint: options.injectedRuntime?.resolveTrustedInputPoint,
		});
	}

	get scope(): PageDriverScope {
		return createPageDriverScope(this.identity, this.#cdp.navigationGeneration);
	}

	get closed(): boolean {
		return this.targetClosed;
	}

	async evaluate<T = unknown>(request: PageEvaluateRequest): Promise<PageEvaluateResult<T>> {
		this.assertActive();
		if (!request.expression.trim()) throw new Error("Page evaluation expression must not be empty");
		const response = await this.evaluateRaw(request);
		return {
			scope: this.scope,
			value: response.result?.value as T,
			type: response.result?.type,
			description: response.result?.description,
		};
	}

	async snapshot(request: PageSnapshotRequest = {}): Promise<PageSnapshotResult> {
		return this.captureSnapshot(request, true);
	}

	actOnRef(request: PageRefActionRequest): Promise<PageRefActionResult> {
		this.assertActive();
		return this.refs.actOnRef(request);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.removeCloseListener();
		await Promise.all([this.network.dispose(), this.screencast.dispose()]);
		await this.ready.catch(() => undefined);
		if (this.lifetimeAcquired) {
			this.lifetimeAcquired = false;
			await this.#cdp.release(this.lifetimeOwner);
		}
	}

	private async initializeLifetime(): Promise<void> {
		await this.#cdp.acquire(this.lifetimeOwner);
		if (this.targetClosed) {
			throw new PageDriverTargetChangedError("Page target closed while acquiring the driver lifetime");
		}
		this.lifetimeAcquired = true;
		try {
			await this.#cdp.ensureDomain("Page");
			if (this.targetClosed) {
				throw new PageDriverTargetChangedError("Page target closed while enabling navigation tracking");
			}
		} catch (error) {
			if (this.lifetimeAcquired) {
				this.lifetimeAcquired = false;
				await this.#cdp.release(this.lifetimeOwner).catch(() => undefined);
			}
			throw error;
		}
	}

	private async captureSnapshot(request: PageSnapshotRequest, remember: boolean): Promise<PageSnapshotResult> {
		this.assertActive();
		throwIfAborted(request.signal, "Page snapshot aborted");
		const frameId = normalizeFrameId(request.frameId);
		if (frameId !== 0 && !this.options.injectedRuntime) {
			throw new Error(`CDP PageDriver currently supports only top-frame snapshots (frameId 0), received ${frameId}`);
		}
		const startedScope = this.scope;
		const config: SnapshotInjectionConfig = {
			frameId,
			maxEntries: normalizeMaxEntries(request.maxEntries),
			includeHidden: request.includeHidden === true,
			snapshotIdPrefix: this.nextSnapshotPrefix(startedScope),
			...(request.query ? { query: request.query } : {}),
		};
		await this.ready;
		this.assertActive();
		const scriptResponse =
			frameId !== 0 && this.options.injectedRuntime
				? await this.options.injectedRuntime.snapshot(config, request.signal)
				: ((
						await this.evaluateRaw({
							expression: this.options.buildSnapshotExpression(config),
							awaitPromise: true,
							returnByValue: true,
							signal: request.signal,
						})
					).result?.value as SnapshotInjectionResponse | undefined);
		if (!sameScopeGeneration(startedScope, this.scope)) {
			throw new PageDriverTargetChangedError("Page changed while capturing snapshot");
		}
		if (!scriptResponse || scriptResponse.success !== true || !scriptResponse.result) {
			throw new Error(scriptResponse?.error || "Page snapshot runtime returned no serializable result");
		}
		if (scriptResponse.result.entries.some((entry) => entry.frameId !== frameId)) {
			throw new Error("Page snapshot runtime returned entries for an unsupported frame");
		}
		const result: PageSnapshotResult = {
			scope: startedScope,
			snapshot: normalizeSnapshotResult(scriptResponse.result),
		};
		if (remember) this.refs.remember(result);
		return result;
	}

	private async runRefAction(
		request: PageRefEngineRuntimeRequest,
		signal?: AbortSignal,
	): Promise<PageRefEngineRuntimeResult> {
		this.assertActive();
		throwIfAborted(signal, "Reference action aborted");
		const frameId = normalizeFrameId(request.storedEntry.frameId);
		if (frameId !== 0 && !this.options.injectedRuntime) {
			throw new Error(
				`CDP PageDriver currently supports only top-frame ref actions (frameId 0), received ${frameId}`,
			);
		}
		const startedScope = this.scope;
		const injectionRequest: PageRefActionInjectionRequest = {
			...request,
			frameId,
			snapshotIdPrefix: this.nextSnapshotPrefix(startedScope),
			stableElementIdAttribute: "data-shuvgeist-stable-id",
		};
		await this.ready;
		this.assertActive();
		const result =
			frameId !== 0 && this.options.injectedRuntime
				? await this.options.injectedRuntime.refAction(injectionRequest, signal)
				: (
						await this.evaluateRaw({
							expression: this.buildRefActionExpression(injectionRequest),
							awaitPromise: true,
							returnByValue: true,
							signal,
						})
					).result?.value;
		if (!isPageRefActionInjectionResult(result)) {
			throw new Error("Page ref action runtime returned an invalid result");
		}
		// Successful DOM actions may themselves navigate. Resolve-only and failed
		// actions must remain in the generation in which they started.
		if ((request.operation === "resolve" || !result.ok) && !sameScopeGeneration(startedScope, this.scope)) {
			throw new PageDriverTargetChangedError("Page changed while resolving the reference action");
		}
		return { scope: startedScope, result };
	}

	private async evaluateRaw(request: PageEvaluateRequest): Promise<RuntimeEvaluateResponse> {
		throwIfAborted(request.signal, "Page evaluation aborted");
		await this.ready;
		this.assertActive();
		const owner = `page-driver:evaluate:${++this.operationNumber}`;
		await this.#cdp.acquire(owner);
		try {
			throwIfAborted(request.signal, "Page evaluation aborted");
			this.assertActive();
			const response = await this.#cdp.send<RuntimeEvaluateResponse>("Runtime.evaluate", {
				expression: request.expression,
				awaitPromise: request.awaitPromise ?? true,
				returnByValue: request.returnByValue ?? true,
			});
			if (response.exceptionDetails) {
				throw new Error(
					response.exceptionDetails.exception?.description ??
						response.exceptionDetails.text ??
						"Page evaluation failed",
				);
			}
			return response;
		} finally {
			await this.#cdp.release(owner);
		}
	}

	private nextSnapshotPrefix(scope: PageDriverScope): string {
		const identity = encodeURIComponent(pageIdentityKey(scope.page));
		return `${identity}:g${scope.navigationGeneration}:s${++this.snapshotNumber}`;
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Page driver has been disposed");
		if (this.targetClosed) {
			const suffix = this.closeReason === undefined ? "" : `: ${String(this.closeReason)}`;
			throw new PageDriverTargetChangedError(`Page target has closed${suffix}`);
		}
	}
}

/** The raw CDP transport is accepted only at construction and is never exposed by PageDriver. */
export function createPageDriver(cdp: CdpSession, options: PageDriverFactoryOptions): PageDriver {
	if (cdp.target.id !== options.identity.pageId) {
		throw new Error(`CDP target '${cdp.target.id}' does not match page identity '${options.identity.pageId}'`);
	}
	return new CdpPageDriver(options.identity, cdp, options);
}

export function buildPageRefActionExpression(request: PageRefActionInjectionRequest): string {
	const serialized = JSON.stringify(request).replace(/</g, "\\u003c");
	return buildInjectedArtifactInvocation(PAGE_REF_ACTION_INJECTED_ARTIFACT, [serialized]);
}

function normalizeMaxEntries(value: number | undefined): number {
	if (value === undefined) return 120;
	if (!Number.isFinite(value)) throw new Error("Page snapshot maxEntries must be finite");
	return Math.max(1, Math.min(500, Math.trunc(value)));
}

function normalizeFrameId(value: number | undefined): number {
	const frameId = value ?? 0;
	if (!Number.isSafeInteger(frameId) || frameId < 0) {
		throw new Error(`PageDriver frameId must be a non-negative safe integer, received ${frameId}`);
	}
	return frameId;
}

function sameScopeGeneration(left: PageDriverScope, right: PageDriverScope): boolean {
	return (
		left.navigationGeneration === right.navigationGeneration &&
		pageIdentityKey(left.page) === pageIdentityKey(right.page)
	);
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
	if (signal?.aborted) throw new Error(message);
}

function isPageRefActionInjectionResult(value: unknown): value is PageRefActionInjectionResult {
	if (typeof value !== "object" || value === null || !("ok" in value) || !("operation" in value)) return false;
	const result = value as {
		ok?: unknown;
		operation?: unknown;
		match?: unknown;
		execution?: unknown;
		reason?: unknown;
	};
	if (result.operation !== "resolve" && result.operation !== "dom-action") return false;
	if (result.ok === true) {
		if (typeof result.match !== "object" || result.match === null) return false;
		return result.operation === "resolve" || (typeof result.execution === "object" && result.execution !== null);
	}
	return result.ok === false && typeof result.reason === "string";
}
