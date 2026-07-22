// ============================================================================
// INJECTED ELEMENT PICKER RUNTIME
//
// Extracted from ask-user-which-element.ts so both the agent tool and
// user-initiated flows (e.g. the sidepanel "Inspect element" button) can
// share the same in-page overlay, injection wrapper, and abort semantics.
//
// Behavior is unchanged relative to the original tool implementation, apart
// from two documented tweaks inside `getElementInfo`:
//   - text:  500  -> 1000 chars
//   - html: 1000  -> 4000 chars (with a "<!-- [truncated] -->" marker)
// ============================================================================

import type { ElementInfo } from "@shuvgeist/driver/injected-contracts";

// Extend Window interface for our custom property
declare global {
	interface Window {
		__shuvgeistElementPicker?: boolean;
	}
}

// ----------------------------------------------------------------------------
// IN-PAGE OVERLAY
//
// This function runs in the page's USER_SCRIPT world from the bundled picker
// artifact. Its imports are resolved by esbuild before it crosses the boundary.
// ----------------------------------------------------------------------------

export async function createElementPickerOverlay(message?: string): Promise<ElementInfo | null> {
	// Prevent multiple overlays
	if (window.__shuvgeistElementPicker) {
		throw new Error("Element picker is already active");
	}

	window.__shuvgeistElementPicker = true;

	return new Promise((resolve) => {
		// Create overlay container
		const overlay = document.createElement("div");
		overlay.id = "shuvgeist-element-picker";
		overlay.style.cssText = `
		position: fixed;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		z-index: 2147483647;
		pointer-events: none;
	`;

		// Create highlight element
		const highlight = document.createElement("div");
		highlight.style.cssText = `
		position: absolute;
		pointer-events: none;
		border: 2px solid #3b82f6;
		background: rgba(59, 130, 246, 0.1);
		transition: all 0.1s ease;
		box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.5);
	`;
		overlay.appendChild(highlight);

		// Create tooltip
		const tooltip = document.createElement("div");
		tooltip.style.cssText = `
		position: absolute;
		pointer-events: none;
		background: #1f2937;
		color: white;
		padding: 8px 12px;
		border-radius: 6px;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		font-size: 12px;
		line-height: 1.4;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		max-width: 300px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	`;
		overlay.appendChild(tooltip);

		// Create instruction banner
		const banner = document.createElement("div");
		banner.style.cssText = `
		position: fixed;
		top: 20px;
		left: 50%;
		transform: translateX(-50%);
		background: #1f2937;
		color: white;
		padding: 12px 24px;
		border-radius: 8px;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		font-size: 14px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		pointer-events: auto;
		z-index: 2147483647;
		display: flex;
		align-items: center;
		gap: 12px;
	`;

		const bannerText = document.createElement("span");
		bannerText.textContent = message || "Click element to select • ↑↓ to change depth";
		banner.appendChild(bannerText);

		const cancelButton = document.createElement("button");
		cancelButton.textContent = "Cancel (ESC)";
		cancelButton.style.cssText = `
		background: #374151;
		border: none;
		color: white;
		padding: 4px 12px;
		border-radius: 4px;
		font-size: 12px;
		cursor: pointer;
		transition: background 0.2s;
	`;
		cancelButton.addEventListener("mouseenter", () => {
			cancelButton.style.background = "#4b5563";
		});
		cancelButton.addEventListener("mouseleave", () => {
			cancelButton.style.background = "#374151";
		});
		banner.appendChild(cancelButton);

		document.body.appendChild(banner);
		document.body.appendChild(overlay);

		let isSelecting = true;
		let currentElement: Element | null = null;
		let ancestorIndex = 0; // 0 = deepest element, higher = ancestors

		// Generate optimized CSS selector
		function generateSelector(element: Element): string {
			if (element.id) {
				return `#${CSS.escape(element.id)}`;
			}

			const path: string[] = [];
			let current: Element | null = element;

			while (current && current !== document.body) {
				let selector = current.tagName.toLowerCase();

				if (current.className && typeof current.className === "string") {
					const classes = current.className.split(/\s+/).filter((c) => c && !c.startsWith("shuvgeist-"));
					if (classes.length > 0) {
						selector += `.${classes.map((c) => CSS.escape(c)).join(".")}`;
					}
				}

				// Add nth-child if needed for uniqueness
				if (current.parentElement) {
					const siblings = Array.from(current.parentElement.children).filter(
						(el) => el.tagName === current!.tagName,
					);
					if (siblings.length > 1) {
						const index = siblings.indexOf(current) + 1;
						selector += `:nth-child(${index})`;
					}
				}

				path.unshift(selector);
				current = current.parentElement;
			}

			return path.join(" > ");
		}

		// Generate XPath
		function generateXPath(element: Element): string {
			if (element.id) {
				return `//*[@id="${element.id}"]`;
			}

			const path: string[] = [];
			let current: Element | null = element;

			while (current && current !== document.documentElement) {
				let index = 0;
				let sibling = current.previousElementSibling;

				while (sibling) {
					if (sibling.tagName === current.tagName) {
						index++;
					}
					sibling = sibling.previousElementSibling;
				}

				const tagName = current.tagName.toLowerCase();
				const position = index > 0 ? `[${index + 1}]` : "";
				path.unshift(`${tagName}${position}`);
				current = current.parentElement;
			}

			return `/${path.join("/")}`;
		}

		// Get element info
		function getElementInfo(element: Element): ElementInfo {
			const rect = element.getBoundingClientRect();
			const styles = window.getComputedStyle(element);

			// Get relevant computed styles
			const computedStyles: Record<string, string> = {
				display: styles.display,
				position: styles.position,
				width: styles.width,
				height: styles.height,
				color: styles.color,
				backgroundColor: styles.backgroundColor,
				fontSize: styles.fontSize,
				fontWeight: styles.fontWeight,
			};

			// Get attributes
			const attributes: Record<string, string> = {};
			for (const attr of element.attributes) {
				attributes[attr.name] = attr.value;
			}

			// Get parent chain
			const parentChain: string[] = [];
			let current: Element | null = element;
			while (current && current !== document.documentElement) {
				parentChain.unshift(current.tagName.toLowerCase());
				current = current.parentElement;
			}

			// Get text content (truncated to 1000 chars)
			const text = element.textContent?.trim().substring(0, 1000) || "";

			// Get HTML (truncated to 4000 chars, with a marker if truncated)
			const outer = element.outerHTML;
			const html = outer.length > 4000 ? `${outer.substring(0, 4000)}<!-- [truncated] -->` : outer;

			return {
				selector: generateSelector(element),
				xpath: generateXPath(element),
				html,
				tagName: element.tagName.toLowerCase(),
				attributes,
				text,
				boundingBox: {
					x: rect.x + window.scrollX,
					y: rect.y + window.scrollY,
					width: rect.width,
					height: rect.height,
				},
				computedStyles,
				parentChain,
			};
		}

		// Update highlight position
		function updateHighlight(element: Element) {
			const rect = element.getBoundingClientRect();
			highlight.style.top = `${rect.top}px`;
			highlight.style.left = `${rect.left}px`;
			highlight.style.width = `${rect.width}px`;
			highlight.style.height = `${rect.height}px`;

			// Update tooltip
			const tagName = element.tagName.toLowerCase();
			const id = element.id ? `#${element.id}` : "";
			const className = element.className ? `.${element.className.toString().split(/\s+/).join(".")}` : "";
			tooltip.textContent = `${tagName}${id}${className}`;

			// Position tooltip above or below element
			const tooltipRect = tooltip.getBoundingClientRect();
			if (rect.top > tooltipRect.height + 10) {
				tooltip.style.top = `${rect.top - tooltipRect.height - 5}px`;
			} else {
				tooltip.style.top = `${rect.bottom + 5}px`;
			}
			tooltip.style.left = `${Math.min(rect.left, window.innerWidth - tooltipRect.width - 10)}px`;
		}

		// Get ancestors of an element up to body
		function getAncestors(element: Element): Element[] {
			const ancestors: Element[] = [];
			let current: Element | null = element;
			while (current && current !== document.body && current !== document.documentElement) {
				ancestors.push(current);
				current = current.parentElement;
			}
			return ancestors;
		}

		// Get all elements at a point (penetrating through covering elements like <a> tags)
		function getAllElementsAtPoint(x: number, y: number): Element[] {
			const elements: Element[] = [];
			const elementsToHide: Array<{ element: HTMLElement; originalPointerEvents: string }> = [];
			const seenElements = new Set<Element>();
			const MAX_DEPTH = 50; // Prevent infinite loops
			let iterations = 0;

			try {
				let element = document.elementFromPoint(x, y);

				// Keep getting elements and temporarily hiding them to get elements beneath
				while (element && element !== document.documentElement && element !== document.body) {
					// Safety check: prevent infinite loops
					if (iterations++ > MAX_DEPTH) {
						console.warn("[select-element] Reached max depth, stopping element penetration");
						break;
					}

					// Skip our overlay elements
					if (element === overlay || overlay.contains(element) || element === banner || banner.contains(element)) {
						break;
					}

					// Check if we've already seen this element (infinite loop protection)
					if (seenElements.has(element)) {
						console.warn("[select-element] Already seen element, stopping to prevent loop");
						break;
					}

					seenElements.add(element);
					elements.push(element);

					// Hide this element temporarily and get the next one beneath it
					if (element instanceof HTMLElement) {
						const original = element.style.pointerEvents;
						elementsToHide.push({ element, originalPointerEvents: original });
						element.style.pointerEvents = "none";
					}

					const nextElement = document.elementFromPoint(x, y);

					// If we get the same element back, we're stuck
					if (nextElement === element) {
						console.warn("[select-element] Got same element back, stopping");
						break;
					}

					element = nextElement;
				}

				return elements;
			} finally {
				// Restore pointer events for all elements we modified
				for (const { element, originalPointerEvents } of elementsToHide) {
					element.style.pointerEvents = originalPointerEvents;
				}
			}
		}

		// Mouse move handler
		function handleMouseMove(e: MouseEvent) {
			if (!isSelecting) return;

			// Get all elements at cursor position (penetrating through covering elements)
			const elementsAtPoint = getAllElementsAtPoint(e.clientX, e.clientY);

			if (elementsAtPoint.length === 0) {
				return;
			}

			// Use the first (topmost) element as the current element
			const element = elementsAtPoint[0];

			// Reset to deepest element on mouse move
			currentElement = element;
			ancestorIndex = 0;
			updateHighlight(element);
		}

		// Click handler
		function handleClick(e: MouseEvent) {
			if (!isSelecting) return;

			// Check if click is on banner or its children
			if (e.target === banner || banner.contains(e.target as Node)) {
				return; // Let banner handle its own clicks
			}

			e.preventDefault();
			e.stopPropagation();

			// Use the currently highlighted element (after arrow key navigation)
			// If no navigation happened, currentElement is the element under cursor
			if (!currentElement) {
				// Fallback: get element at click position
				const element = document.elementFromPoint(e.clientX, e.clientY);
				if (
					!element ||
					element === overlay ||
					overlay.contains(element) ||
					element === banner ||
					banner.contains(element)
				) {
					return;
				}
				currentElement = element;
			}

			// Get the currently selected element (possibly an ancestor after arrow keys)
			const ancestors = getAncestors(currentElement);
			const selectedElement = ancestors[ancestorIndex] || currentElement;

			const elementInfo = getElementInfo(selectedElement);
			cleanup();
			resolve(elementInfo);
		}

		// Cleanup function
		function cleanup() {
			isSelecting = false;
			document.removeEventListener("mousemove", handleMouseMove, true);
			document.removeEventListener("click", handleClick, true);
			document.removeEventListener("keydown", handleKeyDown, true);
			window.removeEventListener("shuvgeist-element-cancel", handleCancel);
			overlay.remove();
			banner.remove();
			delete window.__shuvgeistElementPicker;
		}

		// Keyboard handler (ESC to cancel, Arrow keys to change depth)
		function handleKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				cleanup();
				resolve(null);
				return;
			}

			// Arrow keys to navigate up/down the DOM tree
			if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				e.preventDefault();

				if (!currentElement) return;

				const ancestors = getAncestors(currentElement);

				if (e.key === "ArrowUp") {
					// Move up to parent (increase ancestor index)
					if (ancestorIndex < ancestors.length - 1) {
						ancestorIndex++;
						updateHighlight(ancestors[ancestorIndex]);
					}
				} else if (e.key === "ArrowDown") {
					// Move down to child (decrease ancestor index)
					if (ancestorIndex > 0) {
						ancestorIndex--;
						updateHighlight(ancestors[ancestorIndex]);
					}
				}
			}
		}

		// Cancel button handler
		cancelButton.addEventListener("click", (e) => {
			e.stopPropagation();
			cleanup();
			resolve(null);
		});

		// External cancel handler (from abort signal)
		function handleCancel() {
			if (isSelecting) {
				cleanup();
				resolve(null);
			}
		}

		// Listen for external cancel event (from abort signal)
		window.addEventListener("shuvgeist-element-cancel", handleCancel, {
			once: true,
		});

		// Attach event listeners
		document.addEventListener("mousemove", handleMouseMove, true);
		document.addEventListener("click", handleClick, true);
		document.addEventListener("keydown", handleKeyDown, true);
	});
}
