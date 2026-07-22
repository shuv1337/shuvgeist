import type { CdpSession, ChromeDebuggerDetachListener } from "@shuvgeist/driver/cdp-session";
import {
	PAGE_REF_ACTION_INJECTED_ARTIFACT,
	SNAPSHOT_INJECTED_ARTIFACT,
} from "@shuvgeist/driver/driver-artifacts-generated";
import type {
	PageRefActionInjectionRequest,
	PageRefActionInjectionResult,
	SnapshotInjectionConfig,
	SnapshotInjectionResponse,
} from "@shuvgeist/driver/injected-contracts";
import { buildInjectedArtifactFunction, buildInjectedArtifactInvocation } from "@shuvgeist/driver/injected-invocation";
import {
	createPageDriver,
	type PageDriver,
	type PageDriverFactoryOptions,
	type PageDriverInjectedRuntime,
} from "@shuvgeist/driver/page-driver";
import { createPageIdentity } from "@shuvgeist/driver/page-driver-identity";
import { shuvgeistSnapshotPageScript } from "@shuvgeist/driver/snapshot-page-script";
import { type ResolvedTabTarget, resolveTabTarget } from "../tools/helpers/browser-target.js";
import { listFrames } from "../tools/helpers/frame-resolver.js";
import { executePageFunction } from "../tools/helpers/page-execution.js";

const PAGE_REF_ACTION_SCRIPT_FILE = "page-ref-action-runtime.js";

export interface ResolvedChromePageDriver extends ResolvedTabTarget {
	driver: PageDriver;
}

export interface ChromePageDriverRegistryLike {
	resolve(tabId?: number): Promise<ResolvedChromePageDriver>;
	getByTabId(tabId: number): PageDriver | undefined;
	release(tabId: number): Promise<void>;
	dispose(): Promise<void>;
}

export interface ChromePageDriverRegistryDebuggerManager {
	cdpSession(tabId: number): CdpSession;
	addDetachListener(tabId: number, listener: ChromeDebuggerDetachListener): () => void;
}

export interface ChromePageDriverRegistryOptions {
	ownerWindowId: number;
	sessionId?: string;
	debuggerManager: ChromePageDriverRegistryDebuggerManager;
	resolveTarget?: typeof resolveTabTarget;
	createDriver?: (cdp: CdpSession, options: PageDriverFactoryOptions) => PageDriver;
}

interface ChromePageDriverEntry {
	driver: PageDriver;
	windowId: number;
	removeDetachListener: () => void;
}

/**
 * Owns one PageDriver per concrete Chrome tab identity. The registry keeps the
 * driver alive across commands so navigation generations and ref ownership are
 * meaningful, then evicts it on detach, tab movement, or explicit cleanup.
 */
export class ChromePageDriverRegistry {
	private readonly entries = new Map<number, ChromePageDriverEntry>();
	private readonly resolveTarget: typeof resolveTabTarget;
	private readonly createDriver: (cdp: CdpSession, options: PageDriverFactoryOptions) => PageDriver;
	private disposed = false;

	constructor(private readonly options: ChromePageDriverRegistryOptions) {
		this.resolveTarget = options.resolveTarget ?? resolveTabTarget;
		this.createDriver = options.createDriver ?? createPageDriver;
	}

	async resolve(tabId?: number): Promise<ResolvedChromePageDriver> {
		this.assertActive();
		const resolved = await this.resolveTarget({ windowId: this.options.ownerWindowId, tabId });
		const actualWindowId = resolved.tab.windowId;
		if (!Number.isInteger(actualWindowId) || actualWindowId <= 0) {
			throw new Error(`Chrome tab ${resolved.tabId} has no usable window identity`);
		}
		if (actualWindowId !== this.options.ownerWindowId) {
			await this.release(resolved.tabId);
			throw new Error(
				`Chrome tab ${resolved.tabId} belongs to window ${actualWindowId}, not authorized window ${this.options.ownerWindowId}`,
			);
		}

		let entry = this.entries.get(resolved.tabId);
		if (entry && entry.windowId !== actualWindowId) {
			await this.release(resolved.tabId);
			entry = undefined;
		}
		if (!entry) entry = this.createEntry(resolved.tabId, actualWindowId);
		try {
			await entry.driver.ready;
		} catch (error) {
			if (this.entries.get(resolved.tabId) === entry) await this.release(resolved.tabId);
			throw error;
		}
		return { ...resolved, driver: entry.driver };
	}

	getByTabId(tabId: number): PageDriver | undefined {
		return this.entries.get(tabId)?.driver;
	}

	async release(tabId: number): Promise<void> {
		const entry = this.entries.get(tabId);
		if (!entry) return;
		this.entries.delete(tabId);
		entry.removeDetachListener();
		await entry.driver.dispose();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await Promise.all([...this.entries.keys()].map((tabId) => this.release(tabId)));
	}

	private createEntry(tabId: number, windowId: number): ChromePageDriverEntry {
		const identity = createPageIdentity("chrome-debugger", {
			sessionId: this.options.sessionId ?? `bridge-window:${this.options.ownerWindowId}`,
			windowId: String(windowId),
			pageId: String(tabId),
		});
		const driver = this.createDriver(this.options.debuggerManager.cdpSession(tabId), {
			identity,
			buildSnapshotExpression,
			injectedRuntime: createChromeInjectedRuntime(tabId),
			authorizeCdpInput: () => true,
		});
		const removeDetachListener = this.options.debuggerManager.addDetachListener(tabId, () => {
			const current = this.entries.get(tabId);
			if (current?.driver !== driver) return;
			this.entries.delete(tabId);
			current.removeDetachListener();
			void current.driver.dispose();
		});
		const entry = { driver, windowId, removeDetachListener };
		this.entries.set(tabId, entry);
		return entry;
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Chrome page driver registry has been disposed");
	}
}

export function buildChromePageSnapshotExpression(config: SnapshotInjectionConfig): string {
	return buildSnapshotExpression(config);
}

function buildSnapshotExpression(config: SnapshotInjectionConfig): string {
	return buildInjectedArtifactInvocation(SNAPSHOT_INJECTED_ARTIFACT, [JSON.stringify(config)]);
}

function createChromeInjectedRuntime(tabId: number): PageDriverInjectedRuntime {
	return {
		async snapshot(config, signal) {
			const execution = await executePageFunction<SnapshotInjectionResponse>(
				{ tabId, frameId: config.frameId },
				buildInjectedArtifactFunction(SNAPSHOT_INJECTED_ARTIFACT),
				{
					worldId: "shuvgeist-page-driver-snapshot",
					args: [config],
					signal,
					scriptingFallback: shuvgeistSnapshotPageScript,
				},
			);
			if (!execution.success || !execution.value) {
				throw new Error(execution.error || "Chrome page snapshot injection returned no result");
			}
			return execution.value;
		},
		async refAction(request, signal) {
			const execution = await executePageFunction<PageRefActionInjectionResult>(
				{ tabId, frameId: request.frameId },
				buildInjectedArtifactFunction(PAGE_REF_ACTION_INJECTED_ARTIFACT),
				{
					worldId: "shuvgeist-page-driver-ref-action",
					args: [request],
					signal,
					scriptingFiles: [PAGE_REF_ACTION_SCRIPT_FILE],
					scriptingFallback: invokeInstalledPageRefActionArtifact,
					scriptingFallbackArgs: [request],
				},
			);
			if (!execution.success || !execution.value) {
				throw new Error(execution.error || "Chrome ref action injection returned no result");
			}
			return execution.value;
		},
		async resolveTrustedInputPoint(_scope, entry, point, signal) {
			const offset = await resolveFrameViewportOffset(tabId, entry.frameId, signal);
			return { x: point.x + offset.x, y: point.y + offset.y };
		},
	};
}

function invokeInstalledPageRefActionArtifact(request: PageRefActionInjectionRequest): PageRefActionInjectionResult {
	const runtime = (
		globalThis as typeof globalThis & {
			__SHUVGEIST_INJECTED_PAGE_REF_ACTION__?: {
				run(value: PageRefActionInjectionRequest): PageRefActionInjectionResult;
			};
		}
	).__SHUVGEIST_INJECTED_PAGE_REF_ACTION__;
	if (!runtime || typeof runtime.run !== "function") {
		throw new Error("Page ref action fallback runtime was not installed in the target frame");
	}
	return runtime.run(request);
}

async function resolveFrameViewportOffset(
	tabId: number,
	frameId: number,
	signal?: AbortSignal,
): Promise<{ x: number; y: number }> {
	if (frameId === 0) return { x: 0, y: 0 };
	if (signal?.aborted) throw new Error("Trusted input frame offset resolution aborted");
	const frames = await listFrames(tabId);
	const frame = frames.find((candidate) => candidate.frameId === frameId);
	if (!frame) throw new Error(`Frame ${frameId} was not found for trusted input coordinate resolution`);
	const parentFrameId = frame.parentFrameId >= 0 ? frame.parentFrameId : 0;
	const parentOffset = await resolveFrameViewportOffset(tabId, parentFrameId, signal);
	const execution = await executePageFunction<FrameOffsetResult>(
		{ tabId, frameId: parentFrameId },
		frameElementOffsetInPage,
		{
			worldId: "shuvgeist-page-driver-frame-offset",
			args: [frame.url],
			signal,
		},
	);
	if (!execution.success) {
		throw new Error(
			`Trusted input frame offset resolution failed for frame ${frameId}: ${execution.error || "unknown script error"}`,
		);
	}
	if (!execution.value?.ok) {
		throw new Error(
			`Trusted input frame offset resolution failed for frame ${frameId}: ${execution.value?.error || "invalid result"}`,
		);
	}
	return { x: parentOffset.x + execution.value.x, y: parentOffset.y + execution.value.y };
}

type FrameOffsetResult = { ok: true; x: number; y: number } | { ok: false; error: string };

function frameElementOffsetInPage(frameUrl: string): FrameOffsetResult {
	try {
		const candidates = Array.from(document.querySelectorAll("iframe,frame"));
		const matches: Element[] = [];
		for (const candidate of candidates) {
			if (!(candidate instanceof HTMLIFrameElement || candidate instanceof HTMLFrameElement)) continue;
			let matchesUrl = false;
			try {
				matchesUrl = candidate.contentWindow?.location.href === frameUrl;
			} catch {
				matchesUrl = false;
			}
			if (!matchesUrl) {
				const rawSrc = candidate.getAttribute("src");
				if (rawSrc) {
					try {
						matchesUrl = new URL(rawSrc, document.baseURI).href === frameUrl;
					} catch {
						matchesUrl = false;
					}
				}
			}
			if (matchesUrl) matches.push(candidate);
		}
		if (matches.length === 0) return { ok: false, error: `No frame element matched ${frameUrl}` };
		if (matches.length > 1) {
			return { ok: false, error: `Multiple frame elements matched ${frameUrl}; coordinates are ambiguous` };
		}
		const rect = matches[0].getBoundingClientRect();
		if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || rect.width <= 0 || rect.height <= 0) {
			return { ok: false, error: "Resolved frame element has no usable viewport bounds" };
		}
		return { ok: true, x: rect.left, y: rect.top };
	} catch (error) {
		return {
			ok: false,
			error: `Unable to resolve frame element offset: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
