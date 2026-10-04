/**
 * Chrome's debugger.attach walks every frame in the tab. A child frame whose
 * document URL is another extension's chrome-extension:// page makes the
 * whole attach fail, so screenshot and eval abort before they can run.
 * There is no top-frame-only attach flag. Removing those frame elements from
 * the top document lets the same command retry against the top frame.
 */
export const FOREIGN_EXTENSION_FRAME_ERROR = "Cannot access a chrome-extension:// URL of different extension";

const EXTENSION_URL_PREFIX = "chrome-extension://";
const FRAME_SELECTOR = "iframe,frame,embed,object";

export function isForeignExtensionFrameAccessError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes(FOREIGN_EXTENSION_FRAME_ERROR);
}

/**
 * Runs in the tab's top frame. Must stay self-contained: chrome.scripting
 * serializes this function alone and does not include module helpers.
 */
export function removeForeignExtensionFrames(ownExtensionId: string): number {
	const seen = new Set<ParentNode>();
	let removed = 0;

	const extensionHost = (url: string): string | null => {
		if (!url.startsWith(EXTENSION_URL_PREFIX)) return null;
		const rest = url.slice(EXTENSION_URL_PREFIX.length);
		const end = rest.search(/[/?#]/);
		const host = end === -1 ? rest : rest.slice(0, end);
		return host.length > 0 ? host : null;
	};

	const embeddedUrl = (element: Element): string => {
		const attribute = element.getAttribute("src");
		if (attribute?.startsWith(EXTENSION_URL_PREFIX)) return attribute;
		const withSrc = element as Element & { src?: unknown };
		if (typeof withSrc.src === "string" && withSrc.src.startsWith(EXTENSION_URL_PREFIX)) return withSrc.src;
		return "";
	};

	const isForeign = (url: string): boolean => {
		const host = extensionHost(url);
		return host !== null && host !== ownExtensionId;
	};

	const closedShadowRoot = (element: Element): ShadowRoot | null => {
		if (!(element instanceof HTMLElement)) return null;
		const openOrClosed = globalThis.chrome?.dom?.openOrClosedShadowRoot;
		if (!openOrClosed) return null;
		try {
			return openOrClosed(element);
		} catch {
			return null;
		}
	};

	const visit = (root: ParentNode): void => {
		if (seen.has(root)) return;
		seen.add(root);
		for (const element of root.querySelectorAll(FRAME_SELECTOR)) {
			if (!isForeign(embeddedUrl(element))) continue;
			element.remove();
			removed += 1;
		}
		for (const element of root.querySelectorAll("*")) {
			const shadow = element.shadowRoot ?? closedShadowRoot(element);
			if (shadow) visit(shadow);
		}
	};

	visit(document);
	return removed;
}

export async function skipForeignExtensionFrames(tabId: number): Promise<number> {
	const scripting = globalThis.chrome?.scripting;
	const ownExtensionId = globalThis.chrome?.runtime?.id;
	if (!scripting?.executeScript || !ownExtensionId) return 0;
	const results = await scripting.executeScript({
		target: { tabId, allFrames: false },
		func: removeForeignExtensionFrames,
		args: [ownExtensionId],
		injectImmediately: true,
	});
	const removed = results[0]?.result;
	return typeof removed === "number" && removed > 0 ? removed : 0;
}
