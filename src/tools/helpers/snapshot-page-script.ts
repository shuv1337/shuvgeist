interface SnapshotPageScriptConfig {
	frameId: number;
	maxEntries: number;
	includeHidden: boolean;
	snapshotIdPrefix?: string;
	stableElementIdAttribute?: string;
}

interface SnapshotPageScriptEntry {
	snapshotId: string;
	stableElementId?: string;
	frameId: number;
	tagName: string;
	role?: string;
	name?: string;
	text?: string;
	label?: string;
	attributes: Record<string, string>;
	selectorCandidates: string[];
	ordinalPath: number[];
	boundingBox: { x: number; y: number; width: number; height: number };
	interactive: boolean;
	headingLevel?: number;
	landmark?: string;
}

interface SnapshotHTMLElement {
	tagName: string;
	tabIndex: number;
	isContentEditable: boolean;
	parentElement: SnapshotHTMLElement | null;
	children: ArrayLike<SnapshotHTMLElement>;
	textContent: string | null;
	getAttribute(name: string): string | null;
	getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}

interface SnapshotHTMLInputElement extends SnapshotHTMLElement {
	value: string;
	labels: ArrayLike<{ textContent: string | null }> | null;
}

interface SnapshotHTMLTextAreaElement extends SnapshotHTMLElement {
	labels: ArrayLike<{ textContent: string | null }> | null;
}

interface SnapshotHTMLSelectElement extends SnapshotHTMLElement {
	labels: ArrayLike<{ textContent: string | null }> | null;
}

declare const HTMLElement: { new (): SnapshotHTMLElement };
declare const HTMLInputElement: { new (): SnapshotHTMLInputElement };
declare const HTMLTextAreaElement: { new (): SnapshotHTMLTextAreaElement };
declare const HTMLSelectElement: { new (): SnapshotHTMLSelectElement };

declare const document: {
	body: SnapshotHTMLElement;
	title: string;
	querySelector(selector: string): SnapshotHTMLElement | null;
	querySelectorAll(selector: string): ArrayLike<SnapshotHTMLElement>;
	getElementById(id: string): SnapshotHTMLElement | null;
};
declare const location: { href: string };
declare const window: {
	CSS?: { escape?: (input: string) => string };
	getComputedStyle(element: SnapshotHTMLElement): { display: string; visibility: string };
};

export function shuvgeistSnapshotPageScript(config: SnapshotPageScriptConfig) {
	const selector = [
		"a[href]",
		"button",
		"input",
		"select",
		"textarea",
		"summary",
		"[role]",
		"[tabindex]",
		'[contenteditable="true"]',
		"label",
		"h1,h2,h3,h4,h5,h6",
		"main,nav,header,footer,aside,article,section",
	].join(",");
	const landmarkRoles = new Set(["main", "navigation", "banner", "contentinfo", "complementary", "region", "search"]);
	const interactiveRoles = new Set([
		"button",
		"link",
		"textbox",
		"checkbox",
		"radio",
		"switch",
		"combobox",
		"listbox",
		"menuitem",
		"tab",
		"slider",
		"spinbutton",
		"option",
	]);

	const normalize = (value: unknown, maxLen: number): string => {
		if (typeof value !== "string") return "";
		const text = value.replace(/\s+/g, " ").trim();
		if (!text) return "";
		return text.length <= maxLen ? text : text.slice(0, Math.max(0, maxLen - 1)) + "...";
	};

	const isVisible = (element: SnapshotHTMLElement): boolean => {
		const style = window.getComputedStyle(element);
		if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
		const rect = element.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	};

	const safeEscape = (input: string): string => {
		if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(input);
		return input.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
	};

	const implicitRole = (element: SnapshotHTMLElement): string => {
		const tag = element.tagName.toLowerCase();
		if (tag === "a" && element.getAttribute("href")) return "link";
		if (tag === "button") return "button";
		if (tag === "select") return "combobox";
		if (tag === "textarea") return "textbox";
		if (tag === "summary") return "button";
		if (tag === "input") {
			const type = (element.getAttribute("type") || "text").toLowerCase();
			if (type === "checkbox") return "checkbox";
			if (type === "radio") return "radio";
			if (type === "range") return "slider";
			if (type === "number") return "spinbutton";
			if (type === "button" || type === "submit" || type === "reset") return "button";
			return "textbox";
		}
		if (tag === "main") return "main";
		if (tag === "nav") return "navigation";
		if (tag === "header") return "banner";
		if (tag === "footer") return "contentinfo";
		if (tag === "aside") return "complementary";
		if (tag === "section" && (element.getAttribute("aria-label") || element.getAttribute("aria-labelledby"))) {
			return "region";
		}
		return "";
	};

	const elementName = (element: SnapshotHTMLElement): string => {
		const ariaLabel = element.getAttribute("aria-label");
		if (ariaLabel) return normalize(ariaLabel, 120);
		const title = element.getAttribute("title");
		if (title) return normalize(title, 120);
		if (element instanceof HTMLInputElement && element.value) return normalize(element.value, 120);
		const alt = element.getAttribute("alt");
		if (alt) return normalize(alt, 120);
		return normalize(element.textContent || "", 120);
	};

	const elementLabel = (element: SnapshotHTMLElement): string => {
		const ariaLabelledBy = element.getAttribute("aria-labelledby");
		if (ariaLabelledBy) {
			const parts = ariaLabelledBy
				.split(/\s+/)
				.filter(Boolean)
				.map((id) => document.getElementById(id))
				.filter((node) => node !== null)
				.map((node) => normalize(node.textContent || "", 120))
				.filter(Boolean);
			if (parts.length > 0) return parts.join(" ");
		}
		if (
			element instanceof HTMLInputElement ||
			element instanceof HTMLTextAreaElement ||
			element instanceof HTMLSelectElement
		) {
			if (element.labels && element.labels.length > 0) {
				return normalize(element.labels[0].textContent || "", 120);
			}
			const id = element.getAttribute("id");
			if (id) {
				const label = document.querySelector('label[for="' + safeEscape(id) + '"]');
				if (label) return normalize(label.textContent || "", 120);
			}
		}
		return "";
	};

	const selectorCandidates = (element: SnapshotHTMLElement): string[] => {
		const out: string[] = [];
		const tag = element.tagName.toLowerCase();
		const id = element.getAttribute("id");
		if (id) out.push("#" + safeEscape(id));
		const dataTestId = element.getAttribute("data-testid");
		if (dataTestId) out.push('[data-testid="' + safeEscape(dataTestId) + '"]');
		const name = element.getAttribute("name");
		if (name) out.push(tag + '[name="' + safeEscape(name) + '"]');
		const classes = (element.getAttribute("class") || "")
			.split(/\s+/)
			.filter(Boolean)
			.filter((namePart) => !namePart.startsWith("shuvgeist-"))
			.slice(0, 2);
		if (classes.length > 0) out.push(tag + "." + classes.map((item) => safeEscape(item)).join("."));
		if (element.parentElement) {
			const sameTag = Array.from(element.parentElement.children).filter(
				(child) => child.tagName === element.tagName,
			);
			const index = sameTag.indexOf(element) + 1;
			if (index > 0) out.push(tag + ":nth-of-type(" + index + ")");
		}
		out.push(tag);
		return Array.from(new Set(out)).slice(0, 5);
	};

	const ordinalPath = (element: SnapshotHTMLElement): number[] => {
		const path: number[] = [];
		let node = element;
		while (node && node !== document.body && node.parentElement) {
			path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
			node = node.parentElement;
		}
		return path;
	};

	const snapshotIdFor = (ordinal: number): string => {
		return config.snapshotIdPrefix ? config.snapshotIdPrefix + ":ref" + ordinal : "e" + ordinal;
	};

	const stableElementIdFor = (element: SnapshotHTMLElement): string | undefined => {
		const primaryAttribute = config.stableElementIdAttribute || "data-shuvgeist-stable-id";
		const value = element.getAttribute(primaryAttribute) || element.getAttribute("data-shuvgeist-id");
		return normalize(value || "", 180) || undefined;
	};

	const relevant = Array.from(document.querySelectorAll(selector));
	const seen = new Set<SnapshotHTMLElement>();
	const out: SnapshotPageScriptEntry[] = [];
	let totalCandidates = 0;

	for (const element of relevant) {
		if (!(element instanceof HTMLElement)) continue;
		if (seen.has(element)) continue;
		seen.add(element);

		const visible = isVisible(element);
		if (!config.includeHidden && !visible) continue;

		const tagName = element.tagName.toLowerCase();
		const explicitRole = element.getAttribute("role") || "";
		const role = explicitRole || implicitRole(element);
		const headingLevel = /^h[1-6]$/.test(tagName) ? Number.parseInt(tagName.slice(1), 10) : undefined;
		const landmark = landmarkRoles.has(role) ? role : undefined;
		const interactive = interactiveRoles.has(role) || element.tabIndex >= 0 || element.isContentEditable;
		if (!interactive && !headingLevel && !landmark) continue;

		totalCandidates++;
		if (out.length >= config.maxEntries) continue;

		const rect = element.getBoundingClientRect();
		const label = elementLabel(element);
		const attrs: Record<string, string> = {};
		for (const key of ["id", "name", "type", "href", "placeholder", "aria-label", "data-testid", "title"]) {
			const value = element.getAttribute(key);
			if (value) attrs[key] = normalize(value, 120);
		}

		const ordinal = out.length + 1;
		out.push({
			snapshotId: snapshotIdFor(ordinal),
			stableElementId: stableElementIdFor(element),
			frameId: config.frameId,
			tagName,
			role: role || undefined,
			name: elementName(element) || undefined,
			text: normalize(element.textContent || "", 180) || undefined,
			label: label || undefined,
			attributes: attrs,
			selectorCandidates: selectorCandidates(element),
			ordinalPath: ordinalPath(element),
			boundingBox: {
				x: rect.x,
				y: rect.y,
				width: rect.width,
				height: rect.height,
			},
			interactive,
			headingLevel,
			landmark,
		});
	}

	return {
		success: true,
		result: {
			url: location.href,
			title: document.title || "",
			generatedAt: Date.now(),
			totalCandidates,
			truncated: totalCandidates > out.length,
			entries: out,
		},
	};
}

export const SNAPSHOT_PAGE_SCRIPT = shuvgeistSnapshotPageScript.toString();
