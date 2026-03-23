class DOMMatrixMock {
	multiplySelf() {
		return this;
	}
	preMultiplySelf() {
		return this;
	}
	translateSelf() {
		return this;
	}
	scaleSelf() {
		return this;
	}
	rotateSelf() {
		return this;
	}
	invertSelf() {
		return this;
	}
}

class StorageMock {
	private data = new Map<string, string>();

	getItem(key: string): string | null {
		return this.data.has(key) ? this.data.get(key) ?? null : null;
	}

	setItem(key: string, value: string): void {
		this.data.set(key, String(value));
	}

	removeItem(key: string): void {
		this.data.delete(key);
	}

	clear(): void {
		this.data.clear();
	}

	key(index: number): string | null {
		return [...this.data.keys()][index] ?? null;
	}

	get length(): number {
		return this.data.size;
	}
}

if (!("DOMMatrix" in globalThis)) {
	(globalThis as typeof globalThis & { DOMMatrix: typeof DOMMatrixMock }).DOMMatrix = DOMMatrixMock;
}

const localStorageCandidate = (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage;
if (!localStorageCandidate || typeof localStorageCandidate.getItem !== "function") {
	Object.defineProperty(globalThis, "localStorage", {
		value: new StorageMock(),
		configurable: true,
	});
}

const sessionStorageCandidate = (globalThis as typeof globalThis & { sessionStorage?: Storage }).sessionStorage;
if (!sessionStorageCandidate || typeof sessionStorageCandidate.getItem !== "function") {
	Object.defineProperty(globalThis, "sessionStorage", {
		value: new StorageMock(),
		configurable: true,
	});
}

if (!("requestAnimationFrame" in globalThis)) {
	(globalThis as typeof globalThis & { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = (
		cb,
	) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
}

if (!("cancelAnimationFrame" in globalThis)) {
	(globalThis as typeof globalThis & { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame = (id) => {
		clearTimeout(id);
	};
}
