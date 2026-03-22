/**
 * Browser-based OAuth flows for Chrome extensions.
 *
 * Instead of spawning a local HTTP server, we:
 * 1. Open the auth URL in a new tab
 * 2. Watch for the tab to redirect to localhost (which fails to load)
 * 3. Extract code/state from the URL
 * 4. Exchange the code for tokens via fetch (direct or proxied)
 */

/**
 * Open an auth URL in a new tab and wait for the redirect to a localhost URL.
 * Returns the redirect URL with code/state params.
 */
export async function waitForOAuthRedirect(authUrl: string, redirectHost: string): Promise<URL> {
	const tab = await chrome.tabs.create({ url: authUrl, active: true });
	const tabId = tab.id;
	if (!tabId) throw new Error("Failed to create auth tab");

	return new Promise<URL>((resolve, reject) => {
		const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
			if (updatedTabId !== tabId || !changeInfo.url) return;

			let url: URL;
			try {
				url = new URL(changeInfo.url);
			} catch {
				return;
			}

			// Check if we hit the localhost redirect
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
				if (url.host === redirectHost || url.hostname === new URL(`http://${redirectHost}`).hostname) {
					cleanup();
					chrome.tabs.remove(tabId).catch(() => {});
					resolve(url);
				}
			}
		};

		const onRemoved = (removedTabId: number) => {
			if (removedTabId !== tabId) return;
			cleanup();
			reject(new Error("Auth tab was closed before completing login"));
		};

		const cleanup = () => {
			chrome.tabs.onUpdated.removeListener(onUpdated);
			chrome.tabs.onRemoved.removeListener(onRemoved);
		};

		chrome.tabs.onUpdated.addListener(onUpdated);
		chrome.tabs.onRemoved.addListener(onRemoved);
	});
}

/**
 * Generate PKCE code verifier and challenge using Web Crypto API.
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);

	const data = new TextEncoder().encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const challenge = base64urlEncode(new Uint8Array(hashBuffer));

	return { verifier, challenge };
}

/**
 * Generate a random state string.
 */
export function generateState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return base64urlEncode(bytes);
}

function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Post a token request as application/x-www-form-urlencoded.
 *
 * Using form-urlencoded (instead of JSON) is important for two reasons:
 * 1. It is what the OAuth 2.0 spec mandates for token endpoints.
 * 2. It qualifies as a CORS "simple request", so the browser skips the
 *    OPTIONS preflight. Some providers (Anthropic) aggressively rate-limit
 *    the token endpoint, and the extra preflight request can push us over
 *    the limit before the real POST even fires.
 */
export async function postTokenRequest(
	url: string,
	body: Record<string, string>,
	proxyUrl?: string,
): Promise<Record<string, unknown>> {
	const targetUrl = proxyUrl ? `${proxyUrl}/?url=${encodeURIComponent(url)}` : url;

	const response = await fetch(targetUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(body).toString(),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Token request failed: ${response.status} ${text}`);
	}

	return response.json();
}
