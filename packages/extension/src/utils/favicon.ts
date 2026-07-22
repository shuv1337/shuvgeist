/**
 * Get favicon URL for a domain using Google's favicon service.
 * @param domainPattern Domain pattern (e.g., 'slack.com', 'github.com/*', '*.google.com')
 * @param size Favicon size in pixels (default: 32)
 * @returns URL to the favicon image
 */
export function getFaviconUrl(domainPattern: string, size: number = 32): string {
	// Extract base domain from pattern (remove wildcards and paths)
	const domain = domainPattern.replace(/\*/g, "").split("/")[0];
	// Use Google's favicon service
	return `https://www.google.com/s2/favicons?domain=${domain}&sz=${size}`;
}
