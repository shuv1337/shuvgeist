import { FakeStorageBackend } from "./fake-storage-backend.js";

describe("FakeStorageBackend", () => {
	it("supports the full helper surface", async () => {
		const backend = new FakeStorageBackend();
		backend.seed("skills", "a", { name: "alpha", date: "2026-03-22" });
		backend.seed("skills", "b", { name: "beta", date: "2026-03-21" });

		expect(await backend.get("skills", "a")).toEqual({ name: "alpha", date: "2026-03-22" });
		expect(await backend.has("skills", "a")).toBe(true);
		expect(await backend.keys("skills")).toEqual(["a", "b"]);
		expect(await backend.keys("skills", "a")).toEqual(["a"]);
		expect(await backend.getAllFromIndex("skills", "date", "asc")).toEqual([
			{ name: "beta", date: "2026-03-21" },
			{ name: "alpha", date: "2026-03-22" },
		]);
		expect(await backend.getAllFromIndex("skills", "date", "desc")).toEqual([
			{ name: "alpha", date: "2026-03-22" },
			{ name: "beta", date: "2026-03-21" },
		]);

		await backend.transaction(["skills", "sessions"], "readwrite", async (tx) => {
			await tx.set("sessions", "s1", { title: "Session 1" });
			expect(await tx.get("sessions", "s1")).toEqual({ title: "Session 1" });
			await tx.delete("skills", "b");
		});
		expect(await backend.get("sessions", "s1")).toEqual({ title: "Session 1" });
		expect(await backend.get("skills", "b")).toBeNull();

		await backend.delete("skills", "a");
		expect(await backend.get("skills", "a")).toBeNull();
		await backend.clear("sessions");
		expect(await backend.keys("sessions")).toEqual([]);
		expect(await backend.getQuotaInfo()).toEqual({ usage: 0, quota: 0, percent: 0 });
		expect(await backend.requestPersistence()).toBe(true);
	});
});
