import { describe, expect, it } from "vitest";
import { DirectCdpAgentSessionAdapter } from "shuvgeist/direct-cdp-runtime";
import { PAGE_REF_ACTION_INJECTED_ARTIFACT } from "@shuvgeist/driver/driver-artifacts-generated";
import type {
	PageRefActionInjectionResult,
	SnapshotInjectionEntry,
	SnapshotInjectionResult,
} from "@shuvgeist/driver/injected-contracts";
import type {
	CdpSession,
	CdpSessionCloseListener,
	CdpSessionDomain,
	CdpSessionEnsureDomainOptions,
	CdpSessionEventListener,
	CdpSessionTarget,
	CdpSessionTraceOptions,
} from "@shuvgeist/driver/cdp-session";

class FakeDirectCdpSession implements CdpSession {
	readonly target: CdpSessionTarget = { kind: "electron-ws", id: "direct-page" };
	readonly events: string[] = [];
	readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
	readonly runtimeResponses: unknown[] = [];
	pageEnableFailures = 0;
	private readonly closeListeners = new Set<CdpSessionCloseListener>();
	private generation = 0;

	get navigationGeneration(): number {
		return this.generation;
	}

	async acquire(owner: string, _trace?: CdpSessionTraceOptions): Promise<void> {
		this.events.push(`acquire:${owner}`);
	}

	async release(owner: string, _trace?: CdpSessionTraceOptions): Promise<void> {
		this.events.push(`release:${owner}`);
	}

	async ensureDomain(domain: CdpSessionDomain, _options?: CdpSessionEnsureDomainOptions): Promise<void> {
		this.events.push(`enable:${domain}`);
		if (domain === "Page" && this.pageEnableFailures > 0) {
			this.pageEnableFailures -= 1;
			throw new Error("transient Page.enable failure");
		}
	}

	async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
		this.calls.push({ method, params });
		if (method === "Runtime.evaluate") {
			const response = this.runtimeResponses.shift();
			if (!response) throw new Error("Missing fake Runtime.evaluate response");
			return response as T;
		}
		return {} as T;
	}

	onEvent(_method: string, _listener: CdpSessionEventListener): () => void {
		return () => {};
	}

	onClose(listener: CdpSessionCloseListener): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	close(): void {
		this.events.push("transport:close");
		for (const listener of this.closeListeners) listener("closed");
	}
}

describe("direct-CDP PageDriver adapter", () => {
	it("rejects a discovery target that does not match the connected CDP target", () => {
		const cdp = new FakeDirectCdpSession();

		expect(
			() =>
				new DirectCdpAgentSessionAdapter({
					cdp,
					target: {
						id: "different-page",
						type: "page",
						webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/different-page",
					},
				}),
		).toThrow("discovery target different-page does not match CDP target direct-page");
		expect(cdp.events).toEqual([]);
	});

	it("evicts a failed PageDriver initialization so a later command retries", async () => {
		const cdp = new FakeDirectCdpSession();
		cdp.pageEnableFailures = 1;
		cdp.runtimeResponses.push(snapshotResponse(snapshot([entry("after-retry")])));
		const adapter = new DirectCdpAgentSessionAdapter({ cdp });

		await expect(adapter.snapshot()).rejects.toThrow("transient Page.enable failure");
		await expect(adapter.snapshot()).resolves.toMatchObject({
			snapshot: { entries: [{ snapshotId: "after-retry" }] },
		});
		expect(cdp.events.filter((event) => event === "enable:Page")).toHaveLength(2);
		expect(cdp.calls.filter((call) => call.method === "Runtime.evaluate")).toHaveLength(1);
		await adapter.close();
	});

	it("returns target-neutral snapshots and fails closed on an ambiguous fresh ref", async () => {
		const cdp = new FakeDirectCdpSession();
		const stored = entry("dynamic-ref", { name: "Search", role: "button" });
		const candidates = [
			entry("fresh-a", { name: "Search", role: "button" }),
			entry("fresh-b", { name: "Search", role: "button" }),
		];
		cdp.runtimeResponses.push(
			snapshotResponse(snapshot([stored])),
			refActionResponse({
				ok: false,
				operation: "resolve",
				reason: "ambiguous_match",
				message: "Reference matched multiple candidates with similar scores",
				candidates: candidates.map((candidate) => ({ entry: candidate, score: 0.9, reasons: ["name"] })),
			}),
		);
		const adapter = new DirectCdpAgentSessionAdapter({ cdp, sessionId: "direct-session" });

		const captured = await adapter.snapshot();
		expect(adapter).not.toHaveProperty("cdp");
		expect(captured).not.toHaveProperty("tabId");
		expect(captured.scope).toEqual({
			page: {
				transport: "websocket-cdp",
				sessionId: "direct-session",
				windowId: "direct-page",
				pageId: "direct-page",
			},
			navigationGeneration: 0,
		});
		const result = await adapter.clickRef({ refId: captured.snapshot.entries[0].snapshotId });

		expect(result).toMatchObject({ ok: false, reason: "ambiguous_match" });
		expect(result.ok === false ? result.candidates : undefined).toHaveLength(2);
		expect(cdp.calls.some((call) => call.method.startsWith("Input."))).toBe(false);
		expect(cdp.calls[1]?.params?.expression).toContain(PAGE_REF_ACTION_INJECTED_ARTIFACT.globalName);
		await adapter.close();
	});

	it("fills a revalidated contenteditable ref with trusted input and disposes before closing CDP", async () => {
		const cdp = new FakeDirectCdpSession();
		const stored = entry("editor-ref", {
			role: "textbox",
			name: "Composer",
			text: "Old draft",
			attributes: { contenteditable: "true" },
		});
		const fresh = entry("fresh-editor", {
			role: "textbox",
			name: "Composer",
			text: "Old draft",
			attributes: { contenteditable: "true" },
			boundingBox: { x: 20, y: 30, width: 80, height: 20 },
		});
		cdp.runtimeResponses.push(
			snapshotResponse(snapshot([stored])),
			refActionResponse({
				ok: true,
				operation: "resolve",
				match: { entry: fresh, score: 0.94, reasons: ["role", "name"] },
			}),
		);
		const adapter = new DirectCdpAgentSessionAdapter({ cdp });
		const captured = await adapter.snapshot();
		const refId = captured.snapshot.entries[0].snapshotId;

		const result = await adapter.fillRef({ refId, value: "Updated draft" });

		expect(result).toMatchObject({
			ok: true,
			match: { entry: { snapshotId: "fresh-editor", role: "textbox" } },
			execution: { kind: "fill", point: { x: 60, y: 40 }, textLength: 13 },
		});
		expect(cdp.calls.some((call) => call.method === "Input.insertText" && call.params?.text === "Updated draft")).toBe(
			true,
		);

		await adapter.close();
		const transportCloseIndex = cdp.events.indexOf("transport:close");
		const lifetimeReleaseIndex = cdp.events.findIndex((event) => event.startsWith("release:page-driver:lifetime:"));
		expect(lifetimeReleaseIndex).toBeGreaterThanOrEqual(0);
		expect(transportCloseIndex).toBeGreaterThan(lifetimeReleaseIndex);
		await adapter.close();
		expect(cdp.events.filter((event) => event === "transport:close")).toHaveLength(1);
	});
});

function snapshotResponse(value: SnapshotInjectionResult): unknown {
	return { result: { value: { success: true, result: value } } };
}

function refActionResponse(value: PageRefActionInjectionResult): unknown {
	return { result: { value } };
}

function snapshot(entries: SnapshotInjectionEntry[]): SnapshotInjectionResult {
	return {
		url: "https://example.test",
		title: "Direct fixture",
		generatedAt: 1,
		totalCandidates: entries.length,
		truncated: false,
		entries,
	};
}

function entry(snapshotId: string, overrides: Partial<SnapshotInjectionEntry> = {}): SnapshotInjectionEntry {
	return {
		snapshotId,
		frameId: 0,
		tagName: "button",
		name: snapshotId,
		interactive: true,
		...overrides,
		attributes: { ...(overrides.attributes ?? {}) },
		selectorCandidates: [...(overrides.selectorCandidates ?? ["button.shared"])],
		ordinalPath: [...(overrides.ordinalPath ?? [0])],
		boundingBox: { ...(overrides.boundingBox ?? { x: 10, y: 20, width: 100, height: 30 }) },
	};
}
