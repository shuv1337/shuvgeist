import type { AuthenticatedJsonInjectionRequest, AuthenticatedJsonInjectionResult } from "./contracts.js";

const SAFE_METHODS = new Set(["GET"]);
const CONTROLLER_KEY = "__SHUVGEIST_AUTHENTICATED_JSON_CONTROLLERS__";

interface AuthenticatedJsonGlobal {
	[CONTROLLER_KEY]?: Map<string, AbortController>;
}

export async function run(request: AuthenticatedJsonInjectionRequest): Promise<AuthenticatedJsonInjectionResult> {
	const pageOrigin = window.location.origin;
	if (!/^https?:\/\//u.test(pageOrigin)) {
		return { success: false, code: "invalid_page_origin", message: "The selected page is not an HTTP(S) origin." };
	}
	if (!isRelativePath(request.path)) {
		return {
			success: false,
			code: "invalid_relative_path",
			message: "Authenticated JSON requests require a relative path.",
		};
	}
	const url = new URL(request.path, window.location.href);
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== pageOrigin) {
		return {
			success: false,
			code: "cross_origin",
			message: "The request path does not resolve to the selected page origin.",
		};
	}
	const mutation = !SAFE_METHODS.has(request.method);
	if (mutation && !request.reviewMutation) {
		return {
			success: false,
			code: "mutation_review_required",
			message: `Mutating ${request.method} requests require explicit review.`,
		};
	}

	const controller = new AbortController();
	const scope = globalThis as typeof globalThis & AuthenticatedJsonGlobal;
	const controllers = scope[CONTROLLER_KEY] ?? new Map<string, AbortController>();
	scope[CONTROLLER_KEY] = controllers;
	controllers.set(request.token, controller);
	let timedOut = false;
	const timeout = window.setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, request.timeoutMs);
	try {
		const response = await window.fetch(url.href, {
			method: request.method,
			credentials: "same-origin",
			cache: "no-store",
			redirect: "manual",
			signal: controller.signal,
			headers:
				request.body === undefined
					? { Accept: "application/json" }
					: {
							Accept: "application/json",
							"Content-Type": "application/json",
						},
			...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
		});
		if (
			response.redirected ||
			response.type === "opaqueredirect" ||
			(response.status >= 300 && response.status < 400)
		) {
			return {
				success: false,
				code: "redirect_rejected",
				message: "Authenticated JSON requests do not follow redirects.",
				status: response.status || undefined,
			};
		}
		if (response.url && new URL(response.url).origin !== pageOrigin) {
			return {
				success: false,
				code: "cross_origin",
				message: "The response URL left the selected page origin.",
			};
		}
		if (!response.ok) {
			return {
				success: false,
				code: "http_error",
				message: `Authenticated JSON request failed with HTTP ${response.status}.`,
				status: response.status,
			};
		}
		const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
		if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
			return {
				success: false,
				code: "non_json_response",
				message: "Authenticated JSON response did not declare a JSON content type.",
				status: response.status,
			};
		}
		const bytes = await readBoundedBody(response, request.maxResponseBytes, controller);
		if (!bytes.ok) return bytes.failure;
		let data: unknown;
		try {
			data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.value)) as unknown;
		} catch {
			return {
				success: false,
				code: "invalid_json_response",
				message: "Authenticated JSON response was not valid UTF-8 JSON.",
				status: response.status,
			};
		}
		return {
			success: true,
			status: response.status,
			origin: pageOrigin,
			path: `${url.pathname}${url.search}`,
			method: request.method,
			mutation,
			responseBytes: bytes.value.byteLength,
			data,
		};
	} catch (error) {
		if (controller.signal.aborted) {
			return {
				success: false,
				code: timedOut ? "request_timed_out" : "request_aborted",
				message: timedOut ? "Authenticated JSON request timed out." : "Authenticated JSON request was aborted.",
			};
		}
		return {
			success: false,
			code: "http_error",
			message: error instanceof Error ? `Authenticated JSON request failed: ${error.name}.` : "Request failed.",
		};
	} finally {
		window.clearTimeout(timeout);
		controllers.delete(request.token);
		if (controllers.size === 0) delete scope[CONTROLLER_KEY];
	}
}

function isRelativePath(path: string): boolean {
	if (!path.trim() || path.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(path)) return false;
	try {
		const parsed = new URL(path, "https://relative.invalid/base");
		return parsed.origin === "https://relative.invalid" && !parsed.username && !parsed.password;
	} catch {
		return false;
	}
}

async function readBoundedBody(
	response: Response,
	maxBytes: number,
	controller: AbortController,
): Promise<{ ok: true; value: Uint8Array } | { ok: false; failure: AuthenticatedJsonInjectionResult }> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		controller.abort();
		return {
			ok: false,
			failure: {
				success: false,
				code: "response_too_large",
				message: `Authenticated JSON response exceeded ${maxBytes} bytes.`,
				status: response.status,
			},
		};
	}
	if (!response.body) return { ok: true, value: new Uint8Array() };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > maxBytes) {
				controller.abort();
				return {
					ok: false,
					failure: {
						success: false,
						code: "response_too_large",
						message: `Authenticated JSON response exceeded ${maxBytes} bytes.`,
						status: response.status,
					},
				};
			}
			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}
	const value = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		value.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, value };
}
