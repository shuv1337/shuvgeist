/**
 * Minimal DOM shim for service worker contexts.
 *
 * When the background service worker bundles code that transitively imports
 * lit, pi-web-ui, or other DOM-dependent libraries (via BrowserCommandExecutor
 * → tool files → renderers), those libraries reference HTMLElement,
 * customElements, document, etc. at the module level.
 *
 * This shim provides no-op stubs so the modules can load without crashing.
 * It only activates when these globals are missing (service workers); in
 * contexts with real DOM access (sidepanel, offscreen) it's a complete no-op.
 */

if (typeof HTMLElement === "undefined") {
	globalThis.HTMLElement = class HTMLElement {};
}

if (typeof customElements === "undefined") {
	globalThis.customElements = {
		define() {},
		get() {
			return undefined;
		},
		whenDefined() {
			return Promise.resolve();
		},
	};
}

if (typeof document === "undefined") {
	globalThis.document = {
		createElement() {
			return {};
		},
		createComment() {
			return {};
		},
		createDocumentFragment() {
			return {};
		},
		createTreeWalker() {
			return {
				nextNode() {
					return null;
				},
			};
		},
		adoptedStyleSheets: [],
		documentElement: {
			classList: {
				add() {},
				remove() {},
				toggle() {},
				contains() {
					return false;
				},
			},
		},
		head: { appendChild() {} },
		body: {},
		querySelector() {
			return null;
		},
		querySelectorAll() {
			return [];
		},
		addEventListener() {},
		removeEventListener() {},
	};
}

if (typeof Document === "undefined") {
	globalThis.Document = class Document {};
	globalThis.Document.prototype.adoptedStyleSheets = [];
}

if (typeof CSSStyleSheet === "undefined") {
	globalThis.CSSStyleSheet = class CSSStyleSheet {
		replaceSync() {}
		replace() {
			return Promise.resolve(this);
		}
	};
}

if (typeof MutationObserver === "undefined") {
	globalThis.MutationObserver = class MutationObserver {
		observe() {}
		disconnect() {}
	};
}

if (typeof DOMParser === "undefined") {
	globalThis.DOMParser = class DOMParser {
		parseFromString() {
			return {};
		}
	};
}

// Shim window + window APIs needed by bundled sidepanel/debug code that
// runs at the module level without typeof guards.
if (typeof window === "undefined") {
	globalThis.window = globalThis;
}
if (typeof localStorage === "undefined") {
	const store = new Map();
	globalThis.localStorage = {
		getItem(k) {
			return store.get(k) ?? null;
		},
		setItem(k, v) {
			store.set(k, String(v));
		},
		removeItem(k) {
			store.delete(k);
		},
		clear() {
			store.clear();
		},
		get length() {
			return store.size;
		},
		key(i) {
			return [...store.keys()][i] ?? null;
		},
	};
}
if (typeof matchMedia === "undefined") {
	globalThis.matchMedia = () => ({
		matches: false,
		media: "",
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	});
}
if (typeof requestAnimationFrame === "undefined") {
	globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
	globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}
if (typeof getComputedStyle === "undefined") {
	globalThis.getComputedStyle = () => new Proxy({}, { get: () => "" });
}

// Dummy export so esbuild doesn't tree-shake this file when injected
export const __domShimActive = typeof HTMLElement !== "undefined";
