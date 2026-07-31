import {
	PlaywrightAdapterError,
	PlaywrightCdpAdapterPrototype,
	type PrototypeCdpBackend,
	type PrototypeCdpCommand,
	type PrototypeCdpEvent,
	type PrototypePlaywrightClient,
} from "@shuvgeist/server/prototypes/playwright-cdp-adapter";

function root(overrides: Record<string, unknown> = {}) {
	return {
		kind: "page" as const,
		rootKey: "extension-1:tab-9:g2",
		targetId: "target-root",
		sessionId: "chrome-root-session",
		url: "https://example.com",
		title: "Example",
		rootGeneration: 2,
		navigationGeneration: 4,
		...overrides,
	};
}

function child(
	type: "iframe" | "worker" | "service_worker" | "shared_worker" | "other",
	overrides: Record<string, unknown> = {},
) {
	return {
		parentSessionId: "chrome-root-session",
		targetId: `target-${type}`,
		sessionId: `chrome-${type}-session`,
		type,
		url: `https://example.com/${type}`,
		title: type,
		navigationGeneration: 1,
		...overrides,
	};
}

function attachedAliases(events: PrototypeCdpEvent[]): string[] {
	return events
		.filter((event) => event.method === "Target.attachedToTarget")
		.map((event) => (event.params as { sessionId: string }).sessionId);
}

class FakeBackend implements PrototypeCdpBackend {
	readonly commands: Array<{ command: PrototypeCdpCommand; signal: AbortSignal }> = [];
	readonly releases: string[] = [];
	sendImpl: PrototypeCdpBackend["send"] = async (command) => ({ method: command.method });

	send(command: PrototypeCdpCommand, signal: AbortSignal): Promise<Record<string, unknown>> {
		this.commands.push({ command, signal });
		return this.sendImpl(command, signal);
	}

	async releaseSession(sessionId: string): Promise<void> {
		this.releases.push(sessionId);
	}
}

function connect(
	adapter: PlaywrightCdpAdapterPrototype,
	clientId: string,
	events: PrototypeCdpEvent[],
	options: { capabilities?: string[]; commandTimeoutMs?: number } = {},
): PrototypePlaywrightClient {
	return adapter.connect({
		clientId,
		bearerAuthenticated: true,
		capabilities: options.capabilities ?? ["playwright_compat"],
		commandTimeoutMs: options.commandTimeoutMs,
		onEvent: (event) => events.push(event),
	});
}

describe("Playwright CDP compatibility adapter prototype", () => {
	afterEach(() => vi.useRealTimers());

	it("replays roots, OOPIF frames, and dedicated workers while filtering browser workers", () => {
		const backend = new FakeBackend();
		const adapter = new PlaywrightCdpAdapterPrototype(backend);
		adapter.announceRoot(root());
		adapter.announceChild(child("iframe"));
		adapter.recordChildFrameEvent("chrome-iframe-session", {
			method: "Page.frameAttached",
			params: { frameId: "oopif-frame", parentFrameId: "root-frame" },
		});
		adapter.recordChildFrameEvent("chrome-iframe-session", {
			method: "Page.frameNavigated",
			params: { frame: { id: "oopif-frame", url: "https://example.com/iframe" } },
		});
		adapter.announceChild(child("worker"));
		adapter.announceChild(child("service_worker"));
		adapter.announceChild(child("shared_worker"));

		const events: PrototypeCdpEvent[] = [];
		connect(adapter, "one", events);
		expect(events.map((event) => event.method)).toEqual([
			"Target.targetCreated",
			"Target.attachedToTarget",
			"Target.attachedToTarget",
			"Page.frameAttached",
			"Page.frameNavigated",
			"Target.attachedToTarget",
		]);
		expect(
			events
				.filter((event) => event.method === "Target.attachedToTarget")
				.map((event) => (event.params as { targetInfo: { type: string } }).targetInfo.type),
		).toEqual(["page", "iframe", "worker"]);
	});

	it("suppresses exact duplicate announcements and replaces duplicate target ids deterministically", () => {
		const adapter = new PlaywrightCdpAdapterPrototype(new FakeBackend());
		const events: PrototypeCdpEvent[] = [];
		connect(adapter, "duplicates", events);
		adapter.announceRoot(root());
		adapter.announceRoot(root());
		adapter.announceChild(child("iframe"));
		adapter.announceChild(child("iframe"));
		expect(events.filter((event) => event.method === "Target.attachedToTarget")).toHaveLength(2);

		adapter.announceChild(child("iframe", { sessionId: "replacement-session", navigationGeneration: 2 }));
		expect(events.slice(-2).map((event) => event.method)).toEqual([
			"Target.detachedFromTarget",
			"Target.attachedToTarget",
		]);
	});

	it("tracks navigation generation without duplicating the root target", () => {
		const adapter = new PlaywrightCdpAdapterPrototype(new FakeBackend());
		const events: PrototypeCdpEvent[] = [];
		const client = connect(adapter, "navigation", events);
		adapter.announceRoot(root());
		const [alias] = attachedAliases(events);
		if (!alias) throw new Error("Expected root alias");
		adapter.navigateRoot(root({ url: "https://example.com/next", navigationGeneration: 5 }));
		adapter.navigateRoot(root({ url: "https://example.com/stale", navigationGeneration: 4 }));
		expect(events.filter((event) => event.method === "Target.targetCreated")).toHaveLength(1);
		expect(events.filter((event) => event.method === "Page.frameNavigated")).toHaveLength(1);
		expect(client.targetGeneration(alias)).toEqual({ rootGeneration: 2, navigationGeneration: 5 });
	});

	it("isolates client aliases and releases backend sessions only after the last client disconnects", async () => {
		const backend = new FakeBackend();
		const adapter = new PlaywrightCdpAdapterPrototype(backend);
		adapter.announceRoot(root());
		const firstEvents: PrototypeCdpEvent[] = [];
		const secondEvents: PrototypeCdpEvent[] = [];
		const first = connect(adapter, "first", firstEvents, { capabilities: ["playwright_compat", "playwright_evaluate"] });
		const second = connect(adapter, "second", secondEvents, {
			capabilities: ["playwright_compat", "playwright_evaluate"],
		});
		const [firstAlias] = attachedAliases(firstEvents);
		const [secondAlias] = attachedAliases(secondEvents);
		expect(firstAlias).not.toBe(secondAlias);
		await first.send({ method: "Runtime.evaluate", sessionId: firstAlias, params: { expression: "document.title" } });
		await second.send({
			method: "Runtime.evaluate",
			sessionId: secondAlias,
			params: { expression: "document.title" },
		});
		expect(backend.commands.map(({ command }) => command.sessionId)).toEqual([
			"chrome-root-session",
			"chrome-root-session",
		]);

		await first.disconnect();
		expect(backend.releases).toEqual([]);
		await second.send({ method: "Runtime.evaluate", sessionId: secondAlias, params: { expression: "location.href" } });
		await second.disconnect();
		expect(backend.releases).toEqual(["chrome-root-session"]);
		await expect(first.send({ method: "Browser.getVersion" })).rejects.toMatchObject({
			code: "CLIENT_DISCONNECTED",
		});
	});

	it("times out, aborts, and discards a late backend result", async () => {
		vi.useFakeTimers();
		const backend = new FakeBackend();
		let resolveBackend: ((value: Record<string, unknown>) => void) | undefined;
		backend.sendImpl = (_command, _signal) =>
			new Promise((resolve) => {
				resolveBackend = resolve;
			});
		const adapter = new PlaywrightCdpAdapterPrototype(backend);
		adapter.announceRoot(root());
		const events: PrototypeCdpEvent[] = [];
		const client = connect(adapter, "timeout", events, {
			capabilities: ["playwright_compat", "playwright_evaluate"],
			commandTimeoutMs: 25,
		});
		const [alias] = attachedAliases(events);
		const pending = client.send({ method: "Runtime.evaluate", sessionId: alias, params: { expression: "42" } });
		const rejection = expect(pending).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
		await vi.advanceTimersByTimeAsync(25);
		await rejection;
		expect(backend.commands[0]?.signal.aborted).toBe(true);
		resolveBackend?.({ value: 42 });
		await Promise.resolve();
		expect(events.filter((event) => event.method === "Runtime.result")).toEqual([]);
		vi.useRealTimers();
	});

	it("rejects pending work immediately on disconnect even when the backend ignores abort", async () => {
		const backend = new FakeBackend();
		backend.sendImpl = () => new Promise(() => undefined);
		const adapter = new PlaywrightCdpAdapterPrototype(backend);
		adapter.announceRoot(root());
		const events: PrototypeCdpEvent[] = [];
		const client = connect(adapter, "disconnect", events, {
			capabilities: ["playwright_compat", "playwright_evaluate"],
		});
		const [alias] = attachedAliases(events);
		const pending = client.send({ method: "Runtime.evaluate", sessionId: alias, params: { expression: "slow()" } });
		const rejection = expect(pending).rejects.toMatchObject({ code: "CLIENT_DISCONNECTED" });
		await client.disconnect();
		await rejection;
		expect(backend.commands[0]?.signal.aborted).toBe(true);
	});

	it("requires bearer authentication and separate evaluate/input capabilities", async () => {
		const backend = new FakeBackend();
		const adapter = new PlaywrightCdpAdapterPrototype(backend);
		expect(() =>
			adapter.connect({
				clientId: "unauthenticated",
				bearerAuthenticated: false,
				capabilities: ["playwright_compat"],
				onEvent: vi.fn(),
			}),
		).toThrowError(PlaywrightAdapterError);
		const events: PrototypeCdpEvent[] = [];
		const client = connect(adapter, "restricted", events);
		adapter.announceRoot(root());
		const [alias] = attachedAliases(events);
		await expect(client.send({ method: "Runtime.evaluate", sessionId: alias })).rejects.toMatchObject({
			code: "CAPABILITY_REQUIRED",
		});
		await expect(client.send({ method: "Input.dispatchMouseEvent", sessionId: alias })).rejects.toMatchObject({
			code: "CAPABILITY_REQUIRED",
		});
		await expect(client.send({ method: "Browser.setDownloadBehavior" })).rejects.toMatchObject({
			code: "METHOD_DENIED",
		});
	});
});
