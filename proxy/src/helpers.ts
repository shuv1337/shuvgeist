export const DEFAULT_ALLOWED_HOSTS = [
	"platform.claude.com",
	"api.anthropic.com",
	"github.com",
	"api.z.ai",
	"chatgpt.com",
] as const;

export interface ProxyConfig {
	readonly port: number;
	readonly allowedHosts: readonly string[];
	readonly proxySecret: string | null;
	readonly rateLimitRpm: number;
	readonly maxBodySize: string;
	readonly requestTimeoutMs: number;
}

export interface ResponseLike {
	setHeader(name: string, value: string): void;
}

export interface RequestLike {
	query: Record<string, unknown>;
	path: string;
	headers: Record<string, string | string[] | undefined>;
	socket: { remoteAddress?: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
	const allowedHosts =
		env.ALLOWED_HOSTS != null && env.ALLOWED_HOSTS.trim() !== ""
			? env.ALLOWED_HOSTS.split(",")
					.map((host) => host.trim())
					.filter(Boolean)
			: DEFAULT_ALLOWED_HOSTS;

	const proxySecret = env.PROXY_SECRET != null && env.PROXY_SECRET.trim() !== "" ? env.PROXY_SECRET.trim() : null;

	return {
		port: Number.parseInt(env.PORT ?? "3001", 10),
		allowedHosts,
		proxySecret,
		rateLimitRpm: Number.parseInt(env.RATE_LIMIT_RPM ?? "300", 10),
		maxBodySize: env.MAX_BODY_SIZE ?? "10mb",
		requestTimeoutMs: Number.parseInt(env.REQUEST_TIMEOUT_MS ?? "120000", 10),
	};
}

export const CORS_ALLOW_HEADERS = [
	"Authorization",
	"Content-Type",
	"Accept",
	"User-Agent",
	"X-Api-Key",
	"X-Proxy-Secret",
	"Copilot-Integration-Id",
	"Editor-Version",
	"Editor-Plugin-Version",
	"Anthropic-Version",
	"Anthropic-Beta",
	"OpenAI-Organization",
].join(", ");

export function addCorsHeaders(res: ResponseLike): void {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
	res.setHeader("Access-Control-Max-Age", "86400");
}

const FORWARD_REQUEST_HEADERS = new Set([
	"authorization",
	"content-type",
	"accept",
	"accept-language",
	"user-agent",
	"x-api-key",
	"copilot-integration-id",
	"editor-version",
	"editor-plugin-version",
	"anthropic-version",
	"anthropic-beta",
	"openai-organization",
]);

const STRIP_RESPONSE_HEADERS = new Set([
	"access-control-allow-origin",
	"access-control-allow-methods",
	"access-control-allow-headers",
	"access-control-allow-credentials",
	"access-control-expose-headers",
	"access-control-max-age",
	"content-encoding",
	"content-length",
	"transfer-encoding",
]);

export function filterRequestHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		if (!FORWARD_REQUEST_HEADERS.has(key.toLowerCase())) continue;
		out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
	}
	return out;
}

export function filterResponseHeaders(upstream: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	upstream.forEach((value, key) => {
		if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
			out[key] = value;
		}
	});
	return out;
}

interface RateLimitWindow {
	count: number;
	windowStart: number;
}

const RATE_WINDOW_MS = 60_000;

export function createRateLimiter(rateLimitRpm: number): (ip: string) => boolean {
	const rateLimitStore = new Map<string, RateLimitWindow>();
	setInterval(() => {
		const now = Date.now();
		for (const [ip, entry] of rateLimitStore) {
			if (now - entry.windowStart >= RATE_WINDOW_MS) {
				rateLimitStore.delete(ip);
			}
		}
	}, RATE_WINDOW_MS).unref();

	return (ip: string): boolean => {
		const now = Date.now();
		const entry = rateLimitStore.get(ip);

		if (entry === undefined || now - entry.windowStart >= RATE_WINDOW_MS) {
			rateLimitStore.set(ip, { count: 1, windowStart: now });
			return false;
		}

		if (entry.count >= rateLimitRpm) {
			return true;
		}

		entry.count++;
		return false;
	};
}

export function clientIp(req: Pick<RequestLike, "headers" | "socket">): string {
	const forwarded = req.headers["x-forwarded-for"];
	if (typeof forwarded === "string" && forwarded.trim() !== "") {
		return forwarded.split(",")[0]?.trim() ?? "unknown";
	}
	return req.socket.remoteAddress ?? "unknown";
}

export function parseTargetUrl(req: Pick<RequestLike, "query" | "path">): string | null {
	const urlParam = req.query.url;
	if (typeof urlParam === "string" && urlParam.trim() !== "") {
		return urlParam;
	}

	const rawPath = req.path;
	if (rawPath.length > 1) {
		const candidate = rawPath.slice(1);
		if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
			return candidate;
		}
		try {
			const decoded = decodeURIComponent(candidate);
			if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
				return decoded;
			}
		} catch {
			return null;
		}
	}

	return null;
}
