import {
	clientIp,
	createRateLimiter,
	filterRequestHeaders,
	filterResponseHeaders,
	loadConfig,
	parseTargetUrl,
} from "../src/helpers.js";

describe("proxy helpers", () => {
	it("loads config from environment and defaults", () => {
		const config = loadConfig({
			PORT: "3001",
			ALLOWED_HOSTS: "example.com, api.example.com",
			PROXY_SECRET: "secret",
			RATE_LIMIT_RPM: "42",
			MAX_BODY_SIZE: "1mb",
			REQUEST_TIMEOUT_MS: "9000",
		} as NodeJS.ProcessEnv);
		expect(config).toEqual({
			port: 3001,
			allowedHosts: ["example.com", "api.example.com"],
			proxySecret: "secret",
			rateLimitRpm: 42,
			maxBodySize: "1mb",
			requestTimeoutMs: 9000,
		});
	});

	it("parses target urls from query and path mode", () => {
		expect(parseTargetUrl({ query: { url: "https://example.com?a=1" }, path: "/" })).toBe("https://example.com?a=1");
		expect(parseTargetUrl({ query: {}, path: "/https://example.com/path" })).toBe("https://example.com/path");
		expect(parseTargetUrl({ query: {}, path: `/${encodeURIComponent("https://example.com/encoded")}` })).toBe(
			"https://example.com/encoded",
		);
		expect(parseTargetUrl({ query: {}, path: "/not-a-url" })).toBeNull();
	});

	it("filters request and response headers", () => {
		expect(
			filterRequestHeaders({
				authorization: "Bearer token",
				cookie: "should-strip",
				"content-type": "application/json",
				"x-api-key": "abc",
			}),
		).toEqual({
			authorization: "Bearer token",
			"content-type": "application/json",
			"x-api-key": "abc",
		});

		const headers = new Headers({
			"content-type": "application/json",
			"content-encoding": "gzip",
			"access-control-allow-origin": "*",
			"x-custom": "ok",
		});
		expect(filterResponseHeaders(headers)).toEqual({
			"content-type": "application/json",
			"x-custom": "ok",
		});
	});

	it("tracks rate limits by client ip", () => {
		const isRateLimited = createRateLimiter(2);
		expect(isRateLimited("1.2.3.4")).toBe(false);
		expect(isRateLimited("1.2.3.4")).toBe(false);
		expect(isRateLimited("1.2.3.4")).toBe(true);
		expect(
			clientIp({ headers: { "x-forwarded-for": "9.8.7.6, 1.1.1.1" }, socket: { remoteAddress: "2.2.2.2" } }),
		).toBe("9.8.7.6");
	});
});
