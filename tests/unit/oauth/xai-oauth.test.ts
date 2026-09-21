import { describe, expect, it } from "vitest";
import { isOAuthProvider } from "@shuvgeist/extension/oauth/index";
import {
	assertXaiAuthEndpoint,
	credentialsFromXaiTokenPayload,
	parseXaiDeviceCode,
	parseXaiDiscovery,
} from "@shuvgeist/extension/oauth/xai";
import { getOAuthProviderDisplayName, getProviderDefaultModelId } from "@shuvgeist/extension/providers/catalog";

const discovery = {
	authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
	token_endpoint: "https://auth.x.ai/oauth2/token",
	device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
};

describe("xAI OAuth", () => {
	it("is a subscription provider with Grok 4.7 as the default model", () => {
		expect(isOAuthProvider("xai")).toBe(true);
		expect(getOAuthProviderDisplayName("xai")).toBe("xAI SuperGrok");
		expect(getProviderDefaultModelId("xai")).toBe("grok-4.7");
		expect(getProviderDefaultModelId("openai-codex")).toBe("gpt-5.6-sol");
	});

	it("accepts only auth.x.ai discovery endpoints", () => {
		expect(parseXaiDiscovery(discovery)).toEqual({
			authorizationEndpoint: "https://auth.x.ai/oauth2/authorize",
			tokenEndpoint: "https://auth.x.ai/oauth2/token",
			deviceAuthorizationEndpoint: "https://auth.x.ai/oauth2/device/code",
		});
		expect(() => assertXaiAuthEndpoint("https://evil.example/token", "token_endpoint")).toThrow(/auth\.x\.ai/);
		expect(() =>
			parseXaiDiscovery({ ...discovery, token_endpoint: "http://auth.x.ai/oauth2/token" }),
		).toThrow(/https:\/\/auth\.x\.ai/);
	});

	it("parses a device-code response and token payload", () => {
		expect(
			parseXaiDeviceCode({
				device_code: "device",
				user_code: "ABCD-EFGH",
				verification_uri: "https://accounts.x.ai/device",
				verification_uri_complete: "https://accounts.x.ai/device?user_code=ABCD-EFGH",
				expires_in: "300",
				interval: 5,
			}),
		).toMatchObject({
			deviceCode: "device",
			userCode: "ABCD-EFGH",
			verificationUriComplete: "https://accounts.x.ai/device?user_code=ABCD-EFGH",
			expiresIn: 300,
			interval: 5,
		});

		const credentials = credentialsFromXaiTokenPayload(
			{ access_token: "access", expires_in: 60 },
			"refresh",
		);
		expect(credentials.providerId).toBe("xai");
		expect(credentials.access).toBe("access");
		expect(credentials.refresh).toBe("refresh");
		expect(credentials.expires).toBeGreaterThan(Date.now());
		expect(() => credentialsFromXaiTokenPayload({ access_token: "access" })).toThrow(/refresh_token/);
	});
});
