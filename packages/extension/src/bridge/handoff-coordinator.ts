export type HandoffKind = "manual" | "browser-native";
export type HandoffTerminalState = "completed" | "cancelled" | "timed_out";
export type HandoffLifecycleState = "started" | "acknowledged" | HandoffTerminalState;

export interface HandoffBinding {
	handoffId: string;
	taskId: string;
	sessionId: string;
	kind: HandoffKind;
	windowId: number;
	tabId: number;
	frameId: number;
	navigationGeneration: number;
	startedAt: string;
}

export interface HandoffLifecycleEvent extends HandoffBinding {
	state: HandoffLifecycleState;
	at: string;
}

export interface HandoffPageEvent {
	type: "shuvgeist-handoff-lifecycle";
	handoffId: string;
	taskId: string;
	sessionId: string;
	tabId: number;
	frameId: number;
	navigationGeneration: number;
	state: "acknowledged" | "completed" | "cancelled";
}

export interface HandoffSenderIdentity {
	tabId?: number;
	frameId?: number;
}

export interface HandoffTerminalOutcome {
	state: HandoffTerminalState;
	acknowledgedAt?: string;
	endedAt: string;
}

export function isHandoffPageEvent(value: unknown): value is HandoffPageEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Record<string, unknown>;
	return (
		event.type === "shuvgeist-handoff-lifecycle" &&
		typeof event.handoffId === "string" &&
		typeof event.taskId === "string" &&
		typeof event.sessionId === "string" &&
		typeof event.tabId === "number" &&
		Number.isSafeInteger(event.tabId) &&
		typeof event.frameId === "number" &&
		Number.isSafeInteger(event.frameId) &&
		typeof event.navigationGeneration === "number" &&
		Number.isSafeInteger(event.navigationGeneration) &&
		(event.state === "acknowledged" || event.state === "completed" || event.state === "cancelled")
	);
}

export interface ActiveHandoff {
	binding: HandoffBinding;
	acknowledged: Promise<string>;
	terminal: Promise<HandoffTerminalOutcome>;
}

interface HandoffRecord {
	binding: HandoffBinding;
	state: "started" | "acknowledged";
	acknowledgedAt?: string;
	resolveAcknowledged: (at: string) => void;
	rejectAcknowledged: (error: Error) => void;
	resolveTerminal: (outcome: HandoffTerminalOutcome) => void;
	timeoutId: ReturnType<typeof setTimeout>;
	isCurrent?: () => boolean;
	onRevoke?: () => void;
}

export class HandoffCoordinator {
	private readonly records = new Map<string, HandoffRecord>();
	private readonly listeners = new Set<(event: HandoffLifecycleEvent) => void>();

	start(
		input: Omit<HandoffBinding, "handoffId" | "startedAt">,
		timeoutMs: number,
		signal?: AbortSignal,
		isCurrent?: () => boolean,
		onRevoke?: () => void,
	): ActiveHandoff {
		if (signal?.aborted) throw new Error("Human handoff was cancelled before it started");
		const handoffId = crypto.randomUUID();
		const binding: HandoffBinding = {
			...input,
			handoffId,
			startedAt: new Date().toISOString(),
		};
		let resolveAcknowledged!: (at: string) => void;
		let rejectAcknowledged!: (error: Error) => void;
		const acknowledged = new Promise<string>((resolve, reject) => {
			resolveAcknowledged = resolve;
			rejectAcknowledged = reject;
		});
		let resolveTerminal!: (outcome: HandoffTerminalOutcome) => void;
		const terminal = new Promise<HandoffTerminalOutcome>((resolve) => {
			resolveTerminal = resolve;
		});
		const timeoutId = setTimeout(() => this.terminate(handoffId, "timed_out"), timeoutMs);
		const record: HandoffRecord = {
			binding,
			state: "started",
			resolveAcknowledged,
			rejectAcknowledged,
			resolveTerminal,
			timeoutId,
			isCurrent,
			onRevoke,
		};
		this.records.set(handoffId, record);
		if (signal) {
			signal.addEventListener("abort", () => this.terminate(handoffId, "cancelled"), { once: true });
		}
		this.emit(binding, "started", binding.startedAt);
		return { binding, acknowledged, terminal };
	}

	acceptPageEvent(event: unknown, sender: HandoffSenderIdentity): { ok: boolean; reason?: string } {
		if (!isHandoffPageEvent(event)) return { ok: false, reason: "Malformed handoff event" };
		const record = this.records.get(event.handoffId);
		if (!record) return { ok: false, reason: "Unknown or stale handoff" };
		const { binding } = record;
		if (record.isCurrent && !record.isCurrent()) {
			this.terminate(binding.handoffId, "cancelled");
			return { ok: false, reason: "Handoff target navigation generation is stale" };
		}
		if (
			event.taskId !== binding.taskId ||
			event.sessionId !== binding.sessionId ||
			event.tabId !== binding.tabId ||
			event.frameId !== binding.frameId ||
			event.navigationGeneration !== binding.navigationGeneration ||
			sender.tabId !== binding.tabId ||
			(sender.frameId ?? 0) !== binding.frameId
		) {
			return { ok: false, reason: "Handoff identity does not match the active target" };
		}
		const at = new Date().toISOString();
		if (event.state === "acknowledged") {
			if (record.state !== "started") return { ok: false, reason: "Duplicate or out-of-order acknowledgement" };
			record.state = "acknowledged";
			record.acknowledgedAt = at;
			record.resolveAcknowledged(at);
			this.emit(binding, "acknowledged", at);
			return { ok: true };
		}
		if (event.state === "completed" && record.state !== "acknowledged") {
			return { ok: false, reason: "Completion requires acknowledgement" };
		}
		this.finish(record, event.state);
		return { ok: true };
	}

	cancel(handoffId: string): void {
		this.terminate(handoffId, "cancelled");
	}

	cancelWindow(windowId: number): void {
		for (const record of [...this.records.values()]) {
			if (record.binding.windowId === windowId) this.terminate(record.binding.handoffId, "cancelled");
		}
	}

	subscribe(listener: (event: HandoffLifecycleEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private terminate(handoffId: string, state: "cancelled" | "timed_out"): void {
		const record = this.records.get(handoffId);
		if (!record) return;
		this.finish(record, state);
	}

	private finish(record: HandoffRecord, state: HandoffTerminalState): void {
		const { binding } = record;
		if (!this.records.delete(binding.handoffId)) return;
		clearTimeout(record.timeoutId);
		record.onRevoke?.();
		const endedAt = new Date().toISOString();
		if (record.state === "started") {
			record.rejectAcknowledged(new Error(`Human handoff ${state.replace("_", " ")}`));
		}
		record.resolveTerminal({
			state,
			...(record.acknowledgedAt ? { acknowledgedAt: record.acknowledgedAt } : {}),
			endedAt,
		});
		this.emit(binding, state, endedAt);
	}

	private emit(binding: HandoffBinding, state: HandoffLifecycleState, at: string): void {
		const event = { ...binding, state, at };
		for (const listener of this.listeners) listener(event);
	}
}

export const sharedHandoffCoordinator = new HandoffCoordinator();
