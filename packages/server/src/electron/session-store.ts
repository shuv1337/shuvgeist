import type { BridgeTarget } from "@shuvgeist/protocol/target";
import { resolveElectronApp } from "./app-registry.js";
import type { ElectronSession, ElectronSessionSummary } from "./types.js";

export type ElectronSessionCreateInput = Omit<
	ElectronSession,
	"id" | "startedAt" | "nextWindowNumber" | "windows" | "ipcTaps" | "mainNetworkTaps"
>;

export class ElectronSessionStore {
	private readonly sessions = new Map<string, ElectronSession>();
	private nextSessionNumber = 1;

	list(): ElectronSession[] {
		return Array.from(this.sessions.values());
	}

	get(sessionId: string | undefined): ElectronSession | undefined {
		return sessionId ? this.sessions.get(sessionId) : undefined;
	}

	findByEndpointKey(endpointKey: string): ElectronSession | undefined {
		return Array.from(this.sessions.values()).find((session) => session.endpointKey === endpointKey);
	}

	findEndpointConflicts(endpointKey: string, port: number): ElectronSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) => session.port === port && session.endpointKey !== endpointKey,
		);
	}

	findByPort(port: number): ElectronSession[] {
		return Array.from(this.sessions.values()).filter((session) => session.port === port);
	}

	delete(sessionId: string): boolean {
		return this.sessions.delete(sessionId);
	}

	create(session: ElectronSessionCreateInput): ElectronSession {
		const next: ElectronSession = {
			...session,
			id: `e${this.nextSessionNumber++}`,
			startedAt: new Date().toISOString(),
			nextWindowNumber: 1,
			windows: [],
			ipcTaps: [],
			mainNetworkTaps: [],
		};
		this.sessions.set(next.id, next);
		return next;
	}

	resolveTargetSession(target: BridgeTarget): ElectronSession | undefined {
		if (target.kind !== "electron-window") return undefined;
		if (target.sessionId) {
			const session = this.sessions.get(target.sessionId);
			if (!session) return undefined;
			return !target.appRef || sessionMatchesAppRef(session, target.appRef) ? session : undefined;
		}
		if (target.appRef) {
			return Array.from(this.sessions.values()).find((session) => sessionMatchesAppRef(session, target.appRef!));
		}
		return Array.from(this.sessions.values())[0];
	}

	toSummary(session: ElectronSession): ElectronSessionSummary {
		return {
			id: session.id,
			appId: session.appId,
			appRef: session.appRef,
			pid: session.pid,
			port: session.port,
			browser: session.browser,
			mainInspector: session.mainInspector,
			launched: session.launched,
			startedAt: session.startedAt,
			windows: session.windows
				.filter((window) => !window.closed)
				.map((window) => ({
					ref: window.ref,
					label: window.label,
					type: window.type,
					title: window.title,
					url: window.url,
					isPrimary: window.isPrimary,
					closed: window.closed,
				})),
		};
	}

	summaries(sessions = this.list()): ElectronSessionSummary[] {
		return sessions.map((session) => this.toSummary(session));
	}
}

function sessionMatchesAppRef(session: ElectronSession, appRef: string): boolean {
	const normalized = appRef.trim().toLowerCase();
	if (!normalized) return false;
	if (session.appRef?.trim().toLowerCase() === normalized || session.appId?.toLowerCase() === normalized) return true;
	const app = resolveElectronApp(appRef);
	return Boolean(app && session.appId === app.id);
}
