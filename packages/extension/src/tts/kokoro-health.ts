/**
 * Kokoro health status checking with caching.
 *
 * Probes the Kokoro endpoint to determine availability and feature support.
 * Results are cached for 30 seconds to avoid excessive probing.
 */

import type { KokoroHealthStatus } from "./types.js";

const PROBE_CACHE_TTL_MS = 30000;

interface CachedProbeResult {
	status: KokoroHealthStatus;
	timestamp: number;
}

const probeCache = new Map<string, CachedProbeResult>();

/**
 * Build the cache key for a Kokoro base URL.
 */
function getCacheKey(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").toLowerCase();
}

/**
 * Probe Kokoro health and capability status.
 * Returns cached result if available and not expired.
 */
export async function probeKokoroHealth(
	baseUrl: string,
	apiKey?: string,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<KokoroHealthStatus> {
	const cacheKey = getCacheKey(baseUrl);
	const cached = probeCache.get(cacheKey);
	const now = Date.now();

	if (cached && now - cached.timestamp < PROBE_CACHE_TTL_MS) {
		return cached.status;
	}

	const normalizedUrl = baseUrl.replace(/\/+$/, "");
	const startTime = performance.now();

	try {
		// First, check if the base endpoint is reachable
		const voicesResponse = await fetchImpl(`${normalizedUrl}/audio/voices`, {
			method: "GET",
			headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
			signal,
		});

		if (!voicesResponse.ok) {
			if (voicesResponse.status === 401 || voicesResponse.status === 403) {
				const status: KokoroHealthStatus = {
					status: "auth-required",
					latencyMs: Math.round(performance.now() - startTime),
					message: `Authentication required: ${voicesResponse.status}`,
				};
				probeCache.set(cacheKey, { status, timestamp: now });
				return status;
			}

			const status: KokoroHealthStatus = {
				status: "unreachable",
				latencyMs: Math.round(performance.now() - startTime),
				message: `Voices endpoint returned ${voicesResponse.status}`,
			};
			probeCache.set(cacheKey, { status, timestamp: now });
			return status;
		}

		// Check if captioned speech endpoint exists (HEAD request)
		let captionedSupported = false;
		try {
			const captionCheck = await fetchImpl(`${normalizedUrl.replace(/\/v1$/i, "")}/dev/captioned_speech`, {
				method: "HEAD",
				headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
				signal,
			});
			captionedSupported = captionCheck.ok || captionCheck.status === 405; // 405 means endpoint exists but HEAD not allowed
		} catch {
			captionedSupported = false;
		}

		const latencyMs = Math.round(performance.now() - startTime);

		if (!captionedSupported) {
			const status: KokoroHealthStatus = {
				status: "captioned-unsupported",
				latencyMs,
				message: "Kokoro reachable but /dev/captioned_speech not available",
			};
			probeCache.set(cacheKey, { status, timestamp: now });
			return status;
		}

		const status: KokoroHealthStatus = {
			status: "ok",
			latencyMs,
			message: "Kokoro online with caption support",
		};
		probeCache.set(cacheKey, { status, timestamp: now });
		return status;
	} catch (error) {
		const status: KokoroHealthStatus = {
			status: "unreachable",
			latencyMs: Math.round(performance.now() - startTime),
			message: error instanceof Error ? error.message : String(error),
		};
		probeCache.set(cacheKey, { status, timestamp: now });
		return status;
	}
}

/**
 * Force a fresh probe, bypassing cache.
 */
export async function refreshKokoroHealth(
	baseUrl: string,
	apiKey?: string,
	fetchImpl: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<KokoroHealthStatus> {
	const cacheKey = getCacheKey(baseUrl);
	probeCache.delete(cacheKey);
	return probeKokoroHealth(baseUrl, apiKey, fetchImpl, signal);
}

/**
 * Clear the health probe cache.
 */
export function clearKokoroHealthCache(): void {
	probeCache.clear();
}

/**
 * Check if cached health status is stale (older than TTL).
 */
export function isKokoroHealthStale(baseUrl: string): boolean {
	const cacheKey = getCacheKey(baseUrl);
	const cached = probeCache.get(cacheKey);
	if (!cached) return true;
	return Date.now() - cached.timestamp >= PROBE_CACHE_TTL_MS;
}
