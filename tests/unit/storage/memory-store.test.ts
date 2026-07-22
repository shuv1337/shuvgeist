import { MemoryStore } from "@shuvgeist/extension/storage/stores/memory-store";
import { FakeStorageBackend } from "../../helpers/fake-storage-backend.js";

describe("MemoryStore", () => {
	it("persists memories keyed by skill and returns newest first", async () => {
		const backend = new FakeStorageBackend();
		const store = new MemoryStore();
		store.setBackend(backend);

		await store.add({
			skillName: "gmail",
			sessionId: "session-1",
			createdAt: "2026-06-01T10:00:00.000Z",
			noteId: "validator-note:0",
			note: "Use visible Send button after composing.",
			toolName: "browserjs",
			turn: 1,
		});
		await store.add({
			skillName: "gmail",
			sessionId: "session-2",
			createdAt: "2026-06-01T11:00:00.000Z",
			noteId: "validator-note:0",
			note: "Search result row refs stay valid until navigation.",
			toolName: "page_snapshot",
			turn: 2,
		});
		await store.add({
			skillName: "calendar",
			createdAt: "2026-06-01T12:00:00.000Z",
			noteId: "validator-note:0",
			note: "Unrelated.",
		});

		await expect(store.getForSkill("gmail")).resolves.toEqual([
			expect.objectContaining({
				skillName: "gmail",
				sessionId: "session-2",
				note: "Search result row refs stay valid until navigation.",
			}),
			expect.objectContaining({
				skillName: "gmail",
				sessionId: "session-1",
				note: "Use visible Send button after composing.",
			}),
		]);
	});

	it("preserves multiple notes for one skill, session, and timestamp", async () => {
		const backend = new FakeStorageBackend();
		const store = new MemoryStore();
		store.setBackend(backend);
		const shared = {
			skillName: "gmail",
			sessionId: "session-1",
			createdAt: "2026-06-01T10:00:00.000Z",
		};

		await store.add({ ...shared, noteId: "validator-note:0", note: "First result." });
		await store.add({ ...shared, noteId: "validator-note:1", note: "Second result." });

		await expect(store.getForSkill("gmail")).resolves.toEqual([
			expect.objectContaining({ noteId: "validator-note:0", note: "First result." }),
			expect.objectContaining({ noteId: "validator-note:1", note: "Second result." }),
		]);
	});
});
