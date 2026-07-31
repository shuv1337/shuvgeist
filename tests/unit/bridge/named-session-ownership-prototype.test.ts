import {
	type AdoptedTargetIdentity,
	NamedSessionOwnershipPrototype,
	type NamedSessionOwnershipSnapshot,
	OwnershipConflictError,
	type NamedSessionOwnershipPersistence,
} from "@shuvgeist/server/prototypes/named-session-ownership";

class MemoryPersistence implements NamedSessionOwnershipPersistence {
	readonly saves: NamedSessionOwnershipSnapshot[] = [];
	failNext = false;

	async save(snapshot: NamedSessionOwnershipSnapshot): Promise<void> {
		if (this.failNext) {
			this.failNext = false;
			throw new Error("disk unavailable");
		}
		this.saves.push(structuredClone(snapshot));
	}
}

function chromeTarget(overrides: Partial<Extract<AdoptedTargetIdentity, { kind: "chrome-tab" }>> = {}) {
	return {
		kind: "chrome-tab" as const,
		extensionInstanceId: "extension-epoch-1",
		windowId: 7,
		tabId: 9,
		rootGeneration: 2,
		navigationGeneration: 4,
		...overrides,
	};
}

function electronTarget(
	overrides: Partial<Extract<AdoptedTargetIdentity, { kind: "electron-window" }>> = {},
) {
	return {
		kind: "electron-window" as const,
		appId: "com.microsoft.VSCode",
		sessionId: "e1",
		windowRef: "w1",
		targetId: "target-1",
		rootGeneration: 1,
		navigationGeneration: 0,
		...overrides,
	};
}

function createFixture() {
	let now = Date.parse("2026-07-31T12:00:00.000Z");
	let nextId = 0;
	const persistence = new MemoryPersistence();
	const prototype = new NamedSessionOwnershipPrototype({
		persistence,
		now: () => now,
		idFactory: (kind) => `${kind}-${++nextId}`,
	});
	return {
		prototype,
		persistence,
		advance(ms: number) {
			now += ms;
		},
	};
}

describe("named automation session ownership prototype", () => {
	it("prevents two sessions from silently reserving or owning one adopted target", async () => {
		const { prototype } = createFixture();
		const first = await prototype.createSession("research");
		const second = await prototype.createSession("support");
		const target = chromeTarget();
		const attempts = await Promise.allSettled([
			prototype.reserve(first.id, target, 5_000),
			prototype.reserve(second.id, target, 5_000),
		]);
		expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const conflict = attempts.find((result) => result.status === "rejected");
		expect(conflict).toMatchObject({ reason: expect.any(OwnershipConflictError) });
	});

	it("makes reserve, commit, rollback, timeout, and sticky resolution deterministic", async () => {
		const { prototype, advance } = createFixture();
		const first = await prototype.createSession("first");
		const second = await prototype.createSession("second");
		const target = chromeTarget();
		const expired = await prototype.reserve(first.id, target, 100);
		advance(100);
		await expect(prototype.commit(expired.reservationId, 1_000)).rejects.toThrow("missing or expired");

		const rolledBack = await prototype.reserve(first.id, target, 1_000);
		await expect(prototype.rollback(rolledBack.reservationId)).resolves.toBe(true);
		const committedReservation = await prototype.reserve(second.id, target, 1_000);
		const committed = await prototype.commit(committedReservation.reservationId, 5_000);
		expect(prototype.getReservation(committedReservation.reservationId)).toBeUndefined();
		expect(prototype.getOwnership(target)).toEqual(committed);
		expect(prototype.resolveStickyTarget(second.id)).toEqual(target);
		await expect(prototype.reserve(first.id, target, 1_000)).rejects.toBeInstanceOf(OwnershipConflictError);
	});

	it("keeps commit atomic when durable persistence fails", async () => {
		const { prototype, persistence } = createFixture();
		const session = await prototype.createSession("atomic");
		const reservation = await prototype.reserve(session.id, chromeTarget(), 1_000);
		persistence.failNext = true;
		await expect(prototype.commit(reservation.reservationId, 5_000)).rejects.toThrow("disk unavailable");
		expect(prototype.getReservation(reservation.reservationId)).toEqual(reservation);
		expect(prototype.getOwnership(chromeTarget())).toBeUndefined();
	});

	it("rolls back reservations on disconnect but retains committed ownership only for its lease", async () => {
		const { prototype, advance } = createFixture();
		const session = await prototype.createSession("disconnecting");
		const other = await prototype.createSession("other");
		const reservation = await prototype.reserve(session.id, electronTarget({ targetId: "pending" }), 1_000);
		const committedReservation = await prototype.reserve(session.id, electronTarget(), 1_000);
		await prototype.commit(committedReservation.reservationId, 500);

		await prototype.disconnect(session.id);
		expect(prototype.getReservation(reservation.reservationId)).toBeUndefined();
		await expect(prototype.reserve(other.id, electronTarget(), 1_000)).rejects.toBeInstanceOf(
			OwnershipConflictError,
		);
		advance(500);
		await prototype.sweepExpired();
		await expect(prototype.reserve(other.id, electronTarget(), 1_000)).resolves.toMatchObject({
			sessionId: other.id,
		});
	});

	it("updates navigation generation without changing exclusive root ownership", async () => {
		const { prototype } = createFixture();
		const session = await prototype.createSession("navigation");
		const target = chromeTarget();
		const reservation = await prototype.reserve(session.id, target, 1_000);
		await prototype.commit(reservation.reservationId, 5_000);
		const navigated = chromeTarget({ navigationGeneration: 5 });
		await expect(prototype.navigated(navigated)).resolves.toMatchObject({
			target: { rootGeneration: 2, navigationGeneration: 5 },
		});
		expect(prototype.resolveStickyTarget(session.id)).toEqual(navigated);
		await prototype.targetClosed(navigated);
		expect(prototype.resolveStickyTarget(session.id)).toBeUndefined();
	});

	it("restores only committed, unexpired, still-valid roots and leaves sessions disconnected", async () => {
		const { prototype, persistence, advance } = createFixture();
		const session = await prototype.createSession("restore");
		const validTarget = chromeTarget();
		const validReservation = await prototype.reserve(session.id, validTarget, 1_000);
		await prototype.commit(validReservation.reservationId, 5_000);
		const invalidReservation = await prototype.reserve(session.id, electronTarget(), 1_000);
		await prototype.commit(invalidReservation.reservationId, 5_000);
		const snapshot = prototype.snapshot();
		const validOwnership = snapshot.ownerships[0];
		if (!validOwnership) throw new Error("Expected one committed ownership");
		snapshot.ownerships.push({
			...structuredClone(validOwnership),
			ownershipId: "expired-ownership",
			target: chromeTarget({ tabId: 10 }),
			expiresAt: "2026-07-31T12:00:00.050Z",
		});
		advance(100);

		const restoredPersistence = new MemoryPersistence();
		const restored = await NamedSessionOwnershipPrototype.restore(
			snapshot,
			{
				persistence: restoredPersistence,
				now: () => Date.parse("2026-07-31T12:00:00.100Z"),
				idFactory: (kind) => `${kind}-restored`,
			},
			async (target) =>
				target.kind === "chrome-tab" ? { ...target, navigationGeneration: target.navigationGeneration + 1 } : undefined,
		);

		expect(restored.resolveStickyTarget(session.id)).toEqual(chromeTarget({ navigationGeneration: 5 }));
		expect(restored.getOwnership(electronTarget())).toBeUndefined();
		expect(restored.getOwnership(chromeTarget({ tabId: 10 }))).toBeUndefined();
		await expect(restored.reserve(session.id, chromeTarget(), 1_000)).rejects.toThrow("disconnected");
		await expect(restored.resume(session.id)).resolves.toMatchObject({
			lifecycle: "active",
			connectionEpoch: 2,
		});
		expect(restoredPersistence.saves.at(-1)?.ownerships).toHaveLength(1);
		expect(persistence.saves.every((saved) => !("reservations" in saved))).toBe(true);
	});
});
