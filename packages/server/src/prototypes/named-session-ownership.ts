export type AutomationSessionLifecycle = "active" | "disconnected" | "cancelled" | "closed";

interface AdoptedTargetBase {
	rootGeneration: number;
	navigationGeneration: number;
}

export type AdoptedTargetIdentity =
	| (AdoptedTargetBase & {
			kind: "chrome-tab";
			extensionInstanceId: string;
			windowId: number;
			tabId: number;
	  })
	| (AdoptedTargetBase & {
			kind: "electron-window";
			appId: string;
			sessionId: string;
			windowRef: string;
			targetId: string;
	  });

export interface NamedAutomationSession {
	id: string;
	name: string;
	lifecycle: AutomationSessionLifecycle;
	connectionEpoch: number;
	createdAt: string;
	updatedAt: string;
}

export interface TargetReservation {
	state: "reserved";
	reservationId: string;
	sessionId: string;
	target: AdoptedTargetIdentity;
	createdAt: string;
	expiresAt: string;
}

export interface CommittedTargetOwnership {
	state: "committed";
	ownershipId: string;
	sessionId: string;
	target: AdoptedTargetIdentity;
	committedAt: string;
	expiresAt: string;
}

export interface NamedSessionOwnershipSnapshot {
	version: 1;
	savedAt: string;
	sessions: NamedAutomationSession[];
	ownerships: CommittedTargetOwnership[];
}

export interface NamedSessionOwnershipPersistence {
	save(snapshot: NamedSessionOwnershipSnapshot): Promise<void>;
}

export interface NamedSessionOwnershipPrototypeOptions {
	persistence: NamedSessionOwnershipPersistence;
	now?: () => number;
	idFactory?: (kind: "session" | "reservation" | "ownership") => string;
}

export class OwnershipConflictError extends Error {
	readonly code = "TARGET_ALREADY_OWNED";

	constructor(
		readonly targetKey: string,
		readonly ownerSessionId: string,
	) {
		super(`Target ${targetKey} is already reserved or owned by session ${ownerSessionId}.`);
	}
}

export class OwnershipStateError extends Error {
	readonly code = "INVALID_OWNERSHIP_STATE";
}

function cloneTarget(target: AdoptedTargetIdentity): AdoptedTargetIdentity {
	return { ...target };
}

function cloneSession(session: NamedAutomationSession): NamedAutomationSession {
	return { ...session };
}

function cloneOwnership(ownership: CommittedTargetOwnership): CommittedTargetOwnership {
	return { ...ownership, target: cloneTarget(ownership.target) };
}

export function adoptedTargetKey(target: AdoptedTargetIdentity): string {
	if (target.kind === "chrome-tab") {
		return ["chrome-tab", target.extensionInstanceId, target.windowId, target.tabId, target.rootGeneration].join(":");
	}
	return [
		"electron-window",
		target.appId,
		target.sessionId,
		target.windowRef,
		target.targetId,
		target.rootGeneration,
	].join(":");
}

function assertName(name: string): string {
	const normalized = name.trim();
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(normalized)) {
		throw new OwnershipStateError("Session names must be 1-64 safe characters.");
	}
	return normalized;
}

function assertDuration(label: string, value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new OwnershipStateError(`${label} must be a positive integer.`);
	}
}

/**
 * Executable architecture prototype only. It intentionally has no bridge,
 * CLI, MCP, or SessionRegistry integration.
 */
export class NamedSessionOwnershipPrototype {
	private readonly sessions = new Map<string, NamedAutomationSession>();
	private readonly reservations = new Map<string, TargetReservation>();
	private readonly ownershipByTarget = new Map<string, CommittedTargetOwnership>();
	private readonly now: () => number;
	private readonly idFactory: (kind: "session" | "reservation" | "ownership") => string;
	private mutationTail = Promise.resolve();

	constructor(private readonly options: NamedSessionOwnershipPrototypeOptions) {
		this.now = options.now ?? Date.now;
		this.idFactory = options.idFactory ?? ((kind) => `${kind}-${crypto.randomUUID()}`);
	}

	async createSession(name: string): Promise<NamedAutomationSession> {
		return this.exclusive(async () => {
			const safeName = assertName(name);
			if ([...this.sessions.values()].some((session) => session.name === safeName)) {
				throw new OwnershipStateError(`Session name ${safeName} is already in use.`);
			}
			const now = this.isoNow();
			const session: NamedAutomationSession = {
				id: this.idFactory("session"),
				name: safeName,
				lifecycle: "active",
				connectionEpoch: 1,
				createdAt: now,
				updatedAt: now,
			};
			await this.options.persistence.save(this.snapshotWith({ session }));
			this.sessions.set(session.id, session);
			return cloneSession(session);
		});
	}

	async reserve(
		sessionId: string,
		target: AdoptedTargetIdentity,
		reservationTtlMs: number,
	): Promise<TargetReservation> {
		return this.exclusive(async () => {
			assertDuration("reservationTtlMs", reservationTtlMs);
			await this.sweepExpiredInternal();
			const session = this.requireActiveSession(sessionId);
			const key = adoptedTargetKey(target);
			const committed = this.ownershipByTarget.get(key);
			if (committed && committed.sessionId !== sessionId) {
				throw new OwnershipConflictError(key, committed.sessionId);
			}
			const reserved = [...this.reservations.values()].find(
				(candidate) => adoptedTargetKey(candidate.target) === key,
			);
			if (reserved) throw new OwnershipConflictError(key, reserved.sessionId);
			if (committed) {
				throw new OwnershipStateError(`Session ${sessionId} already owns target ${key}.`);
			}
			const now = this.now();
			const reservation: TargetReservation = {
				state: "reserved",
				reservationId: this.idFactory("reservation"),
				sessionId: session.id,
				target: cloneTarget(target),
				createdAt: new Date(now).toISOString(),
				expiresAt: new Date(now + reservationTtlMs).toISOString(),
			};
			this.reservations.set(reservation.reservationId, reservation);
			return { ...reservation, target: cloneTarget(reservation.target) };
		});
	}

	async commit(reservationId: string, leaseTtlMs: number): Promise<CommittedTargetOwnership> {
		return this.exclusive(async () => {
			assertDuration("leaseTtlMs", leaseTtlMs);
			await this.sweepExpiredInternal();
			const reservation = this.reservations.get(reservationId);
			if (!reservation) throw new OwnershipStateError(`Reservation ${reservationId} is missing or expired.`);
			this.requireActiveSession(reservation.sessionId);
			const key = adoptedTargetKey(reservation.target);
			const conflict = this.ownershipByTarget.get(key);
			if (conflict) throw new OwnershipConflictError(key, conflict.sessionId);
			const now = this.now();
			const ownership: CommittedTargetOwnership = {
				state: "committed",
				ownershipId: this.idFactory("ownership"),
				sessionId: reservation.sessionId,
				target: cloneTarget(reservation.target),
				committedAt: new Date(now).toISOString(),
				expiresAt: new Date(now + leaseTtlMs).toISOString(),
			};
			await this.options.persistence.save(this.snapshotWith({ ownership }));
			this.reservations.delete(reservationId);
			this.ownershipByTarget.set(key, ownership);
			return cloneOwnership(ownership);
		});
	}

	async rollback(reservationId: string): Promise<boolean> {
		return this.exclusive(async () => this.reservations.delete(reservationId));
	}

	async disconnect(sessionId: string): Promise<void> {
		await this.exclusive(async () => {
			const session = this.requireSession(sessionId);
			const updated = { ...session, lifecycle: "disconnected" as const, updatedAt: this.isoNow() };
			const reservations = [...this.reservations.values()].filter((item) => item.sessionId === sessionId);
			await this.options.persistence.save(this.snapshotWith({ session: updated }));
			this.sessions.set(sessionId, updated);
			for (const reservation of reservations) this.reservations.delete(reservation.reservationId);
		});
	}

	async resume(sessionId: string): Promise<NamedAutomationSession> {
		return this.exclusive(async () => {
			const session = this.requireSession(sessionId);
			if (session.lifecycle !== "disconnected") {
				throw new OwnershipStateError(`Session ${sessionId} is not disconnected.`);
			}
			const updated: NamedAutomationSession = {
				...session,
				lifecycle: "active",
				connectionEpoch: session.connectionEpoch + 1,
				updatedAt: this.isoNow(),
			};
			await this.options.persistence.save(this.snapshotWith({ session: updated }));
			this.sessions.set(sessionId, updated);
			return cloneSession(updated);
		});
	}

	async cancel(sessionId: string): Promise<void> {
		await this.finishSession(sessionId, "cancelled");
	}

	async close(sessionId: string): Promise<void> {
		await this.finishSession(sessionId, "closed");
	}

	async targetClosed(target: AdoptedTargetIdentity): Promise<void> {
		await this.exclusive(async () => {
			const key = adoptedTargetKey(target);
			const ownership = this.ownershipByTarget.get(key);
			const reservations = [...this.reservations.values()].filter(
				(candidate) => adoptedTargetKey(candidate.target) === key,
			);
			if (!ownership && reservations.length === 0) return;
			await this.options.persistence.save(this.snapshotWith({ removeTargetKey: key }));
			this.ownershipByTarget.delete(key);
			for (const reservation of reservations) this.reservations.delete(reservation.reservationId);
		});
	}

	async navigated(target: AdoptedTargetIdentity): Promise<CommittedTargetOwnership | undefined> {
		return this.exclusive(async () => {
			const key = adoptedTargetKey(target);
			const ownership = this.ownershipByTarget.get(key);
			if (!ownership) return undefined;
			if (target.navigationGeneration <= ownership.target.navigationGeneration) return cloneOwnership(ownership);
			const updated = { ...ownership, target: cloneTarget(target) };
			await this.options.persistence.save(this.snapshotWith({ ownership: updated }));
			this.ownershipByTarget.set(key, updated);
			return cloneOwnership(updated);
		});
	}

	async sweepExpired(): Promise<void> {
		await this.exclusive(() => this.sweepExpiredInternal());
	}

	resolveStickyTarget(sessionId: string): AdoptedTargetIdentity | undefined {
		const candidates = [...this.ownershipByTarget.values()].filter((ownership) => ownership.sessionId === sessionId);
		if (candidates.length > 1) {
			throw new OwnershipStateError(`Session ${sessionId} has multiple adopted targets; choose one explicitly.`);
		}
		return candidates[0] ? cloneTarget(candidates[0].target) : undefined;
	}

	getReservation(reservationId: string): TargetReservation | undefined {
		const reservation = this.reservations.get(reservationId);
		return reservation ? { ...reservation, target: cloneTarget(reservation.target) } : undefined;
	}

	getOwnership(target: AdoptedTargetIdentity): CommittedTargetOwnership | undefined {
		const ownership = this.ownershipByTarget.get(adoptedTargetKey(target));
		return ownership ? cloneOwnership(ownership) : undefined;
	}

	snapshot(): NamedSessionOwnershipSnapshot {
		return this.snapshotWith();
	}

	static async restore(
		snapshot: NamedSessionOwnershipSnapshot,
		options: NamedSessionOwnershipPrototypeOptions,
		validateTarget: (target: AdoptedTargetIdentity) => Promise<AdoptedTargetIdentity | undefined>,
	): Promise<NamedSessionOwnershipPrototype> {
		if (snapshot.version !== 1) throw new OwnershipStateError(`Unsupported snapshot version ${snapshot.version}.`);
		const prototype = new NamedSessionOwnershipPrototype(options);
		const now = prototype.now();
		for (const stored of snapshot.sessions) {
			if (stored.lifecycle === "cancelled" || stored.lifecycle === "closed") continue;
			prototype.sessions.set(stored.id, {
				...stored,
				lifecycle: "disconnected",
				updatedAt: new Date(now).toISOString(),
			});
		}
		for (const stored of snapshot.ownerships) {
			if (Date.parse(stored.expiresAt) <= now || !prototype.sessions.has(stored.sessionId)) continue;
			const validated = await validateTarget(cloneTarget(stored.target));
			if (!validated || adoptedTargetKey(validated) !== adoptedTargetKey(stored.target)) continue;
			const restored = { ...stored, target: cloneTarget(validated) };
			const key = adoptedTargetKey(restored.target);
			if (prototype.ownershipByTarget.has(key)) continue;
			prototype.ownershipByTarget.set(key, restored);
		}
		await options.persistence.save(prototype.snapshot());
		return prototype;
	}

	private async finishSession(sessionId: string, lifecycle: "cancelled" | "closed"): Promise<void> {
		await this.exclusive(async () => {
			const session = this.requireSession(sessionId);
			const updated = { ...session, lifecycle, updatedAt: this.isoNow() };
			await this.options.persistence.save(this.snapshotWith({ session: updated, removeSessionId: sessionId }));
			this.sessions.set(sessionId, updated);
			for (const [key, ownership] of this.ownershipByTarget) {
				if (ownership.sessionId === sessionId) this.ownershipByTarget.delete(key);
			}
			for (const [id, reservation] of this.reservations) {
				if (reservation.sessionId === sessionId) this.reservations.delete(id);
			}
		});
	}

	private async sweepExpiredInternal(): Promise<void> {
		const now = this.now();
		for (const [id, reservation] of this.reservations) {
			if (Date.parse(reservation.expiresAt) <= now) this.reservations.delete(id);
		}
		const expiredKeys = [...this.ownershipByTarget]
			.filter(([, ownership]) => Date.parse(ownership.expiresAt) <= now)
			.map(([key]) => key);
		if (expiredKeys.length === 0) return;
		await this.options.persistence.save(this.snapshotWith({ removeTargetKeys: new Set(expiredKeys) }));
		for (const key of expiredKeys) this.ownershipByTarget.delete(key);
	}

	private snapshotWith(
		overrides: {
			session?: NamedAutomationSession;
			ownership?: CommittedTargetOwnership;
			removeTargetKey?: string;
			removeTargetKeys?: ReadonlySet<string>;
			removeSessionId?: string;
		} = {},
	): NamedSessionOwnershipSnapshot {
		const sessions = new Map([...this.sessions].map(([id, session]) => [id, cloneSession(session)]));
		if (overrides.session) sessions.set(overrides.session.id, cloneSession(overrides.session));
		const ownerships = new Map(
			[...this.ownershipByTarget].map(([key, ownership]) => [key, cloneOwnership(ownership)]),
		);
		if (overrides.ownership) {
			ownerships.set(adoptedTargetKey(overrides.ownership.target), cloneOwnership(overrides.ownership));
		}
		if (overrides.removeTargetKey) ownerships.delete(overrides.removeTargetKey);
		for (const key of overrides.removeTargetKeys ?? []) ownerships.delete(key);
		if (overrides.removeSessionId) {
			for (const [key, ownership] of ownerships) {
				if (ownership.sessionId === overrides.removeSessionId) ownerships.delete(key);
			}
		}
		return {
			version: 1,
			savedAt: this.isoNow(),
			sessions: [...sessions.values()].sort((left, right) => left.id.localeCompare(right.id)),
			ownerships: [...ownerships.values()].sort((left, right) =>
				adoptedTargetKey(left.target).localeCompare(adoptedTargetKey(right.target)),
			),
		};
	}

	private requireSession(sessionId: string): NamedAutomationSession {
		const session = this.sessions.get(sessionId);
		if (!session) throw new OwnershipStateError(`Unknown automation session ${sessionId}.`);
		return session;
	}

	private requireActiveSession(sessionId: string): NamedAutomationSession {
		const session = this.requireSession(sessionId);
		if (session.lifecycle !== "active") {
			throw new OwnershipStateError(`Automation session ${sessionId} is ${session.lifecycle}, not active.`);
		}
		return session;
	}

	private isoNow(): string {
		return new Date(this.now()).toISOString();
	}

	private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.mutationTail;
		let release = (): void => undefined;
		this.mutationTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}
