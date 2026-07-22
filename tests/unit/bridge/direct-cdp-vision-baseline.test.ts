import type { Api, Model } from "@shuv1337/pi-ai";
import { describe, expect, it } from "vitest";
import {
	DirectCdpAgentSessionAdapter,
	buildDirectCdpVisionCandidateBaseline,
	modelSupportsVision,
	type DirectCdpScreenshotResult,
} from "shuvgeist/direct-cdp-runtime";
import type {
	CdpSession,
	CdpSessionCloseListener,
	CdpSessionEventListener,
} from "@shuvgeist/driver/cdp-session";
import type { PageSnapshotResult } from "@shuvgeist/extension/tools/page-snapshot";

class RejectingCdpSession implements CdpSession {
	readonly target = { kind: "electron-ws" as const, id: "unit" };
	readonly navigationGeneration = 0;
	readonly calls: string[] = [];

	async acquire(): Promise<void> {
		this.calls.push("acquire");
	}

	async release(): Promise<void> {
		this.calls.push("release");
	}

	async ensureDomain(): Promise<void> {
		this.calls.push("ensureDomain");
		throw new Error("Unexpected CDP domain enable");
	}

	async send(): Promise<unknown> {
		this.calls.push("send");
		throw new Error("Unexpected CDP command");
	}

	onEvent(_method: string, _listener: CdpSessionEventListener): () => void {
		return () => {};
	}

	onClose(_listener: CdpSessionCloseListener): () => void {
		return () => {};
	}
}

function createModel(input: Model<Api>["input"]): Model<Api> {
	return {
		id: "mock",
		name: "Mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createSnapshot(): PageSnapshotResult {
	return {
		tabId: 0,
		frameId: 0,
		query: "invoice",
		url: "https://example.invalid/invoices",
		title: "Invoices",
		generatedAt: 1,
		totalCandidates: 1,
		truncated: false,
		entries: [
			{
				snapshotId: "e1",
				stableElementId: "stable-1",
				tabId: 0,
				frameId: 0,
				tagName: "button",
				role: "button",
				name: "Archive selected invoice",
				attributes: { id: "archive" },
				selectorCandidates: ["#archive"],
				ordinalPath: [0, 1],
				boundingBox: { x: 12, y: 24, width: 120, height: 32 },
				interactive: true,
			},
		],
	};
}

function createScreenshot(): DirectCdpScreenshotResult {
	return {
		format: "png",
		mimeType: "image/png",
		data: "c2VlZA==",
		dataUrl: "data:image/png;base64,c2VlZA==",
	};
}

describe("direct-CDP vision candidate baseline", () => {
	it("detects vision-capable models from the pi-ai model input contract", () => {
		expect(modelSupportsVision(createModel(["text", "image"]))).toBe(true);
		expect(modelSupportsVision(createModel(["text"]))).toBe(false);
		expect(modelSupportsVision(undefined)).toBe(false);
	});

	it("builds screenshot plus structured candidate JSON without numbered marks", () => {
		const baseline = buildDirectCdpVisionCandidateBaseline({
			model: createModel(["text", "image"]),
			trigger: "planner-validator-failure",
			screenshot: createScreenshot(),
			snapshot: createSnapshot(),
		});

		expect(baseline).toMatchObject({
			ok: true,
			trigger: "planner-validator-failure",
			model: { provider: "openai", id: "mock", input: ["text", "image"] },
			screenshot: { mimeType: "image/png" },
			snapshot: { candidateCount: 1, query: "invoice" },
		});
		expect(baseline.candidates).toEqual([
			expect.objectContaining({
				refId: "e1",
				stableElementId: "stable-1",
				role: "button",
				name: "Archive selected invoice",
				boundingBox: { x: 12, y: 24, width: 120, height: 32 },
			}),
		]);
		expect(JSON.stringify(baseline.candidates)).not.toContain('"mark"');
		expect(JSON.stringify(baseline.candidates)).not.toContain('"badge"');
	});

	it("rejects capture for text-only models before touching CDP", async () => {
		const cdp = new RejectingCdpSession();
		const adapter = new DirectCdpAgentSessionAdapter({ cdp });

		await expect(
			adapter.captureVisionCandidateBaseline({
				model: createModel(["text"]),
				trigger: "ambiguous-ref",
			}),
		).rejects.toThrow("vision-capable model");
		expect(cdp.calls).toEqual([]);
	});

	it("rejects unknown fallback triggers before touching CDP", async () => {
		const cdp = new RejectingCdpSession();
		const adapter = new DirectCdpAgentSessionAdapter({ cdp });

		await expect(
			adapter.captureVisionCandidateBaseline({
				model: createModel(["text", "image"]),
				trigger: "manual" as unknown as "ambiguous-ref",
			}),
		).rejects.toThrow("explicit fallback trigger");
		expect(cdp.calls).toEqual([]);
	});
});
