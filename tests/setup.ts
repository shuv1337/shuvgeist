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

function hasUsableStorage(name: "localStorage" | "sessionStorage"): boolean {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
	if (!descriptor || !("value" in descriptor)) return false;
	const storage = descriptor.value as Storage | undefined;
	return typeof storage?.getItem === "function";
}

if (!hasUsableStorage("localStorage")) {
	Object.defineProperty(globalThis, "localStorage", {
		value: new StorageMock(),
		configurable: true,
	});
}

if (!hasUsableStorage("sessionStorage")) {
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
