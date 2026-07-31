import type {
	AuthenticatedJsonInjectionRequest,
	AuthenticatedJsonInjectionResult,
	AuthenticatedJsonMethod,
} from "./injected/contracts.js";
import type { PageDriverScope } from "./page-driver-identity.js";

export interface AuthenticatedJsonRequest {
	path: string;
	method?: AuthenticatedJsonMethod;
	body?: unknown;
	timeoutMs?: number;
	maxResponseBytes?: number;
	reviewMutation?: boolean;
	schema?: Record<string, unknown>;
	signal?: AbortSignal;
}

export interface AuthenticatedJsonResult {
	scope: PageDriverScope;
	result:
		| AuthenticatedJsonInjectionResult
		| {
				success: false;
				code: "schema_validation_failed";
				message: string;
				issues: string[];
		  };
}

export function normalizeAuthenticatedJsonRequest(
	request: AuthenticatedJsonRequest,
	token: string,
): AuthenticatedJsonInjectionRequest {
	const path = request.path.trim();
	if (!path || path.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(path)) {
		throw new Error("Authenticated JSON requests require a relative path, not an absolute or protocol-relative URL.");
	}
	const method = request.method ?? "GET";
	if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
		throw new Error(`Unsupported authenticated JSON method '${method}'.`);
	}
	if (method === "GET" && request.body !== undefined) {
		throw new Error("Authenticated JSON GET requests cannot include a body.");
	}
	if (request.body !== undefined) {
		const serializedBody = JSON.stringify(request.body);
		if (new TextEncoder().encode(serializedBody).byteLength > 256_000) {
			throw new Error("Authenticated JSON request body exceeds 256000 bytes.");
		}
	}
	return {
		token,
		path,
		method,
		...(request.body === undefined ? {} : { body: request.body }),
		timeoutMs: boundedInteger(request.timeoutMs, 15_000, 100, 60_000, "timeoutMs"),
		maxResponseBytes: boundedInteger(request.maxResponseBytes, 256_000, 1, 1_048_576, "maxResponseBytes"),
		reviewMutation: request.reviewMutation === true,
	};
}

export function validateAuthenticatedJsonData(data: unknown, schema: Record<string, unknown> | undefined): string[] {
	if (!schema) return [];
	const issues: string[] = [];
	let nodes = 0;
	const visit = (value: unknown, rule: Record<string, unknown>, path: string, depth: number): void => {
		if (issues.length >= 10) return;
		nodes += 1;
		if (nodes > 100 || depth > 8) {
			issues.push(`${path}: schema validation budget exceeded`);
			return;
		}
		const type = typeof rule.type === "string" ? rule.type : undefined;
		if (type && !matchesJsonType(value, type)) {
			issues.push(`${path}: expected ${type}, received ${jsonType(value)}`);
			return;
		}
		if (
			Array.isArray(rule.enum) &&
			!rule.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))
		) {
			issues.push(`${path}: value was not in the declared enum`);
			return;
		}
		if (type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
			const record = value as Record<string, unknown>;
			const required = Array.isArray(rule.required)
				? rule.required.filter((entry): entry is string => typeof entry === "string")
				: [];
			for (const field of required) {
				if (!Object.hasOwn(record, field)) issues.push(`${path}.${field}: required property is missing`);
				if (issues.length >= 10) return;
			}
			const properties = asRecord(rule.properties);
			if (properties) {
				for (const [field, childRule] of Object.entries(properties)) {
					if (!Object.hasOwn(record, field)) continue;
					const normalizedRule = asRecord(childRule);
					if (!normalizedRule) {
						issues.push(`${path}.${field}: declared property schema must be an object`);
						continue;
					}
					visit(record[field], normalizedRule, `${path}.${field}`, depth + 1);
				}
			}
		}
		if (type === "array" && Array.isArray(value) && rule.items !== undefined) {
			const itemRule = asRecord(rule.items);
			if (!itemRule) {
				issues.push(`${path}: declared items schema must be an object`);
				return;
			}
			for (let index = 0; index < value.length && issues.length < 10; index++) {
				visit(value[index], itemRule, `${path}[${index}]`, depth + 1);
			}
		}
	};
	visit(data, schema, "$", 0);
	return issues.slice(0, 10);
}

function matchesJsonType(value: unknown, type: string): boolean {
	switch (type) {
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			return value !== null && typeof value === "object" && !Array.isArray(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "number":
		case "string":
		case "boolean":
			return typeof value === type;
		default:
			return false;
	}
}

function jsonType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function boundedInteger(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	name: string,
): number {
	const candidate = value ?? fallback;
	if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
		throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
	}
	return candidate;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
