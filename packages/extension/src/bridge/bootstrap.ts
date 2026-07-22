import type { BridgeSettings } from "./internal-messages.js";
import { isLoopbackBridgeUrl } from "./settings.js";

export interface BridgeBootstrapResponse {
	version: 1;
	token: string;
}

export type BootstrapFetchLike = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "json" | "text">>;

export interface BootstrapTokenIfNeededResult {
	settings: BridgeSettings;
	persistedToken: boolean;
	attemptedBootstrap: boolean;
}

export async function bootstrapTokenIfNeeded(
	settings: BridgeSettings,
	fetchImpl: BootstrapFetchLike = fetch,
): Promise<BootstrapTokenIfNeededResult> {
	if (!settings.enabled || settings.token || !isLoopbackBridgeUrl(settings.url)) {
		return {
			settings,
			persistedToken: false,
			attemptedBootstrap: false,
		};
	}

	const bootstrapUrl = getBootstrapUrl(settings.url);
	const response = await fetchImpl(bootstrapUrl, {
		method: "GET",
		headers: {
			"X-Shuvgeist-Bootstrap": "1",
		},
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`Bridge bootstrap failed (${response.status})${detail ? `: ${detail}` : ""}`);
	}

	const payload = (await response.json()) as Partial<BridgeBootstrapResponse>;
	if (payload.version !== 1 || typeof payload.token !== "string" || !payload.token) {
		throw new Error("Bridge bootstrap returned an invalid payload");
	}

	return {
		settings: {
			...settings,
			token: payload.token,
		},
		persistedToken: true,
		attemptedBootstrap: true,
	};
}

export function getBootstrapUrl(wsUrl: string): string {
	const url = new URL(wsUrl);
	url.protocol = url.protocol === "wss:" ? "https:" : "http:";
	url.pathname = "/bootstrap";
	url.search = "";
	url.hash = "";
	return url.toString();
}
