/**
 * Anthropic OAuth flow for browser extensions.
 *
 * Uses the console.anthropic.com endpoints which are designed for browser
 * environments. The redirect goes to a real web page that displays the auth
 * code. The extension auto-detects the redirect by watching the tab URL,
 * with a manual paste input as a racing fallback.
 */

import { generatePKCE, postTokenRequest } from "./browser-oauth.js";
import type { OAuthCredentials } from "./types.js";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// Not a full URL, keep parsing below.
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return {
			code: code || undefined,
			state: state || undefined,
		};
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value.startsWith("?") ? value.slice(1) : value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

/**
 * Watch for a tab to navigate to the Anthropic code callback page.
 * Extracts code and state from the URL, then closes the tab.
 */
function waitForAnthropicCallback(authUrl: string): Promise<{ code: string; state: string }> {
	return new Promise((resolve, reject) => {
		chrome.tabs.create({ url: authUrl, active: true }).then((tab) => {
			const tabId = tab.id;
			if (!tabId) {
				reject(new Error("Failed to create auth tab"));
				return;
			}

			const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
				if (updatedTabId !== tabId || !changeInfo.url) return;

				let url: URL;
				try {
					url = new URL(changeInfo.url);
				} catch {
					return;
				}

				// Detect redirect to the console callback page
				if (url.hostname === "console.anthropic.com" && url.pathname === "/oauth/code/callback") {
					const code = url.searchParams.get("code");
					const state = url.searchParams.get("state");
					if (code && state) {
						cleanup();
						chrome.tabs.remove(tabId).catch(() => {});
						resolve({ code, state });
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
	});
}

/**
 * Callback type for collecting the authorization code from the user.
 */
export type AnthropicCodeCallback = () => Promise<string>;

/**
 * Run the Anthropic OAuth login flow in the browser.
 *
 * Opens a tab, watches for the console.anthropic.com callback redirect, and
 * exchanges the code. If onCodeInput is provided, it races with the redirect
 * watcher so the user can manually paste the code if auto-detection fails.
 */
export async function loginAnthropic(onCodeInput?: AnthropicCodeCallback): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();

	const authParams = new URLSearchParams({
		code: "true",
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
	});

	const authUrl = `${AUTHORIZE_URL}?${authParams.toString()}`;

	let code: string | undefined;
	let state: string | undefined;

	if (onCodeInput) {
		// Race: auto redirect watcher vs manual paste
		const redirectPromise = waitForAnthropicCallback(authUrl)
			.then((result) => ({ source: "redirect" as const, ...result }))
			.catch(() => null);

		const manualPromise = onCodeInput()
			.then((input) => ({ source: "manual" as const, input }))
			.catch(() => null);

		const winner = await Promise.race([redirectPromise, manualPromise]);

		if (winner?.source === "redirect") {
			code = winner.code;
			state = winner.state;
		} else if (winner?.source === "manual" && winner.input) {
			const parsed = parseAuthorizationInput(winner.input);
			code = parsed.code;
			state = parsed.state ?? verifier;
		}

		// If first winner produced nothing, wait for the other
		if (!code) {
			const other = winner?.source === "redirect" ? await manualPromise : await redirectPromise;
			if (other?.source === "redirect") {
				code = other.code;
				state = other.state;
			} else if (other?.source === "manual" && other.input) {
				const parsed = parseAuthorizationInput(other.input);
				code = parsed.code;
				state = parsed.state ?? verifier;
			}
		}
	} else {
		// No manual fallback — just watch for redirect
		const result = await waitForAnthropicCallback(authUrl);
		code = result.code;
		state = result.state;
	}

	if (!code) throw new Error("Missing authorization code");
	if (!state) state = verifier;
	if (state !== verifier) throw new Error("OAuth state mismatch");

	const tokenData = await postTokenRequest(TOKEN_URL, {
		grant_type: "authorization_code",
		client_id: CLIENT_ID,
		code,
		state,
		redirect_uri: REDIRECT_URI,
		code_verifier: verifier,
	});

	const access = tokenData.access_token as string;
	const refresh = tokenData.refresh_token as string;
	const expiresIn = tokenData.expires_in as number;

	if (!access || !refresh || typeof expiresIn !== "number") {
		throw new Error("Token response missing required fields");
	}

	return {
		providerId: "anthropic",
		access,
		refresh,
		expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
	};
}

/**
 * Refresh an Anthropic OAuth token.
 */
export async function refreshAnthropic(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const tokenData = await postTokenRequest(TOKEN_URL, {
		grant_type: "refresh_token",
		client_id: CLIENT_ID,
		refresh_token: credentials.refresh,
	});

	const access = tokenData.access_token as string;
	const refresh = tokenData.refresh_token as string;
	const expiresIn = tokenData.expires_in as number;

	if (!access || !refresh || typeof expiresIn !== "number") {
		throw new Error("Token refresh response missing required fields");
	}

	return {
		providerId: "anthropic",
		access,
		refresh,
		expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000,
	};
}
