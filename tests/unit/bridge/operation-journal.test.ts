import { appendFile, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildOperationAftermath,
	OperationJournal,
	sessionJournalKey,
} from "@shuvgeist/server/operation-journal";

function aftermath(
	index: number,
	overrides: Partial<Parameters<typeof buildOperationAftermath>[0]> = {},
) {
	return buildOperationAftermath({
		method: "navigate",
		sessionIdentity: "session-1",
		startedAtMs: 1_000 + index,
		endedAtMs: 1_010 + index,
		response: {
			result: {
				target: { kind: "chrome-tab", tabId: 42, frameId: 0 },
				navigationGeneration: 3,
				finalUrl: `https://example.com/private/${index}?token=secret-${index}`,
			},
		},
		...overrides,
	});
}

describe("OperationJournal", () => {
	it("persists only bounded, redacted aftermath with mode-0600 files", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shuvgeist-journal-"));
		const journal = new OperationJournal({ directory, now: () => 2_000 });
		const record = buildOperationAftermath({
			method: "repl",
			sessionIdentity: "session-private",
			startedAtMs: 1_000,
			endedAtMs: 1_025,
			response: {
				result: {
					target: { kind: "chrome-tab", tabId: 9, frameId: 2 },
					navigationGeneration: 4,
					url: "https://alice:password@example.com/private/path?token=super-secret#secret",
					headers: { authorization: "Bearer plaintext-secret" },
					body: "credential-body",
					warnings: ["prompt-content-must-not-persist"],
					consoleErrorCount: 2,
				},
			},
		});
		await journal.append(record);

		const path = join(directory, `${sessionJournalKey("session-private")}.jsonl`);
		const contents = await readFile(path, "utf8");
		expect(contents).not.toContain("super-secret");
		expect(contents).not.toContain("plaintext-secret");
		expect(contents).not.toContain("credential-body");
		expect(contents).not.toContain("prompt-content");
		expect(contents).not.toContain("/private/path");
		expect(contents).toContain('"toOrigin":"https://example.com"');
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		await expect(journal.read()).resolves.toEqual([record]);
	});

	it("serializes concurrent writes and rotates each session by count", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shuvgeist-journal-"));
		const journal = new OperationJournal({ directory, maxEntries: 3, now: () => 2_000 });
		await Promise.all(Array.from({ length: 12 }, (_, index) => journal.append(aftermath(index))));
		const records = await journal.read({ last: 50 });

		expect(records).toHaveLength(3);
		expect(records.map((record) => record.startedAt)).toEqual([
			new Date(1_011).toISOString(),
			new Date(1_010).toISOString(),
			new Date(1_009).toISOString(),
		]);
	});

	it("skips corrupt and partial lines without hiding valid records", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shuvgeist-journal-"));
		const journal = new OperationJournal({ directory, now: () => 2_000 });
		const record = aftermath(1);
		await journal.append(record);
		const path = join(directory, `${record.sessionKey}.jsonl`);
		await appendFile(path, '{"id":"partial"\nnot-json\n', "utf8");

		await expect(journal.read()).resolves.toEqual([record]);
	});

	it("rotates by encoded byte size", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shuvgeist-journal-"));
		const journal = new OperationJournal({ directory, maxEntries: 50, maxBytes: 900, now: () => 2_000 });
		await Promise.all(Array.from({ length: 10 }, (_, index) => journal.append(aftermath(index))));
		const path = join(directory, `${sessionJournalKey("session-1")}.jsonl`);
		expect((await stat(path)).size).toBeLessThanOrEqual(900);
		expect((await journal.read({ last: 50 })).length).toBeGreaterThan(0);
	});

	it("drops expired entries and keeps journal write errors separate from aftermath construction", async () => {
		const directory = await mkdtemp(join(tmpdir(), "shuvgeist-journal-"));
		let now = 10_000;
		const journal = new OperationJournal({ directory, retentionMs: 100, now: () => now });
		await journal.append(aftermath(1, { startedAtMs: 9_800, endedAtMs: 9_810 }));
		now = 10_100;
		const current = aftermath(2, { startedAtMs: 10_090, endedAtMs: 10_095 });
		await journal.append(current);
		await expect(journal.read()).resolves.toEqual([current]);

		const blockedPath = join(directory, "not-a-directory");
		await appendFile(blockedPath, "occupied", "utf8");
		const failing = new OperationJournal({ directory: blockedPath });
		await expect(failing.append(aftermath(3))).rejects.toBeDefined();
		expect(aftermath(3).outcome).toBe("succeeded");
	});

	it("classifies timeout, cancellation, failures, warnings, handoffs, and artifacts without error text", () => {
		const timedOut = buildOperationAftermath({
			method: "handoff_start",
			sessionIdentity: "session-1",
			startedAtMs: 100,
			endedAtMs: 150,
			response: {
				result: {
					state: "timed_out",
					handoffId: "handoff-1",
					truncated: true,
					error: "credential must never persist",
				},
			},
		});
		expect(timedOut).toMatchObject({
			outcome: "timed_out",
			handoffCount: 1,
			artifactIds: ["handoff-1"],
			warnings: ["result_truncated", "handoff_timed_out"],
		});
		expect(JSON.stringify(timedOut)).not.toContain("credential");

		expect(
			buildOperationAftermath({
				method: "navigate",
				sessionIdentity: "session-1",
				startedAtMs: 0,
				response: { error: { code: -32005, message: "secret cancellation detail" } },
			}).outcome,
		).toBe("cancelled");
		expect(
			buildOperationAftermath({
				method: "navigate",
				sessionIdentity: "session-1",
				startedAtMs: 0,
				response: { error: { code: -32003, message: "secret failure detail" } },
			}).outcome,
		).toBe("failed");
	});
});
