import {
	HandoffCoordinator,
	type HandoffPageEvent,
} from "@shuvgeist/extension/bridge/handoff-coordinator";

function start(coordinator: HandoffCoordinator, signal?: AbortSignal) {
	return coordinator.start(
		{
			taskId: "task-1",
			sessionId: "session-1",
			kind: "manual",
			windowId: 7,
			tabId: 42,
			frameId: 3,
			navigationGeneration: 9,
		},
		10_000,
		signal,
	);
}

function event(
	active: ReturnType<typeof start>,
	state: HandoffPageEvent["state"],
	overrides: Partial<HandoffPageEvent> = {},
): HandoffPageEvent {
	return {
		type: "shuvgeist-handoff-lifecycle",
		handoffId: active.binding.handoffId,
		taskId: active.binding.taskId,
		sessionId: active.binding.sessionId,
		tabId: active.binding.tabId,
		frameId: active.binding.frameId,
		navigationGeneration: active.binding.navigationGeneration,
		state,
		...overrides,
	};
}

describe("HandoffCoordinator", () => {
	afterEach(() => vi.useRealTimers());

	it("requires exact identity and acknowledgement before one matching completion", async () => {
		const coordinator = new HandoffCoordinator();
		const active = start(coordinator);
		const sender = { tabId: 42, frameId: 3 };

		expect(coordinator.acceptPageEvent({ ...event(active, "acknowledged"), state: "started" }, sender)).toEqual({
			ok: false,
			reason: "Malformed handoff event",
		});
		expect(coordinator.acceptPageEvent(event(active, "acknowledged", { tabId: 41 }), sender)).toEqual({
			ok: false,
			reason: "Handoff identity does not match the active target",
		});
		expect(coordinator.acceptPageEvent(event(active, "completed"), sender)).toEqual({
			ok: false,
			reason: "Completion requires acknowledgement",
		});
		expect(coordinator.acceptPageEvent(event(active, "acknowledged"), sender)).toEqual({ ok: true });
		await expect(active.acknowledged).resolves.toEqual(expect.any(String));
		expect(coordinator.acceptPageEvent(event(active, "acknowledged"), sender)).toEqual({
			ok: false,
			reason: "Duplicate or out-of-order acknowledgement",
		});
		expect(coordinator.acceptPageEvent(event(active, "completed"), sender)).toEqual({ ok: true });
		await expect(active.terminal).resolves.toMatchObject({ state: "completed", acknowledgedAt: expect.any(String) });
		expect(coordinator.acceptPageEvent(event(active, "completed"), sender)).toEqual({
			ok: false,
			reason: "Unknown or stale handoff",
		});
	});

	it("rejects a completion after the target navigation generation changes", async () => {
		let current = true;
		const coordinator = new HandoffCoordinator();
		const active = coordinator.start(
			{
				taskId: "task-1",
				sessionId: "session-1",
				kind: "manual",
				windowId: 7,
				tabId: 42,
				frameId: 0,
				navigationGeneration: 9,
			},
			10_000,
			undefined,
			() => current,
		);
		expect(coordinator.acceptPageEvent(event(active, "acknowledged", { frameId: 0 }), { tabId: 42, frameId: 0 })).toEqual({
			ok: true,
		});
		current = false;
		expect(coordinator.acceptPageEvent(event(active, "completed", { frameId: 0 }), { tabId: 42, frameId: 0 })).toEqual({
			ok: false,
			reason: "Handoff target navigation generation is stale",
		});
		await expect(active.terminal).resolves.toMatchObject({ state: "cancelled" });
	});

	it("revokes the binding before timeout or abort can accept late work", async () => {
		vi.useFakeTimers();
		const coordinator = new HandoffCoordinator();
		let revokeCheck: { ok: boolean; reason?: string } | undefined;
		const active = coordinator.start(
			{
				taskId: "task-1",
				sessionId: "session-1",
				kind: "manual",
				windowId: 7,
				tabId: 42,
				frameId: 3,
				navigationGeneration: 9,
			},
			10_000,
			undefined,
			undefined,
			() => {
				revokeCheck = coordinator.acceptPageEvent(event(active, "acknowledged"), { tabId: 42, frameId: 3 });
			},
		);
		void active.acknowledged.catch(() => undefined);
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(active.terminal).resolves.toMatchObject({ state: "timed_out" });
		expect(revokeCheck).toEqual({ ok: false, reason: "Unknown or stale handoff" });
		expect(coordinator.acceptPageEvent(event(active, "acknowledged"), { tabId: 42, frameId: 3 })).toMatchObject({
			ok: false,
		});

		const controller = new AbortController();
		const aborted = start(coordinator, controller.signal);
		void aborted.acknowledged.catch(() => undefined);
		controller.abort();
		await expect(aborted.terminal).resolves.toMatchObject({ state: "cancelled" });
		expect(coordinator.acceptPageEvent(event(aborted, "acknowledged"), { tabId: 42, frameId: 3 })).toMatchObject({
			ok: false,
		});
	});
});
