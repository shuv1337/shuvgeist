import { describe, expect, it, vi } from "vitest";

import type {
	SidepanelCapabilityMaterial,
	SidepanelWindowConfirmRequest,
	SidepanelWindowPrepareRequest,
} from "@shuvgeist/extension/agent/sidepanel-context-identity";
import {
	SidepanelWindowAuthority,
	type SidepanelAuthorityContext,
	type SidepanelAuthoritySender,
	type SidepanelWindowAuthorityState,
} from "@shuvgeist/extension/agent/sidepanel-window-authority";

const extensionId = "extension-id";
const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
const contextType = "SIDE_PANEL";
const nonceA1 = "00000000-0000-4000-8000-000000000011";
const nonceA2 = "00000000-0000-4000-8000-000000000012";
const nonceA3 = "00000000-0000-4000-8000-000000000013";
const nonceB = "00000000-0000-4000-8000-000000000021";

function context(contextId: string, documentId: string, nonce?: string, windowId = -1): SidepanelAuthorityContext {
	return {
		contextId,
		contextType,
		documentId,
		documentOrigin: `chrome-extension://${extensionId}`,
		documentUrl: `${sidepanelUrl}${nonce ? `?shuvgeistContext=${nonce}` : ""}`,
		frameId: -1,
		tabId: -1,
		windowId,
	};
}

function sender(documentId?: string): SidepanelAuthoritySender {
	return {
		id: extensionId,
		url: sidepanelUrl,
		origin: `chrome-extension://${extensionId}`,
		...(documentId ? { documentId } : {}),
		documentLifecycle: "active",
	};
}

function prepareRequest(nonce: string, proof?: SidepanelCapabilityMaterial): SidepanelWindowPrepareRequest {
	return { type: "sidepanel-prepare-window", nonce, ...(proof ? { proof } : {}) };
}

function confirmRequest(nonce: string, material: SidepanelCapabilityMaterial): SidepanelWindowConfirmRequest {
	return { type: "sidepanel-confirm-window", nonce, ...material };
}

function token(index: number): string {
	return index.toString(16).padStart(64, "0");
}

function capabilityId(index: number): string {
	return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function materialFrom(response: {
	ok: boolean;
	continuationToken?: string;
	transactionId?: string;
	leaseId?: string;
}): SidepanelCapabilityMaterial {
	if (!response.ok || !response.continuationToken || !response.transactionId || !response.leaseId) {
		throw new Error("expected successful capability response");
	}
	return {
		continuationToken: response.continuationToken,
		transactionId: response.transactionId,
		leaseId: response.leaseId,
	};
}

function harness(
	initialContexts: SidepanelAuthorityContext[] = [],
	overrides: {
		stored?: unknown;
		wait?(delayMs: number): Promise<void>;
		createContinuationToken?(): string;
		createCapabilityId?(): string;
		hashContinuationToken?(value: string): Promise<string>;
	} = {},
) {
	let contexts = initialContexts;
	let stored = structuredClone(overrides.stored);
	let tokenIndex = 1;
	let idIndex = 1;
	const saves: SidepanelWindowAuthorityState[] = [];
	const storage = {
		load: vi.fn(async () => structuredClone(stored)),
		save: vi.fn(async (state: SidepanelWindowAuthorityState) => {
			stored = structuredClone(state);
			saves.push(structuredClone(state));
		}),
	};
	const createAuthority = () =>
		new SidepanelWindowAuthority({
			extensionId,
			sidepanelUrl,
			sidePanelContextType: contextType,
			getContexts: async () => structuredClone(contexts),
			storage,
			openedEventSettleDelayMs: 0,
			openedContextMaxAttempts: 1,
			createContinuationToken: overrides.createContinuationToken ?? (() => token(tokenIndex++)),
			createCapabilityId: overrides.createCapabilityId ?? (() => capabilityId(idIndex++)),
			...(overrides.hashContinuationToken ? { hashContinuationToken: overrides.hashContinuationToken } : {}),
			...(overrides.wait ? { wait: overrides.wait } : {}),
		});
	return {
		createAuthority,
		storage,
		saves,
		setContexts(next: SidepanelAuthorityContext[]) {
			contexts = next;
		},
		stored: () => structuredClone(stored),
	};
}

async function openAndActivate(
	fixture: ReturnType<typeof harness>,
	contextId = "context-a",
	documentId = "document-a",
	nonce = nonceA1,
	windowId = 11,
): Promise<{ authority: SidepanelWindowAuthority; material: SidepanelCapabilityMaterial }> {
	fixture.setContexts([context(contextId, documentId)]);
	const authority = fixture.createAuthority();
	await authority.observeOpened({ path: "/sidepanel.html", windowId });
	fixture.setContexts([context(contextId, documentId, nonce)]);
	const pending = await authority.prepareWindow(prepareRequest(nonce), sender(documentId));
	const material = materialFrom(pending);
	await expect(authority.resolveActiveLease(nonce, material, documentId)).resolves.toBeUndefined();
	await expect(authority.confirmWindow(confirmRequest(nonce, material), sender(documentId))).resolves.toMatchObject({
		ok: true,
		phase: "active",
		windowId,
	});
	return { authority, material };
}

describe("sidepanel browser-window authority ratchet", () => {
	it("persists pending before exposing a raw token and admits ports only after durable confirmation", async () => {
		const fixture = harness();
		const { authority, material } = await openAndActivate(fixture);
		expect(fixture.saves.map((state) => state.windows[0]?.stage)).toEqual(["opened", "pending", "active"]);
		const pendingState = fixture.saves[1];
		expect(JSON.stringify(pendingState)).not.toContain(material.continuationToken);
		expect(pendingState?.windows[0]).toMatchObject({
			stage: "pending",
			candidate: { contextId: "context-a", documentId: "document-a", documentNonce: nonceA1 },
			next: { transactionId: material.transactionId, leaseId: material.leaseId },
		});
		await expect(authority.resolveActiveLease(nonceA1, material, "document-a")).resolves.toMatchObject({
			contextId: "context-a",
			windowId: 11,
			lease: { transactionId: material.transactionId, leaseId: material.leaseId },
		});
	});

	it("makes confirmation idempotent without another persistence write", async () => {
		const fixture = harness();
		const { authority, material } = await openAndActivate(fixture);
		const saveCount = fixture.storage.save.mock.calls.length;
		await expect(authority.confirmWindow(confirmRequest(nonceA1, material), sender("document-a"))).resolves.toMatchObject({
			ok: true,
			phase: "active",
		});
		expect(fixture.storage.save).toHaveBeenCalledTimes(saveCount);
	});

	it("rotates every capability component across an active full reload and fences the old lease before confirm", async () => {
		const fixture = harness();
		const { authority, material: active } = await openAndActivate(fixture);
		const activeState = fixture.stored() as SidepanelWindowAuthorityState;
		const activeRecord = activeState.windows[0];
		if (!activeRecord || activeRecord.stage !== "active") throw new Error("expected active authority");
		fixture.setContexts([context("context-a2", "document-a2", nonceA2)]);
		const pendingResponse = await authority.prepareWindow(prepareRequest(nonceA2, active), sender("document-a2"));
		const pending = materialFrom(pendingResponse);
		expect(pending).not.toEqual(active);
		expect(pending.continuationToken).not.toBe(active.continuationToken);
		expect(new Set([pending.transactionId, pending.leaseId, active.transactionId, active.leaseId]).size).toBe(4);
		const pendingState = fixture.stored() as SidepanelWindowAuthorityState;
		const pendingRecord = pendingState.windows[0];
		if (!pendingRecord || pendingRecord.stage !== "pending") throw new Error("expected pending authority");
		expect(pendingRecord.next.verifierDigest).not.toBe(activeRecord.verifierDigest);
		await expect(authority.resolveActiveLease(nonceA1, active, "document-a")).resolves.toBeUndefined();
		await expect(authority.resolveActiveLease(nonceA2, pending, "document-a2")).resolves.toBeUndefined();
		await authority.confirmWindow(confirmRequest(nonceA2, pending), sender("document-a2"));
		await expect(authority.resolveActiveLease(nonceA2, pending, "document-a2")).resolves.toBeDefined();
	});

	it("advances a pre-confirm reload one-way and rejects the superseded pending token", async () => {
		const fixture = harness([context("context-a", "document-a")]);
		const authority = fixture.createAuthority();
		await authority.observeOpened({ path: "/sidepanel.html", windowId: 11 });
		fixture.setContexts([context("context-a", "document-a", nonceA1)]);
		const first = materialFrom(await authority.prepareWindow(prepareRequest(nonceA1), sender("document-a")));
		fixture.setContexts([context("context-a2", "document-a2", nonceA2)]);
		const second = materialFrom(await authority.prepareWindow(prepareRequest(nonceA2, first), sender("document-a2")));
		expect(second).not.toEqual(first);
		await expect(authority.confirmWindow(confirmRequest(nonceA2, first), sender("document-a2"))).resolves.toMatchObject({
			ok: false,
		});
		await expect(authority.confirmWindow(confirmRequest(nonceA2, second), sender("document-a2"))).resolves.toMatchObject({
			ok: true,
		});
	});

	it("does not let an old active proof jump over a pending hop", async () => {
		const fixture = harness();
		const { authority, material: active } = await openAndActivate(fixture);
		fixture.setContexts([context("context-a2", "document-a2", nonceA2)]);
		const pending = materialFrom(await authority.prepareWindow(prepareRequest(nonceA2, active), sender("document-a2")));
		fixture.setContexts([context("context-a3", "document-a3", nonceA3)]);
		await expect(authority.prepareWindow(prepareRequest(nonceA3, active), sender("document-a3"))).resolves.toMatchObject({
			ok: false,
		});
		await expect(authority.prepareWindow(prepareRequest(nonceA3, pending), sender("document-a3"))).resolves.toMatchObject({
			ok: true,
		});
	});

	it("recovers a lost prepare only after a clean worker restart for the same candidate", async () => {
		const fixture = harness([context("context-a", "document-a")]);
		const firstWorker = fixture.createAuthority();
		await firstWorker.observeOpened({ path: "/sidepanel.html", windowId: 11 });
		fixture.setContexts([context("context-a", "document-a", nonceA1)]);
		const lost = materialFrom(await firstWorker.prepareWindow(prepareRequest(nonceA1), sender("document-a")));
		await expect(firstWorker.prepareWindow(prepareRequest(nonceA1), sender("document-a"))).resolves.toMatchObject({
			ok: false,
		});
		const restarted = fixture.createAuthority();
		const recovered = materialFrom(await restarted.prepareWindow(prepareRequest(nonceA1), sender("document-a")));
		expect(recovered).not.toEqual(lost);
	});

	it("consumes restart recovery eligibility when the pending-next proof is observed", async () => {
		const fixture = harness();
		const { authority, material: active } = await openAndActivate(fixture);
		fixture.setContexts([context("context-a2", "document-a2", nonceA2)]);
		const pending = materialFrom(await authority.prepareWindow(prepareRequest(nonceA2, active), sender("document-a2")));
		const restarted = fixture.createAuthority();
		await expect(restarted.prepareWindow(prepareRequest(nonceA2, pending), sender("document-a2"))).resolves.toMatchObject({
			ok: true,
			continuationToken: pending.continuationToken,
		});
		await expect(restarted.prepareWindow(prepareRequest(nonceA2, active), sender("document-a2"))).resolves.toMatchObject({
			ok: false,
		});
	});

	it.each([
		["contextId", "context-a2", "document-a"],
		["documentId", "context-a", "document-a2"],
	])("restores a pending lineage when only %s rotates", async (_label, nextContextId, nextDocumentId) => {
		const fixture = harness();
		const { authority, material: active } = await openAndActivate(fixture);
		fixture.setContexts([context(nextContextId, nextDocumentId, nonceA2)]);
		const pending = materialFrom(
			await authority.prepareWindow(prepareRequest(nonceA2, active), sender(nextDocumentId)),
		);
		const restarted = fixture.createAuthority();
		await expect(
			restarted.confirmWindow(confirmRequest(nonceA2, pending), sender(nextDocumentId)),
		).resolves.toMatchObject({ ok: true, phase: "active" });
	});

	it("requires both the predecessor document and every raw match for its old nonce to disappear", async () => {
		const fixture = harness();
		const { authority, material: active } = await openAndActivate(fixture);
		fixture.setContexts([
			context("context-a2", "document-a2", nonceA2),
			context("unbound-old-nonce", "unbound-document", nonceA1),
		]);
		await expect(authority.prepareWindow(prepareRequest(nonceA2, active), sender("document-a2"))).resolves.toMatchObject({
			ok: false,
		});
	});

	it("rejects a nonce duplicated across raw live contexts before authority filtering", async () => {
		const fixture = harness();
		const { authority, material } = await openAndActivate(fixture);
		fixture.setContexts([
			context("context-a", "document-a", nonceA1),
			context("unbound", "unbound-document", nonceA1),
		]);
		await expect(authority.resolveActiveLease(nonceA1, material, "document-a")).resolves.toBeUndefined();
	});

	it("revokes a same-window lease before an ambiguous onOpened attribution settles", async () => {
		let releaseWait = () => {};
		let gateWait = false;
		const waitGate = new Promise<void>((resolve) => {
			releaseWait = resolve;
		});
		const fixture = harness([], { wait: async () => (gateWait ? waitGate : undefined) });
		const { authority, material } = await openAndActivate(fixture);
		gateWait = true;
		fixture.setContexts([
			context("context-a", "document-a", nonceA1),
			context("replacement", "replacement-document"),
		]);
		const opening = authority.observeOpened({ path: "/sidepanel.html", windowId: 11 });
		await expect(authority.isLeaseCurrent({
			windowId: 11,
			contextId: "context-a",
			documentId: "document-a",
			documentNonce: nonceA1,
			transactionId: material.transactionId,
			leaseId: material.leaseId,
		})).resolves.toBe(false);
		releaseWait();
		await expect(opening).rejects.toThrow("ambiguous sidepanel onOpened");
		expect(fixture.stored()).toEqual({ version: 2, windows: [] });
	});

	it("poisons the current worker when session storage is missing or a save is uncertain", async () => {
		const missing = harness([context("context-a", "document-a")]);
		missing.storage.load.mockRejectedValue(new Error("storage unavailable"));
		const missingAuthority = missing.createAuthority();
		await expect(missingAuthority.observeOpened({ path: "/sidepanel.html", windowId: 11 })).rejects.toThrow(
			"storage unavailable",
		);
		missing.storage.load.mockResolvedValue(undefined);
		await expect(missingAuthority.observeOpened({ path: "/sidepanel.html", windowId: 11 })).rejects.toThrow(
			"unavailable until service-worker restart",
		);

		const uncertain = harness([context("context-a", "document-a")]);
		uncertain.storage.save.mockRejectedValueOnce(new Error("save uncertain"));
		const uncertainAuthority = uncertain.createAuthority();
		await expect(uncertainAuthority.observeOpened({ path: "/sidepanel.html", windowId: 11 })).rejects.toThrow(
			"save uncertain",
		);
		await expect(uncertainAuthority.listAuthorizedContexts()).resolves.toEqual([]);
	});

	it("cleans malformed persisted state for the next restart while denying the current worker", async () => {
		const fixture = harness([], { stored: { version: 2, windows: [{ stage: "active", windowId: 11 }] } });
		const poisoned = fixture.createAuthority();
		await expect(poisoned.listAuthorizedContexts()).resolves.toEqual([]);
		expect(fixture.storage.save).toHaveBeenCalledWith({ version: 2, windows: [] });
		fixture.setContexts([context("context-a", "document-a")]);
		await expect(poisoned.observeOpened({ path: "/sidepanel.html", windowId: 11 })).rejects.toThrow(
			"unavailable until service-worker restart",
		);
		await expect(fixture.createAuthority().observeOpened({ path: "/sidepanel.html", windowId: 11 })).resolves.toEqual({
			contextId: "context-a",
			windowId: 11,
		});
	});

	it("rejects generated transaction/lease collisions and revalidates the live candidate after hashing", async () => {
		const collision = harness([context("context-a", "document-a")], {
			createCapabilityId: () => capabilityId(1),
		});
		const collisionAuthority = collision.createAuthority();
		await collisionAuthority.observeOpened({ path: "/sidepanel.html", windowId: 11 });
		collision.setContexts([context("context-a", "document-a", nonceA1)]);
		await expect(collisionAuthority.prepareWindow(prepareRequest(nonceA1), sender("document-a"))).rejects.toThrow(
			"colliding ids",
		);

		let fixture: ReturnType<typeof harness>;
		fixture = harness([context("context-a", "document-a")], {
			hashContinuationToken: async () => {
				fixture.setContexts([]);
				return "b".repeat(64);
			},
		});
		const authority = fixture.createAuthority();
		await authority.observeOpened({ path: "/sidepanel.html", windowId: 11 });
		fixture.setContexts([context("context-a", "document-a", nonceA1)]);
		await expect(authority.prepareWindow(prepareRequest(nonceA1), sender("document-a"))).resolves.toMatchObject({
			ok: false,
		});
	});

	it("accepts a canonical stale reload URL while joining the current live nonce and capability", async () => {
		const fixture = harness();
		const { authority, material: active } = await openAndActivate(fixture);
		fixture.setContexts([context("context-a2", "document-a2", nonceA2)]);
		const reloadSender: SidepanelAuthoritySender = {
			...sender(),
			url: `${sidepanelUrl}?session=${capabilityId(80)}&shuvgeistContext=${nonceA1}`,
		};
		const pending = await authority.prepareWindow(prepareRequest(nonceA2, active), reloadSender);
		expect(pending).toMatchObject({ ok: true, phase: "pending", windowId: 11 });
		await expect(
			authority.confirmWindow(confirmRequest(nonceA2, materialFrom(pending)), reloadSender),
		).resolves.toMatchObject({ ok: true, phase: "active", windowId: 11 });
	});

	it("rejects noncanonical sender routes, mismatched document ids, and contradictory native windows", async () => {
		const fixture = harness([context("context-a", "document-a")]);
		const authority = fixture.createAuthority();
		await authority.observeOpened({ path: "/sidepanel.html", windowId: 11 });
		fixture.setContexts([context("context-a", "document-a", nonceA1, 22)]);
		for (const url of [
			`${sidepanelUrl}?forged=1`,
			`${sidepanelUrl}?shuvgeistContext=${nonceA1}&shuvgeistContext=${nonceA2}`,
			`${sidepanelUrl}#forged`,
		]) {
			await expect(
				authority.prepareWindow(prepareRequest(nonceA1), { ...sender("document-a"), url }),
				url,
			).resolves.toMatchObject({ ok: false });
		}
		await expect(
			authority.prepareWindow(prepareRequest(nonceA1), sender("wrong-document")),
		).resolves.toMatchObject({ ok: false });
		await expect(authority.prepareWindow(prepareRequest(nonceA1), sender("document-a"))).resolves.toMatchObject({
			ok: false,
		});
	});

	it("serializes concurrent successor prepares so only one distinct candidate wins", async () => {
		const fixture = harness();
		const { authority, material: active } = await openAndActivate(fixture);
		fixture.setContexts([
			context("context-a2", "document-a2", nonceA2),
			context("context-a3", "document-a3", nonceA3),
		]);
		const results = await Promise.all([
			authority.prepareWindow(prepareRequest(nonceA2, active), sender("document-a2")),
			authority.prepareWindow(prepareRequest(nonceA3, active), sender("document-a3")),
		]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok)).toHaveLength(1);
	});

	it("poisons transfer and confirmation after uncertain persistence without exposing usable authority", async () => {
		const transferFixture = harness();
		const { authority: transferAuthority, material: active } = await openAndActivate(transferFixture);
		transferFixture.setContexts([context("context-a2", "document-a2", nonceA2)]);
		transferFixture.storage.save.mockRejectedValueOnce(new Error("transfer save uncertain"));
		await expect(
			transferAuthority.prepareWindow(prepareRequest(nonceA2, active), sender("document-a2")),
		).rejects.toThrow("transfer save uncertain");
		await expect(transferAuthority.resolveActiveLease(nonceA1, active, "document-a")).resolves.toBeUndefined();

		const confirmFixture = harness([context("context-a", "document-a")]);
		const confirmAuthority = confirmFixture.createAuthority();
		await confirmAuthority.observeOpened({ path: "/sidepanel.html", windowId: 11 });
		confirmFixture.setContexts([context("context-a", "document-a", nonceA1)]);
		const pending = materialFrom(
			await confirmAuthority.prepareWindow(prepareRequest(nonceA1), sender("document-a")),
		);
		confirmFixture.storage.save.mockRejectedValueOnce(new Error("confirm save uncertain"));
		await expect(
			confirmAuthority.confirmWindow(confirmRequest(nonceA1, pending), sender("document-a")),
		).rejects.toThrow("confirm save uncertain");
		await expect(confirmAuthority.resolveActiveLease(nonceA1, pending, "document-a")).resolves.toBeUndefined();
	});

	it("durably replaces a same-window onOpened record and rejects the prior token", async () => {
		const fixture = harness();
		const { authority, material: active } = await openAndActivate(fixture);
		fixture.setContexts([context("replacement-context", "replacement-document")]);
		await expect(authority.observeOpened({ path: "/sidepanel.html", windowId: 11 })).resolves.toEqual({
			contextId: "replacement-context",
			windowId: 11,
		});
		await expect(authority.resolveActiveLease(nonceA1, active, "document-a")).resolves.toBeUndefined();
		expect(fixture.stored()).toEqual({
			version: 2,
			windows: [
				{
					stage: "opened",
					windowId: 11,
					contextId: "replacement-context",
					documentId: "replacement-document",
				},
			],
		});
	});

	it("releases durable authority even after the raw context vanishes", async () => {
		const fixture = harness();
		const { authority, material } = await openAndActivate(fixture);
		fixture.setContexts([]);
		await authority.releaseWindow(11);
		expect(fixture.stored()).toEqual({ version: 2, windows: [] });
		await expect(
			authority.isLeaseCurrent({
				windowId: 11,
				contextId: "context-a",
				documentId: "document-a",
				documentNonce: nonceA1,
				transactionId: material.transactionId,
				leaseId: material.leaseId,
			}),
		).resolves.toBe(false);
	});

	it("strictly rejects legacy, unknown-key, and cross-window duplicate persisted authority", async () => {
		const validFixture = harness();
		await openAndActivate(validFixture);
		const valid = validFixture.stored() as SidepanelWindowAuthorityState;
		const active = valid.windows[0];
		if (!active || active.stage !== "active") throw new Error("expected active test state");
		const malformedStates: unknown[] = [
			{ version: 1, bindings: [] },
			{ ...valid, unexpected: true },
			{
				version: 2,
				windows: [
					active,
					{ ...active, windowId: 22 },
				],
			},
			{
				version: 2,
				windows: [
					active,
					{
						...active,
						windowId: 22,
						candidate: {
							contextId: "context-b",
							documentId: "document-b",
							documentNonce: nonceB,
						},
						transactionId: capabilityId(90),
						leaseId: capabilityId(91),
					},
				],
			},
		];
		for (const malformed of malformedStates) {
			const fixture = harness([], { stored: malformed });
			await expect(fixture.createAuthority().listAuthorizedContexts()).resolves.toEqual([]);
			expect(fixture.storage.save).toHaveBeenCalledWith({ version: 2, windows: [] });
		}
	});

	it("rejects a verifier collision with prior current authority", async () => {
		const fixture = harness([], { hashContinuationToken: async () => "b".repeat(64) });
		const { authority, material: active } = await openAndActivate(fixture);
		fixture.setContexts([context("context-a2", "document-a2", nonceA2)]);
		await expect(authority.prepareWindow(prepareRequest(nonceA2, active), sender("document-a2"))).rejects.toThrow(
			"previously used value",
		);
	});
});
