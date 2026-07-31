import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ResolvedPageTarget, validateBridgeCommandResult } from "@shuvgeist/protocol/command-schemas";
import type { BridgeMethod, BridgeResponse, OperationAftermath, OperationOutcome } from "@shuvgeist/protocol/protocol";
import type { BridgeTarget } from "@shuvgeist/protocol/target";

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface OperationJournalOptions {
	directory: string;
	maxEntries?: number;
	maxBytes?: number;
	retentionMs?: number;
	now?: () => number;
}

export interface BuildOperationAftermathInput {
	method: BridgeMethod;
	sessionIdentity: string;
	startedAtMs: number;
	endedAtMs?: number;
	response: Pick<BridgeResponse, "result" | "error">;
	requestTarget?: BridgeTarget;
	outcome?: OperationOutcome;
}

export class OperationJournal {
	private tail: Promise<void> = Promise.resolve();
	private readonly maxEntries: number;
	private readonly maxBytes: number;
	private readonly retentionMs: number;
	private readonly now: () => number;

	constructor(private readonly options: OperationJournalOptions) {
		this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
		this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
		this.retentionMs = positiveInteger(options.retentionMs, DEFAULT_RETENTION_MS);
		this.now = options.now ?? Date.now;
	}

	append(aftermath: OperationAftermath): Promise<void> {
		const operation = this.tail.then(() => this.appendNow(aftermath));
		this.tail = operation.catch(() => undefined);
		return operation;
	}

	async flush(): Promise<void> {
		await this.tail;
	}

	async read(options: { last?: number; sessionKey?: string } = {}): Promise<OperationAftermath[]> {
		await this.tail;
		let names: string[];
		try {
			names = await readdir(this.options.directory);
		} catch {
			return [];
		}
		const records = (
			await Promise.all(
				names
					.filter((name) => name.endsWith(".jsonl"))
					.map((name) => this.readRecords(join(this.options.directory, name))),
			)
		)
			.flat()
			.filter((record) => Date.parse(record.endedAt) >= this.now() - this.retentionMs)
			.filter((record) => !options.sessionKey || record.sessionKey === options.sessionKey)
			.sort((left, right) => right.endedAt.localeCompare(left.endedAt));
		return records.slice(0, Math.min(positiveInteger(options.last, 50), this.maxEntries));
	}

	private async appendNow(aftermath: OperationAftermath): Promise<void> {
		await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
		await chmod(this.options.directory, 0o700);
		const path = join(this.options.directory, `${aftermath.sessionKey}.jsonl`);
		const cutoff = this.now() - this.retentionMs;
		const existing = (await this.readRecords(path)).filter(
			(record) => Date.parse(record.endedAt) >= cutoff && record.sessionKey === aftermath.sessionKey,
		);
		const retained = [...existing, aftermath].slice(-this.maxEntries);
		while (retained.length > 1 && encodedSize(retained) > this.maxBytes) retained.shift();
		const contents = retained.map((record) => JSON.stringify(record)).join("\n") + "\n";
		const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
			await rename(temporary, path);
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
	}

	private async readRecords(path: string): Promise<OperationAftermath[]> {
		let contents: string;
		try {
			contents = await readFile(path, "utf8");
		} catch {
			return [];
		}
		const records: OperationAftermath[] = [];
		for (const line of contents.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as unknown;
				if (isOperationAftermath(parsed)) records.push(parsed);
			} catch {
				// A partial/corrupt line does not hide the remaining readable records.
			}
		}
		return records;
	}
}

export function sessionJournalKey(identity: string): string {
	return createHash("sha256").update(identity).digest("hex").slice(0, 20);
}

export function buildOperationAftermath(input: BuildOperationAftermathInput): OperationAftermath {
	const endedAtMs = input.endedAtMs ?? Date.now();
	const result = record(input.response.result);
	const outcome = input.outcome ?? responseOutcome(input.response, result);
	const target =
		resolvedTarget(result?.target) ?? chromeCompatibilityTarget(result) ?? safeRequestTarget(input.requestTarget);
	const navigationGeneration = safeInteger(result?.navigationGeneration);
	const urlBefore = safeHttpOrigin(result?.previousUrl ?? result?.fromUrl);
	const urlAfter = safeHttpOrigin(result?.finalUrl ?? result?.url);
	const artifactIds = [
		safeArtifactId(result?.recordingId),
		safeArtifactId(result?.handoffId),
		safeArtifactId(record(result?.record)?.id),
	].filter((value): value is string => value !== undefined);
	const warnings: string[] = [];
	if (result?.truncated === true) warnings.push("result_truncated");
	if (result?.ok === false) warnings.push("operation_reported_not_ok");
	if (result?.state === "timed_out") warnings.push("handoff_timed_out");
	if (result?.state === "cancelled") warnings.push("handoff_cancelled");
	return {
		id: randomUUID(),
		sessionKey: sessionJournalKey(input.sessionIdentity),
		method: input.method,
		startedAt: new Date(input.startedAtMs).toISOString(),
		endedAt: new Date(endedAtMs).toISOString(),
		durationMs: Math.max(0, endedAtMs - input.startedAtMs),
		outcome,
		...(target ? { target } : {}),
		...(navigationGeneration !== undefined ? { navigationGeneration } : {}),
		...(urlBefore || urlAfter
			? {
					urlMovement: {
						...(urlBefore ? { fromOrigin: urlBefore } : {}),
						...(urlAfter ? { toOrigin: urlAfter } : {}),
					},
				}
			: {}),
		consoleErrorCount: safeInteger(result?.consoleErrorCount) ?? 0,
		pageErrorCount: safeInteger(result?.pageErrorCount) ?? 0,
		warnings,
		handoffCount: input.method === "handoff_start" ? 1 : (safeInteger(result?.handoffCount) ?? 0),
		artifactIds,
	};
}

function responseOutcome(
	response: Pick<BridgeResponse, "result" | "error">,
	result: Record<string, unknown> | undefined,
): OperationOutcome {
	if (response.error?.code === -32004 || result?.state === "timed_out") return "timed_out";
	if (response.error?.code === -32005 || result?.state === "cancelled") return "cancelled";
	if (result?.ok === false) return "failed";
	return response.error ? "failed" : "succeeded";
}

function safeRequestTarget(target: BridgeTarget | undefined): ResolvedPageTarget | undefined {
	if (target?.kind === "chrome-tab" && typeof target.tabId === "number") {
		return {
			kind: "chrome-tab",
			tabId: target.tabId,
			...(typeof target.frameId === "number" ? { frameId: target.frameId } : {}),
		};
	}
	if (
		target?.kind === "electron-window" &&
		typeof target.sessionId === "string" &&
		typeof target.windowRef === "string" &&
		typeof target.targetId === "string"
	) {
		return {
			kind: "electron-window",
			sessionId: target.sessionId,
			windowRef: target.windowRef,
			targetId: target.targetId,
		};
	}
	return undefined;
}

function chromeCompatibilityTarget(result: Record<string, unknown> | undefined): ResolvedPageTarget | undefined {
	const tabId = safeInteger(result?.tabId);
	if (tabId === undefined) return undefined;
	const frameId = safeInteger(result?.frameId);
	return {
		kind: "chrome-tab",
		tabId,
		...(frameId !== undefined ? { frameId } : {}),
	};
}

function resolvedTarget(value: unknown): ResolvedPageTarget | undefined {
	const target = record(value);
	if (target?.kind === "chrome-tab" && safeInteger(target.tabId) !== undefined) {
		return {
			kind: "chrome-tab",
			tabId: target.tabId as number,
			...(safeInteger(target.frameId) !== undefined ? { frameId: target.frameId as number } : {}),
		};
	}
	if (
		target?.kind === "electron-window" &&
		typeof target.sessionId === "string" &&
		typeof target.windowRef === "string" &&
		typeof target.targetId === "string"
	) {
		return {
			kind: "electron-window",
			sessionId: target.sessionId,
			windowRef: target.windowRef,
			targetId: target.targetId,
			...(safeInteger(target.frameId) !== undefined ? { frameId: target.frameId as number } : {}),
		};
	}
	return undefined;
}

function safeHttpOrigin(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

function safeArtifactId(value: unknown): string | undefined {
	return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/u.test(value) ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function encodedSize(records: OperationAftermath[]): number {
	return Buffer.byteLength(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function isOperationAftermath(value: unknown): value is OperationAftermath {
	return validateBridgeCommandResult("journal_list", { entries: [value] }).ok;
}
