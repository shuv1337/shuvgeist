import { describe, expect, it, vi } from "vitest";

import {
	agentRuntimePortName,
	confirmSidepanelWindowIdentity,
	isCanonicalSidepanelSenderUrl,
	isSidepanelWindowConfirmRequest,
	isSidepanelWindowPrepareRequest,
	parseAgentRuntimePortName,
	parseSidepanelTrackingPortName,
	planSidepanelDocumentBootstrap,
	prepareSidepanelWindowIdentity,
	sidepanelDocumentNonce,
	sidepanelTrackingPortName,
	type SidepanelCapabilityMaterial,
} from "@shuvgeist/extension/agent/sidepanel-context-identity";

const firstNonce = "00000000-0000-4000-8000-000000000007";
const secondNonce = "00000000-0000-4000-8000-000000000008";
const sessionId = "00000000-0000-4000-8000-000000000009";
const material: SidepanelCapabilityMaterial = {
	continuationToken: "a".repeat(64),
	transactionId: "00000000-0000-4000-8000-000000000017",
	leaseId: "00000000-0000-4000-8000-000000000027",
};

describe("sidepanel context identity", () => {
	it("accepts only the canonical sidepanel sender route grammar", () => {
		const base = "chrome-extension://extension-id/sidepanel.html";
		const debugSteps = encodeURIComponent(JSON.stringify(["inspect the page", "report the title"]));
		for (const accepted of [
			base,
			`${base}?shuvgeistContext=${firstNonce}`,
			`${base}?session=${sessionId}&shuvgeistContext=${firstNonce}`,
			`${base}?new=true&shuvgeistContext=${firstNonce}`,
			`${base}?teststeps=${debugSteps}&provider=openrouter&model=z-ai%2Fglm-4.6&session=${sessionId}&shuvgeistContext=${firstNonce}`,
		]) {
			expect(isCanonicalSidepanelSenderUrl(accepted, base), accepted).toBe(true);
		}

		for (const rejected of [
			`${base}?unknown=value`,
			`${base}?shuvgeistContext=${firstNonce}&shuvgeistContext=${secondNonce}`,
			`${base}?session=${sessionId}&session=${sessionId}`,
			`${base}?session=not-a-uuid`,
			`${base}?new=false`,
			`${base}?new=true&session=${sessionId}`,
			`${base}?provider=openai&model=gpt-5`,
			`${base}?teststeps=${debugSteps}&provider=openai`,
			`${base}?teststeps=not-json&provider=openai&model=gpt-5`,
			`${base}#forged`,
			"chrome-extension://other-extension/sidepanel.html",
			"chrome-extension://extension-id/settings.html",
		]) {
			expect(isCanonicalSidepanelSenderUrl(rejected, base), rejected).toBe(false);
		}
	});

	it("rotates the non-secret document nonce without duplicating its query parameter", () => {
		const first = planSidepanelDocumentBootstrap(
			"chrome-extension://extension-id/sidepanel.html?session=session-1",
			() => firstNonce,
		);
		expect(sidepanelDocumentNonce(first.url)).toBe(firstNonce);
		const second = planSidepanelDocumentBootstrap(first.url, () => secondNonce);
		expect(sidepanelDocumentNonce(second.url)).toBe(secondNonce);
		expect(new URL(second.url).searchParams.getAll("shuvgeistContext")).toEqual([secondNonce]);
	});

	it("round-trips canonical runtime and tracking names with token, transaction, and lease material", () => {
		const runtimeIdentity = {
			clientId: "sidepanel/client",
			windowId: 7,
			documentNonce: firstNonce,
			...material,
		};
		const trackingIdentity = { windowId: 7, documentNonce: firstNonce, ...material };
		const runtimeName = agentRuntimePortName(runtimeIdentity);
		const trackingName = sidepanelTrackingPortName(trackingIdentity);
		expect(runtimeName).toBe(
			`agent-runtime:sidepanel%2Fclient:7:${firstNonce}:${material.continuationToken}:${material.transactionId}:${material.leaseId}`,
		);
		expect(trackingName).toBe(
			`sidepanel:7:${firstNonce}:${material.continuationToken}:${material.transactionId}:${material.leaseId}`,
		);
		expect(parseAgentRuntimePortName(runtimeName)).toEqual(runtimeIdentity);
		expect(parseSidepanelTrackingPortName(trackingName)).toEqual(trackingIdentity);
		for (const malformed of [
			`agent-runtime:sidepanel:7:${firstNonce}`,
			`agent-runtime:sidepanel:07:${firstNonce}:${material.continuationToken}:${material.transactionId}:${material.leaseId}`,
			`${runtimeName}:extra`,
			runtimeName.replace(material.leaseId, "not-a-lease"),
		]) {
			expect(parseAgentRuntimePortName(malformed), malformed).toBeUndefined();
		}
	});

	it("prepares with prior proof, then confirms the exact pending capability", async () => {
		const sendMessage = vi
			.fn<(message: unknown) => Promise<unknown>>()
			.mockResolvedValueOnce({ ok: true, phase: "pending", windowId: 7, ...material })
			.mockResolvedValueOnce({ ok: true, phase: "active", windowId: 7, ...material });
		const url = `chrome-extension://extension-id/sidepanel.html?shuvgeistContext=${firstNonce}`;
		const pending = await prepareSidepanelWindowIdentity({ sendMessage }, url, material);
		expect(sendMessage).toHaveBeenNthCalledWith(1, {
			type: "sidepanel-prepare-window",
			nonce: firstNonce,
			proof: material,
		});
		await expect(confirmSidepanelWindowIdentity({ sendMessage }, url, material)).resolves.toEqual({
			windowId: 7,
			...material,
		});
		expect(pending).toEqual({ windowId: 7, ...material });
		expect(sendMessage).toHaveBeenNthCalledWith(2, {
			type: "sidepanel-confirm-window",
			nonce: firstNonce,
			...material,
		});
	});

	it("retries idempotent confirmation but rejects malformed authority replies", async () => {
		const wait = vi.fn(async () => undefined);
		const sendMessage = vi
			.fn<(message: unknown) => Promise<unknown>>()
			.mockRejectedValueOnce(new Error("worker stopped"))
			.mockResolvedValueOnce({ ok: true, phase: "active", windowId: 8, ...material });
		await expect(
			confirmSidepanelWindowIdentity(
				{ sendMessage },
				`chrome-extension://extension-id/sidepanel.html?shuvgeistContext=${firstNonce}`,
				material,
				{ maxAttempts: 2, retryDelayMs: 3, wait },
			),
		).resolves.toEqual({ windowId: 8, ...material });
		expect(wait).toHaveBeenCalledWith(3);
	});

	it("strictly validates staged requests and fails closed without a nonce", async () => {
		expect(isSidepanelWindowPrepareRequest({ type: "sidepanel-prepare-window", nonce: firstNonce })).toBe(true);
		expect(
			isSidepanelWindowPrepareRequest({ type: "sidepanel-prepare-window", nonce: firstNonce, windowId: 99 }),
		).toBe(false);
		expect(isSidepanelWindowConfirmRequest({ type: "sidepanel-confirm-window", nonce: firstNonce, ...material })).toBe(
			true,
		);
		expect(
			isSidepanelWindowConfirmRequest({
				type: "sidepanel-confirm-window",
				nonce: firstNonce,
				...material,
				continuationToken: "not-a-token",
			}),
		).toBe(false);
		await expect(
			prepareSidepanelWindowIdentity({ sendMessage: vi.fn() }, "chrome-extension://extension-id/sidepanel.html", undefined),
		).rejects.toThrow("missing its authenticated context nonce");
	});
});
