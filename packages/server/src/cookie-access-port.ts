/** Node-side cookie import planning for the bridge server. */
import { readFileSync } from "node:fs";

export interface CookieImportRequest {
	sourcePath: string;
	siteUrl: string;
	consent: boolean;
}

export interface ImportedCookie {
	url: string;
	name: string;
	value: string;
	domain: string;
	path: string;
	secure: boolean;
	httpOnly: boolean;
	expirationDate?: number;
}

export interface CookieImportPlan {
	siteUrl: string;
	sourcePath: string;
	cookies: ImportedCookie[];
}

export class CookieAccessPort {
	planImport(request: CookieImportRequest): CookieImportPlan {
		if (!request.consent) {
			throw new Error("Cookie import requires explicit per-site consent.");
		}
		const site = new URL(request.siteUrl);
		const cookies = parseNetscapeCookieFile(readFileSync(request.sourcePath, "utf-8")).filter((cookie) =>
			domainMatchesSite(cookie.domain, site.hostname),
		);
		return { sourcePath: request.sourcePath, siteUrl: request.siteUrl, cookies };
	}
}

export function parseNetscapeCookieFile(contents: string): ImportedCookie[] {
	const cookies: ImportedCookie[] = [];
	for (const line of contents.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("#HttpOnly_"))) continue;
		const httpOnly = trimmed.startsWith("#HttpOnly_");
		const fields = (httpOnly ? trimmed.slice("#HttpOnly_".length) : trimmed).split("\t");
		if (fields.length < 7) continue;
		const [rawDomain, , rawPath, rawSecure, rawExpires, name, value] = fields;
		if (!rawDomain || !rawPath || !name) continue;
		const domain = rawDomain.toLowerCase();
		const secure = rawSecure.toUpperCase() === "TRUE";
		const expiration = Number.parseInt(rawExpires, 10);
		const host = domain.startsWith(".") ? domain.slice(1) : domain;
		const scheme = secure ? "https" : "http";
		cookies.push({
			url: scheme + "://" + host + rawPath,
			name,
			value,
			domain,
			path: rawPath,
			secure,
			httpOnly,
			...(Number.isFinite(expiration) && expiration > 0 ? { expirationDate: expiration } : {}),
		});
	}
	return cookies;
}

function domainMatchesSite(cookieDomain: string, hostname: string): boolean {
	const normalizedCookieDomain = cookieDomain.replace(/^\./u, "").toLowerCase();
	const normalizedHost = hostname.toLowerCase();
	return normalizedHost === normalizedCookieDomain || normalizedHost.endsWith("." + normalizedCookieDomain);
}
