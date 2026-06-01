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
	it("resolves the single day-one handle regardless of requested target", () => {
		const registry = new SessionRegistry<{ id: string }>();
		const handle = registry.register({
			kind: "chrome-tab",
			connection: { id: "extension-1" },
			windowId: 7,
			sessionId: "session-7",
			capabilities: ["status", "page_snapshot"],
		});

		expect(handle.key).toBe("chrome-window:7");
		expect(registry.activeHandle).toBe(handle);
		expect(registry.resolve({ kind: "chrome-tab", tabId: 42 })).toBe(handle);
		expect(registry.get(handle.key)).toBe(handle);
		expect(registry.findByConnection(handle.connection)).toBe(handle);
	});

	it("clears handle writer state when the registered connection is removed", () => {
		const registry = new SessionRegistry<{ id: string }>();
		const connection = { id: "extension-1" };
		const handle = registry.register({ kind: "chrome-tab", connection, windowId: 9 });
		handle.writeLock.acquire("cli-a", "session-a");

		expect(registry.unregisterByConnection(connection)).toBe(handle);
		expect(registry.activeHandle).toBeUndefined();
		expect(handle.writeLock.currentHolder).toBeUndefined();
	});
});
