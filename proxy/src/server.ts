/**
 * Sitegeist CORS Proxy
 *
 * Forwards browser extension requests to upstream provider endpoints that
 * enforce CORS restrictions. Supports the Sitegeist contract:
 *
 *   GET|POST|OPTIONS /?url=<encoded-target-url>
 *
 * Also handles a path-based fallback for document extraction:
 *
 *   GET /<encoded-target-url>
 *
 * Upstream traffic is restricted to an allowlist of known hosts. Credentials
 * and request bodies are never logged.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import {
	addCorsHeaders,
	clientIp,
	createRateLimiter,
	filterRequestHeaders,
	filterResponseHeaders,
	loadConfig,
	parseTargetUrl,
	type ProxyConfig,
} from "./helpers.js";

// ============================================================================
// STRUCTURED LOGGING
// ============================================================================

type LogLevel = "info" | "warn" | "error";

interface LogEntry {
	level: LogLevel;
	time: string;
	event: string;
	reqId?: string;
	method?: string;
	upstreamHost?: string;
	status?: number;
	durationMs?: number;
	error?: string;
	// Startup fields
	port?: number;
	allowedHosts?: readonly string[];
	authRequired?: boolean;
	rateLimitRpm?: number;
}

function log(entry: LogEntry): void {
	// NEVER include: Authorization headers, request/response bodies, or full URLs
	// with query strings — only the upstream hostname is logged.
	process.stdout.write(JSON.stringify(entry) + "\n");
}

function makeReqId(): string {
	return Math.random().toString(36).slice(2, 10);
}

export interface ProxyServerDependencies {
	fetchImpl?: typeof fetch;
	log?: (entry: LogEntry) => void;
	now?: () => number;
	makeReqId?: () => string;
}

// ============================================================================
// EXPRESS APP
// ============================================================================

export function createProxyApp(
	config: ProxyConfig = loadConfig(),
	deps: ProxyServerDependencies = {},
) {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const logEntry = deps.log ?? log;
	const now = deps.now ?? (() => Date.now());
	const nextReqId = deps.makeReqId ?? makeReqId;
	const isRateLimited = createRateLimiter(config.rateLimitRpm);
	const app = express();

	// Parse raw request bodies for all content types so we can forward bytes
	// verbatim to the upstream without re-encoding.
	app.use(
		express.raw({
			type: () => true,
			limit: config.maxBodySize,
		}),
	);

	// ============================================================================
	// HEALTH CHECK
	// ============================================================================

	app.get("/health", (_req: Request, res: Response) => {
		res.json({
			status: "ok",
			allowedHosts: config.allowedHosts,
			rateLimitRpm: config.rateLimitRpm,
			authRequired: config.proxySecret !== null,
		});
	});

	// ============================================================================
	// PROXY HANDLER
	// ============================================================================

	app.use(async (req: Request, res: Response, _next: NextFunction) => {
		const reqId = nextReqId();
		const startMs = now();

		// CORS headers on every response, including error responses.
		addCorsHeaders(res);

		// Preflight: respond immediately without touching the upstream.
		if (req.method === "OPTIONS") {
			res.status(204).end();
			return;
		}

		// ---- Rate limiting -------------------------------------------------------

		const ip = clientIp(req);
		if (isRateLimited(ip)) {
			logEntry({
				level: "warn",
				time: new Date().toISOString(),
				event: "rate_limited",
				reqId,
				method: req.method,
				upstreamHost: "n/a",
				status: 429,
			});
			res.status(429).json({ error: "Rate limit exceeded. Try again later." });
			return;
		}

		// ---- Auth ----------------------------------------------------------------

		if (config.proxySecret !== null) {
			const provided = req.headers["x-proxy-secret"];
			if (provided !== config.proxySecret) {
				logEntry({
					level: "warn",
					time: new Date().toISOString(),
					event: "auth_failed",
					reqId,
					method: req.method,
					upstreamHost: "n/a",
					status: 401,
				});
				res.status(401).json({ error: "Unauthorized. Provide a valid X-Proxy-Secret header." });
				return;
			}
		}

		// ---- Target URL ----------------------------------------------------------

		const rawUrl = parseTargetUrl(req);
		if (rawUrl === null) {
			res.status(400).json({
				error: "Missing target URL. Use /?url=<encoded-url> or /<url>.",
			});
			return;
		}

		let targetUrl: URL;
		try {
			targetUrl = new URL(rawUrl);
		} catch {
			res.status(400).json({ error: "Invalid target URL — must be an absolute http/https URL." });
			return;
		}

		if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
			res.status(400).json({ error: "Only http and https target URLs are supported." });
			return;
		}

		// ---- Allowlist -----------------------------------------------------------

		if (!config.allowedHosts.includes(targetUrl.hostname)) {
			logEntry({
				level: "warn",
				time: new Date().toISOString(),
				event: "host_blocked",
				reqId,
				method: req.method,
				// Log the host — it is not sensitive; full URL and query string are not logged.
				upstreamHost: targetUrl.hostname,
				status: 403,
			});
			res.status(403).json({
				error: `Upstream host not allowed: ${targetUrl.hostname}`,
				allowedHosts: config.allowedHosts,
			});
			return;
		}

		// ---- Forward request -----------------------------------------------------

		const forwardHeaders = filterRequestHeaders(
			req.headers as Record<string, string | string[] | undefined>,
		);

		// Only attach a body for methods that semantically carry one.
		// Express raw() gives us a Buffer. Node's fetch BodyInit type (via lib.dom.d.ts)
		// requires ArrayBufferView<ArrayBuffer> — Buffer's backing .buffer is ArrayBufferLike,
		// so we extract a proper ArrayBuffer slice to satisfy the type checker without
		// any unsafe cast.
		const methodHasBody = !["GET", "HEAD", "OPTIONS"].includes(req.method);
		const body: ArrayBuffer | undefined = (() => {
			if (!methodHasBody) return undefined;
			const raw = req.body as Buffer | undefined;
			if (!Buffer.isBuffer(raw) || raw.length === 0) return undefined;
			// raw.buffer is the shared Node pool buffer; slice to get only our bytes.
			return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
		})();

		const controller = new AbortController();
		const timeoutHandle = setTimeout(() => controller.abort(), config.requestTimeoutMs);

		try {
			const upstream = await fetchImpl(targetUrl.toString(), {
				method: req.method,
				headers: forwardHeaders,
				body,
				signal: controller.signal,
				// Redirect: follow by default so the client always receives a final response.
				redirect: "follow",
			});

			clearTimeout(timeoutHandle);

			const durationMs = now() - startMs;

			logEntry({
				level: "info",
				time: new Date().toISOString(),
				event: "proxy_ok",
				reqId,
				method: req.method,
				upstreamHost: targetUrl.hostname,
				status: upstream.status,
				durationMs,
			});

			// Write status and filtered headers.
			res.status(upstream.status);
			const responseHeaders = filterResponseHeaders(upstream.headers);
			for (const [key, value] of Object.entries(responseHeaders)) {
				res.setHeader(key, value);
			}

			// Stream the response body back to the client. This ensures that
			// server-sent event streams and large payloads are not fully buffered
			// in this proxy process.
			if (upstream.body === null) {
				res.end();
				return;
			}

			const reader = upstream.body.getReader();

			const pump = async (): Promise<void> => {
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) {
							res.end();
							break;
						}
						// Respect backpressure: wait for the client socket to drain before
						// reading the next chunk to avoid unbounded memory growth.
						if (!res.write(value)) {
							await new Promise<void>((resolve) => res.once("drain", resolve));
						}
					}
				} catch {
					reader.cancel().catch(() => {});
					if (!res.writableEnded) {
						res.end();
					}
				}
			};

			void pump();
		} catch (err: unknown) {
			clearTimeout(timeoutHandle);

			const durationMs = now() - startMs;
			const isTimeout = err instanceof Error && err.name === "AbortError";
			const errorMessage = err instanceof Error ? err.message : String(err);

			logEntry({
				level: "error",
				time: new Date().toISOString(),
				event: isTimeout ? "upstream_timeout" : "upstream_error",
				reqId,
				method: req.method,
				upstreamHost: targetUrl.hostname,
				status: isTimeout ? 504 : 502,
				durationMs,
				// Safe to log: error message describes the network failure, not a secret.
				error: isTimeout ? "Request timed out" : errorMessage,
			});

			if (!res.headersSent) {
				if (isTimeout) {
					res.status(504).json({ error: "Upstream request timed out." });
				} else {
					res.status(502).json({ error: "Upstream request failed.", detail: errorMessage });
				}
			}
		}
	});

	// ============================================================================
	// ERROR HANDLER — catches body-parser overflows and unhandled middleware errors
	// ============================================================================

	// Express requires the 4-argument signature to recognise an error handler.
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	app.use((err: Error & { type?: string; status?: number }, _req: Request, res: Response, _next: NextFunction) => {
		if (err.type === "entity.too.large") {
			res.status(413).json({ error: "Request body exceeds the configured size limit." });
			return;
		}
		logEntry({
			level: "error",
			time: new Date().toISOString(),
			event: "unhandled_middleware_error",
			error: err.message,
		});
		if (!res.headersSent) {
			res.status(500).json({ error: "Internal proxy error." });
		}
	});

	return app;
}

// ============================================================================
// START
// ============================================================================

let app: ReturnType<typeof createProxyApp> | undefined;
let server: ReturnType<ReturnType<typeof createProxyApp>["listen"]> | undefined;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const config = loadConfig();
	app = createProxyApp(config);
	server = app.listen(config.port, () => {
		log({
			level: "info",
			time: new Date().toISOString(),
			event: "server_start",
			port: config.port,
			allowedHosts: config.allowedHosts,
			authRequired: config.proxySecret !== null,
			rateLimitRpm: config.rateLimitRpm,
		});
	});
}

export { app, server };
