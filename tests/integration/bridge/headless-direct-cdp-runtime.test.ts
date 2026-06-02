import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Model,
} from "@shuv1337/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { CreateAgentRuntimeOptions } from "../../../src/agent/runtime.js";
import {
	buildDirectCdpSnapshotExpression,
	connectDirectCdpHeadlessRuntime,
	listDirectCdpPageTargets,
} from "../../../src/bridge/headless/direct-cdp-runtime.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected assistant event");
			},
		);
	}
}

function createModel(): Model<Api> {
	return {
		id: "mock",
		name: "Mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createVisionModel(): Model<Api> {
	return {
		...createModel(),
		input: ["text", "image"],
	};
}

function createUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

async function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Could not allocate a TCP port"));
				return;
			}
			const port = address.port;
			server.close((error) => {
				if (error) reject(error);
				else resolve(port);
			});
		});
	});
}

async function waitForPageTarget(port: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			const targets = await listDirectCdpPageTargets({ port });
			if (targets.length > 0) return;
		} catch {
			// Chromium may not have opened the remote-debugging endpoint yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Timed out waiting for headless Chromium page target");
}

describe("direct-CDP headless runtime", () => {
	const chromiumPath = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";
	const runChromiumTest = existsSync(chromiumPath) ? it : it.skip;
	let child: ChildProcessWithoutNullStreams | undefined;
	let userDataDir: string | undefined;

	afterEach(() => {
		child?.kill("SIGKILL");
		child = undefined;
		if (userDataDir) {
			rmSync(userDataDir, { recursive: true, force: true });
			userDataDir = undefined;
		}
	});

	it("builds a snapshot expression with a local transpiler helper shim", () => {
		const expression = buildDirectCdpSnapshotExpression({ frameId: 0, maxEntries: 5, includeHidden: false });
		expect(expression).toContain("const __name = (fn) => fn");
		expect(expression).toContain("maxEntries");
	});

	runChromiumTest(
		"runs a no-extension snapshot to locate to click to snapshot agent loop",
		async () => {
			const port = await getFreePort();
			userDataDir = mkdtempSync(join(tmpdir(), "shuvgeist-t11-"));
			const html =
				"<!doctype html><html><head><title>T11 Headless Runtime</title></head><body>" +
				"<button id=\"run\" onclick=\"window.__clicked=(window.__clicked||0)+1; this.textContent='clicked '+window.__clicked;\">Run headless action</button>" +
				"</body></html>";
			const url = "data:text/html;charset=utf-8," + encodeURIComponent(html);
			child = spawn(
				chromiumPath,
				[
					"--headless=new",
					"--disable-default-apps",
					"--disable-gpu",
					"--no-first-run",
					"--no-sandbox",
					"--remote-debugging-address=127.0.0.1",
					"--remote-debugging-port=" + port,
					"--user-data-dir=" + userDataDir,
					url,
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			await waitForPageTarget(port);

			let callIndex = 0;
			const streamFn: NonNullable<CreateAgentRuntimeOptions["streamFn"]> = () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					let message: AssistantMessage;
					if (callIndex === 0) {
						message = createAssistantMessage(
							[{ type: "toolCall", id: "snapshot-1", name: "page_snapshot", arguments: {} }],
							"toolUse",
						);
					} else if (callIndex === 1) {
						message = createAssistantMessage(
							[
								{
									type: "toolCall",
									id: "locate-1",
									name: "locate_by_role",
									arguments: { role: "button", name: "Run headless action" },
								},
							],
							"toolUse",
						);
					} else if (callIndex === 2) {
						message = createAssistantMessage(
							[{ type: "toolCall", id: "click-1", name: "ref_click", arguments: { refId: "e1" } }],
							"toolUse",
						);
					} else if (callIndex === 3) {
						message = createAssistantMessage(
							[{ type: "toolCall", id: "snapshot-2", name: "page_snapshot", arguments: {} }],
							"toolUse",
						);
					} else {
						message = createAssistantMessage([{ type: "text", text: "done" }]);
					}
					callIndex += 1;
					stream.push({ type: "done", reason: message.stopReason, message });
				});
				return stream;
			};

			const adapter = await connectDirectCdpHeadlessRuntime({
				port,
				model: createModel(),
				streamFn,
				sessionId: "headless-session",
			});
			await adapter.prompt("Click the run headless action button, then inspect the page again.");

			expect(callIndex).toBe(5);
			expect(adapter.lastSnapshot?.entries[0]?.name).toBe("clicked 1");
			expect(adapter.runtime.agent.state.messages.map((message) => message.role)).toContain("toolResult");
			const firstTargetId = adapter.target?.id;
			expect(firstTargetId).toBeTruthy();
			adapter.close();

			const reconnected = await connectDirectCdpHeadlessRuntime({
				port,
				targetId: firstTargetId,
				model: createModel(),
			});
			expect(reconnected.target?.id).toBe(firstTargetId);
			const snapshotAfterReconnect = await reconnected.snapshot();
			expect(snapshotAfterReconnect.entries[0]?.name).toBe("clicked 1");
			reconnected.close();
		},
		30_000,
	);

	runChromiumTest(
		"captures a gated screenshot plus structured candidate JSON baseline",
		async () => {
			const port = await getFreePort();
			userDataDir = mkdtempSync(join(tmpdir(), "shuvgeist-t13-"));
			const html =
				"<!doctype html><html><head><title>T13 Vision Baseline</title></head><body>" +
				'<main><button id="archive">Archive selected invoice</button>' +
				'<button id="hold">Hold selected invoice</button></main>' +
				"</body></html>";
			const url = "data:text/html;charset=utf-8," + encodeURIComponent(html);
			child = spawn(
				chromiumPath,
				[
					"--headless=new",
					"--disable-default-apps",
					"--disable-gpu",
					"--no-first-run",
					"--no-sandbox",
					"--remote-debugging-address=127.0.0.1",
					"--remote-debugging-port=" + port,
					"--user-data-dir=" + userDataDir,
					url,
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			await waitForPageTarget(port);

			const adapter = await connectDirectCdpHeadlessRuntime({
				port,
				model: createVisionModel(),
			});
			const baseline = await adapter.captureVisionCandidateBaseline({
				model: createVisionModel(),
				trigger: "ambiguous-ref",
				snapshotOptions: { query: "invoice", maxEntries: 10 },
			});

			expect(baseline.trigger).toBe("ambiguous-ref");
			expect(baseline.model.input).toContain("image");
			expect(baseline.screenshot.mimeType).toBe("image/png");
			expect(baseline.screenshot.dataUrl).toMatch(/^data:image\/png;base64,/);
			expect(Buffer.from(baseline.screenshot.data, "base64").byteLength).toBeGreaterThan(0);
			expect(baseline.candidates).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						role: "button",
						name: "Archive selected invoice",
						interactive: true,
					}),
				]),
			);
			expect(JSON.stringify(baseline.candidates)).not.toContain('"mark"');
			adapter.close();
		},
		30_000,
	);
});
