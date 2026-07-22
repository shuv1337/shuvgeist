export const SIDEPANEL_DOCUMENT_NONCE_PARAM = "shuvgeistContext";
export const SIDEPANEL_WINDOW_PREPARE_MESSAGE_TYPE = "sidepanel-prepare-window";
export const SIDEPANEL_WINDOW_CONFIRM_MESSAGE_TYPE = "sidepanel-confirm-window";
export const AGENT_RUNTIME_PORT_PREFIX = "agent-runtime";
export const SIDEPANEL_TRACKING_PORT_PREFIX = "sidepanel";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTINUATION_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const SIDEPANEL_ROUTE_QUERY_KEYS = [
	SIDEPANEL_DOCUMENT_NONCE_PARAM,
	"session",
	"new",
	"teststeps",
	"provider",
	"model",
] as const;
const SIDEPANEL_ROUTE_QUERY_KEY_SET = new Set<string>(SIDEPANEL_ROUTE_QUERY_KEYS);
const MAX_DEBUG_STEPS_QUERY_LENGTH = 128 * 1024;
const MAX_DEBUG_STEP_COUNT = 128;
const MAX_DEBUG_STEP_LENGTH = 32 * 1024;
const MAX_DEBUG_MODEL_PART_LENGTH = 256;
const ROUTE_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export function isSidepanelDocumentNonce(value: unknown): value is string {
	return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

export function isSidepanelContinuationToken(value: unknown): value is string {
	return typeof value === "string" && CONTINUATION_TOKEN_PATTERN.test(value);
}

export function isSidepanelCapabilityId(value: unknown): value is string {
	return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function boundedCanonicalRouteText(value: string, maxLength: number): boolean {
	return (
		value.length > 0 &&
		value.length <= maxLength &&
		value === value.trim() &&
		!ROUTE_CONTROL_CHARACTER_PATTERN.test(value)
	);
}

function isValidDebugSteps(value: string): boolean {
	if (!boundedCanonicalRouteText(value, MAX_DEBUG_STEPS_QUERY_LENGTH)) return false;
	try {
		const parsed: unknown = JSON.parse(decodeURIComponent(value));
		return (
			Array.isArray(parsed) &&
			parsed.length <= MAX_DEBUG_STEP_COUNT &&
			parsed.every((step) => typeof step === "string" && step.length <= MAX_DEBUG_STEP_LENGTH)
		);
	} catch {
		return false;
	}
}

/**
 * Validates the coarse URL exposed by MessageSender/Port.sender. Chrome can
 * freeze this URL at the committed pre-history reload URL, so its nonce is
 * syntax-only; live nonce/capability ownership is joined separately through
 * runtime.getContexts().
 */
export function isCanonicalSidepanelSenderUrl(actualValue: string, expectedValue: string): boolean {
	try {
		const actual = new URL(actualValue);
		const expected = new URL(expectedValue);
		if (
			expected.protocol !== "chrome-extension:" ||
			actual.protocol !== expected.protocol ||
			actual.host !== expected.host ||
			actual.pathname !== expected.pathname ||
			actual.hash !== ""
		) {
			return false;
		}

		for (const key of actual.searchParams.keys()) {
			if (!SIDEPANEL_ROUTE_QUERY_KEY_SET.has(key) || actual.searchParams.getAll(key).length !== 1) return false;
		}

		const nonce = actual.searchParams.get(SIDEPANEL_DOCUMENT_NONCE_PARAM);
		if (nonce !== null && !isSidepanelDocumentNonce(nonce)) return false;
		const session = actual.searchParams.get("session");
		if (session !== null && !isSidepanelCapabilityId(session)) return false;
		const fresh = actual.searchParams.get("new");
		if (fresh !== null && fresh !== "true") return false;
		if (fresh !== null && session !== null) return false;

		const testSteps = actual.searchParams.get("teststeps");
		const provider = actual.searchParams.get("provider");
		const model = actual.searchParams.get("model");
		const debugParts = [testSteps, provider, model];
		const debugPartCount = debugParts.filter((value) => value !== null).length;
		if (debugPartCount !== 0 && debugPartCount !== debugParts.length) return false;
		if (
			testSteps !== null &&
			provider !== null &&
			model !== null &&
			(!isValidDebugSteps(testSteps) ||
				!boundedCanonicalRouteText(provider, MAX_DEBUG_MODEL_PART_LENGTH) ||
				!boundedCanonicalRouteText(model, MAX_DEBUG_MODEL_PART_LENGTH))
		) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

export function sidepanelDocumentNonce(urlValue: string): string | undefined {
	try {
		const values = new URL(urlValue).searchParams.getAll(SIDEPANEL_DOCUMENT_NONCE_PARAM);
		return values.length === 1 && isSidepanelDocumentNonce(values[0]) ? values[0] : undefined;
	} catch {
		return undefined;
	}
}

export interface SidepanelDocumentBootstrapPlan {
	nonce: string;
	url: string;
}

export interface SidepanelCapabilityMaterial {
	continuationToken: string;
	transactionId: string;
	leaseId: string;
}

export interface SidepanelWindowPrepareRequest {
	type: typeof SIDEPANEL_WINDOW_PREPARE_MESSAGE_TYPE;
	nonce: string;
	proof?: SidepanelCapabilityMaterial;
}

export interface SidepanelWindowConfirmRequest extends SidepanelCapabilityMaterial {
	type: typeof SIDEPANEL_WINDOW_CONFIRM_MESSAGE_TYPE;
	nonce: string;
}

export type SidepanelWindowAuthorityRequest = SidepanelWindowPrepareRequest | SidepanelWindowConfirmRequest;

export interface AgentRuntimePortIdentity extends SidepanelCapabilityMaterial {
	clientId: string;
	windowId: number;
	documentNonce: string;
}

export interface SidepanelTrackingPortIdentity extends SidepanelCapabilityMaterial {
	windowId: number;
	documentNonce: string;
}

export interface SidepanelLeaseIdentity {
	windowId: number;
	contextId: string;
	documentId: string;
	documentNonce: string;
	transactionId: string;
	leaseId: string;
}

function usableCanonicalWindowId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateCapabilityMaterial(value: SidepanelCapabilityMaterial): void {
	if (!isSidepanelContinuationToken(value.continuationToken)) {
		throw new Error("continuationToken must be a canonical 256-bit token");
	}
	if (!isSidepanelCapabilityId(value.transactionId)) {
		throw new Error("transactionId must be a canonical UUID v4");
	}
	if (!isSidepanelCapabilityId(value.leaseId)) throw new Error("leaseId must be a canonical UUID v4");
}

export function isSidepanelCapabilityMaterial(value: unknown): value is SidepanelCapabilityMaterial {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["continuationToken", "transactionId", "leaseId"]) &&
		isSidepanelContinuationToken(value.continuationToken) &&
		isSidepanelCapabilityId(value.transactionId) &&
		isSidepanelCapabilityId(value.leaseId)
	);
}

export function agentRuntimePortName(identity: AgentRuntimePortIdentity): string {
	if (!identity.clientId.trim()) throw new Error("clientId must be non-empty");
	if (!usableCanonicalWindowId(identity.windowId)) throw new Error("windowId must be a non-negative safe integer");
	if (!isSidepanelDocumentNonce(identity.documentNonce)) throw new Error("documentNonce must be a canonical UUID v4");
	validateCapabilityMaterial(identity);
	return `${AGENT_RUNTIME_PORT_PREFIX}:${encodeURIComponent(identity.clientId)}:${identity.windowId}:${identity.documentNonce}:${identity.continuationToken}:${identity.transactionId}:${identity.leaseId}`;
}

export function parseAgentRuntimePortName(name: string): AgentRuntimePortIdentity | undefined {
	const match = /^agent-runtime:([^:]+):(0|[1-9]\d*):([^:]+):([^:]+):([^:]+):([^:]+)$/u.exec(name);
	if (!match?.[1] || match[2] === undefined || !match[3] || !match[4] || !match[5] || !match[6]) return undefined;
	try {
		const identity = {
			clientId: decodeURIComponent(match[1]),
			windowId: Number(match[2]),
			documentNonce: match[3],
			continuationToken: match[4],
			transactionId: match[5],
			leaseId: match[6],
		};
		if (!identity.clientId.trim() || !usableCanonicalWindowId(identity.windowId)) return undefined;
		if (
			!isSidepanelDocumentNonce(identity.documentNonce) ||
			!isSidepanelCapabilityMaterial({
				continuationToken: identity.continuationToken,
				transactionId: identity.transactionId,
				leaseId: identity.leaseId,
			}) ||
			agentRuntimePortName(identity) !== name
		) {
			return undefined;
		}
		return identity;
	} catch {
		return undefined;
	}
}

export function sidepanelTrackingPortName(identity: SidepanelTrackingPortIdentity): string {
	if (!usableCanonicalWindowId(identity.windowId)) throw new Error("windowId must be a non-negative safe integer");
	if (!isSidepanelDocumentNonce(identity.documentNonce)) throw new Error("documentNonce must be a canonical UUID v4");
	validateCapabilityMaterial(identity);
	return `${SIDEPANEL_TRACKING_PORT_PREFIX}:${identity.windowId}:${identity.documentNonce}:${identity.continuationToken}:${identity.transactionId}:${identity.leaseId}`;
}

export function parseSidepanelTrackingPortName(name: string): SidepanelTrackingPortIdentity | undefined {
	const match = /^sidepanel:(0|[1-9]\d*):([^:]+):([^:]+):([^:]+):([^:]+)$/u.exec(name);
	if (match?.[1] === undefined || !match[2] || !match[3] || !match[4] || !match[5]) return undefined;
	const identity = {
		windowId: Number(match[1]),
		documentNonce: match[2],
		continuationToken: match[3],
		transactionId: match[4],
		leaseId: match[5],
	};
	if (
		!usableCanonicalWindowId(identity.windowId) ||
		!isSidepanelDocumentNonce(identity.documentNonce) ||
		!isSidepanelCapabilityMaterial({
			continuationToken: identity.continuationToken,
			transactionId: identity.transactionId,
			leaseId: identity.leaseId,
		})
	) {
		return undefined;
	}
	return sidepanelTrackingPortName(identity) === name ? identity : undefined;
}

export type SidepanelWindowPrepareResponse =
	| ({ ok: true; phase: "pending"; windowId: number } & SidepanelCapabilityMaterial)
	| { ok: false; error: string };

export type SidepanelWindowConfirmResponse =
	| ({ ok: true; phase: "active"; windowId: number } & SidepanelCapabilityMaterial)
	| { ok: false; error: string };

export interface SidepanelResolvedIdentity extends SidepanelCapabilityMaterial {
	windowId: number;
}

/** Installs a fresh, non-secret join nonce without disturbing other URL state. */
export function planSidepanelDocumentBootstrap(
	currentUrl: string,
	createNonce: () => string,
): SidepanelDocumentBootstrapPlan {
	const nonce = createNonce();
	if (!isSidepanelDocumentNonce(nonce)) throw new Error("Sidepanel context nonce generator returned a malformed UUID");
	const url = new URL(currentUrl);
	url.searchParams.set(SIDEPANEL_DOCUMENT_NONCE_PARAM, nonce);
	return { nonce, url: url.toString() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

export function isSidepanelWindowPrepareRequest(value: unknown): value is SidepanelWindowPrepareRequest {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["type", "nonce", "proof"]) &&
		value.type === SIDEPANEL_WINDOW_PREPARE_MESSAGE_TYPE &&
		isSidepanelDocumentNonce(value.nonce) &&
		(value.proof === undefined || isSidepanelCapabilityMaterial(value.proof))
	);
}

export function isSidepanelWindowConfirmRequest(value: unknown): value is SidepanelWindowConfirmRequest {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["type", "nonce", "continuationToken", "transactionId", "leaseId"]) &&
		value.type === SIDEPANEL_WINDOW_CONFIRM_MESSAGE_TYPE &&
		isSidepanelDocumentNonce(value.nonce) &&
		isSidepanelCapabilityMaterial({
			continuationToken: value.continuationToken,
			transactionId: value.transactionId,
			leaseId: value.leaseId,
		})
	);
}

function usableWindowId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPrepareResponse(value: unknown): value is SidepanelWindowPrepareResponse {
	if (!isRecord(value) || typeof value.ok !== "boolean") return false;
	if (!value.ok)
		return hasOnlyKeys(value, ["ok", "error"]) && typeof value.error === "string" && value.error.length > 0;
	return (
		hasOnlyKeys(value, ["ok", "phase", "windowId", "continuationToken", "transactionId", "leaseId"]) &&
		value.phase === "pending" &&
		usableWindowId(value.windowId) &&
		isSidepanelCapabilityMaterial({
			continuationToken: value.continuationToken,
			transactionId: value.transactionId,
			leaseId: value.leaseId,
		})
	);
}

function isConfirmResponse(value: unknown): value is SidepanelWindowConfirmResponse {
	if (!isRecord(value) || typeof value.ok !== "boolean") return false;
	if (!value.ok)
		return hasOnlyKeys(value, ["ok", "error"]) && typeof value.error === "string" && value.error.length > 0;
	return (
		hasOnlyKeys(value, ["ok", "phase", "windowId", "continuationToken", "transactionId", "leaseId"]) &&
		value.phase === "active" &&
		usableWindowId(value.windowId) &&
		isSidepanelCapabilityMaterial({
			continuationToken: value.continuationToken,
			transactionId: value.transactionId,
			leaseId: value.leaseId,
		})
	);
}

export interface SidepanelWindowAuthorityMessenger {
	sendMessage(message: SidepanelWindowAuthorityRequest): Promise<unknown>;
}

export interface SidepanelWindowResolveOptions {
	maxAttempts?: number;
	retryDelayMs?: number;
	wait?(delayMs: number): Promise<void>;
}

function retryOptions(options: SidepanelWindowResolveOptions): {
	maxAttempts: number;
	retryDelayMs: number;
	wait(delayMs: number): Promise<void>;
} {
	const maxAttempts = options.maxAttempts ?? 40;
	const retryDelayMs = options.retryDelayMs ?? 25;
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
		throw new Error("Sidepanel window resolution attempts must be a positive safe integer");
	}
	if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
		throw new Error("Sidepanel window resolution delay must be a non-negative safe integer");
	}
	return {
		maxAttempts,
		retryDelayMs,
		wait: options.wait ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs))),
	};
}

export async function prepareSidepanelWindowIdentity(
	messenger: SidepanelWindowAuthorityMessenger,
	currentUrl: string,
	proof: SidepanelCapabilityMaterial | undefined,
	options: SidepanelWindowResolveOptions = {},
): Promise<SidepanelResolvedIdentity> {
	const nonce = sidepanelDocumentNonce(currentUrl);
	if (!nonce) throw new Error("Sidepanel document is missing its authenticated context nonce");
	if (proof !== undefined && !isSidepanelCapabilityMaterial(proof)) {
		throw new Error("Sidepanel document has malformed continuation material");
	}
	const retry = retryOptions(options);
	const request: SidepanelWindowPrepareRequest = {
		type: SIDEPANEL_WINDOW_PREPARE_MESSAGE_TYPE,
		nonce,
		...(proof ? { proof: { ...proof } } : {}),
	};
	for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
		try {
			const response = await messenger.sendMessage(request);
			if (isPrepareResponse(response) && response.ok) {
				return {
					windowId: response.windowId,
					continuationToken: response.continuationToken,
					transactionId: response.transactionId,
					leaseId: response.leaseId,
				};
			}
		} catch {
			// The MV3 worker or its onOpened handler may still be starting.
		}
		if (attempt + 1 < retry.maxAttempts) await retry.wait(retry.retryDelayMs);
	}
	throw new Error("Failed to prepare authoritative sidepanel browser-window continuation");
}

export async function confirmSidepanelWindowIdentity(
	messenger: SidepanelWindowAuthorityMessenger,
	currentUrl: string,
	pending: SidepanelCapabilityMaterial,
	options: SidepanelWindowResolveOptions = {},
): Promise<SidepanelResolvedIdentity> {
	const nonce = sidepanelDocumentNonce(currentUrl);
	if (!nonce) throw new Error("Sidepanel document is missing its authenticated context nonce");
	if (!isSidepanelCapabilityMaterial(pending)) throw new Error("Sidepanel document has malformed pending material");
	const retry = retryOptions(options);
	const request: SidepanelWindowConfirmRequest = {
		type: SIDEPANEL_WINDOW_CONFIRM_MESSAGE_TYPE,
		nonce,
		...pending,
	};
	for (let attempt = 0; attempt < retry.maxAttempts; attempt++) {
		try {
			const response = await messenger.sendMessage(request);
			if (isConfirmResponse(response) && response.ok) {
				return {
					windowId: response.windowId,
					continuationToken: response.continuationToken,
					transactionId: response.transactionId,
					leaseId: response.leaseId,
				};
			}
		} catch {
			// Confirmation is idempotent, so a lost worker response is retryable.
		}
		if (attempt + 1 < retry.maxAttempts) await retry.wait(retry.retryDelayMs);
	}
	throw new Error("Failed to confirm authoritative sidepanel browser-window continuation");
}
