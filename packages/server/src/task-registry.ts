/** Lifecycle state for server-managed asynchronous tasks. */
export type TaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface TaskHandle<TResult = unknown, TMetadata extends Record<string, unknown> = Record<string, unknown>> {
	id: string;
	kind: string;
	status: TaskStatus;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	endedAt?: string;
	metadata: TMetadata;
	result?: TResult;
	error?: string;
}

export interface CreateTaskOptions<TMetadata extends Record<string, unknown> = Record<string, unknown>> {
	id?: string;
	kind: string;
	metadata?: TMetadata;
}

export class TaskRegistry {
	private readonly tasks = new Map<string, TaskHandle>();
	private nextTaskNumber = 1;

	create<TMetadata extends Record<string, unknown> = Record<string, unknown>>(
		options: CreateTaskOptions<TMetadata>,
	): TaskHandle<unknown, TMetadata> {
		const now = new Date().toISOString();
		const task: TaskHandle<unknown, TMetadata> = {
			id: options.id ?? this.createTaskId(),
			kind: options.kind,
			status: "queued",
			createdAt: now,
			updatedAt: now,
			metadata: options.metadata ?? ({} as TMetadata),
		};
		this.tasks.set(task.id, task as TaskHandle);
		return task;
	}

	start(id: string): TaskHandle {
		const task = this.requireTask(id);
		if (task.status !== "queued") {
			throw new Error(`Cannot start task '${id}' from status '${task.status}'`);
		}
		const now = new Date().toISOString();
		task.status = "running";
		task.startedAt = now;
		task.updatedAt = now;
		return task;
	}

	succeed<TResult = unknown>(id: string, result?: TResult): TaskHandle<TResult> {
		const task = this.finish(id, "succeeded") as TaskHandle<TResult>;
		task.result = result;
		return task;
	}

	fail(id: string, error: string): TaskHandle {
		const task = this.finish(id, "failed");
		task.error = error;
		return task;
	}

	cancel(id: string, reason?: string): TaskHandle {
		const task = this.finish(id, "cancelled");
		if (reason) task.error = reason;
		return task;
	}

	get(id: string): TaskHandle | undefined {
		return this.tasks.get(id);
	}

	list(): TaskHandle[] {
		return Array.from(this.tasks.values());
	}

	delete(id: string): boolean {
		return this.tasks.delete(id);
	}

	clear(): void {
		this.tasks.clear();
	}

	private finish(id: string, status: Exclude<TaskStatus, "queued" | "running">): TaskHandle {
		const task = this.requireTask(id);
		if (task.status !== "queued" && task.status !== "running") {
			throw new Error(`Cannot finish task '${id}' from status '${task.status}'`);
		}
		const now = new Date().toISOString();
		task.status = status;
		task.endedAt = now;
		task.updatedAt = now;
		return task;
	}

	private requireTask(id: string): TaskHandle {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Unknown task '${id}'`);
		return task;
	}

	private createTaskId(): string {
		return `task_${this.nextTaskNumber++}`;
	}
}
