import {
	isCanonicalSidepanelSenderUrl,
	isSidepanelCapabilityId,
	isSidepanelCapabilityMaterial,
	isSidepanelContinuationToken,
	isSidepanelDocumentNonce,
	isSidepanelWindowConfirmRequest,
	isSidepanelWindowPrepareRequest,
	type SidepanelCapabilityMaterial,
	type SidepanelLeaseIdentity,
	type SidepanelWindowConfirmResponse,
	type SidepanelWindowPrepareResponse,
	sidepanelDocumentNonce,
} from "./sidepanel-context-identity.js";

export interface SidepanelAuthorityContext {
	contextId: string;
	contextType: string;
	documentId?: string;
	documentOrigin?: string;
	documentUrl?: string;
	frameId: number;
	tabId: number;
	windowId: number;
}

export interface SidepanelAuthoritySender {
	id?: string;
	url?: string;
	origin?: string;
	documentId?: string;
	documentLifecycle?: string;
	frameId?: number;
	tab?: { id?: number; windowId?: number };
}

export interface SidepanelOpenedAuthorityEvent {
	path: string;
	windowId: number;
}

export interface SidepanelDocumentIdentity {
	contextId: string;
	documentId: string;
	documentNonce: string;
}

export interface SidepanelOpenedAuthorityRecord {
	stage: "opened";
	windowId: number;
	contextId: string;
	documentId: string;
}

export type SidepanelAuthorityProof =
	| { kind: "opened"; contextId: string; documentId: string }
	| ({ kind: "capability"; candidate: SidepanelDocumentIdentity; verifierDigest: string } & Omit<
			SidepanelCapabilityMaterial,
			"continuationToken"
	  >);

export interface SidepanelPendingAuthorityRecord {
	stage: "pending";
	windowId: number;
	proof: SidepanelAuthorityProof;
	candidate: SidepanelDocumentIdentity;
	next: {
		verifierDigest: string;
		transactionId: string;
		leaseId: string;
	};
}

export interface SidepanelActiveAuthorityRecord {
	stage: "active";
	windowId: number;
	candidate: SidepanelDocumentIdentity;
	verifierDigest: string;
	transactionId: string;
	leaseId: string;
}

export type SidepanelWindowAuthorityRecord =
	| SidepanelOpenedAuthorityRecord
	| SidepanelPendingAuthorityRecord
	| SidepanelActiveAuthorityRecord;

export interface SidepanelWindowAuthorityState {
	version: 2;
	windows: SidepanelWindowAuthorityRecord[];
}

export interface SidepanelWindowAuthorityStorage {
	load(): Promise<unknown>;
	save(state: SidepanelWindowAuthorityState): Promise<void>;
}

export interface SidepanelWindowAuthorityOptions {
	extensionId: string;
	sidepanelUrl: string;
	sidePanelContextType: string;
	getContexts(): Promise<SidepanelAuthorityContext[]>;
	storage: SidepanelWindowAuthorityStorage;
	openedEventSettleDelayMs?: number;
	openedContextMaxAttempts?: number;
	openedContextRetryDelayMs?: number;
	createContinuationToken?(): string;
	createCapabilityId?(): string;
	hashContinuationToken?(token: string): Promise<string>;
	wait?(delayMs: number): Promise<void>;
}

export interface SidepanelAuthorizedContext extends SidepanelAuthorityContext {
	lease: SidepanelLeaseIdentity;
}

interface LiveSidepanelSnapshot {
	contexts: SidepanelAuthorityContext[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function usableWindowId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function usableNativeContextWindowId(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= -1;
}

function extensionOrigin(value: string): string | undefined {
	try {
		const url = new URL(value);
		return url.protocol === "chrome-extension:" ? `${url.protocol}//${url.host}` : undefined;
	} catch {
		return undefined;
	}
}

function sameExtensionPage(actualValue: string, expectedValue: string): boolean {
	try {
		const actual = new URL(actualValue);
		const expected = new URL(expectedValue);
		return (
			actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname
		);
	} catch {
		return false;
	}
}

function sameOpenedPath(actualValue: string, expectedUrl: string): boolean {
	try {
		const expected = new URL(expectedUrl);
		const actual = new URL(actualValue, `${expected.protocol}//${expected.host}/`);
		return (
			actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname
		);
	} catch {
		return false;
	}
}

function validDocumentIdentity(value: unknown): value is SidepanelDocumentIdentity {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ["contextId", "documentId", "documentNonce"]) &&
		nonEmptyString(value.contextId) &&
		nonEmptyString(value.documentId) &&
		isSidepanelDocumentNonce(value.documentNonce)
	);
}

function validCapabilityFields(value: Record<string, unknown>): boolean {
	return (
		isSidepanelContinuationToken(value.verifierDigest) &&
		isSidepanelCapabilityId(value.transactionId) &&
		isSidepanelCapabilityId(value.leaseId)
	);
}

function validProof(value: unknown): value is SidepanelAuthorityProof {
	if (!isRecord(value) || (value.kind !== "opened" && value.kind !== "capability")) return false;
	if (value.kind === "opened") {
		return (
			hasOnlyKeys(value, ["kind", "contextId", "documentId"]) &&
			nonEmptyString(value.contextId) &&
			nonEmptyString(value.documentId)
		);
	}
	return (
		hasOnlyKeys(value, ["kind", "candidate", "verifierDigest", "transactionId", "leaseId"]) &&
		validDocumentIdentity(value.candidate) &&
		validCapabilityFields(value)
	);
}

function validRecord(value: unknown): value is SidepanelWindowAuthorityRecord {
	if (!isRecord(value) || !usableWindowId(value.windowId)) return false;
	if (value.stage === "opened") {
		return (
			hasOnlyKeys(value, ["stage", "windowId", "contextId", "documentId"]) &&
			nonEmptyString(value.contextId) &&
			nonEmptyString(value.documentId)
		);
	}
	if (value.stage === "active") {
		return (
			hasOnlyKeys(value, ["stage", "windowId", "candidate", "verifierDigest", "transactionId", "leaseId"]) &&
			validDocumentIdentity(value.candidate) &&
			validCapabilityFields(value)
		);
	}
	if (value.stage !== "pending" || !isRecord(value.next)) return false;
	return (
		hasOnlyKeys(value, ["stage", "windowId", "proof", "candidate", "next"]) &&
		validProof(value.proof) &&
		validDocumentIdentity(value.candidate) &&
		hasOnlyKeys(value.next, ["verifierDigest", "transactionId", "leaseId"]) &&
		validCapabilityFields(value.next)
	);
}

function parseAuthorityState(value: unknown): Map<number, SidepanelWindowAuthorityRecord> {
	if (value === undefined) return new Map();
	if (
		!isRecord(value) ||
		value.version !== 2 ||
		!Array.isArray(value.windows) ||
		!hasOnlyKeys(value, ["version", "windows"])
	) {
		throw new Error("Stored sidepanel window authority state is malformed");
	}
	const records = new Map<number, SidepanelWindowAuthorityRecord>();
	const contextOwners = new Map<string, number>();
	const documentOwners = new Map<string, number>();
	const exactDocuments = new Set<string>();
	const documentNonces = new Set<string>();
	const capabilityIds = new Set<string>();
	const verifierDigests = new Set<string>();
	const registerIdentity = (windowId: number, identity: SidepanelDocumentIdentity): void => {
		const exact = JSON.stringify([identity.contextId, identity.documentId]);
		const contextOwner = contextOwners.get(identity.contextId);
		const documentOwner = documentOwners.get(identity.documentId);
		if (
			exactDocuments.has(exact) ||
			documentNonces.has(identity.documentNonce) ||
			(contextOwner !== undefined && contextOwner !== windowId) ||
			(documentOwner !== undefined && documentOwner !== windowId)
		) {
			throw new Error("Stored sidepanel authority document identity is not unique");
		}
		exactDocuments.add(exact);
		documentNonces.add(identity.documentNonce);
		contextOwners.set(identity.contextId, windowId);
		documentOwners.set(identity.documentId, windowId);
	};
	const registerCapability = (capability: {
		verifierDigest: string;
		transactionId: string;
		leaseId: string;
	}): void => {
		if (
			verifierDigests.has(capability.verifierDigest) ||
			capabilityIds.has(capability.transactionId) ||
			capabilityIds.has(capability.leaseId) ||
			capability.transactionId === capability.leaseId
		) {
			throw new Error("Stored sidepanel authority capability is not unique");
		}
		verifierDigests.add(capability.verifierDigest);
		capabilityIds.add(capability.transactionId);
		capabilityIds.add(capability.leaseId);
	};
	for (const valueRecord of value.windows) {
		if (!validRecord(valueRecord) || records.has(valueRecord.windowId)) {
			throw new Error("Stored sidepanel window authority state is malformed");
		}
		const record = structuredClone(valueRecord);
		if (record.stage === "opened") {
			const contextOwner = contextOwners.get(record.contextId);
			const documentOwner = documentOwners.get(record.documentId);
			if (
				(contextOwner !== undefined && contextOwner !== record.windowId) ||
				(documentOwner !== undefined && documentOwner !== record.windowId)
			) {
				throw new Error("Stored sidepanel authority document identity is not unique");
			}
			contextOwners.set(record.contextId, record.windowId);
			documentOwners.set(record.documentId, record.windowId);
		} else {
			registerIdentity(record.windowId, record.candidate);
		}
		if (record.stage === "active") registerCapability(record);
		if (record.stage === "pending") {
			registerCapability(record.next);
			if (record.proof.kind === "capability") {
				registerIdentity(record.windowId, record.proof.candidate);
				registerCapability(record.proof);
			}
		}
		records.set(record.windowId, record);
	}
	return records;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function createContinuationToken(): string {
	return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashContinuationToken(token: string): Promise<string> {
	const input = new TextEncoder().encode(`shuvgeist.sidepanel-continuation.v1\0${token}`);
	return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", input)));
}

function sameCandidate(left: SidepanelDocumentIdentity, right: SidepanelDocumentIdentity): boolean {
	return (
		left.contextId === right.contextId &&
		left.documentId === right.documentId &&
		left.documentNonce === right.documentNonce
	);
}

function candidateFromContext(
	context: SidepanelAuthorityContext,
	nonce: string,
): SidepanelDocumentIdentity | undefined {
	return nonEmptyString(context.documentId)
		? { contextId: context.contextId, documentId: context.documentId, documentNonce: nonce }
		: undefined;
}

/** Durable browser-window authority for SIDE_PANEL documents and their leases. */
export class SidepanelWindowAuthority {
	private readonly windows = new Map<number, SidepanelWindowAuthorityRecord>();
	private readonly pendingCreatedThisWorker = new Set<number>();
	private readonly pendingOpenedEvents = new Set<symbol>();
	private readonly openingWindows = new Map<number, number>();
	private openedEventOverlapTainted = false;
	private loaded = false;
	private poisoned = false;
	private operationTail: Promise<void> = Promise.resolve();

	constructor(private readonly options: SidepanelWindowAuthorityOptions) {}

	private async exclusively<T>(operation: () => Promise<T>): Promise<T> {
		const prior = this.operationTail;
		let release = () => {};
		this.operationTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await prior;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	private async ensureLoaded(): Promise<void> {
		if (this.poisoned) throw new Error("Sidepanel window authority is unavailable until service-worker restart");
		if (this.loaded) return;
		let loaded: unknown;
		try {
			loaded = await this.options.storage.load();
		} catch (error) {
			this.poisoned = true;
			throw error;
		}
		try {
			const parsed = parseAuthorityState(loaded);
			for (const [windowId, record] of parsed) this.windows.set(windowId, record);
			this.loaded = true;
		} catch (error) {
			this.poisoned = true;
			try {
				await this.options.storage.save({ version: 2, windows: [] });
			} catch {
				// The current worker remains poisoned regardless of cleanup outcome.
			}
			throw error;
		}
	}

	private state(): SidepanelWindowAuthorityState {
		return {
			version: 2,
			windows: Array.from(this.windows.values(), (record) => structuredClone(record)).sort(
				(left, right) => left.windowId - right.windowId,
			),
		};
	}

	private async saveOrPoison(): Promise<void> {
		try {
			await this.options.storage.save(this.state());
		} catch (error) {
			this.poisoned = true;
			throw error;
		}
	}

	private releaseOpenedEventToken(token: symbol): void {
		this.pendingOpenedEvents.delete(token);
		if (this.pendingOpenedEvents.size === 0) this.openedEventOverlapTainted = false;
	}

	private beginOpeningWindow(windowId: number): void {
		this.openingWindows.set(windowId, (this.openingWindows.get(windowId) ?? 0) + 1);
	}

	private endOpeningWindow(windowId: number): void {
		const count = this.openingWindows.get(windowId) ?? 0;
		if (count <= 1) this.openingWindows.delete(windowId);
		else this.openingWindows.set(windowId, count - 1);
	}

	private isWindowOpening(windowId: number): boolean {
		return (this.openingWindows.get(windowId) ?? 0) > 0;
	}

	private validContext(context: SidepanelAuthorityContext): boolean {
		const expectedOrigin = extensionOrigin(this.options.sidepanelUrl);
		return (
			expectedOrigin !== undefined &&
			context.contextType === this.options.sidePanelContextType &&
			nonEmptyString(context.contextId) &&
			nonEmptyString(context.documentId) &&
			context.documentOrigin === expectedOrigin &&
			nonEmptyString(context.documentUrl) &&
			sameExtensionPage(context.documentUrl, this.options.sidepanelUrl) &&
			usableNativeContextWindowId(context.windowId)
		);
	}

	private async liveSnapshot(): Promise<LiveSidepanelSnapshot> {
		return { contexts: (await this.options.getContexts()).filter((context) => this.validContext(context)) };
	}

	private uniqueRawContextForNonce(
		snapshot: LiveSidepanelSnapshot,
		documentNonce: string,
		documentId?: string,
	): SidepanelAuthorityContext | undefined {
		const matches = snapshot.contexts.filter(
			(context) => sidepanelDocumentNonce(context.documentUrl ?? "") === documentNonce,
		);
		if (matches.length !== 1) return undefined;
		const [context] = matches;
		if (!context || (documentId !== undefined && context.documentId !== documentId)) return undefined;
		return context;
	}

	private validSender(sender: SidepanelAuthoritySender): boolean {
		const expectedOrigin = extensionOrigin(this.options.sidepanelUrl);
		return Boolean(
			expectedOrigin &&
				sender.id === this.options.extensionId &&
				nonEmptyString(sender.url) &&
				sender.origin === expectedOrigin &&
				isCanonicalSidepanelSenderUrl(sender.url, this.options.sidepanelUrl) &&
				sender.tab === undefined &&
				sender.frameId === undefined &&
				(sender.documentLifecycle === undefined || sender.documentLifecycle === "active"),
		);
	}

	private async digestContinuationToken(token: string): Promise<string> {
		const digest = await (this.options.hashContinuationToken ?? hashContinuationToken)(token);
		if (!isSidepanelContinuationToken(digest)) {
			throw new Error("Sidepanel continuation-token verifier returned a malformed digest");
		}
		return digest;
	}

	private freshContinuationToken(): string {
		const token = (this.options.createContinuationToken ?? createContinuationToken)();
		if (!isSidepanelContinuationToken(token)) {
			throw new Error("Sidepanel continuation-token generator returned a malformed token");
		}
		return token;
	}

	private freshCapabilityId(): string {
		const value = (this.options.createCapabilityId ?? (() => crypto.randomUUID()))();
		if (!isSidepanelCapabilityId(value))
			throw new Error("Sidepanel capability-id generator returned a malformed UUID");
		return value;
	}

	private async freshNext(): Promise<{
		raw: SidepanelCapabilityMaterial;
		persisted: SidepanelPendingAuthorityRecord["next"];
	}> {
		const raw = {
			continuationToken: this.freshContinuationToken(),
			transactionId: this.freshCapabilityId(),
			leaseId: this.freshCapabilityId(),
		};
		if (raw.transactionId === raw.leaseId) throw new Error("Sidepanel capability generator returned colliding ids");
		const verifierDigest = await this.digestContinuationToken(raw.continuationToken);
		const persistedValues = this.persistedCapabilityValues();
		if (
			persistedValues.verifiers.has(verifierDigest) ||
			persistedValues.ids.has(raw.transactionId) ||
			persistedValues.ids.has(raw.leaseId)
		) {
			throw new Error("Sidepanel capability generator returned a previously used value");
		}
		return {
			raw,
			persisted: {
				verifierDigest,
				transactionId: raw.transactionId,
				leaseId: raw.leaseId,
			},
		};
	}

	private persistedCapabilityValues(): { verifiers: Set<string>; ids: Set<string> } {
		const verifiers = new Set<string>();
		const ids = new Set<string>();
		const add = (capability: { verifierDigest: string; transactionId: string; leaseId: string }): void => {
			verifiers.add(capability.verifierDigest);
			ids.add(capability.transactionId);
			ids.add(capability.leaseId);
		};
		for (const record of this.windows.values()) {
			if (record.stage === "active") add(record);
			if (record.stage === "pending") {
				add(record.next);
				if (record.proof.kind === "capability") add(record.proof);
			}
		}
		return { verifiers, ids };
	}

	private async capabilityMatches(
		material: SidepanelCapabilityMaterial,
		persisted: { verifierDigest: string; transactionId: string; leaseId: string },
	): Promise<boolean> {
		return (
			material.transactionId === persisted.transactionId &&
			material.leaseId === persisted.leaseId &&
			(await this.digestContinuationToken(material.continuationToken)) === persisted.verifierDigest
		);
	}

	private proofFromActive(record: SidepanelActiveAuthorityRecord): SidepanelAuthorityProof {
		return {
			kind: "capability",
			candidate: structuredClone(record.candidate),
			verifierDigest: record.verifierDigest,
			transactionId: record.transactionId,
			leaseId: record.leaseId,
		};
	}

	private proofFromPending(record: SidepanelPendingAuthorityRecord): SidepanelAuthorityProof {
		return {
			kind: "capability",
			candidate: structuredClone(record.candidate),
			verifierDigest: record.next.verifierDigest,
			transactionId: record.next.transactionId,
			leaseId: record.next.leaseId,
		};
	}

	private async proofMatches(
		material: SidepanelCapabilityMaterial | undefined,
		proof: SidepanelAuthorityProof,
	): Promise<boolean> {
		if (proof.kind === "opened") return material === undefined;
		return material !== undefined && this.capabilityMatches(material, proof);
	}

	private recordForContext(contextId: string): SidepanelWindowAuthorityRecord | undefined {
		return Array.from(this.windows.values()).find((record) =>
			record.stage === "opened" ? record.contextId === contextId : record.candidate.contextId === contextId,
		);
	}

	private recordIdentities(record: SidepanelWindowAuthorityRecord): SidepanelDocumentIdentity[] {
		if (record.stage === "opened") return [];
		return [
			structuredClone(record.candidate),
			...(record.stage === "pending" && record.proof.kind === "capability"
				? [structuredClone(record.proof.candidate)]
				: []),
		];
	}

	private previousCandidateIsGone(snapshot: LiveSidepanelSnapshot, candidate: SidepanelDocumentIdentity): boolean {
		return !snapshot.contexts.some(
			(context) =>
				(context.contextId === candidate.contextId && context.documentId === candidate.documentId) ||
				sidepanelDocumentNonce(context.documentUrl ?? "") === candidate.documentNonce,
		);
	}

	private async revalidateCandidate(
		windowId: number,
		candidate: SidepanelDocumentIdentity,
		expectedRecord: SidepanelWindowAuthorityRecord,
		predecessor?: SidepanelDocumentIdentity,
	): Promise<boolean> {
		const snapshot = await this.liveSnapshot();
		const liveCandidate = this.uniqueRawContextForNonce(snapshot, candidate.documentNonce, candidate.documentId);
		const currentRecord = this.windows.get(windowId);
		const ownedElsewhere = Array.from(this.windows.values()).some((record) => {
			if (record.windowId === windowId) return false;
			if (record.stage === "opened") {
				return record.contextId === candidate.contextId || record.documentId === candidate.documentId;
			}
			return this.recordIdentities(record).some(
				(identity) =>
					identity.contextId === candidate.contextId ||
					identity.documentId === candidate.documentId ||
					identity.documentNonce === candidate.documentNonce,
			);
		});
		return Boolean(
			!this.isWindowOpening(windowId) &&
				liveCandidate &&
				liveCandidate.contextId === candidate.contextId &&
				(liveCandidate.windowId < 0 || liveCandidate.windowId === windowId) &&
				!ownedElsewhere &&
				JSON.stringify(currentRecord) === JSON.stringify(expectedRecord) &&
				(predecessor === undefined || this.previousCandidateIsGone(snapshot, predecessor)),
		);
	}

	private response(windowId: number, material: SidepanelCapabilityMaterial): SidepanelWindowPrepareResponse {
		return { ok: true, phase: "pending", windowId, ...material };
	}

	private rejectPrepare(): SidepanelWindowPrepareResponse {
		return { ok: false, error: "Unable to prepare the sidepanel browser-window continuation" };
	}

	private rejectConfirm(): SidepanelWindowConfirmResponse {
		return { ok: false, error: "Unable to confirm the sidepanel browser-window continuation" };
	}

	private async persistPending(
		windowId: number,
		proof: SidepanelAuthorityProof,
		candidate: SidepanelDocumentIdentity,
		expectedRecord: SidepanelWindowAuthorityRecord,
		predecessor?: SidepanelDocumentIdentity,
	): Promise<SidepanelWindowPrepareResponse> {
		const next = await this.freshNext();
		if (!(await this.revalidateCandidate(windowId, candidate, expectedRecord, predecessor)))
			return this.rejectPrepare();
		this.windows.set(windowId, {
			stage: "pending",
			windowId,
			proof: structuredClone(proof),
			candidate: structuredClone(candidate),
			next: next.persisted,
		});
		this.pendingCreatedThisWorker.add(windowId);
		await this.saveOrPoison();
		return this.response(windowId, next.raw);
	}

	/** Records one authoritative Chrome onOpened event and revokes any same-window lease. */
	async observeOpened(event: SidepanelOpenedAuthorityEvent): Promise<{ contextId: string; windowId: number }> {
		if (!usableWindowId(event.windowId) || !sameOpenedPath(event.path, this.options.sidepanelUrl)) {
			throw new Error("Rejected a sidepanel onOpened event with an invalid path or browser window");
		}
		const eventToken = Symbol("sidepanel-opened-event");
		this.beginOpeningWindow(event.windowId);
		this.pendingOpenedEvents.add(eventToken);
		if (this.pendingOpenedEvents.size > 1) this.openedEventOverlapTainted = true;
		const settleDelayMs = this.options.openedEventSettleDelayMs ?? 50;
		if (!Number.isSafeInteger(settleDelayMs) || settleDelayMs < 0) {
			this.releaseOpenedEventToken(eventToken);
			this.endOpeningWindow(event.windowId);
			throw new Error("Sidepanel authority settle delay must be a non-negative safe integer");
		}
		const wait =
			this.options.wait ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
		try {
			// Revoke the previous verifier/lease before attribution or settling.
			// Ambiguity can therefore fail closed without resurrecting the old page.
			await this.exclusively(async () => {
				await this.ensureLoaded();
				if (!this.windows.delete(event.windowId)) return;
				this.pendingCreatedThisWorker.delete(event.windowId);
				await this.saveOrPoison();
			});
			await wait(settleDelayMs);
			return await this.exclusively(async () => {
				await this.ensureLoaded();
				if (this.openedEventOverlapTainted || this.pendingOpenedEvents.size !== 1) {
					throw new Error("Refused to bind overlapping sidepanel onOpened events");
				}
				const maxAttempts = this.options.openedContextMaxAttempts ?? 40;
				const retryDelayMs = this.options.openedContextRetryDelayMs ?? 25;
				if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
					throw new Error("Sidepanel authority attempts must be a positive safe integer");
				}
				if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
					throw new Error("Sidepanel authority delay must be a non-negative safe integer");
				}
				for (let attempt = 0; attempt < maxAttempts; attempt++) {
					const snapshot = await this.liveSnapshot();
					if (this.openedEventOverlapTainted || this.pendingOpenedEvents.size !== 1) {
						throw new Error("Refused to bind overlapping sidepanel onOpened events");
					}
					const candidates = snapshot.contexts.filter((context) => {
						if (context.windowId !== -1 && context.windowId !== event.windowId) return false;
						const owner = this.recordForContext(context.contextId);
						return owner === undefined || owner.windowId === event.windowId;
					});
					if (candidates.length > 1) throw new Error("Refused to bind an ambiguous sidepanel onOpened event");
					const candidate = candidates[0];
					if (candidate?.documentId) {
						this.windows.set(event.windowId, {
							stage: "opened",
							windowId: event.windowId,
							contextId: candidate.contextId,
							documentId: candidate.documentId,
						});
						this.pendingCreatedThisWorker.delete(event.windowId);
						await this.saveOrPoison();
						return { contextId: candidate.contextId, windowId: event.windowId };
					}
					if (attempt + 1 < maxAttempts) await wait(retryDelayMs);
				}
				throw new Error("No new live sidepanel context appeared for the onOpened event");
			});
		} finally {
			this.releaseOpenedEventToken(eventToken);
			this.endOpeningWindow(event.windowId);
		}
	}

	/** Persists a pending replacement before returning any raw capability. */
	async prepareWindow(
		requestValue: unknown,
		sender: SidepanelAuthoritySender,
	): Promise<SidepanelWindowPrepareResponse> {
		return this.exclusively(async () => {
			try {
				await this.ensureLoaded();
				if (!isSidepanelWindowPrepareRequest(requestValue) || !this.validSender(sender)) {
					return this.rejectPrepare();
				}
				const snapshot = await this.liveSnapshot();
				const context = this.uniqueRawContextForNonce(snapshot, requestValue.nonce, sender.documentId);
				const candidate = context ? candidateFromContext(context, requestValue.nonce) : undefined;
				if (!context || !candidate) return this.rejectPrepare();
				const contextOwner = this.recordForContext(context.contextId);

				if (contextOwner?.stage === "opened") {
					if (
						this.isWindowOpening(contextOwner.windowId) ||
						requestValue.proof !== undefined ||
						contextOwner.contextId !== candidate.contextId ||
						contextOwner.documentId !== candidate.documentId ||
						(context.windowId >= 0 && context.windowId !== contextOwner.windowId)
					) {
						return this.rejectPrepare();
					}
					return this.persistPending(
						contextOwner.windowId,
						{ kind: "opened", contextId: contextOwner.contextId, documentId: contextOwner.documentId },
						candidate,
						contextOwner,
					);
				}

				for (const record of this.windows.values()) {
					if (this.isWindowOpening(record.windowId)) continue;
					if (context.windowId >= 0 && context.windowId !== record.windowId) continue;
					if (record.stage === "active" && requestValue.proof) {
						if (
							(await this.capabilityMatches(requestValue.proof, record)) &&
							this.previousCandidateIsGone(snapshot, record.candidate) &&
							(contextOwner === undefined || contextOwner.windowId === record.windowId)
						) {
							return this.persistPending(
								record.windowId,
								this.proofFromActive(record),
								candidate,
								record,
								record.candidate,
							);
						}
						continue;
					}
					if (record.stage !== "pending") continue;
					if (
						requestValue.proof &&
						(await this.capabilityMatches(requestValue.proof, record.next)) &&
						(contextOwner === undefined || contextOwner.windowId === record.windowId)
					) {
						if (sameCandidate(record.candidate, candidate)) {
							this.pendingCreatedThisWorker.add(record.windowId);
							return this.response(record.windowId, requestValue.proof);
						}
						if (!this.previousCandidateIsGone(snapshot, record.candidate)) return this.rejectPrepare();
						return this.persistPending(
							record.windowId,
							this.proofFromPending(record),
							candidate,
							record,
							record.candidate,
						);
					}
					if (
						!this.pendingCreatedThisWorker.has(record.windowId) &&
						sameCandidate(record.candidate, candidate) &&
						(await this.proofMatches(requestValue.proof, record.proof))
					) {
						return this.persistPending(record.windowId, record.proof, candidate, record);
					}
				}
				return this.rejectPrepare();
			} catch (error) {
				if (this.poisoned) throw error;
				throw error;
			}
		});
	}

	/** Confirms exactly one pending capability and persists active authority first. */
	async confirmWindow(
		requestValue: unknown,
		sender: SidepanelAuthoritySender,
	): Promise<SidepanelWindowConfirmResponse> {
		return this.exclusively(async () => {
			await this.ensureLoaded();
			if (!isSidepanelWindowConfirmRequest(requestValue) || !this.validSender(sender)) return this.rejectConfirm();
			const snapshot = await this.liveSnapshot();
			const context = this.uniqueRawContextForNonce(snapshot, requestValue.nonce, sender.documentId);
			const candidate = context ? candidateFromContext(context, requestValue.nonce) : undefined;
			if (!context || !candidate) return this.rejectConfirm();
			const material: SidepanelCapabilityMaterial = {
				continuationToken: requestValue.continuationToken,
				transactionId: requestValue.transactionId,
				leaseId: requestValue.leaseId,
			};
			for (const record of this.windows.values()) {
				if (this.isWindowOpening(record.windowId)) continue;
				if (context.windowId >= 0 && context.windowId !== record.windowId) continue;
				if (record.stage === "pending") {
					if (
						!sameCandidate(record.candidate, candidate) ||
						!(await this.capabilityMatches(material, record.next))
					) {
						continue;
					}
					if (!(await this.revalidateCandidate(record.windowId, candidate, record))) {
						return this.rejectConfirm();
					}
					this.windows.set(record.windowId, {
						stage: "active",
						windowId: record.windowId,
						candidate: structuredClone(record.candidate),
						...record.next,
					});
					this.pendingCreatedThisWorker.delete(record.windowId);
					await this.saveOrPoison();
					return { ok: true, phase: "active", windowId: record.windowId, ...material };
				}
				if (
					record.stage === "active" &&
					sameCandidate(record.candidate, candidate) &&
					(await this.capabilityMatches(material, record))
				) {
					if (!(await this.revalidateCandidate(record.windowId, candidate, record))) {
						return this.rejectConfirm();
					}
					return { ok: true, phase: "active", windowId: record.windowId, ...material };
				}
			}
			return this.rejectConfirm();
		});
	}

	/** Authenticates an active port and returns only redacted lease identity. */
	async resolveActiveLease(
		documentNonce: string,
		material: SidepanelCapabilityMaterial,
		documentId?: string,
	): Promise<SidepanelAuthorizedContext | undefined> {
		if (!isSidepanelDocumentNonce(documentNonce) || !isSidepanelCapabilityMaterial(material)) return undefined;
		return this.exclusively(async () => {
			try {
				await this.ensureLoaded();
				const snapshot = await this.liveSnapshot();
				const context = this.uniqueRawContextForNonce(snapshot, documentNonce, documentId);
				if (!context?.documentId) return undefined;
				for (const record of this.windows.values()) {
					if (
						this.isWindowOpening(record.windowId) ||
						record.stage !== "active" ||
						record.candidate.contextId !== context.contextId ||
						record.candidate.documentId !== context.documentId ||
						record.candidate.documentNonce !== documentNonce ||
						(context.windowId >= 0 && context.windowId !== record.windowId) ||
						!(await this.capabilityMatches(material, record))
					) {
						continue;
					}
					if (!(await this.revalidateCandidate(record.windowId, record.candidate, record))) return undefined;
					return {
						...context,
						windowId: record.windowId,
						lease: {
							windowId: record.windowId,
							contextId: context.contextId,
							documentId: context.documentId,
							documentNonce,
							transactionId: record.transactionId,
							leaseId: record.leaseId,
						},
					};
				}
				return undefined;
			} catch {
				return undefined;
			}
		});
	}

	/** Generation fence for every async port/coordinator handoff. */
	async isLeaseCurrent(lease: SidepanelLeaseIdentity): Promise<boolean> {
		return this.exclusively(async () => {
			try {
				await this.ensureLoaded();
				const record = this.windows.get(lease.windowId);
				if (
					this.isWindowOpening(lease.windowId) ||
					!record ||
					record.stage !== "active" ||
					record.transactionId !== lease.transactionId ||
					record.leaseId !== lease.leaseId ||
					record.candidate.contextId !== lease.contextId ||
					record.candidate.documentId !== lease.documentId ||
					record.candidate.documentNonce !== lease.documentNonce
				) {
					return false;
				}
				const snapshot = await this.liveSnapshot();
				if (this.isWindowOpening(lease.windowId) || this.windows.get(lease.windowId) !== record) return false;
				const context = this.uniqueRawContextForNonce(snapshot, lease.documentNonce, lease.documentId);
				return Boolean(context && context.contextId === lease.contextId);
			} catch {
				return false;
			}
		});
	}

	async listAuthorizedContexts(): Promise<SidepanelAuthorizedContext[]> {
		return this.exclusively(async () => {
			try {
				await this.ensureLoaded();
				const snapshot = await this.liveSnapshot();
				const contexts: SidepanelAuthorizedContext[] = [];
				for (const record of this.windows.values()) {
					if (record.stage !== "active") continue;
					const context = this.uniqueRawContextForNonce(
						snapshot,
						record.candidate.documentNonce,
						record.candidate.documentId,
					);
					if (!context || context.contextId !== record.candidate.contextId) continue;
					contexts.push({
						...context,
						windowId: record.windowId,
						lease: {
							windowId: record.windowId,
							...record.candidate,
							transactionId: record.transactionId,
							leaseId: record.leaseId,
						},
					});
				}
				return contexts;
			} catch {
				return [];
			}
		});
	}

	async releaseWindow(windowId: number): Promise<void> {
		await this.exclusively(async () => {
			await this.ensureLoaded();
			if (!this.windows.delete(windowId)) return;
			this.pendingCreatedThisWorker.delete(windowId);
			await this.saveOrPoison();
		});
	}
}
