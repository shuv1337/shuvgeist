import { CostStore } from "../../../src/storage/stores/cost-store.js";
import { FakeStorageBackend } from "../../helpers/fake-storage-backend.js";
import { restoreRealTime, withFixedDate } from "../../helpers/time.js";

describe("CostStore", () => {
	afterEach(() => {
		restoreRealTime();
	});

	it("records and aggregates daily costs atomically", async () => {
		withFixedDate("2026-03-22T12:00:00.000Z");
		const backend = new FakeStorageBackend();
		const store = new CostStore();
		store.setBackend(backend);

		await store.recordCost("anthropic", "claude-sonnet-4-6", 1.25);
		await store.recordCost("anthropic", "claude-sonnet-4-6", 0.75);
		await store.recordCost("openai", "gpt-4o", 2.5);

		const all = await store.getAll();
		expect(all).toEqual([
			{
				date: "2026-03-22",
				total: 4.5,
				byProvider: {
					anthropic: { "claude-sonnet-4-6": 2 },
					openai: { "gpt-4o": 2.5 },
				},
			},
		]);
		expect(await store.getTotalCost()).toBe(4.5);
		expect(await store.getCostsByProvider()).toEqual({ anthropic: 2, openai: 2.5 });
		expect(await store.getCostsByModel()).toEqual({
			"anthropic:claude-sonnet-4-6": 2,
			"openai:gpt-4o": 2.5,
		});
	});

	it("filters costs by date range", async () => {
		const backend = new FakeStorageBackend();
		backend.seed("daily_costs", "2026-03-20", {
			date: "2026-03-20",
			total: 1,
			byProvider: { anthropic: { a: 1 } },
		});
		backend.seed("daily_costs", "2026-03-21", {
			date: "2026-03-21",
			total: 2,
			byProvider: { anthropic: { a: 2 } },
		});
		backend.seed("daily_costs", "2026-03-22", {
			date: "2026-03-22",
			total: 3,
			byProvider: { anthropic: { a: 3 } },
		});

		const store = new CostStore();
		store.setBackend(backend);
		const range = await store.getCostsByDateRange(new Date("2026-03-21"), new Date("2026-03-22"));
		expect(range.map((day) => day.date)).toEqual(["2026-03-22", "2026-03-21"]);
	});
});
