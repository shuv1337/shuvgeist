import {
	InMemoryNetworkSecretStore,
	NetworkRedactor,
	stableSecretSlot,
} from "@shuvgeist/driver/network-redaction";

describe("network redaction", () => {
	it("replaces headers and cookies with stable references without exposing values", () => {
		const store = new InMemoryNetworkSecretStore();
		const redactor = new NetworkRedactor({ store });
		const first = redactor.redactHeaders(
			{
				Authorization: "Bearer first-token",
				Cookie: "session=first-cookie; theme=dark",
				"X-Trace-Id": "trace-123",
			},
			"request.header",
		);
		const rotated = redactor.redactHeaders(
			{ Authorization: "Bearer rotated-token", Cookie: "session=rotated-cookie" },
			"request.header",
		);

		expect(first.headers?.Authorization).toBe(rotated.headers?.Authorization);
		expect(first.headers?.Cookie).toContain("session={{shuvgeist-secret:");
		expect(first.headers?.["X-Trace-Id"]).toBe("trace-123");
		expect(JSON.stringify(first)).not.toContain("first-token");
		const authorizationSlot = stableSecretSlot("request.header.authorization");
		expect(store.get(authorizationSlot)).toMatchObject({
			value: "Bearer rotated-token",
			source: "request.header.authorization",
		});
	});

	it("redacts JSON and GraphQL variables by structure, annotation, and entropy", () => {
		const store = new InMemoryNetworkSecretStore();
		const redactor = new NetworkRedactor({ store, sensitiveFields: ["tenantPin"] });
		const result = redactor.redactBody(
			JSON.stringify({
				query: "mutation Login($password: String!) { login(password: $password) }",
				variables: {
					password: "hunter2",
					accessToken: "eyJhbGciOiJIUzI1NiJ9.payload.signature",
					tenantPin: 1234,
					id: "ca761232-ed42-11ce-bacd-00aa0057b223",
				},
			}),
			"application/json",
			"request.body",
		);

		expect(result.omitted).toBe(false);
		expect(result.text).toContain("mutation Login");
		expect(result.text).toContain("ca761232-ed42-11ce-bacd-00aa0057b223");
		expect(result.text).not.toContain("hunter2");
		expect(result.text).not.toContain("eyJhbGci");
		expect(result.text).not.toContain("1234");
		expect(result.redactedFields).toEqual(
			expect.arrayContaining([
				"request.body.variables.password",
				"request.body.variables.accessToken",
				"request.body.variables.tenantPin",
			]),
		);
	});

	it("handles forms and encoded opaque credentials while preserving ordinary fields", () => {
		const redactor = new NetworkRedactor();
		const result = redactor.redactBody(
			"username=alice&password=correct-horse&blob=QWxhZGRpbjpvcGVuIHNlc2FtZQ%3D%3D&city=Seattle",
			"application/x-www-form-urlencoded",
			"request.body",
		);

		expect(result.text).toContain("username=alice");
		expect(result.text).toContain("city=Seattle");
		expect(result.text).not.toContain("correct-horse");
		expect(result.text).not.toContain("QWxhZGRpb");
		expect(result.secretReferences).toHaveLength(2);
	});

	it("redacts credential-bearing URLs and high-entropy custom headers", () => {
		const redactor = new NetworkRedactor();
		const url = redactor.redactUrl(
			"https://alice:password@example.test/callback?code=abc&access_token=super-secret-token&state=ordinary#fragment",
			"request.https://example.test.url",
		);
		const headers = redactor.redactHeaders(
			{
				Location: "https://example.test/next?token=redirect-secret",
				"X-Custom-Credential": "R29vZExvbmdPcGFxdWVDcmVkZW50aWFsMTIz",
				"X-Request-Id": "ca761232-ed42-11ce-bacd-00aa0057b223",
			},
			"response.https://example.test.header",
		);

		expect(url.url).not.toContain("alice");
		expect(url.url).not.toContain("password");
		expect(url.url).not.toContain("super-secret-token");
		expect(url.url).not.toContain("fragment");
		expect(url.url).toContain("state=ordinary");
		expect(headers.headers?.Location).not.toContain("redirect-secret");
		expect(headers.headers?.["X-Custom-Credential"]).toContain("{{shuvgeist-secret:");
		expect(headers.headers?.["X-Request-Id"]).toBe("ca761232-ed42-11ce-bacd-00aa0057b223");
	});

	it("omits ambiguous text, malformed JSON, scalar JSON, and binary bodies", () => {
		const redactor = new NetworkRedactor();
		for (const [body, contentType] of [
			["plain credential-like material", "text/plain"],
			['{"token":', "application/json"],
			['"opaque"', "application/json"],
			["AAECAwQ=", "application/octet-stream"],
		] as const) {
			const result = redactor.redactBody(body, contentType, "response.body");
			expect(result).toMatchObject({ omitted: true });
			expect(result).not.toHaveProperty("text");
		}
	});
});
