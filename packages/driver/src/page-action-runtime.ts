import type {
	PageActionExecutionResult,
	PageActionExecutionSuccess,
	PageActionRuntimeRequest,
} from "./injected/contracts.js";

interface RuntimeEvent {
	readonly defaultPrevented?: boolean;
}

interface RuntimeOption {
	value: string;
	text: string;
}

export interface PageActionRuntimeElement {
	tagName: string;
	textContent: string | null;
	isContentEditable?: boolean;
	value?: string;
	options?: ArrayLike<RuntimeOption>;
	getAttribute(name: string): string | null;
	focus?(): void;
	click?(): void;
	dispatchEvent(event: RuntimeEvent): boolean;
}

interface RuntimeRange {
	selectNodeContents(element: PageActionRuntimeElement): void;
	deleteContents(): void;
	insertNode(node: RuntimeTextNode): void;
	collapse(toStart?: boolean): void;
}

interface RuntimeTextNode {
	readonly nodeType: number;
}

interface RuntimeSelection {
	removeAllRanges(): void;
	addRange(range: RuntimeRange): void;
}

declare const document: {
	querySelectorAll(selector: string): ArrayLike<PageActionRuntimeElement>;
	createRange?(): RuntimeRange;
	createTextNode?(value: string): RuntimeTextNode;
	getSelection?(): RuntimeSelection | null;
	execCommand?(command: string, showUi?: boolean, value?: string): boolean;
};
declare const Event: { new (type: string, init?: { bubbles?: boolean; cancelable?: boolean }): RuntimeEvent };
declare const InputEvent:
	| {
			new (
				type: string,
				init?: { bubbles?: boolean; cancelable?: boolean; inputType?: string; data?: string },
			): RuntimeEvent;
	  }
	| undefined;

/**
 * Shared DOM action runtime. It is intentionally self-contained so #47 can
 * bundle it as an injected artifact without pulling host-side dependencies.
 */
export function shuvgeistPageActionScript(
	request: PageActionRuntimeRequest,
	freshElement?: PageActionRuntimeElement,
): PageActionExecutionResult {
	const isSupportedContentEditable = (element: PageActionRuntimeElement): boolean => {
		const attribute = element.getAttribute("contenteditable");
		if (attribute !== null) {
			const normalized = attribute.trim().toLowerCase();
			return normalized === "" || normalized === "true" || normalized === "plaintext-only";
		}
		return element.isContentEditable === true;
	};

	const uniqueElements = (values: PageActionRuntimeElement[]): PageActionRuntimeElement[] => {
		const seen = new Set<PageActionRuntimeElement>();
		return values.filter((value) => {
			if (seen.has(value)) return false;
			seen.add(value);
			return true;
		});
	};

	const resolveTarget = ():
		| {
				ok: true;
				element: PageActionRuntimeElement;
				strategy: "stable-id" | "unique-selector" | "fresh-snapshot";
				selector?: string;
		  }
		| { ok: false; reason: "target_not_found" | "ambiguous_target"; message: string } => {
		if (freshElement) return { ok: true, element: freshElement, strategy: "fresh-snapshot" };
		const stableId = request.target.stableElementId;
		const stableAttribute = request.target.stableElementIdAttribute || "data-shuvgeist-stable-id";
		if (stableId && /^[A-Za-z_:][A-Za-z0-9_:.-]*$/.test(stableAttribute)) {
			const stableMatches = Array.from(document.querySelectorAll(`[${stableAttribute}]`)).filter(
				(element) => element.getAttribute(stableAttribute) === stableId,
			);
			if (stableMatches.length === 1) {
				return { ok: true, element: stableMatches[0], strategy: "stable-id" };
			}
			if (stableMatches.length > 1) {
				return {
					ok: false,
					reason: "ambiguous_target",
					message: `Stable element id '${stableId}' matched multiple elements`,
				};
			}
		}

		const uniqueSelectorMatches: Array<{ element: PageActionRuntimeElement; selector: string }> = [];
		let ambiguousSelector: string | undefined;
		for (const selector of request.target.selectorCandidates) {
			try {
				const matches = Array.from(document.querySelectorAll(selector));
				if (matches.length === 1) uniqueSelectorMatches.push({ element: matches[0], selector });
				if (matches.length > 1) ambiguousSelector ??= selector;
			} catch {
				// Ignore stale or invalid selectors and continue with stronger candidates.
			}
		}
		const uniqueMatches = uniqueElements(uniqueSelectorMatches.map((match) => match.element));
		if (uniqueMatches.length === 1) {
			const match = uniqueSelectorMatches.find((candidate) => candidate.element === uniqueMatches[0]);
			return { ok: true, element: uniqueMatches[0], strategy: "unique-selector", selector: match?.selector };
		}
		if (uniqueMatches.length > 1 || ambiguousSelector) {
			return {
				ok: false,
				reason: "ambiguous_target",
				message: `Stored selectors no longer identify one element${ambiguousSelector ? ` ('${ambiguousSelector}')` : ""}`,
			};
		}
		return { ok: false, reason: "target_not_found", message: "No stored selector matched the resolved target" };
	};

	const createInputEvent = (type: "beforeinput" | "input", value: string, cancelable: boolean): RuntimeEvent => {
		if (typeof InputEvent === "function") {
			try {
				return new InputEvent(type, {
					bubbles: true,
					cancelable,
					inputType: "insertText",
					data: value,
				});
			} catch {
				// Older embedded Chromium builds can reject the InputEvent constructor.
			}
		}
		return new Event(type, { bubbles: true, cancelable });
	};

	const dispatchSimpleEvent = (element: PageActionRuntimeElement, type: "input" | "change"): void => {
		element.dispatchEvent(new Event(type, { bubbles: true }));
	};

	const setNativeValue = (element: PageActionRuntimeElement, value: string): void => {
		const prototype = Object.getPrototypeOf(element) as object | null;
		const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : undefined;
		if (descriptor?.set) descriptor.set.call(element, value);
		else element.value = value;
	};

	const resolved = resolveTarget();
	if (!resolved.ok) return resolved;
	const element = resolved.element;
	if (request.action.kind === "click") {
		if (typeof element.click !== "function") {
			return { ok: false, reason: "not_actionable", message: "Resolved ref target is not clickable" };
		}
		element.click();
		return { ok: true, kind: "click", strategy: resolved.strategy, selector: resolved.selector };
	}

	element.focus?.();
	const tagName = element.tagName.toLowerCase();
	const value = request.action.value;
	if (tagName === "select") {
		const options = Array.from(element.options ?? []);
		const option = options.find((candidate) => candidate.value === value || candidate.text.trim() === value.trim());
		if (!option) {
			return { ok: false, reason: "not_actionable", message: `Resolved select has no option matching '${value}'` };
		}
		setNativeValue(element, option.value);
		dispatchSimpleEvent(element, "input");
		dispatchSimpleEvent(element, "change");
		return {
			ok: true,
			kind: "fill",
			strategy: resolved.strategy,
			selector: resolved.selector,
			textLength: value.length,
			inputStrategy: "select",
		};
	}
	if (tagName === "input" || tagName === "textarea") {
		setNativeValue(element, value);
		dispatchSimpleEvent(element, "input");
		dispatchSimpleEvent(element, "change");
		return {
			ok: true,
			kind: "fill",
			strategy: resolved.strategy,
			selector: resolved.selector,
			textLength: value.length,
			inputStrategy: "value",
		};
	}
	if (!isSupportedContentEditable(element)) {
		return { ok: false, reason: "not_actionable", message: "Resolved ref target is not fillable" };
	}

	const beforeInput = createInputEvent("beforeinput", value, true);
	if (!element.dispatchEvent(beforeInput) || beforeInput.defaultPrevented === true) {
		return {
			ok: false,
			reason: "beforeinput_canceled",
			message: "Contenteditable beforeinput was canceled; content was not replaced",
		};
	}
	const range = document.createRange?.();
	const selection = document.getSelection?.();
	if (range && selection) {
		range.selectNodeContents(element);
		selection.removeAllRanges();
		selection.addRange(range);
	}
	let inputStrategy: PageActionExecutionSuccess["inputStrategy"];
	if (range && selection && document.createTextNode) {
		range.deleteContents();
		range.insertNode(document.createTextNode(value));
		range.collapse(false);
		selection.removeAllRanges();
		selection.addRange(range);
		inputStrategy = "contenteditable-range";
	} else {
		let usedExecCommand = false;
		try {
			usedExecCommand = document.execCommand?.("insertText", false, value) === true;
		} catch {
			usedExecCommand = false;
		}
		// execCommand can report success while acting on an unrelated caret (or
		// doing nothing) when Selection is unavailable. Only trust it after the
		// requested editing host demonstrably contains the replacement value.
		inputStrategy =
			usedExecCommand && element.textContent === value ? "contenteditable-exec-command" : "contenteditable-fallback";
	}
	if (inputStrategy === "contenteditable-fallback") {
		element.textContent = value;
		if (range && selection) {
			range.selectNodeContents(element);
			range.collapse(false);
			selection.removeAllRanges();
			selection.addRange(range);
		}
	}
	element.dispatchEvent(createInputEvent("input", value, false));
	return {
		ok: true,
		kind: "fill",
		strategy: resolved.strategy,
		selector: resolved.selector,
		textLength: value.length,
		inputStrategy,
	};
}

export function isPageActionExecutionSuccess(result: PageActionExecutionResult): result is PageActionExecutionSuccess {
	return result.ok;
}
