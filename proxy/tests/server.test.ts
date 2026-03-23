import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { createProxyApp } from "../src/server.js";
import type { ProxyConfig } from "../src/helpers.js";

interface RunningProxy {
	server: Server;
	baseUrl: string;
	logs: Array<Record<string, unknown>>;
}

async function startProxy(
	config: ProxyConfig,
	fetchImpl: typeof fetch,
): Promise<RunningProxy> {
	const logs: Array<Record<string, unknown>> = [];
	const app = createProxyApp(config, {
		fetchImpl,
		log: (entry) => logs.push(entry as Record<string, unknown>),
		makeReqId: () => "req_test",
		now: (() => {
			let time = 1_000;
			return () => ++time;
		})(),
	});

	const server = createServer(app);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address() as AddressInfo;
	return {
		server,
		baseUrl: `http://127.0.0.1:${address.port}`,
		logs,
	};
}

async function stopProxy(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe("proxy runtime", () => {
	it("serves health and handles preflight without calling upstream", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		const proxy = await startProxy(
			{
				port: 0,
				allowedHosts: ["example.com"],
				proxySecret: null,
				rateLimitRpm: 10,
				maxBodySize: "1mb",
				requestTimeoutMs: 50,
			},
			fetchImpl,
		);
		try {
			const health = await fetch(`${proxy.baseUrl}/health`);
			expect(health.status).toBe(200);
			expect(await health.json()).toEqual({
				status: "ok",
				allowedHosts: ["example.com"],
				rateLimitRpm: 10,
				authRequired: false,
			});

			const preflight = await fetch(`${proxy.baseUrl}/?url=https://example.com/test`, {
				method: "OPTIONS",
			});
			expect(preflight.status).toBe(204);
			expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
			expect(fetchImpl).not.toHaveBeenCalled();
		} finally {
			await stopProxy(proxy.server);
		}
	});

	it("forwards allowed requests, filters headers, and supports path-mode urls", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
			expect(String(input)).toBe("https://example.com/path?q=1");
			expect(init?.method).toBe("POST");
			expect(init?.redirect).toBe("follow");
			const headers = init?.headers as Record<string, string>;
			expect(headers.authorization).toBe("Bearer token");
			expect(headers["content-type"]).toBe("application/json");
			expect(headers.accept).toBe("application/json");
			expect(headers.cookie).toBeUndefined();
			const text = init?.body instanceof ArrayBuffer ? Buffer.from(init.body).toString("utf8") : "";
			expect(text).toBe('{"hello":"world"}');
			return new Response("proxied", {
				status: 201,
				headers: {
					"content-type": "text/plain",
					"x-upstream": "ok",
					"access-control-allow-origin": "https://secret.example",
				},
			});
		});
		const proxy = await startProxy(
			{
				port: 0,
				allowedHosts: ["example.com"],
				proxySecret: null,
				rateLimitRpm: 10,
				maxBodySize: "1mb",
				requestTimeoutMs: 50,
			},
			fetchImpl,
		);
		try {
			const encoded = encodeURIComponent("https://example.com/path?q=1");
			const response = await fetch(`${proxy.baseUrl}/${encoded}`, {
				method: "POST",
				headers: {
					authorization: "Bearer token",
					"content-type": "application/json",
					accept: "application/json",
					cookie: "strip-me",
				},
				body: '{"hello":"world"}',
			});

			expect(response.status).toBe(201);
			expect(response.headers.get("content-type")).toContain("text/plain");
			expect(response.headers.get("x-upstream")).toBe("ok");
			expect(response.headers.get("access-control-allow-origin")).toBe("*");
			expect(await response.text()).toBe("proxied");
			expect(proxy.logs.some((entry) => entry.event === "proxy_ok")).toBe(true);
		} finally {
			await stopProxy(proxy.server);
		}
	});

	it("enforces auth, allowlist, body size limits, and timeout handling", async () => {
		const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const error = new Error("aborted");
					error.name = "AbortError";
					reject(error);
				});
			});
		});
		const proxy = await startProxy(
			{
				port: 0,
				allowedHosts: ["example.com"],
				proxySecret: "secret",
				rateLimitRpm: 10,
				maxBodySize: "5b",
				requestTimeoutMs: 1,
			},
			fetchImpl,
		);
		try {
			const unauthorized = await fetch(`${proxy.baseUrl}/?url=https://example.com/secure`);
			expect(unauthorized.status).toBe(401);

			const blocked = await fetch(`${proxy.baseUrl}/?url=https://blocked.example/path`, {
				headers: { "x-proxy-secret": "secret" },
			});
			expect(blocked.status).toBe(403);
			expect((await blocked.json()).error).toContain("blocked.example");

			const tooLarge = await fetch(`${proxy.baseUrl}/?url=https://example.com/upload`, {
				method: "POST",
				headers: {
					"x-proxy-secret": "secret",
					"content-type": "text/plain",
				},
				body: "123456",
			});
			expect(tooLarge.status).toBe(413);

			const timedOut = await fetch(`${proxy.baseUrl}/?url=https://example.com/slow`, {
				headers: { "x-proxy-secret": "secret" },
			});
			expect(timedOut.status).toBe(504);
			expect(await timedOut.json()).toEqual({ error: "Upstream request timed out." });
			expect(proxy.logs.some((entry) => entry.event === "upstream_timeout")).toBe(true);
		} finally {
			await stopProxy(proxy.server);
		}
	});
});
