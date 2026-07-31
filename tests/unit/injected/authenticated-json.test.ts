// @vitest-environment happy-dom

import { validateAuthenticatedJsonData } from "@shuvgeist/driver/authenticated-json";
import type { AuthenticatedJsonInjectionRequest } from "@shuvgeist/driver/injected-contracts";
import { run } from "@shuvgeist/driver/injected-authenticated-json";

function request(overrides: Partial<AuthenticatedJsonInjectionRequest> = {}): AuthenticatedJsonInjectionRequest {
	return {
		token: "request-token",
		path: "/api/me",
		method: "GET",
		timeoutMs: 5_000,
		maxResponseBytes: 1_024,
		reviewMutation: false,
		...overrides,
	};
}

describe("authenticated JSON page runtime", () => {
	beforeEach(() => {
		window.happyDOM.setURL("https://app.example.test/account");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it.each(["https://evil.example/api", "//evil.example/api", "javascript:alert(1)"])(
		"rejects origin-confusing path %s before fetch",
		async (path) => {
			const fetch = vi.fn();
			window.fetch = fetch;
			expect(await run(request({ path }))).toMatchObject({ success: false });
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("uses same-origin browser credentials, no-store caching, and no redirects", async () => {
		const fetch = vi.fn(async () =>
			new Response('{"name":"Ada"}', {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		window.fetch = fetch;
		const result = await run(request({ path: "/api/me?view=compact" }));

		expect(result).toMatchObject({
			success: true,
			origin: "https://app.example.test",
			path: "/api/me?view=compact",
			data: { name: "Ada" },
		});
		expect(fetch).toHaveBeenCalledWith(
			"https://app.example.test/api/me?view=compact",
			expect.objectContaining({ credentials: "same-origin", cache: "no-store", redirect: "manual" }),
		);
	});

	it("requires mutation review and performs a reviewed mutation exactly once", async () => {
		const fetch = vi.fn(async () =>
			new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		window.fetch = fetch;
		expect(await run(request({ method: "POST", body: { name: "Ada" } }))).toMatchObject({
			success: false,
			code: "mutation_review_required",
		});
		expect(fetch).not.toHaveBeenCalled();

		expect(
			await run(request({ method: "POST", body: { name: "Ada" }, reviewMutation: true })),
		).toMatchObject({ success: true, mutation: true });
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0]?.[1]).toMatchObject({
			method: "POST",
			body: '{"name":"Ada"}',
		});
	});

	it("rejects redirects, non-JSON content, and declared or streamed oversize responses", async () => {
		window.fetch = vi.fn(async () => new Response("", { status: 302, headers: { Location: "/login" } }));
		expect(await run(request())).toMatchObject({ success: false, code: "redirect_rejected" });

		window.fetch = vi.fn(async () => new Response("plain", { status: 200, headers: { "Content-Type": "text/plain" } }));
		expect(await run(request())).toMatchObject({ success: false, code: "non_json_response" });

		window.fetch = vi.fn(
			async () =>
				new Response('{"large":true}', {
					status: 200,
					headers: { "Content-Type": "application/json", "Content-Length": "9999" },
				}),
		);
		expect(await run(request({ maxResponseBytes: 10 }))).toMatchObject({
			success: false,
			code: "response_too_large",
		});

		window.fetch = vi.fn(
			async () =>
				new Response('{"large":"streamed"}', {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		expect(await run(request({ maxResponseBytes: 10 }))).toMatchObject({
			success: false,
			code: "response_too_large",
		});
	});

	it("distinguishes external abort from timeout", async () => {
		window.fetch = vi.fn(
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
				}),
		);
		const pending = run(request());
		await vi.waitFor(() => {
			const scope = globalThis as typeof globalThis & {
				__SHUVGEIST_AUTHENTICATED_JSON_CONTROLLERS__?: Map<string, AbortController>;
			};
			expect(scope.__SHUVGEIST_AUTHENTICATED_JSON_CONTROLLERS__?.get("request-token")).toBeDefined();
			scope.__SHUVGEIST_AUTHENTICATED_JSON_CONTROLLERS__?.get("request-token")?.abort();
		});
		expect(await pending).toMatchObject({ success: false, code: "request_aborted" });

		vi.useFakeTimers();
		const timed = run(request({ token: "timeout-token", timeoutMs: 100 }));
		await vi.advanceTimersByTimeAsync(100);
		expect(await timed).toMatchObject({ success: false, code: "request_timed_out" });
	});

	it("returns bounded actionable schema issues without including response values", () => {
		const issues = validateAuthenticatedJsonData(
			{ user: { id: "private-value" } },
			{
				type: "object",
				required: ["status"],
				properties: {
					user: {
						type: "object",
						properties: { id: { type: "number" } },
					},
				},
			},
		);
		expect(issues).toEqual([
			"$.status: required property is missing",
			"$.user.id: expected number, received string",
		]);
		expect(issues.join(" ")).not.toContain("private-value");
	});
});
