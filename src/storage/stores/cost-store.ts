import type { StorageBackend, StoreConfig } from "@mariozechner/pi-web-ui/storage/types.js";

export type DailyCostAggregate = {
	date: string; // "2025-10-24" (YYYY-MM-DD)
	total: number; // Total cost this day
	byProvider: Record<string, Record<string, number>>;
	// {
	//   "anthropic": { "claude-sonnet-4": 0.0234 },
	//   "openai": { "gpt-4": 0.0789 }
	// }
};

export class CostStore {
	private backend!: StorageBackend;
	private readonly storeName = "daily_costs";

	setBackend(backend: StorageBackend) {
		this.backend = backend;
	}

	getConfig(): StoreConfig {
		return {
			name: this.storeName,
			keyPath: "date", // Use date as primary key
			indices: [{ name: "date", keyPath: "date", unique: true }],
		};
	}

	/**
	 * Record cost atomically - prevents race conditions.
	 */
	async recordCost(provider: string, modelId: string, cost: number): Promise<void> {
		const today = new Date().toISOString().split("T")[0];

		// Use transaction for atomic read-modify-write
		await this.backend.transaction([this.storeName], "readwrite", async (tx) => {
			// Read current aggregate
			let aggregate = await tx.get<DailyCostAggregate>(this.storeName, today);

			// Initialize if doesn't exist
			if (!aggregate) {
				aggregate = { date: today, total: 0, byProvider: {} };
			}

			// Modify
			if (!aggregate.byProvider[provider]) {
				aggregate.byProvider[provider] = {};
			}
			aggregate.total += cost;
			aggregate.byProvider[provider][modelId] = (aggregate.byProvider[provider][modelId] || 0) + cost;

			// Write (within same transaction - atomic!)
			await tx.set(this.storeName, today, aggregate);
		});
	}

	/**
	 * Get all daily aggregates.
	 */
	async getAll(): Promise<DailyCostAggregate[]> {
		return this.backend.getAllFromIndex<DailyCostAggregate>(
			this.storeName,
			"date",
			"desc", // Most recent first
		);
	}

	/**
	 * Get total cost (all time).
	 */
	async getTotalCost(): Promise<number> {
		const allDays = await this.getAll();
		return allDays.reduce((sum, day) => sum + day.total, 0);
	}

	/**
	 * Get costs by provider (all time, aggregated).
	 */
	async getCostsByProvider(): Promise<Record<string, number>> {
		const allDays = await this.getAll();
		const byProvider: Record<string, number> = {};

		for (const day of allDays) {
			for (const [provider, models] of Object.entries(day.byProvider)) {
				const providerTotal = Object.values(models).reduce((sum, cost) => sum + cost, 0);
				byProvider[provider] = (byProvider[provider] || 0) + providerTotal;
			}
		}

		return byProvider;
	}

	/**
	 * Get costs by model (all time, aggregated).
	 */
	async getCostsByModel(): Promise<Record<string, number>> {
		const allDays = await this.getAll();
		const byModel: Record<string, number> = {};

		for (const day of allDays) {
			for (const [provider, models] of Object.entries(day.byProvider)) {
				for (const [modelId, cost] of Object.entries(models)) {
					const key = `${provider}:${modelId}`;
					byModel[key] = (byModel[key] || 0) + cost;
				}
			}
		}

		return byModel;
	}

	/**
	 * Get costs within date range.
	 */
	async getCostsByDateRange(start: Date, end: Date): Promise<DailyCostAggregate[]> {
		const allDays = await this.getAll();
		const startStr = start.toISOString().split("T")[0];
		const endStr = end.toISOString().split("T")[0];

		return allDays.filter((day) => day.date >= startStr && day.date <= endStr);
	}
}
