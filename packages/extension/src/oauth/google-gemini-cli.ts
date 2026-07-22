/**
 * Google Gemini CLI (Cloud Code Assist) OAuth flow for browser extensions.
 *
 * Uses the same client ID and endpoints as the CLI,
 * but replaces the local HTTP callback server with tab URL watching.
 * All Google endpoints have CORS enabled for chrome extensions, no proxy needed.
 */

import { generatePKCE, waitForOAuthRedirect } from "./browser-oauth.js";
import type { OAuthCredentials } from "./types.js";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode(
	"NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t",
);
const CLIENT_SECRET = decode("R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw=");
const REDIRECT_URI = "http://localhost:8085/oauth2callback";
const REDIRECT_HOST = "localhost:8085";
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

async function discoverProject(accessToken: string): Promise<string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "gl-node/22.17.0",
	};

	const loadResponse = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			metadata: {
				ideType: "IDE_UNSPECIFIED",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
			},
		}),
	});

	if (!loadResponse.ok) {
		const errorText = await loadResponse.text();
		throw new Error(`loadCodeAssist failed: ${loadResponse.status} ${errorText}`);
	}

	const data = await loadResponse.json();

	if (data.cloudaicompanionProject) {
		return data.cloudaicompanionProject;
	}

	// Need onboarding
	const tierId = data.allowedTiers?.find((t: any) => t.isDefault)?.id || "free-tier";

	const onboardResponse = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			tierId,
			metadata: {
				ideType: "IDE_UNSPECIFIED",
				platform: "PLATFORM_UNSPECIFIED",
				pluginType: "GEMINI",
			},
		}),
	});

	if (!onboardResponse.ok) {
		const errorText = await onboardResponse.text();
		throw new Error(`onboardUser failed: ${onboardResponse.status} ${errorText}`);
	}

	let lroData = await onboardResponse.json();

	// Poll if not done
	while (!lroData.done && lroData.name) {
		await new Promise((r) => setTimeout(r, 5000));
		const pollResponse = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal/${lroData.name}`, {
			method: "GET",
			headers,
		});
		if (!pollResponse.ok) throw new Error(`Poll failed: ${pollResponse.status}`);
		lroData = await pollResponse.json();
	}

	const projectId = lroData.response?.cloudaicompanionProject?.id;
	if (projectId) return projectId;

	throw new Error("Could not discover or provision a Google Cloud project for Gemini CLI.");
}

/**
 * Run the Gemini CLI OAuth login flow in the browser.
 * Opens a tab for Google sign-in, watches for the redirect.
 * All endpoints have CORS enabled, no proxy needed.
 */
export async function loginGeminiCli(): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();

	const authParams = new URLSearchParams({
		client_id: CLIENT_ID,
		response_type: "code",
		redirect_uri: REDIRECT_URI,
		scope: SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: verifier,
		access_type: "offline",
		prompt: "consent",
	});

	const redirectUrl = await waitForOAuthRedirect(`${AUTH_URL}?${authParams.toString()}`, REDIRECT_HOST);

	const code = redirectUrl.searchParams.get("code");
	const state = redirectUrl.searchParams.get("state");

	if (!code) throw new Error("Missing authorization code in redirect");
	if (state !== verifier) throw new Error("OAuth state mismatch");

	// Exchange code for tokens (Google has CORS enabled)
	const tokenResponse = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		}),
	});

	if (!tokenResponse.ok) {
		const error = await tokenResponse.text();
		throw new Error(`Token exchange failed: ${error}`);
	}

	const tokenData = await tokenResponse.json();

	if (!tokenData.refresh_token) {
		throw new Error("No refresh token received. Please try again.");
	}

	// Discover project
	const projectId = await discoverProject(tokenData.access_token);

	return {
		providerId: "google-gemini-cli",
		access: tokenData.access_token,
		refresh: tokenData.refresh_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
		projectId,
	};
}

/**
 * Refresh a Gemini CLI token. No proxy needed.
 */
export async function refreshGeminiCli(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const projectId = credentials.projectId;
	if (!projectId) throw new Error("Gemini CLI credentials missing projectId");

	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			refresh_token: credentials.refresh,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Token refresh failed: ${error}`);
	}

	const data = await response.json();

	return {
		providerId: "google-gemini-cli",
		access: data.access_token,
		refresh: data.refresh_token || credentials.refresh,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		projectId,
	};
}
