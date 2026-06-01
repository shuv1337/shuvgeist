import { describe, expect, it } from "vitest";
import { PerHandleWriteLock } from "../../../src/bridge/per-handle-write-lock.js";
import { SessionRegistry } from "../../../src/bridge/session-registry.js";

describe("PerHandleWriteLock", () => {
	it("enforces one writer per handle until the holder is released", () => {
		const lock = new PerHandleWriteLock();

		expect(lock.acquire("cli-a", "session-a")).toEqual({
			ok: true,
			holder: { cliConnectionId: "cli-a", sessionId: "session-a" },
		});
		expect(lock.acquire("cli-b")).toEqual({
			ok: false,
			holder: { cliConnectionId: "cli-a", sessionId: "session-a" },
		});
		expect(lock.releaseForSessionChange("session-b")).toEqual({
			cliConnectionId: "cli-a",
			sessionId: "session-a",
		});
		expect(lock.acquire("cli-b")).toEqual({
			ok: true,
			holder: { cliConnectionId: "cli-b", sessionId: undefined },
		});
	});
});

describe("SessionRegistry", () => {
	it("resolves the active handle for default chrome targets", () => {
		const registry = new SessionRegistry<{ id: string }>();
		const first = registry.register({
			kind: "chrome-tab",
			connection: { id: "extension-1" },
			windowId: 7,
			sessionId: "session-7",
			capabilities: ["status", "page_snapshot"],
		});
		const second = registry.register({
			kind: "chrome-tab",
			connection: { id: "extension-2" },
			windowId: 8,
			sessionId: "session-8",
			capabilities: ["status"],
		});

		expect(first.key).toBe("chrome-window:7");
		expect(second.key).toBe("chrome-window:8");
		expect(registry.activeHandle).toBe(second);
		expect(registry.resolve({ kind: "chrome-tab" })).toBe(second);
		expect(registry.resolve({ kind: "chrome-tab", tabRef: "window:7" })).toBe(first);
		expect(registry.resolve({ kind: "chrome-tab", tabRef: "session-8" })).toBe(second);
		expect(registry.get(first.key)).toBe(first);
		expect(registry.findByConnection(first.connection)).toBe(first);
	});

	it("clears handle writer state when the registered connection is removed", () => {
		const registry = new SessionRegistry<{ id: string }>();
		const connection = { id: "extension-1" };
		const handle = registry.register({ kind: "chrome-tab", connection, windowId: 9 });
		const remaining = registry.register({ kind: "chrome-tab", connection: { id: "extension-2" }, windowId: 10 });
		handle.writeLock.acquire("cli-a", "session-a");

		expect(registry.unregisterByConnection(connection)).toBe(handle);
		expect(registry.activeHandle).toBe(remaining);
		expect(handle.writeLock.currentHolder).toBeUndefined();
	});

	it("releases writer locks for one cli across all handles", () => {
		const registry = new SessionRegistry<{ id: string }>();
		const first = registry.register({ kind: "chrome-tab", connection: { id: "extension-1" }, windowId: 1 });
		const second = registry.register({ kind: "chrome-tab", connection: { id: "extension-2" }, windowId: 2 });
		first.writeLock.acquire("cli-a", "session-a");
		second.writeLock.acquire("cli-a", "session-b");

		expect(registry.releaseLocksForCli("cli-a")).toEqual([
			{ handle: first, sessionId: "session-a" },
			{ handle: second, sessionId: "session-b" },
		]);
		expect(first.writeLock.currentHolder).toBeUndefined();
		expect(second.writeLock.currentHolder).toBeUndefined();
	});
});
