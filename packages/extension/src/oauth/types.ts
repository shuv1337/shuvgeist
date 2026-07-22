export interface OAuthCredentials {
	providerId: string;
	access: string;
	refresh: string;
	expires: number;
	accountId?: string;
	projectId?: string;
}

export interface ApiKeyProviderCredential {
	kind: "api-key";
	value: string;
}

export interface OAuthProviderCredential {
	kind: "oauth";
	credentials: OAuthCredentials;
}

export interface FreeTierProviderCredential {
	kind: "free-tier";
	value: string;
}

export type ProviderCredential = ApiKeyProviderCredential | OAuthProviderCredential | FreeTierProviderCredential;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isOAuthCredentialsObject(value: unknown): value is OAuthCredentials {
	return (
		isRecord(value) &&
		typeof value.providerId === "string" &&
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number"
	);
}

export function parseProviderCredential(value: string): ProviderCredential {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return { kind: "api-key", value };
	}

	if (!isRecord(parsed)) {
		return { kind: "api-key", value };
	}

	if (parsed.kind === "oauth" && isOAuthCredentialsObject(parsed.credentials)) {
		return { kind: "oauth", credentials: parsed.credentials };
	}

	if (parsed.kind === "api-key" && typeof parsed.value === "string") {
		return { kind: "api-key", value: parsed.value };
	}

	if (parsed.kind === "free-tier" && typeof parsed.value === "string") {
		return { kind: "free-tier", value: parsed.value };
	}

	if (isOAuthCredentialsObject(parsed)) {
		return { kind: "oauth", credentials: parsed };
	}

	return { kind: "api-key", value };
}

export function isOAuthCredentials(value: string): boolean {
	return parseProviderCredential(value).kind === "oauth";
}

export function parseOAuthCredentials(value: string): OAuthCredentials {
	const credential = parseProviderCredential(value);
	if (credential.kind !== "oauth") {
		throw new Error("Stored provider credential is not OAuth credentials");
	}
	return credential.credentials;
}

export function serializeOAuthCredentials(credentials: OAuthCredentials): string {
	return JSON.stringify({ kind: "oauth", credentials } satisfies OAuthProviderCredential);
}

export function serializeFreeTierCredential(value: string): string {
	return JSON.stringify({ kind: "free-tier", value } satisfies FreeTierProviderCredential);
}
