import {
	isOAuthCredentials,
	parseProviderCredential,
	parseOAuthCredentials,
	resolveApiKey,
	serializeOAuthCredentials,
	type OAuthCredentials,
} from "../../../src/oauth/index.js";

describe("OAuth credential resolution", () => {
	it("returns stored API keys unchanged", async () => {
		const storage = { set: vi.fn(async () => {}) };

		await expect(resolveApiKey("sk-test-key", "anthropic", storage)).resolves.toBe("sk-test-key");
		expect(storage.set).not.toHaveBeenCalled();
		expect(isOAuthCredentials("sk-test-key")).toBe(false);
	});

	it("loads unexpired stored OAuth credentials and returns the access token", async () => {
		const credentials: OAuthCredentials = {
			providerId: "anthropic",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 120_000,
			accountId: "acct-1",
		};
		const stored = serializeOAuthCredentials(credentials);
		const storage = { set: vi.fn(async () => {}) };

		expect(isOAuthCredentials(stored)).toBe(true);
		expect(parseProviderCredential(stored)).toEqual({ kind: "oauth", credentials });
		expect(parseOAuthCredentials(stored)).toEqual(credentials);
		await expect(resolveApiKey(stored, "anthropic", storage, "http://proxy.test")).resolves.toBe("access-token");
		expect(storage.set).not.toHaveBeenCalled();
	});

	it("migrates legacy OAuth JSON credentials without using a brace heuristic", async () => {
		const credentials: OAuthCredentials = {
			providerId: "anthropic",
			access: "legacy-access-token",
			refresh: "legacy-refresh-token",
			expires: Date.now() + 120_000,
		};
		const legacyStored = JSON.stringify(credentials);
		const jsonApiKey = JSON.stringify({ token: "plain-json-key", projectId: "project-1" });
		const storage = { set: vi.fn(async () => {}) };

		expect(parseProviderCredential(legacyStored)).toEqual({ kind: "oauth", credentials });
		expect(isOAuthCredentials(jsonApiKey)).toBe(false);
		expect(parseProviderCredential(jsonApiKey)).toEqual({ kind: "api-key", value: jsonApiKey });
		await expect(resolveApiKey(jsonApiKey, "google-gemini-cli", storage)).resolves.toBe(jsonApiKey);
		expect(storage.set).not.toHaveBeenCalled();
	});
});
