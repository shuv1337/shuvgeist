import type { BridgeTarget } from "../target.js";
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
		if (target.sessionId) return this.sessions.get(target.sessionId);
		if (target.appRef) {
			const app = resolveElectronApp(target.appRef);
			return Array.from(this.sessions.values()).find(
				(session) => session.appRef === target.appRef || (app && session.appId === app.id),
			);
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
