import { describe, expect, it, vi } from "vitest";
import { PAGE_REF_ACTION_INJECTED_ARTIFACT } from "@shuvgeist/driver/driver-artifacts-generated";
import type {
	PageRefActionInjectionRequest,
	PageRefActionInjectionResult,
	SnapshotInjectionEntry,
	SnapshotInjectionResult,
} from "@shuvgeist/driver/injected-contracts";
import type {
	ChromeDebuggerDetachListener,
	ChromeDebuggerEventListener,
	ChromeDebuggerManagerLike,
	CdpSessionDomain,
} from "@shuvgeist/driver/cdp-session";
import {
	createChromeDebuggerPageDriver,
	createWebSocketCdpPageDriver,
} from "@shuvgeist/driver/page-driver-bindings";
import { createPageIdentity, pageIdentityKey } from "@shuvgeist/driver/page-driver-identity";
import {
	buildPageRefActionExpression,
	createPageDriver,
	type PageDriver,
} from "@shuvgeist/driver/page-driver";
import { FakePageCdpSession } from "./page-driver-fixture.js";

const snapshotExpression = (config: unknown) => `snapshot:${JSON.stringify(config)}`;
const refActionExpression = (request: PageRefActionInjectionRequest) => `refaction:${JSON.stringify(request)}`;

describe("PageDriver concrete target-neutral core", () => {
	it("builds ref actions from the generated artifact instead of function source serialization", () => {
		const expression = buildPageRefActionExpression({
			operation: "resolve",
			frameId: 0,
			snapshotIdPrefix: "transport",
			storedEntry: entry("stored"),
		});

		expect(expression).toContain(PAGE_REF_ACTION_INJECTED_ARTIFACT.globalName);
		expect(expression).toContain(PAGE_REF_ACTION_INJECTED_ARTIFACT.source);
		expect(expression).not.toContain("shuvgeistPageActionScript.toString");
	});

	it("keeps raw CDP private and enables Page for the full Chrome driver lifetime", async () => {
		const manager = new FakeChromeDebuggerManager();
		const driver = createChromeDebuggerPageDriver({
			sessionId: "extension-session-1",
			windowId: "window-7",
			pageId: "page-primary",
			tabId: 42,
			manager,
			buildSnapshotExpression: snapshotExpression,
			buildRefActionExpression: refActionExpression,
		});

		expect(driver.identity).toEqual({
			transport: "chrome-debugger",
			sessionId: "extension-session-1",
			windowId: "window-7",
			pageId: "page-primary",
		});
		expect(driver).not.toHaveProperty("cdp");
		await driver.evaluate({ expression: "2 + 2" });
		expect(manager.lifecycle.slice(0, 5)).toEqual([
			expect.stringContaining("acquire:page-driver:lifetime:"),
			"enable:Page",
			expect.stringContaining("acquire:page-driver:evaluate:"),
			"send:Runtime.evaluate",
			expect.stringContaining("release:page-driver:evaluate:"),
		]);
		expect(manager.calls).toEqual([
			{ tabId: 42, method: "Runtime.evaluate", params: { expression: "2 + 2", awaitPromise: true, returnByValue: true } },
		]);
		manager.emit(42, "Page.frameNavigated");
		expect(driver.scope.navigationGeneration).toBe(1);
		await driver.dispose();
		expect(manager.lifecycle.at(-1)).toContain("release:page-driver:lifetime:");
	});

	it("releases the lifetime owner when Page.enable fails", async () => {
		const manager = new FakeChromeDebuggerManager();
		manager.enableError = new Error("Page domain unavailable");
		const driver = createChromeDebuggerPageDriver({
			sessionId: "extension-session-1",
			windowId: "window-7",
			pageId: "page-primary",
			tabId: 42,
			manager,
			buildSnapshotExpression: snapshotExpression,
		});

		await expect(driver.evaluate({ expression: "1" })).rejects.toThrow("Page domain unavailable");
		expect(manager.lifecycle).toEqual([
			expect.stringContaining("acquire:page-driver:lifetime:"),
			"enable:Page",
			expect.stringContaining("release:page-driver:lifetime:"),
		]);
		await driver.dispose();
		expect(manager.lifecycle.filter((event) => event.includes("release:page-driver:lifetime:"))).toHaveLength(1);
	});

	it("becomes unusable on detach and never releases a stale lifetime owner", async () => {
		const manager = new FakeChromeDebuggerManager();
		const onClose = vi.fn();
		const driver = createChromeDebuggerPageDriver({
			sessionId: "extension-session-1",
			windowId: "window-7",
			pageId: "page-primary",
			tabId: 42,
			manager,
			buildSnapshotExpression: snapshotExpression,
			onClose,
		});
		await driver.evaluate({ expression: "ready" });
		manager.detach(42, "target_closed");

		expect(driver.closed).toBe(true);
		expect(onClose).toHaveBeenCalledWith(driver.identity, "target_closed");
		await expect(driver.evaluate({ expression: "too late" })).rejects.toThrow("Page target has closed");
		await driver.dispose();
		expect(manager.lifecycle.filter((event) => event.includes("release:page-driver:lifetime:"))).toHaveLength(0);
	});

	it("rejects a WebSocket session whose target does not match the page identity", () => {
		const cdp = new FakePageCdpSession("actual-page");
		expect(() =>
			createWebSocketCdpPageDriver({
				sessionId: "electron-session",
				windowId: "w1",
				pageId: "different-page",
				cdp,
				buildSnapshotExpression: snapshotExpression,
			}),
		).toThrow("does not match page identity");
	});

	it("uses collision-safe page/window/session identity keys", () => {
		const left = createPageIdentity("websocket-cdp", { sessionId: "a:b", windowId: "c", pageId: "d" });
		const right = createPageIdentity("websocket-cdp", { sessionId: "a", windowId: "b:c", pageId: "d" });
		expect(pageIdentityKey(left)).not.toBe(pageIdentityKey(right));
		expect(() =>
			createPageIdentity("chrome-debugger", { sessionId: "session", windowId: " ", pageId: "page" }),
		).toThrow("windowId must not be empty");
	});

	it("returns canonical snapshot data and normalizes every editable contenteditable form", async () => {
		const entries = [
			entry("true", { attributes: { contenteditable: "true" } }),
			entry("empty", { attributes: { contenteditable: "" } }),
			entry("plaintext", { attributes: { contenteditable: "plaintext-only" } }),
			entry("false", { attributes: { contenteditable: "false" }, interactive: false }),
			entry("explicit", { role: "button", attributes: { contenteditable: "true", role: "button" } }),
		];
		const { driver, snapshotConfigs, cdp } = createFixture([snapshot(entries)]);
		const result = await driver.snapshot({ maxEntries: 900 });

		expect(result.snapshot.entries.map((candidate) => candidate.role)).toEqual([
			"textbox",
			"textbox",
			"textbox",
			undefined,
			"button",
		]);
		expect(result.snapshot.entries.map((candidate) => candidate.interactive)).toEqual([true, true, true, false, true]);
		expect(snapshotConfigs[0]).toMatchObject({ frameId: 0, maxEntries: 500, includeHidden: false });
		expect(snapshotConfigs[0].snapshotIdPrefix).toContain(encodeURIComponent(pageIdentityKey(driver.identity)));
		expect(cdp.ensuredDomains).toContain("Page");
		await driver.dispose();
	});

	it("keeps raw CDP transports top-frame-only without a frame injection binding", async () => {
		const { driver, snapshotConfigs, cdp } = createFixture([]);

		await expect(driver.snapshot({ frameId: 2 })).rejects.toThrow("supports only top-frame snapshots");
		expect(snapshotConfigs).toEqual([]);
		expect(cdp.calls.some((call) => call.method === "Runtime.evaluate")).toBe(false);
		await driver.dispose();
	});

	it("uses a transport injection binding for atomic subframe refs and trusted point translation", async () => {
		const cdp = new FakePageCdpSession("page-1");
		const subframeEntry = entry("frame-button", {
			frameId: 17,
			role: "button",
			name: "Increment frame counter",
			boundingBox: { x: 10, y: 20, width: 40, height: 20 },
		});
		const snapshotRun = vi.fn(async () => ({ success: true, result: snapshot([subframeEntry]) }));
		const refActionRun = vi.fn(async (request: PageRefActionInjectionRequest) =>
			request.operation === "resolve"
				? resolveSuccess(subframeEntry)
				: domSuccess(subframeEntry, request.action.kind),
		);
		const resolveTrustedInputPoint = vi.fn(async (_scope, _entry, point: { x: number; y: number }) => ({
			x: point.x + 100,
			y: point.y + 50,
		}));
		const driver = createPageDriver(cdp, {
			identity: createPageIdentity("websocket-cdp", {
				sessionId: "session-1",
				windowId: "window-1",
				pageId: "page-1",
			}),
			buildSnapshotExpression: snapshotExpression,
			injectedRuntime: { snapshot: snapshotRun, refAction: refActionRun, resolveTrustedInputPoint },
			authorizeCdpInput: () => true,
		});

		const stored = await driver.snapshot({ frameId: 17 });
		expect(snapshotRun).toHaveBeenCalledWith(expect.objectContaining({ frameId: 17 }), undefined);
		await expect(
			driver.actOnRef({ refId: stored.snapshot.entries[0].snapshotId, action: { kind: "click", mode: "dom" } }),
		).resolves.toMatchObject({ ok: true, execution: { strategy: "fresh-snapshot" } });
		await expect(
			driver.actOnRef({
				refId: stored.snapshot.entries[0].snapshotId,
				action: { kind: "click", mode: "cdp-trusted" },
			}),
		).resolves.toMatchObject({ ok: true, execution: { point: { x: 130, y: 80 } } });
		expect(refActionRun).toHaveBeenNthCalledWith(1, expect.objectContaining({ frameId: 17, operation: "dom-action" }), undefined);
		expect(refActionRun).toHaveBeenNthCalledWith(2, expect.objectContaining({ frameId: 17, operation: "resolve" }), undefined);
		expect(resolveTrustedInputPoint).toHaveBeenCalledOnce();
		await driver.dispose();
	});

	it("resolves and performs a DOM ref action in one Runtime.evaluate", async () => {
		const original = entry("original-search", { name: "Search", role: "button" });
		const fresh = entry("fresh-search", { name: "Search", role: "button", stableElementId: "search-new" });
		const { driver, runtimeRequests, cdp } = createFixture(
			[snapshot([original])],
			[domSuccess(fresh, "click")],
		);
		const stored = await driver.snapshot();
		const evaluationsBefore = runtimeEvaluateCount(cdp);

		const result = await driver.actOnRef({
			refId: stored.snapshot.entries[0].snapshotId,
			action: { kind: "click", mode: "dom" },
		});

		expect(result).toMatchObject({
			ok: true,
			match: { entry: { name: "Search", stableElementId: "search-new" } },
			execution: { strategy: "fresh-snapshot" },
		});
		expect(runtimeEvaluateCount(cdp) - evaluationsBefore).toBe(1);
		expect(runtimeRequests).toHaveLength(1);
		expect(runtimeRequests[0]).toMatchObject({ operation: "dom-action", action: { kind: "click" } });
		await driver.dispose();
	});

	it("fails closed on an ambiguous injected resolution", async () => {
		const original = entry("original", { name: "Search", role: "button" });
		const candidates = [entry("fresh-a", { name: "Search" }), entry("fresh-b", { name: "Search" })];
		const { driver, runtimeRequests } = createFixture(
			[snapshot([original])],
			[
				{
					ok: false,
					operation: "dom-action",
					reason: "ambiguous_match",
					message: "ambiguous",
					candidates: candidates.map((candidate) => ({ entry: candidate, score: 0.9, reasons: ["name"] })),
				},
			],
		);
		const stored = await driver.snapshot();

		const result = await driver.actOnRef({ refId: stored.snapshot.entries[0].snapshotId, action: { kind: "click" } });

		expect(result).toMatchObject({ ok: false, reason: "ambiguous_match" });
		expect(result.ok === false ? result.candidates : undefined).toHaveLength(2);
		expect(runtimeRequests).toHaveLength(1);
		await driver.dispose();
	});

	it("invalidates refs across navigation generations and isolates identical refs across sessions", async () => {
		const cdpA = new FakePageCdpSession("page-a");
		const fixtureA = createFixture([snapshot([entry("shared", { name: "Composer" })])], [], cdpA, {
			sessionId: "session-a",
			windowId: "window-a",
			pageId: "page-a",
		});
		const fixtureB = createFixture([], [], new FakePageCdpSession("page-b"), {
			sessionId: "session-b",
			windowId: "window-b",
			pageId: "page-b",
		});
		const stored = await fixtureA.driver.snapshot();
		const refId = stored.snapshot.entries[0].snapshotId;

		expect(await fixtureB.driver.actOnRef({ refId, action: { kind: "click" } })).toMatchObject({
			ok: false,
			reason: "missing_ref",
		});
		cdpA.navigate();
		expect(await fixtureA.driver.actOnRef({ refId, action: { kind: "click" } })).toMatchObject({
			ok: false,
			reason: "stale_generation",
		});
		expect(fixtureA.runtimeRequests).toEqual([]);
		await Promise.all([fixtureA.driver.dispose(), fixtureB.driver.dispose()]);
	});

	it("fails closed when target policy denies cdp_input after resolve-only revalidation", async () => {
		const candidate = entry("editor", { name: "Editor", role: "textbox" });
		const { driver, cdp, runtimeRequests } = createFixture(
			[snapshot([candidate])],
			[resolveSuccess(entry("fresh-editor", { name: "Editor", role: "textbox" }))],
			undefined,
			undefined,
			() => false,
		);
		const stored = await driver.snapshot();
		const result = await driver.actOnRef({
			refId: stored.snapshot.entries[0].snapshotId,
			action: { kind: "fill", mode: "cdp-trusted", value: "blocked" },
		});

		expect(result).toMatchObject({ ok: false, reason: "capability_denied" });
		expect(runtimeRequests[0].operation).toBe("resolve");
		expect(cdp.calls.some((call) => call.method.startsWith("Input."))).toBe(false);
		await driver.dispose();
	});

	it("dispatches authorized trusted input after one resolve-only evaluation", async () => {
		const storedEntry = entry("editor", { name: "Editor", role: "textbox" });
		const freshEntry = entry("fresh-editor", {
			name: "Editor",
			role: "textbox",
			boundingBox: { x: 20, y: 30, width: 80, height: 20 },
		});
		const { driver, cdp, runtimeRequests } = createFixture(
			[snapshot([storedEntry])],
			[resolveSuccess(freshEntry)],
			undefined,
			undefined,
			() => true,
		);
		const stored = await driver.snapshot();
		const evaluationsBefore = runtimeEvaluateCount(cdp);
		const result = await driver.actOnRef({
			refId: stored.snapshot.entries[0].snapshotId,
			action: { kind: "fill", mode: "cdp-trusted", value: "hello" },
		});

		expect(result).toMatchObject({ ok: true, execution: { kind: "fill", point: { x: 60, y: 40 } } });
		expect(runtimeEvaluateCount(cdp) - evaluationsBefore).toBe(1);
		expect(runtimeRequests).toHaveLength(1);
		expect(cdp.calls.some((call) => call.method === "Input.insertText" && call.params?.text === "hello")).toBe(true);
		await driver.dispose();
	});

	it("does not register refs when navigation changes during snapshot evaluation", async () => {
		const cdp = new FakePageCdpSession("page-1");
		const { driver } = createFixture([snapshot([entry("editor")])], [], cdp);
		const previous = cdp.responseFor;
		cdp.responseFor = (method, params) => {
			const response = previous(method, params);
			if (method === "Runtime.evaluate") cdp.navigate();
			return response;
		};

		await expect(driver.snapshot()).rejects.toThrow("Page changed while capturing snapshot");
		expect(await driver.actOnRef({ refId: "unknown", action: { kind: "click" } })).toMatchObject({
			ok: false,
			reason: "missing_ref",
		});
		await driver.dispose();
	});

	it("returns target_changed when navigation races resolve-only trusted input", async () => {
		const cdp = new FakePageCdpSession("page-1");
		const original = entry("original", { name: "Search", role: "button" });
		const { driver } = createFixture([snapshot([original])], [resolveSuccess(original)], cdp);
		const stored = await driver.snapshot();
		const previous = cdp.responseFor;
		cdp.responseFor = (method, params) => {
			const response = previous(method, params);
			if (method === "Runtime.evaluate") cdp.navigate();
			return response;
		};

		expect(
			await driver.actOnRef({
				refId: stored.snapshot.entries[0].snapshotId,
				action: { kind: "click", mode: "cdp-trusted" },
			}),
		).toMatchObject({ ok: false, reason: "target_changed" });
		expect(cdp.calls.some((call) => call.method.startsWith("Input."))).toBe(false);
		await driver.dispose();
	});

	it("stops trusted click dispatch when navigation races a mouse event", async () => {
		const cdp = new FakePageCdpSession("page-1");
		const original = entry("original", { name: "Search", role: "button" });
		const { driver } = createFixture([snapshot([original])], [resolveSuccess(original)], cdp, undefined, () => true);
		const stored = await driver.snapshot();
		const previous = cdp.responseFor;
		cdp.responseFor = (method, params) => {
			const response = previous(method, params);
			if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved") cdp.navigate();
			return response;
		};

		expect(
			await driver.actOnRef({
				refId: stored.snapshot.entries[0].snapshotId,
				action: { kind: "click", mode: "cdp-trusted" },
			}),
		).toMatchObject({ ok: false, reason: "target_changed" });
		expect(cdp.calls.filter((call) => call.method.startsWith("Input."))).toEqual([
			expect.objectContaining({ method: "Input.dispatchMouseEvent", params: expect.objectContaining({ type: "mouseMoved" }) }),
		]);
		await driver.dispose();
	});

	it("stops trusted fill after a key event crosses a navigation generation", async () => {
		const cdp = new FakePageCdpSession("page-1");
		const original = entry("editor", { name: "Editor", role: "textbox" });
		const { driver } = createFixture([snapshot([original])], [resolveSuccess(original)], cdp, undefined, () => true);
		const stored = await driver.snapshot();
		const previous = cdp.responseFor;
		cdp.responseFor = (method, params) => {
			const response = previous(method, params);
			if (method === "Input.dispatchKeyEvent" && params?.type === "keyDown" && params?.key === "Control") {
				cdp.navigate();
			}
			return response;
		};

		expect(
			await driver.actOnRef({
				refId: stored.snapshot.entries[0].snapshotId,
				action: { kind: "fill", mode: "cdp-trusted", value: "must-not-cross-navigation" },
			}),
		).toMatchObject({ ok: false, reason: "target_changed" });
		const inputCalls = cdp.calls.filter((call) => call.method.startsWith("Input."));
		expect(inputCalls.filter((call) => call.method === "Input.dispatchKeyEvent")).toEqual([
			expect.objectContaining({ params: expect.objectContaining({ type: "keyDown", key: "Control" }) }),
			expect.objectContaining({ params: expect.objectContaining({ type: "keyUp", key: "Control" }) }),
		]);
		expect(inputCalls.some((call) => call.method === "Input.insertText")).toBe(false);
		await driver.dispose();
	});

	it("does not misreport a successful DOM action that itself navigates", async () => {
		const cdp = new FakePageCdpSession("page-1");
		const original = entry("original", { name: "Open", role: "button" });
		const { driver } = createFixture([snapshot([original])], [domSuccess(original, "click")], cdp);
		const stored = await driver.snapshot();
		const previous = cdp.responseFor;
		cdp.responseFor = (method, params) => {
			const response = previous(method, params);
			if (method === "Runtime.evaluate" && String(params?.expression).startsWith("refaction:")) cdp.navigate();
			return response;
		};

		expect(
			await driver.actOnRef({ refId: stored.snapshot.entries[0].snapshotId, action: { kind: "click" } }),
		).toMatchObject({ ok: true });
		await driver.dispose();
	});
});

function createFixture(
	snapshots: SnapshotInjectionResult[],
	refResults: PageRefActionInjectionResult[] = [],
	cdp = new FakePageCdpSession("page-1"),
	identity = { sessionId: "session-1", windowId: "window-1", pageId: "page-1" },
	authorizeCdpInput?: () => boolean,
): {
	driver: PageDriver;
	cdp: FakePageCdpSession;
	snapshotConfigs: Array<Record<string, unknown>>;
	runtimeRequests: PageRefActionInjectionRequest[];
} {
	const snapshotQueue = [...snapshots];
	const resultQueue = [...refResults];
	const snapshotConfigs: Array<Record<string, unknown>> = [];
	const runtimeRequests: PageRefActionInjectionRequest[] = [];
	cdp.responseFor = (method, params) => {
		if (method !== "Runtime.evaluate") return {};
		const expression = String(params?.expression ?? "");
		if (expression.startsWith("snapshot:")) {
			snapshotConfigs.push(JSON.parse(expression.slice("snapshot:".length)) as Record<string, unknown>);
			const next = snapshotQueue.shift();
			if (!next) throw new Error("No queued snapshot");
			return { result: { value: { success: true, result: next } } };
		}
		if (expression.startsWith("refaction:")) {
			runtimeRequests.push(
				JSON.parse(expression.slice("refaction:".length)) as PageRefActionInjectionRequest,
			);
			const next = resultQueue.shift();
			if (!next) throw new Error("No queued page ref action result");
			return { result: { value: next } };
		}
		return { result: { value: 4, type: "number" } };
	};
	const driver = createPageDriver(cdp, {
		identity: createPageIdentity("websocket-cdp", identity),
		buildSnapshotExpression: snapshotExpression,
		buildRefActionExpression: refActionExpression,
		authorizeCdpInput,
	});
	return { driver, cdp, snapshotConfigs, runtimeRequests };
}

function domSuccess(entryValue: SnapshotInjectionEntry, kind: "click" | "fill"): PageRefActionInjectionResult {
	return {
		ok: true,
		operation: "dom-action",
		match: { entry: entryValue, score: 0.92, reasons: ["name", "role"] },
		execution: { ok: true, kind, strategy: "fresh-snapshot" },
	};
}

function resolveSuccess(entryValue: SnapshotInjectionEntry): PageRefActionInjectionResult {
	return {
		ok: true,
		operation: "resolve",
		match: { entry: entryValue, score: 0.92, reasons: ["name", "role"] },
	};
}

function runtimeEvaluateCount(cdp: FakePageCdpSession): number {
	return cdp.calls.filter((call) => call.method === "Runtime.evaluate").length;
}

function snapshot(entries: SnapshotInjectionEntry[]): SnapshotInjectionResult {
	return {
		url: "https://example.test",
		title: "Fixture",
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
		tagName: "div",
		name: snapshotId,
		interactive: true,
		...overrides,
		attributes: { ...(overrides.attributes ?? {}) },
		selectorCandidates: [...(overrides.selectorCandidates ?? [`#${snapshotId}`])],
		ordinalPath: [...(overrides.ordinalPath ?? [0])],
		boundingBox: { ...(overrides.boundingBox ?? { x: 10, y: 20, width: 100, height: 30 }) },
	};
}

class FakeChromeDebuggerManager implements ChromeDebuggerManagerLike {
	readonly calls: Array<{ tabId: number; method: string; params?: Record<string, unknown> }> = [];
	readonly lifecycle: string[] = [];
	enableError?: Error;
	private readonly listeners = new Map<number, Set<ChromeDebuggerEventListener>>();
	private readonly detachListeners = new Map<number, Set<ChromeDebuggerDetachListener>>();

	async acquireWithTrace(_tabId: number, owner: string): Promise<void> {
		this.lifecycle.push(`acquire:${owner}`);
	}

	async releaseWithTrace(_tabId: number, owner: string): Promise<void> {
		this.lifecycle.push(`release:${owner}`);
	}

	async ensureDomainWithTrace(_tabId: number, domain: CdpSessionDomain): Promise<void> {
		this.lifecycle.push(`enable:${domain}`);
		if (this.enableError) throw this.enableError;
	}

	async sendCommandWithTrace<T = unknown>(
		tabId: number,
		method: string,
		params?: Record<string, unknown>,
	): Promise<T> {
		this.lifecycle.push(`send:${method}`);
		this.calls.push({ tabId, method, params });
		return { result: { value: 4, type: "number" } } as T;
	}

	addEventListener(tabId: number, listener: ChromeDebuggerEventListener): () => void {
		const listeners = this.listeners.get(tabId) ?? new Set<ChromeDebuggerEventListener>();
		listeners.add(listener);
		this.listeners.set(tabId, listeners);
		return () => listeners.delete(listener);
	}

	addDetachListener(tabId: number, listener: ChromeDebuggerDetachListener): () => void {
		const listeners = this.detachListeners.get(tabId) ?? new Set<ChromeDebuggerDetachListener>();
		listeners.add(listener);
		this.detachListeners.set(tabId, listeners);
		return () => listeners.delete(listener);
	}

	emit(tabId: number, method: string): void {
		for (const listener of this.listeners.get(tabId) ?? []) listener(method, {}, { tabId });
	}

	detach(tabId: number, reason: unknown): void {
		for (const listener of [...(this.detachListeners.get(tabId) ?? [])]) listener({ tabId, reason });
	}
}
