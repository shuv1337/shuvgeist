/**
 * xAI SuperGrok OAuth for the extension.
 *
 * Uses the public Grok CLI client and the OIDC device-code grant. The extension
 * opens the verification page and polls the token endpoint; no local callback
 * server is required. Inference uses the returned access token as a bearer key
 * on the xAI Responses API.
 */

import type { OAuthCredentials } from "./types.js";

export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_OAUTH_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
export const XAI_OAUTH_DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const AUTH_HOST = "auth.x.ai";
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

export interface XaiOAuthEndpoints {
	authorizationEndpoint: string;
	tokenEndpoint: string;
	deviceAuthorizationEndpoint: string;
}

export interface XaiDeviceCode {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	expiresIn: number;
	interval: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function truncate(text: string, max = 500): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max)}...`;
}

export function assertXaiAuthEndpoint(url: string, field: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`xAI OAuth ${field} is not a URL`);
	}
	if (parsed.protocol !== "https:" || parsed.hostname !== AUTH_HOST) {
		throw new Error(`xAI OAuth ${field} must be an https://${AUTH_HOST} URL`);
	}
	return parsed.toString();
}

function requiredString(payload: Record<string, unknown>, field: string, label: string): string {
	const value = payload[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`xAI ${label} is missing ${field}`);
	}
	return value.trim();
}

function requiredPositiveNumber(payload: Record<string, unknown>, field: string, label: string): number {
	const value = payload[field];
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`xAI ${label} is missing ${field}`);
	}
	return parsed;
}

export function parseXaiDiscovery(payload: unknown): XaiOAuthEndpoints {
	if (!isRecord(payload)) {
		throw new Error("xAI OIDC discovery response was not a JSON object");
	}
	return {
		authorizationEndpoint: assertXaiAuthEndpoint(
			requiredString(payload, "authorization_endpoint", "OIDC discovery"),
			"authorization_endpoint",
		),
		tokenEndpoint: assertXaiAuthEndpoint(
			requiredString(payload, "token_endpoint", "OIDC discovery"),
			"token_endpoint",
		),
		deviceAuthorizationEndpoint: assertXaiAuthEndpoint(
			requiredString(payload, "device_authorization_endpoint", "OIDC discovery"),
			"device_authorization_endpoint",
		),
	};
}

export function parseXaiDeviceCode(payload: unknown): XaiDeviceCode {
	if (!isRecord(payload)) {
		throw new Error("xAI device-code response was not a JSON object");
	}
	const verificationUriComplete = payload.verification_uri_complete;
	return {
		deviceCode: requiredString(payload, "device_code", "device-code response"),
		userCode: requiredString(payload, "user_code", "device-code response"),
		verificationUri: requiredString(payload, "verification_uri", "device-code response"),
		...(typeof verificationUriComplete === "string" && verificationUriComplete.trim().length > 0
			? { verificationUriComplete: verificationUriComplete.trim() }
			: {}),
		expiresIn: requiredPositiveNumber(payload, "expires_in", "device-code response"),
		interval: requiredPositiveNumber(payload, "interval", "device-code response"),
	};
}

export function credentialsFromXaiTokenPayload(payload: unknown, refreshFallback?: string): OAuthCredentials {
	if (!isRecord(payload)) {
		throw new Error("xAI token response was not a JSON object");
	}
	const access = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
	const refresh =
		typeof payload.refresh_token === "string" && payload.refresh_token.trim().length > 0
			? payload.refresh_token.trim()
			: (refreshFallback ?? "");
	if (!access) throw new Error("xAI token response is missing access_token");
	if (!refresh) throw new Error("xAI token response is missing refresh_token");
	const expiresIn = payload.expires_in;
	const seconds =
		typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
			? expiresIn
			: DEFAULT_EXPIRES_IN_SECONDS;
	return {
		providerId: "xai",
		access,
		refresh,
		expires: Date.now() + seconds * 1000,
	};
}

async function readJson(response: Response): Promise<{ payload: unknown; raw: string }> {
	const raw = await response.text();
	if (!raw.trim()) return { payload: {}, raw };
	try {
		return { payload: JSON.parse(raw) as unknown, raw };
	} catch {
		throw new Error(`xAI response was not valid JSON: ${truncate(raw)}`);
	}
}

async function postForm(
	url: string,
	data: Record<string, string>,
): Promise<{ status: number; payload: unknown; raw: string }> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams(data),
	});
	const body = await readJson(response);
	return { status: response.status, ...body };
}

function tokenErrorMessage(status: number, raw: string, action: string): string {
	const detail = truncate(raw);
	if (status === 403) {
		return `xAI ${action} failed (HTTP 403).${detail ? ` ${detail}` : ""} This subscription may not include API access. Re-login will not change that; use an xAI API key or upgrade at https://x.ai/grok.`;
	}
	return `xAI ${action} failed (HTTP ${status}).${detail ? ` ${detail}` : ""}`;
}

function errorCode(payload: unknown): string | undefined {
	if (!isRecord(payload) || typeof payload.error !== "string") return undefined;
	return payload.error;
}

export async function fetchXaiOAuthEndpoints(): Promise<XaiOAuthEndpoints> {
	const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
		headers: { Accept: "application/json" },
	});
	const { payload, raw } = await readJson(response);
	if (!response.ok) {
		throw new Error(`xAI OIDC discovery failed (HTTP ${response.status}).${raw.trim() ? ` ${truncate(raw)}` : ""}`);
	}
	return parseXaiDiscovery(payload);
}

async function pollDeviceToken(tokenEndpoint: string, device: XaiDeviceCode): Promise<OAuthCredentials> {
	const deadline = Date.now() + device.expiresIn * 1000;
	let intervalMs = Math.max(1000, device.interval * 1000);

	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		const result = await postForm(tokenEndpoint, {
			grant_type: XAI_OAUTH_DEVICE_GRANT,
			client_id: XAI_OAUTH_CLIENT_ID,
			device_code: device.deviceCode,
		});
		if (result.status === 200 && isRecord(result.payload) && typeof result.payload.access_token === "string") {
			return credentialsFromXaiTokenPayload(result.payload);
		}

		const code = errorCode(result.payload);
		if (code === "authorization_pending") continue;
		if (code === "slow_down") {
			const nextInterval = isRecord(result.payload) ? result.payload.interval : undefined;
			intervalMs = typeof nextInterval === "number" && nextInterval > 0 ? nextInterval * 1000 : intervalMs + 5000;
			continue;
		}
		if (result.status === 403) {
			throw new Error(tokenErrorMessage(result.status, result.raw, "device-code login"));
		}
		if (code) {
			const description =
				isRecord(result.payload) && typeof result.payload.error_description === "string"
					? result.payload.error_description
					: code;
			throw new Error(`xAI device-code login failed: ${description}`);
		}
		if (result.status !== 200) {
			throw new Error(tokenErrorMessage(result.status, result.raw, "device-code login"));
		}
	}

	throw new Error("xAI device-code login timed out");
}

/**
 * Run the xAI device-code login. Opens the verification page and returns
 * credentials to store under the xAI provider.
 */
export async function loginXai(
	onDeviceCode: (info: { userCode: string; verificationUri: string }) => void,
): Promise<OAuthCredentials> {
	const endpoints = await fetchXaiOAuthEndpoints();
	const started = await postForm(endpoints.deviceAuthorizationEndpoint, {
		client_id: XAI_OAUTH_CLIENT_ID,
		scope: XAI_OAUTH_SCOPE,
	});
	if (started.status !== 200) {
		throw new Error(tokenErrorMessage(started.status, started.raw, "device-code request"));
	}
	const device = parseXaiDeviceCode(started.payload);
	const openUrl = device.verificationUriComplete ?? device.verificationUri;
	onDeviceCode({ userCode: device.userCode, verificationUri: device.verificationUri });
	try {
		await chrome.tabs.create({ url: openUrl, active: true });
	} catch (error) {
		const reason = error instanceof Error ? error.message : "could not open a tab";
		throw new Error(`Open ${openUrl} and enter ${device.userCode}. ${reason}`);
	}
	return pollDeviceToken(endpoints.tokenEndpoint, device);
}

export async function refreshXai(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const refresh = credentials.refresh.trim();
	if (!refresh) {
		throw new Error("xAI OAuth is missing a refresh token. Log in again.");
	}
	const endpoints = await fetchXaiOAuthEndpoints();
	const result = await postForm(endpoints.tokenEndpoint, {
		grant_type: "refresh_token",
		client_id: XAI_OAUTH_CLIENT_ID,
		refresh_token: refresh,
	});
	if (result.status !== 200) {
		throw new Error(tokenErrorMessage(result.status, result.raw, "token refresh"));
	}
	return credentialsFromXaiTokenPayload(result.payload, refresh);
}
