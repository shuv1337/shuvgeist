import {
	buildLockedSessionsMessage,
	buildLockResult,
	initializeOpenSidepanels,
	markSidepanelOpen,
	releaseWindowState,
	shouldCloseSidepanel,
} from "../../../src/background-state.js";

describe("background state helpers", () => {
	it("initializes and marks sidepanels open", () => {
		const initialized = initializeOpenSidepanels([1, 2]);
		expect([...initialized]).toEqual([1, 2]);
		expect([...markSidepanelOpen(initialized, 3)]).toEqual([1, 2, 3]);
	});

	it("grants and rejects locks based on open owners", () => {
		const openSidepanels = new Set([7]);
		expect(buildLockResult({}, openSidepanels, "session-a", 7)).toEqual({
			response: { type: "lockResult", sessionId: "session-a", success: true },
			nextLocks: { "session-a": 7 },
		});

		const locked = buildLockResult({ "session-a": 7 }, openSidepanels, "session-a", 8);
		expect(locked.response).toEqual({
			type: "lockResult",
			sessionId: "session-a",
			success: false,
			ownerWindowId: 7,
		});
		expect(locked.nextLocks).toEqual({ "session-a": 7 });

		const staleOwner = buildLockResult({ "session-a": 7 }, new Set([8]), "session-a", 8);
		expect(staleOwner.response.success).toBe(true);
		expect(staleOwner.nextLocks).toEqual({ "session-a": 8 });
	});

	it("releases window state and exposes lock snapshots", () => {
		expect(
			releaseWindowState(
				{ sessionLocks: { a: 1, b: 2, c: 1 }, openWindows: [1, 2, 3] },
				1,
			),
		).toEqual({
			sessionLocks: { b: 2 },
			openWindows: [2, 3],
		});
		expect(buildLockedSessionsMessage({ a: 1 })).toEqual({ type: "lockedSessions", locks: { a: 1 } });
		expect(shouldCloseSidepanel(new Set([5]), 5)).toBe(true);
		expect(shouldCloseSidepanel(new Set([5]), 6)).toBe(false);
	});
});
