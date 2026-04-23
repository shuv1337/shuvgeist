import { describe, expect, it, vi, beforeEach } from "vitest";
import {
	clearKokoroHealthCache,
	isKokoroHealthStale,
	probeKokoroHealth,
	refreshKokoroHealth,
} from "../../../src/tts/kokoro-health.js";

describe("kokoro-health", () => {
	beforeEach(() => {
		clearKokoroHealthCache();
		vi.useFakeTimers();
	});

	describe("probeKokoroHealth", () => {
		it("returns ok when voices and caption endpoints work", async () => {
			const mockFetch = vi.fn();
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ voices: ["af_heart", "am_onyx"] }),
				})
				.mockResolvedValueOnce({
					ok: true,
				});

			const result = await probeKokoroHealth("http://localhost:8880/v1", undefined, mockFetch);

			expect(result.status).toBe("ok");
			expect(result.latencyMs).toBeDefined();
		});

		it("returns captioned-unsupported when caption endpoint missing", async () => {
			const mockFetch = vi.fn();
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ voices: ["af_heart"] }),
				})
				.mockRejectedValueOnce(new Error("Network error"));

			const result = await probeKokoroHealth("http://localhost:8880/v1", undefined, mockFetch);

			expect(result.status).toBe("captioned-unsupported");
		});

		it("returns auth-required on 401", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
			});

			const result = await probeKokoroHealth("http://localhost:8880/v1", undefined, mockFetch);

			expect(result.status).toBe("auth-required");
		});

		it("returns unreachable when fetch fails", async () => {
			const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

			const result = await probeKokoroHealth("http://localhost:8880/v1", undefined, mockFetch);

			expect(result.status).toBe("unreachable");
			expect(result.message).toContain("Connection refused");
		});

		it("uses apiKey when provided", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ voices: [] }),
			});

			await probeKokoroHealth("http://localhost:8880/v1", "test-key", mockFetch);

			expect(mockFetch).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headers: { authorization: "Bearer test-key" },
				}),
			);
		});

		it("caches results within TTL", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ voices: [] }),
			});

			await probeKokoroHealth("http://localhost:8880/v1", undefined, mockFetch);
			await probeKokoroHealth("http://localhost:8880/v1", undefined, mockFetch);

			expect(mockFetch).toHaveBeenCalledTimes(2); // voices + caption check once
		});

		it("bypasses cache after TTL expires", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ voices: [] }),
			});

			await probeKokoroHealth("http://localhost:8880/v1", undefined, mockFetch);

			vi.advanceTimersByTime(31000); // TTL is 30000ms

			await probeKokoroHealth("http://localhost:8880/v1", undefined, mockFetch);

			// Should have made fresh requests
			expect(mockFetch).toHaveBeenCalledTimes(4);
		});

		it("respects abort signal", async () => {
			const mockFetch = vi.fn().mockRejectedValue(new Error("AbortError"));
			const controller = new AbortController();
			controller.abort();

			const result = await probeKokoroHealth("http://localhost:8880/v1", undefined, mockFetch, controller.signal);

			expect(result.status).toBe("unreachable");
		});
	});

	describe("refreshKokoroHealth", () => {
		it("bypasses cache and forces fresh probe", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ voices: [] }),
			});

			await probeKokoroHealth("http://localhost:8880/v1", undefined, mockFetch);
			await refreshKokoroHealth("http://localhost:8880/v1", undefined, mockFetch);

			// Should have made fresh requests (2 + 2 = 4, minus one for initial caption check that fails)
			expect(mockFetch).toHaveBeenCalledTimes(4);
		});
	});

	describe("isKokoroHealthStale", () => {
		it("returns true when no cached result", () => {
			expect(isKokoroHealthStale("http://localhost:8880/v1")).toBe(true);
		});

		it("returns false when result is fresh", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ voices: [] }),
			});

			await probeKokoroHealth("http://localhost:8880/v1", undefined, mockFetch);

			expect(isKokoroHealthStale("http://localhost:8880/v1")).toBe(false);
		});

		it("returns true when TTL has expired", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ voices: [] }),
			});

			await probeKokoroHealth("http://localhost:8880/v1", undefined, mockFetch);

			vi.advanceTimersByTime(31000);

			expect(isKokoroHealthStale("http://localhost:8880/v1")).toBe(true);
		});
	});

	describe("cache normalization", () => {
		it("normalizes URLs for cache key", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ voices: [] }),
			});

			// These should share a cache entry
			await probeKokoroHealth("http://localhost:8880/v1/", undefined, mockFetch);
			await probeKokoroHealth("http://localhost:8880/v1", undefined, mockFetch);
			await probeKokoroHealth("HTTP://LOCALHOST:8880/V1", undefined, mockFetch);

			// Should only make one set of requests
			expect(mockFetch).toHaveBeenCalledTimes(2);
		});
	});
});
