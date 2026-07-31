const SECRET_FIELD_PATTERN =
	/(?:^|[_\-.])(api[_-]?key|auth|authorization|bearer|cookie|credential|csrf|jwt|password|secret|session|token)(?:$|[_\-.])/iu;
const SENSITIVE_HEADERS = new Set([
	"authorization",
	"cookie",
	"proxy-authorization",
	"set-cookie",
	"x-api-key",
	"x-auth-token",
	"x-csrf-token",
]);
const SAFE_HIGH_ENTROPY_FIELDS = new Set(["id", "request_id", "trace_id", "correlation_id", "etag"]);
const SAFE_HIGH_ENTROPY_HEADERS = new Set([
	"content-security-policy",
	"etag",
	"if-none-match",
	"sec-websocket-key",
	"traceparent",
	"x-amzn-trace-id",
	"x-correlation-id",
	"x-request-id",
	"x-trace-id",
]);

export type NetworkSecretKind = "header" | "cookie" | "json" | "form" | "opaque";

export interface NetworkSecretRecord {
	slot: string;
	placeholder: string;
	source: string;
	kind: NetworkSecretKind;
	value: string;
}

export interface NetworkSecretStore {
	put(record: NetworkSecretRecord): void;
}

export interface NetworkRedactionOptions {
	store?: NetworkSecretStore;
	sensitiveFields?: readonly string[];
}

export interface RedactedHeaders {
	headers?: Record<string, string>;
	redactedHeaders: string[];
	secretReferences: string[];
}

export interface RedactedBody {
	text?: string;
	omitted: boolean;
	redactedFields: string[];
	secretReferences: string[];
}

export class InMemoryNetworkSecretStore implements NetworkSecretStore {
	private readonly records = new Map<string, NetworkSecretRecord>();

	put(record: NetworkSecretRecord): void {
		this.records.set(record.slot, { ...record });
	}

	get(slot: string): NetworkSecretRecord | undefined {
		const record = this.records.get(slot);
		return record ? { ...record } : undefined;
	}

	list(): NetworkSecretRecord[] {
		return [...this.records.values()].map((record) => ({ ...record }));
	}
}

export class NetworkRedactor {
	private readonly store: NetworkSecretStore;
	private readonly sensitiveFields: ReadonlySet<string>;

	constructor(options: NetworkRedactionOptions = {}) {
		this.store = options.store ?? new InMemoryNetworkSecretStore();
		this.sensitiveFields = new Set((options.sensitiveFields ?? []).map(normalizeFieldName));
	}

	redactHeaders(headers: Record<string, string> | undefined, sourcePrefix: string): RedactedHeaders {
		if (!headers) return { redactedHeaders: [], secretReferences: [] };
		const redactedHeaders: string[] = [];
		const secretReferences: string[] = [];
		const safeHeaders: Record<string, string> = {};
		for (const [name, value] of Object.entries(headers)) {
			const normalizedName = name.toLowerCase();
			if (normalizedName === "cookie" || normalizedName === "set-cookie") {
				const redacted = this.redactCookieHeader(value, `${sourcePrefix}.${normalizedName}`, normalizedName);
				safeHeaders[name] = redacted.value;
				secretReferences.push(...redacted.references);
				if (redacted.references.length > 0) redactedHeaders.push(name);
				continue;
			}
			if (SENSITIVE_HEADERS.has(normalizedName) || this.isSensitiveField(normalizedName)) {
				const reference = this.storeSecret(`${sourcePrefix}.${normalizedName}`, "header", value);
				safeHeaders[name] = reference.placeholder;
				redactedHeaders.push(name);
				secretReferences.push(reference.placeholder);
				continue;
			}
			if (normalizedName === "location") {
				const redactedUrl = this.redactUrl(value, `${sourcePrefix}.location`);
				safeHeaders[name] = redactedUrl.url;
				secretReferences.push(...redactedUrl.secretReferences);
				if (redactedUrl.secretReferences.length > 0) redactedHeaders.push(name);
				continue;
			}
			if (!SAFE_HIGH_ENTROPY_HEADERS.has(normalizedName) && looksLikeOpaqueCredential(value)) {
				const reference = this.storeSecret(`${sourcePrefix}.${normalizedName}`, "opaque", value);
				safeHeaders[name] = reference.placeholder;
				redactedHeaders.push(name);
				secretReferences.push(reference.placeholder);
				continue;
			}
			safeHeaders[name] = value;
		}
		return {
			headers: Object.keys(safeHeaders).length > 0 ? safeHeaders : undefined,
			redactedHeaders,
			secretReferences: unique(secretReferences),
		};
	}

	redactUrl(
		value: string,
		sourcePrefix: string,
	): { url: string; redactedFields: string[]; secretReferences: string[] } {
		let parsed: URL;
		try {
			parsed = new URL(value);
		} catch {
			return { url: "<omitted-invalid-url>", redactedFields: [], secretReferences: [] };
		}
		const redactedFields: string[] = [];
		const secretReferences: string[] = [];
		if (parsed.username) {
			const reference = this.storeSecret(`${sourcePrefix}.username`, "opaque", parsed.username);
			parsed.username = reference.placeholder;
			redactedFields.push(`${sourcePrefix}.username`);
			secretReferences.push(reference.placeholder);
		}
		if (parsed.password) {
			const reference = this.storeSecret(`${sourcePrefix}.password`, "opaque", parsed.password);
			parsed.password = reference.placeholder;
			redactedFields.push(`${sourcePrefix}.password`);
			secretReferences.push(reference.placeholder);
		}
		const query = new URLSearchParams();
		for (const [name, entry] of parsed.searchParams) {
			if (isSensitiveUrlParameter(name) || this.shouldRedactField(name, entry)) {
				const path = `${sourcePrefix}.query.${name}`;
				const reference = this.storeSecret(path, "opaque", entry);
				query.append(name, reference.placeholder);
				redactedFields.push(path);
				secretReferences.push(reference.placeholder);
			} else {
				query.append(name, entry);
			}
		}
		parsed.search = query.toString();
		parsed.hash = "";
		return {
			url: parsed.toString(),
			redactedFields,
			secretReferences: unique(secretReferences),
		};
	}

	redactBody(body: string | undefined, contentType: string | undefined, sourcePrefix: string): RedactedBody {
		if (body === undefined) return { omitted: false, redactedFields: [], secretReferences: [] };
		const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
		if (mediaType === "application/json" || mediaType?.endsWith("+json")) {
			return this.redactJson(body, sourcePrefix);
		}
		if (mediaType === "application/graphql+json") return this.redactJson(body, sourcePrefix);
		if (mediaType === "application/x-www-form-urlencoded") return this.redactForm(body, sourcePrefix);
		return { omitted: true, redactedFields: [], secretReferences: [] };
	}

	private redactJson(body: string, sourcePrefix: string): RedactedBody {
		let parsed: unknown;
		try {
			parsed = JSON.parse(body) as unknown;
		} catch {
			return { omitted: true, redactedFields: [], secretReferences: [] };
		}
		if (parsed === null || typeof parsed !== "object") {
			return { omitted: true, redactedFields: [], secretReferences: [] };
		}
		const redactedFields: string[] = [];
		const secretReferences: string[] = [];
		const walk = (value: unknown, path: string, fieldName?: string): unknown => {
			if (fieldName && this.shouldRedactField(fieldName, value)) {
				const reference = this.storeSecret(path, "json", serializeSecretValue(value));
				redactedFields.push(path);
				secretReferences.push(reference.placeholder);
				return reference.placeholder;
			}
			if (Array.isArray(value)) return value.map((entry, index) => walk(entry, `${path}[${index}]`));
			if (value && typeof value === "object") {
				return Object.fromEntries(
					Object.entries(value).map(([key, entry]) => [key, walk(entry, `${path}.${key}`, key)]),
				);
			}
			return value;
		};
		return {
			text: JSON.stringify(walk(parsed, sourcePrefix)),
			omitted: false,
			redactedFields,
			secretReferences: unique(secretReferences),
		};
	}

	private redactForm(body: string, sourcePrefix: string): RedactedBody {
		const params = new URLSearchParams(body);
		const redactedFields: string[] = [];
		const secretReferences: string[] = [];
		const output = new URLSearchParams();
		for (const [name, value] of params) {
			if (this.shouldRedactField(name, value)) {
				const path = `${sourcePrefix}.${name}`;
				const reference = this.storeSecret(path, "form", value);
				output.append(name, reference.placeholder);
				redactedFields.push(path);
				secretReferences.push(reference.placeholder);
			} else {
				output.append(name, value);
			}
		}
		return {
			text: output.toString(),
			omitted: false,
			redactedFields,
			secretReferences: unique(secretReferences),
		};
	}

	private redactCookieHeader(
		value: string,
		sourcePrefix: string,
		kind: "cookie" | "set-cookie",
	): { value: string; references: string[] } {
		const references: string[] = [];
		if (kind === "set-cookie") {
			const reference = this.storeSecret(sourcePrefix, "cookie", value);
			return { value: reference.placeholder, references: [reference.placeholder] };
		}
		const pairs = value.split(";").map((part) => part.trim());
		const redacted = pairs.map((pair, index) => {
			const separator = pair.indexOf("=");
			const name = separator > 0 ? pair.slice(0, separator).trim() : `cookie_${index}`;
			const secret = separator > 0 ? pair.slice(separator + 1) : pair;
			const reference = this.storeSecret(`${sourcePrefix}.${name}`, "cookie", secret);
			references.push(reference.placeholder);
			return separator > 0 ? `${name}=${reference.placeholder}` : reference.placeholder;
		});
		return { value: redacted.join("; "), references };
	}

	private shouldRedactField(fieldName: string, value: unknown): boolean {
		const normalized = normalizeFieldName(fieldName);
		if (this.isSensitiveField(normalized)) return true;
		if (SAFE_HIGH_ENTROPY_FIELDS.has(normalized)) return false;
		return typeof value === "string" && looksLikeOpaqueCredential(value);
	}

	private isSensitiveField(fieldName: string): boolean {
		const normalized = normalizeFieldName(fieldName);
		return this.sensitiveFields.has(normalized) || SECRET_FIELD_PATTERN.test(normalized);
	}

	private storeSecret(source: string, kind: NetworkSecretKind, value: string): NetworkSecretRecord {
		const slot = stableSecretSlot(source);
		const record = {
			slot,
			placeholder: `{{shuvgeist-secret:${slot}}}`,
			source,
			kind,
			value,
		};
		this.store.put(record);
		return record;
	}
}

export function stableSecretSlot(source: string): string {
	const normalized = source.trim().toLowerCase();
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < normalized.length; index++) {
		const code = normalized.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193);
		second = Math.imul(second ^ code, 0x85ebca6b);
	}
	return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function looksLikeOpaqueCredential(value: string): boolean {
	if (value.length < 20 || /\s/u.test(value)) return false;
	const classes = [/[a-z]/u.test(value), /[A-Z]/u.test(value), /[0-9]/u.test(value), /[-_+/=.]/u.test(value)].filter(
		Boolean,
	).length;
	if (classes < 2) return false;
	const counts = new Map<string, number>();
	for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
	let entropy = 0;
	for (const count of counts.values()) {
		const probability = count / value.length;
		entropy -= probability * Math.log2(probability);
	}
	return entropy >= 3.5;
}

function serializeSecretValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function normalizeFieldName(value: string): string {
	return value
		.trim()
		.replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
		.toLowerCase()
		.replaceAll(" ", "_");
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function isSensitiveUrlParameter(value: string): boolean {
	const normalized = normalizeFieldName(value);
	return ["code", "key", "oauth_code", "sig", "signature", "signed"].includes(normalized);
}
