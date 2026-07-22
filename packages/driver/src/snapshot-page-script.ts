import type {
	SnapshotInjectionConfig,
	SnapshotInjectionEntry,
	SnapshotInjectionResponse,
} from "./injected/contracts.js";

export interface SnapshotHTMLElement {
	tagName: string;
	tabIndex: number;
	isContentEditable: boolean;
	parentElement: SnapshotHTMLElement | null;
	children: ArrayLike<SnapshotHTMLElement>;
	textContent: string | null;
	getAttribute(name: string): string | null;
	setAttribute(name: string, value: string): void;
	getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}

export interface SnapshotPageScriptHooks {
	onEntry?: (entry: SnapshotInjectionEntry, element: SnapshotHTMLElement) => void;
}

interface SnapshotPageScriptCandidate {
	element: SnapshotHTMLElement;
	domOrdinal: number;
	tagName: string;
	role: string;
	name: string;
	text: string;
	label: string;
	attributes: Record<string, string>;
	boundingBox: { x: number; y: number; width: number; height: number };
	interactive: boolean;
	headingLevel?: number;
	landmark?: string;
	category: string;
	region: string;
	groupKey: string;
	queryScore: number;
	relevanceScore: number;
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
	activeElement: SnapshotHTMLElement | null;
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
	innerHeight: number;
	innerWidth: number;
};

export function shuvgeistSnapshotPageScript(
	config: SnapshotInjectionConfig,
	hooks?: SnapshotPageScriptHooks,
): SnapshotInjectionResponse {
	const selector = [
		"a[href]",
		"button",
		"input",
		"select",
		"textarea",
		"summary",
		"[role]",
		"[tabindex]",
		'[contenteditable="true" i]',
		'[contenteditable=""]',
		'[contenteditable="plaintext-only" i]',
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

	const isVisible = (
		element: SnapshotHTMLElement,
		rect: { x: number; y: number; width: number; height: number },
	): boolean => {
		const style = window.getComputedStyle(element);
		if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
		return rect.width > 0 && rect.height > 0;
	};

	const isInViewport = (rect: { x: number; y: number; width: number; height: number }): boolean => {
		return (
			rect.width > 0 &&
			rect.height > 0 &&
			rect.x < window.innerWidth &&
			rect.y < window.innerHeight &&
			rect.x + rect.width > 0 &&
			rect.y + rect.height > 0
		);
	};

	const safeEscape = (input: string): string => {
		if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(input);
		return input.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
	};

	const isSupportedContentEditable = (element: SnapshotHTMLElement): boolean => {
		const value = element.getAttribute("contenteditable");
		if (value === null) return false;
		const normalized = value.trim().toLowerCase();
		return normalized === "" || normalized === "true" || normalized === "plaintext-only";
	};

	const implicitRole = (element: SnapshotHTMLElement): string => {
		const tag = element.tagName.toLowerCase();
		if (isSupportedContentEditable(element)) return "textbox";
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

	const stableElementIdFor = (element: SnapshotHTMLElement, ordinal: number): string | undefined => {
		const primaryAttribute = config.stableElementIdAttribute || "data-shuvgeist-stable-id";
		const value = element.getAttribute(primaryAttribute) || element.getAttribute("data-shuvgeist-id");
		const existing = normalize(value || "", 180);
		if (existing) return existing;
		const tagName = element.tagName.toLowerCase();
		const semanticParts = [
			element.getAttribute("id"),
			element.getAttribute("data-testid"),
			element.getAttribute("name"),
			element.getAttribute("aria-label"),
			String(ordinal),
		]
			.filter((part): part is string => Boolean(part))
			.join("-")
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 96);
		const generated = `sg-${tagName}-${semanticParts || ordinal}`;
		element.setAttribute(primaryAttribute, generated);
		return generated;
	};

	const candidateCategory = (
		role: string,
		interactive: boolean,
		headingLevel: number | undefined,
		landmark: string | undefined,
	): string => {
		if (landmark) return "landmark:" + landmark;
		if (role) return "role:" + role;
		if (headingLevel) return "heading:h" + headingLevel;
		return interactive ? "interactive" : "structural";
	};

	const candidateRegion = (element: SnapshotHTMLElement): string => {
		let node: SnapshotHTMLElement | null = element;
		while (node && node !== document.body) {
			const role = node.getAttribute("role") || implicitRole(node);
			if (landmarkRoles.has(role)) {
				const regionName = normalize(
					node.getAttribute("aria-label") || node.getAttribute("title") || "",
					60,
				).toLowerCase();
				return regionName ? role + ":" + regionName : role;
			}
			node = node.parentElement;
		}
		return "unscoped";
	};

	const textMatchScore = (query: string, value: string): number => {
		const normalizedQuery = query.toLowerCase();
		const normalizedValue = value.toLowerCase();
		if (!normalizedQuery || !normalizedValue) return 0;
		if (normalizedValue === normalizedQuery) return 1;
		if (normalizedValue.includes(normalizedQuery)) return 0.78;
		const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
		if (tokens.length === 0) return 0;
		let overlap = 0;
		for (const token of tokens) {
			if (normalizedValue.includes(token)) overlap++;
		}
		return overlap === 0 ? 0 : (overlap / tokens.length) * 0.62;
	};

	const queryRelevance = (
		query: string,
		candidate: {
			role: string;
			name: string;
			text: string;
			label: string;
			tagName: string;
			attributes: Record<string, string>;
		},
	): number => {
		if (!query) return 0;
		return Math.max(
			textMatchScore(query, candidate.name),
			textMatchScore(query, candidate.label),
			textMatchScore(query, candidate.text),
			textMatchScore(query, candidate.role),
			textMatchScore(query, candidate.tagName),
			...Object.values(candidate.attributes).map((value) => textMatchScore(query, value)),
		);
	};

	const rolePriority = (role: string): number => {
		if (role === "textbox") return 90;
		if (role === "combobox" || role === "listbox" || role === "search") return 85;
		if (role === "checkbox" || role === "radio" || role === "switch" || role === "slider" || role === "spinbutton")
			return 80;
		if (role === "button" || role === "menuitem" || role === "tab" || role === "option") return 75;
		if (role === "link") return 65;
		return role ? 30 : 0;
	};

	const spreadDomRun = (candidates: SnapshotPageScriptCandidate[]): SnapshotPageScriptCandidate[] => {
		if (candidates.length <= 2) return [...candidates];
		const ordered = [...candidates].sort((left, right) => left.domOrdinal - right.domOrdinal);
		const spread: SnapshotPageScriptCandidate[] = [ordered[0], ordered[ordered.length - 1]];
		const ranges: Array<[number, number]> = [[1, ordered.length - 2]];
		let rangeIndex = 0;
		while (rangeIndex < ranges.length) {
			const [start, end] = ranges[rangeIndex++];
			if (start > end) continue;
			const midpoint = Math.floor((start + end) / 2);
			spread.push(ordered[midpoint]);
			ranges.push([start, midpoint - 1], [midpoint + 1, end]);
		}
		return spread;
	};

	const selectCandidateBudget = (
		candidates: SnapshotPageScriptCandidate[],
		maxEntries: number,
	): SnapshotPageScriptCandidate[] => {
		if (candidates.length <= maxEntries) return [...candidates];
		const scoreTiers = new Map<number, SnapshotPageScriptCandidate[]>();
		for (const candidate of candidates) {
			const tier = scoreTiers.get(candidate.relevanceScore);
			if (tier) tier.push(candidate);
			else scoreTiers.set(candidate.relevanceScore, [candidate]);
		}

		const selected: SnapshotPageScriptCandidate[] = [];
		const orderedTiers = Array.from(scoreTiers.entries()).sort(([leftScore], [rightScore]) => rightScore - leftScore);
		for (const [, tier] of orderedTiers) {
			const groups = new Map<string, SnapshotPageScriptCandidate[]>();
			for (const candidate of tier) {
				const group = groups.get(candidate.groupKey);
				if (group) group.push(candidate);
				else groups.set(candidate.groupKey, [candidate]);
			}
			const spreadGroups = Array.from(groups.values())
				.map((group) => spreadDomRun(group))
				.sort((left, right) => left[0].domOrdinal - right[0].domOrdinal);
			let round = 0;
			while (selected.length < maxEntries) {
				let added = false;
				for (const group of spreadGroups) {
					const candidate = group[round];
					if (!candidate) continue;
					selected.push(candidate);
					added = true;
					if (selected.length >= maxEntries) break;
				}
				if (!added) break;
				round++;
			}
			if (selected.length >= maxEntries) break;
		}
		return selected.sort((left, right) => left.domOrdinal - right.domOrdinal);
	};

	const countOmissions = (values: string[], maxBuckets?: number): Record<string, number> => {
		const counts: Record<string, number> = {};
		for (const value of values) counts[value] = (counts[value] || 0) + 1;
		const ordered = Object.entries(counts).sort(
			([leftKey, leftCount], [rightKey, rightCount]) =>
				rightCount - leftCount || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0),
		);
		if (!maxBuckets || ordered.length <= maxBuckets) return Object.fromEntries(ordered);
		const retained = ordered.slice(0, Math.max(0, maxBuckets - 1));
		const other = ordered.slice(retained.length).reduce((total, [, count]) => total + count, 0);
		return Object.fromEntries([...retained, ["other", other]]);
	};

	const relevant = Array.from(document.querySelectorAll(selector));
	const seen = new Set<SnapshotHTMLElement>();
	const candidates: SnapshotPageScriptCandidate[] = [];
	const query = normalize(config.query || "", 240).toLowerCase();

	for (const element of relevant) {
		if (!(element instanceof HTMLElement)) continue;
		if (seen.has(element)) continue;
		seen.add(element);

		const rect = element.getBoundingClientRect();
		const visible = isVisible(element, rect);
		if (!config.includeHidden && !visible) continue;

		const tagName = element.tagName.toLowerCase();
		const explicitRole = element.getAttribute("role") || "";
		const role = explicitRole || implicitRole(element);
		const headingLevel = /^h[1-6]$/.test(tagName) ? Number.parseInt(tagName.slice(1), 10) : undefined;
		const landmark = landmarkRoles.has(role) ? role : undefined;
		const interactive = interactiveRoles.has(role) || element.tabIndex >= 0 || isSupportedContentEditable(element);
		if (!interactive && !headingLevel && !landmark) continue;

		const label = elementLabel(element);
		const name = elementName(element);
		const text = normalize(element.textContent || "", 180);
		const attrs: Record<string, string> = {};
		for (const key of [
			"id",
			"name",
			"type",
			"href",
			"placeholder",
			"aria-label",
			"data-testid",
			"title",
			"contenteditable",
		]) {
			const value = element.getAttribute(key);
			if (key === "contenteditable" && value !== null) attrs[key] = value.trim().toLowerCase();
			else if (value) attrs[key] = normalize(value, 120);
		}

		const category = candidateCategory(role, interactive, headingLevel, landmark);
		const region = candidateRegion(element);
		const queryScore = queryRelevance(query, {
			tagName,
			role,
			name,
			text,
			label,
			attributes: attrs,
		});
		const queryPriority = queryScore > 0 ? 20_000 + queryScore * 10_000 : 0;
		const relevanceScore =
			queryPriority +
			(element === document.activeElement ? 10_000 : 0) +
			(isInViewport(rect) ? 1_000 : 0) +
			(visible ? 100 : 0) +
			rolePriority(role) +
			(headingLevel ? 40 - headingLevel : 0) +
			(landmark ? 20 : 0);
		const domOrdinal = candidates.length;
		candidates.push({
			element,
			domOrdinal,
			tagName,
			role,
			name,
			text,
			label,
			attributes: attrs,
			boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			interactive,
			headingLevel,
			landmark,
			category,
			region,
			groupKey: region + "|" + category + "|" + tagName,
			queryScore,
			relevanceScore,
		});
	}

	const queryFilteredCandidates = query ? candidates.filter((candidate) => candidate.queryScore === 0) : [];
	const eligibleCandidates = query ? candidates.filter((candidate) => candidate.queryScore > 0) : candidates;
	const selectedCandidates = selectCandidateBudget(eligibleCandidates, config.maxEntries);
	const selectedSet = new Set(selectedCandidates);
	const budgetOmittedCandidates = eligibleCandidates.filter((candidate) => !selectedSet.has(candidate));
	const omittedCandidates = candidates.filter((candidate) => !selectedSet.has(candidate));
	const out: SnapshotInjectionEntry[] = selectedCandidates.map((candidate) => {
		const entry: SnapshotInjectionEntry = {
			snapshotId: snapshotIdFor(candidate.domOrdinal + 1),
			stableElementId: stableElementIdFor(candidate.element, candidate.domOrdinal + 1),
			frameId: config.frameId,
			tagName: candidate.tagName,
			role: candidate.role || undefined,
			name: candidate.name || undefined,
			text: candidate.text || undefined,
			label: candidate.label || undefined,
			attributes: candidate.attributes,
			selectorCandidates: selectorCandidates(candidate.element),
			ordinalPath: ordinalPath(candidate.element),
			boundingBox: candidate.boundingBox,
			interactive: candidate.interactive,
			headingLevel: candidate.headingLevel,
			landmark: candidate.landmark,
		};
		hooks?.onEntry?.(entry, candidate.element);
		return entry;
	});

	return {
		success: true,
		result: {
			url: location.href,
			title: document.title || "",
			generatedAt: Date.now(),
			totalCandidates: candidates.length,
			truncated: budgetOmittedCandidates.length > 0,
			omissions: {
				total: omittedCandidates.length,
				budgetOmitted: budgetOmittedCandidates.length,
				queryFiltered: queryFilteredCandidates.length,
				byCategory: countOmissions(omittedCandidates.map((candidate) => candidate.category)),
				byRegion: countOmissions(
					omittedCandidates.map((candidate) => candidate.region),
					20,
				),
			},
			entries: out,
		},
	};
}
