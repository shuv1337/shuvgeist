import { TaskRegistry } from "@shuvgeist/server/task-registry";

describe("TaskRegistry", () => {
	it("creates queued task handles with generated ids and metadata", () => {
		const registry = new TaskRegistry();

		const first = registry.create({ kind: "page_snapshot", metadata: { tabId: 7 } });
		const second = registry.create({ kind: "agent_task" });

		expect(first).toMatchObject({
			id: "task_1",
			kind: "page_snapshot",
			status: "queued",
			metadata: { tabId: 7 },
		});
		expect(second.id).toBe("task_2");
		expect(first.createdAt).toBe(first.updatedAt);
		expect(registry.get(first.id)).toBe(first);
	});

	it("transitions queued tasks through running and succeeded states", () => {
		const registry = new TaskRegistry();
		const task = registry.create({ id: "custom-task", kind: "browser_task" });

		const running = registry.start(task.id);
		expect(running).toMatchObject({ id: "custom-task", status: "running" });
		expect(running.startedAt).toBeDefined();

		const succeeded = registry.succeed(task.id, { ok: true });
		expect(succeeded).toMatchObject({ status: "succeeded", result: { ok: true } });
		expect(succeeded.endedAt).toBeDefined();
		expect(registry.list()).toEqual([succeeded]);
	});

	it("records failure and cancellation as terminal states", () => {
		const registry = new TaskRegistry();
		const failed = registry.create({ kind: "browser_task" });
		const cancelled = registry.create({ kind: "browser_task" });

		expect(registry.fail(failed.id, "navigation failed")).toMatchObject({
			status: "failed",
			error: "navigation failed",
		});
		expect(registry.cancel(cancelled.id, "user stopped task")).toMatchObject({
			status: "cancelled",
			error: "user stopped task",
		});
	});

	it("rejects invalid lifecycle transitions", () => {
		const registry = new TaskRegistry();
		const task = registry.create({ kind: "browser_task" });

		registry.succeed(task.id);

		expect(() => registry.start(task.id)).toThrow("Cannot start task 'task_1' from status 'succeeded'");
		expect(() => registry.fail(task.id, "late failure")).toThrow(
			"Cannot finish task 'task_1' from status 'succeeded'",
		);
		expect(() => registry.get("missing")).not.toThrow();
		expect(() => registry.start("missing")).toThrow("Unknown task 'missing'");
	});
});
