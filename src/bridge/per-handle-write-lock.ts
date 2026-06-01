export interface PerHandleWriteLockHolder {
	cliConnectionId: string;
	sessionId?: string;
}

export type PerHandleWriteLockAcquireResult =
	| { ok: true; holder: PerHandleWriteLockHolder }
	| { ok: false; holder: PerHandleWriteLockHolder };

export class PerHandleWriteLock {
	private holder?: PerHandleWriteLockHolder;

	get currentHolder(): PerHandleWriteLockHolder | undefined {
		return this.holder;
	}

	acquire(cliConnectionId: string, sessionId?: string): PerHandleWriteLockAcquireResult {
		if (this.holder && this.holder.cliConnectionId !== cliConnectionId) {
			return { ok: false, holder: this.holder };
		}
		this.holder = { cliConnectionId, sessionId };
		return { ok: true, holder: this.holder };
	}

	releaseForCli(cliConnectionId: string): boolean {
		if (this.holder?.cliConnectionId !== cliConnectionId) return false;
		this.holder = undefined;
		return true;
	}

	releaseForSessionChange(sessionId?: string): PerHandleWriteLockHolder | undefined {
		if (!this.holder?.sessionId || this.holder.sessionId === sessionId) return undefined;
		const released = this.holder;
		this.holder = undefined;
		return released;
	}

	clear(): void {
		this.holder = undefined;
	}
}
