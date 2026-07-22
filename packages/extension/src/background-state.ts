import type { LockedSessionsMessage, LockResultMessage } from "./utils/port.js";

export const SIDEPANEL_OPEN_KEY = "sidepanel_open_windows";
export const SESSION_LOCKS_KEY = "session_locks";

export interface SessionStateSnapshot {
	sessionLocks: Record<string, number>;
	openWindows: number[];
}

export function initializeOpenSidepanels(openWindows: number[] | undefined): Set<number> {
	return new Set<number>(openWindows || []);
}

export function markSidepanelOpen(openSidepanels: Set<number>, windowId: number): Set<number> {
	const next = new Set(openSidepanels);
	next.add(windowId);
	return next;
}

export function buildLockResult(
	sessionLocks: Record<string, number>,
	_openSidepanels: Set<number>,
	sessionId: string,
	reqWindowId: number,
): { response: LockResultMessage; nextLocks: Record<string, number> } {
	const ownerWindowId = sessionLocks[sessionId];
	const success = ownerWindowId === undefined || ownerWindowId === reqWindowId;

	if (success) {
		// A browser window owns at most one active agent session. Switching the
		// sidepanel URL transfers that window's ownership without making panel
		// disconnect itself a release signal.
		const nextLocks = Object.fromEntries(
			Object.entries(sessionLocks).filter(([, windowId]) => windowId !== reqWindowId),
		);
		nextLocks[sessionId] = reqWindowId;
		return {
			response: {
				type: "lockResult",
				sessionId,
				success: true,
			},
			nextLocks,
		};
	}

	return {
		response: {
			type: "lockResult",
			sessionId,
			success: false,
			ownerWindowId,
		},
		nextLocks: { ...sessionLocks },
	};
}

/** Mark presentation as closed without releasing durable runtime ownership. */
export function markSidepanelClosed(snapshot: SessionStateSnapshot, windowId: number): SessionStateSnapshot {
	return {
		sessionLocks: { ...snapshot.sessionLocks },
		openWindows: snapshot.openWindows.filter((openWindowId) => openWindowId !== windowId),
	};
}

export function buildLockedSessionsMessage(sessionLocks: Record<string, number>): LockedSessionsMessage {
	return {
		type: "lockedSessions",
		locks: { ...sessionLocks },
	};
}

export function releaseWindowState(snapshot: SessionStateSnapshot, windowId: number): SessionStateSnapshot {
	const nextLocks: Record<string, number> = {};
	for (const [sessionId, ownerWindowId] of Object.entries(snapshot.sessionLocks)) {
		if (ownerWindowId !== windowId) {
			nextLocks[sessionId] = ownerWindowId;
		}
	}

	const nextOpenWindows = snapshot.openWindows.filter((openWindowId) => openWindowId !== windowId);
	return {
		sessionLocks: nextLocks,
		openWindows: nextOpenWindows,
	};
}

export function shouldCloseSidepanel(openSidepanels: Set<number>, windowId: number): boolean {
	return openSidepanels.has(windowId);
}
