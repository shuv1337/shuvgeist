import type { StorageBackend, StorageTransaction } from "../../../pi-mono/packages/web-ui/src/storage/types.js";

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

class FakeStorageTransaction implements StorageTransaction {
	constructor(private readonly stores: Map<string, Map<string, unknown>>) {}

	async get<T = unknown>(storeName: string, key: string): Promise<T | null> {
		const store = this.stores.get(storeName);
		if (!store || !store.has(key)) return null;
		return cloneValue(store.get(key) as T);
	}

	async set<T = unknown>(storeName: string, key: string, value: T): Promise<void> {
		let store = this.stores.get(storeName);
		if (!store) {
			store = new Map();
			this.stores.set(storeName, store);
		}
		store.set(key, cloneValue(value));
	}

	async delete(storeName: string, key: string): Promise<void> {
		this.stores.get(storeName)?.delete(key);
	}
}

export class FakeStorageBackend implements StorageBackend {
	private readonly stores = new Map<string, Map<string, unknown>>();

	seed(storeName: string, key: string, value: unknown): void {
		let store = this.stores.get(storeName);
		if (!store) {
			store = new Map();
			this.stores.set(storeName, store);
		}
		store.set(key, cloneValue(value));
	}

	async get<T = unknown>(storeName: string, key: string): Promise<T | null> {
		const store = this.stores.get(storeName);
		if (!store || !store.has(key)) return null;
		return cloneValue(store.get(key) as T);
	}

	async set<T = unknown>(storeName: string, key: string, value: T): Promise<void> {
		this.seed(storeName, key, value);
	}

	async delete(storeName: string, key: string): Promise<void> {
		this.stores.get(storeName)?.delete(key);
	}

	async keys(storeName: string, prefix?: string): Promise<string[]> {
		const keys = [...(this.stores.get(storeName)?.keys() || [])];
		return prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
	}

	async getAllFromIndex<T = unknown>(storeName: string, indexName: string, direction: "asc" | "desc" = "asc"): Promise<T[]> {
		const values = [...(this.stores.get(storeName)?.values() || [])].map((value) => cloneValue(value as T));
		const sorted = values.sort((a, b) => {
			const left = (a as Record<string, unknown>)[indexName];
			const right = (b as Record<string, unknown>)[indexName];
			if (left === right) return 0;
			return left! < right! ? -1 : 1;
		});
		return direction === "desc" ? sorted.reverse() : sorted;
	}

	async clear(storeName: string): Promise<void> {
		this.stores.set(storeName, new Map());
	}

	async has(storeName: string, key: string): Promise<boolean> {
		return this.stores.get(storeName)?.has(key) || false;
	}

	async transaction<T>(storeNames: string[], _mode: "readonly" | "readwrite", operation: (tx: StorageTransaction) => Promise<T>): Promise<T> {
		for (const storeName of storeNames) {
			if (!this.stores.has(storeName)) {
				this.stores.set(storeName, new Map());
			}
		}
		const tx = new FakeStorageTransaction(this.stores);
		return operation(tx);
	}

	async getQuotaInfo(): Promise<{ usage: number; quota: number; percent: number }> {
		return { usage: 0, quota: 0, percent: 0 };
	}

	async requestPersistence(): Promise<boolean> {
		return true;
	}
}
