import { spawn, type ChildProcess } from "node:child_process";
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
import type { CreateAgentRuntimeOptions } from "@shuvgeist/driver/runtime";
import { SNAPSHOT_INJECTED_ARTIFACT } from "@shuvgeist/driver/driver-artifacts-generated";
import {
	buildDirectCdpSnapshotExpression,
	connectDirectCdpHeadlessRuntime,
	type DirectCdpLocateResult,
	listDirectCdpPageTargets,
} from "shuvgeist/direct-cdp-runtime";

const CHROMIUM_STARTUP_TIMEOUT_MS = 30_000;
const CHROMIUM_TEST_TIMEOUT_MS = 60_000;

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
	const deadline = Date.now() + CHROMIUM_STARTUP_TIMEOUT_MS;
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

async function stopChildProcess(childProcess: ChildProcess | undefined): Promise<void> {
	if (!childProcess) return;
	if (childProcess.exitCode !== null || childProcess.signalCode !== null) {
		if (process.platform !== "win32" && childProcess.pid) {
			try {
				process.kill(-childProcess.pid, "SIGKILL");
			} catch {}
		}
		return;
	}
	await new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			childProcess.off("exit", finish);
			resolve();
		};
		const timeout = setTimeout(finish, 2_000);
		childProcess.once("exit", finish);
		try {
			if (process.platform !== "win32" && childProcess.pid) process.kill(-childProcess.pid, "SIGKILL");
			else if (!childProcess.kill("SIGKILL")) finish();
		} catch {
			if (!childProcess.kill("SIGKILL")) finish();
		}
	});
}

describe("direct-CDP headless runtime", () => {
	const chromiumPath = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";
	const runChromiumTest = existsSync(chromiumPath) ? it : it.skip;
	let child: ChildProcess | undefined;
	let userDataDir: string | undefined;

	afterEach(async () => {
		await stopChildProcess(child);
		child = undefined;
		if (userDataDir) {
			rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			userDataDir = undefined;
		}
	});

	it("builds a self-contained compiled snapshot expression", () => {
		const expression = buildDirectCdpSnapshotExpression({
			frameId: 0,
			maxEntries: 5,
			includeHidden: false,
			query: "focused composer",
		});
		expect(expression).toContain(SNAPSHOT_INJECTED_ARTIFACT.globalName);
		expect(expression).not.toContain("const __name = (fn) => fn");
		expect(expression).toContain("maxEntries");
		expect(expression).toContain('"query":"focused composer"');
		expect(() => new Function(`return ${expression};`)).not.toThrow();
	});

	runChromiumTest(
		"runs a no-extension snapshot to locate to click to snapshot agent loop",
		async () => {
			const port = await getFreePort();
			userDataDir = mkdtempSync(join(tmpdir(), "shuvgeist-t11-"));
			const html =
				"<!doctype html><html><head><title>T11 Headless Runtime</title></head><body>" +
				"<button id=\"run\" onclick=\"window.__clicked=(window.__clicked||0)+1; this.textContent='clicked '+window.__clicked;\">Run headless action</button>" +
				'<div contenteditable="true" aria-label="Composer"><strong>Old draft</strong></div>' +
				"</body></html>";
			const url = "data:text/html;charset=utf-8," + encodeURIComponent(html);
			child = spawn(
				chromiumPath,
				[
					"--headless=new",
					"--disable-default-apps",
					"--disable-dev-shm-usage",
					"--disable-gpu",
					"--no-first-run",
					"--no-sandbox",
					"--remote-debugging-address=127.0.0.1",
					"--remote-debugging-port=" + port,
					"--user-data-dir=" + userDataDir,
					url,
				],
				{ detached: true, stdio: "ignore" },
			);
			await waitForPageTarget(port);

			let callIndex = 0;
			const streamFn: NonNullable<CreateAgentRuntimeOptions["streamFn"]> = (_model, context) => {
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
						const locateResult = [...context.messages]
							.reverse()
							.find((message) => message.role === "toolResult" && message.toolName === "locate_by_role")
							?.details as DirectCdpLocateResult | undefined;
						const refId = locateResult?.matches[0]?.refId;
						if (!refId) throw new Error("Locate tool did not return a dynamic ref");
						message = createAssistantMessage(
							[{ type: "toolCall", id: "click-1", name: "ref_click", arguments: { refId } }],
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
			expect(adapter).not.toHaveProperty("cdp");
			expect(adapter.lastSnapshot?.snapshot.entries[0]?.name).toBe("clicked 1");
			expect(adapter.lastSnapshot?.scope).toMatchObject({
				page: {
					transport: "websocket-cdp",
					sessionId: "headless-session",
				},
			});

			const editor = await adapter.locateByRole({ role: "textbox", name: "Composer" });
			const editorRef = editor.matches[0]?.refId;
			expect(editorRef).toBeTruthy();
			const fillResult = await adapter.fillRef({ refId: editorRef ?? "missing", value: "Updated draft" });
			expect(fillResult).toMatchObject({
				ok: true,
				execution: { kind: "fill", textLength: 13 },
			});
			const editorAfterFill = await adapter.snapshot({ query: "Composer" });
			expect(editorAfterFill.snapshot.entries[0]).toMatchObject({
				role: "textbox",
				text: "Updated draft",
			});
			expect(adapter.runtime.agent.state.messages.map((message) => message.role)).toContain("toolResult");
			const firstTargetId = adapter.target?.id;
			expect(firstTargetId).toBeTruthy();
			await adapter.close();

			const reconnected = await connectDirectCdpHeadlessRuntime({
				port,
				targetId: firstTargetId,
				model: createModel(),
			});
			expect(reconnected.target?.id).toBe(firstTargetId);
			const snapshotAfterReconnect = await reconnected.snapshot();
			expect(snapshotAfterReconnect.snapshot.entries[0]?.name).toBe("clicked 1");
			await reconnected.close();
		},
		CHROMIUM_TEST_TIMEOUT_MS,
	);

	runChromiumTest(
		"revalidates a generic ref after reorder instead of clicking the first selector match",
		async () => {
			const port = await getFreePort();
			userDataDir = mkdtempSync(join(tmpdir(), "shuvgeist-ref-reorder-"));
			const html =
				"<!doctype html><html><head><title>Ref reorder</title></head><body>" +
				'<button class="shared">Search</button><button id="rerender">Re-render</button>' +
				"<script>document.querySelector('#rerender').onclick=()=>{" +
				"const wrong=document.createElement('button');wrong.className='shared';wrong.textContent='Settings';wrong.onclick=()=>wrong.textContent='WRONG';" +
				"const right=document.createElement('button');right.className='shared';right.textContent='Search';right.onclick=()=>right.textContent='Clicked correct';" +
				"document.body.replaceChildren(wrong,right);};</script></body></html>";
			child = spawn(
				chromiumPath,
				[
					"--headless=new",
					"--disable-default-apps",
					"--disable-dev-shm-usage",
					"--disable-gpu",
					"--no-first-run",
					"--no-sandbox",
					"--remote-debugging-address=127.0.0.1",
					"--remote-debugging-port=" + port,
					"--user-data-dir=" + userDataDir,
					"data:text/html;charset=utf-8," + encodeURIComponent(html),
				],
				{ detached: true, stdio: "ignore" },
			);
			await waitForPageTarget(port);

			const adapter = await connectDirectCdpHeadlessRuntime({ port, model: createModel() });
			const searchRef = (await adapter.locateByRole({ role: "button", name: "Search" })).matches[0]?.refId;
			const rerenderRef = (await adapter.locateByRole({ role: "button", name: "Re-render" })).matches[0]?.refId;
			expect(searchRef).toBeTruthy();
			expect(rerenderRef).toBeTruthy();
			expect(await adapter.clickRef({ refId: rerenderRef ?? "missing" })).toMatchObject({ ok: true });

			const clickResult = await adapter.clickRef({ refId: searchRef ?? "missing" });
			expect(clickResult).toMatchObject({ ok: true, match: { entry: { name: "Search" } } });
			const snapshot = await adapter.snapshot();
			expect(snapshot.snapshot.entries.map((entry) => entry.name)).toContain("Clicked correct");
			expect(snapshot.snapshot.entries.map((entry) => entry.name)).not.toContain("WRONG");
			await adapter.close();
		},
		CHROMIUM_TEST_TIMEOUT_MS,
	);

	runChromiumTest(
		"uses trusted CDP click and fill events when the page rejects DOM-generated input",
		async () => {
			const port = await getFreePort();
			userDataDir = mkdtempSync(join(tmpdir(), "shuvgeist-trusted-input-"));
			const html = `<!doctype html>
				<html><head><title>Trusted input gate</title></head><body>
					<button id="secure-button">Secure action</button>
					<input id="secure-input" aria-label="Secure editor" value="">
					<script>
						const button = document.querySelector("#secure-button");
						const input = document.querySelector("#secure-input");
						button.addEventListener("click", (event) => {
							button.textContent = event.isTrusted ? "Trusted click accepted" : "Untrusted click rejected";
						});
						input.addEventListener("input", (event) => {
							if (!event.isTrusted) {
								input.value = "";
								input.setAttribute("aria-label", "Untrusted fill rejected");
								return;
							}
							input.setAttribute("aria-label", "Trusted fill accepted: " + input.value);
						});
						button.click();
						input.value = "DOM text";
						input.dispatchEvent(new InputEvent("input", {
							bubbles: true,
							data: "DOM text",
							inputType: "insertText"
						}));
					</script>
				</body></html>`;
			child = spawn(
				chromiumPath,
				[
					"--headless=new",
					"--disable-default-apps",
					"--disable-dev-shm-usage",
					"--disable-gpu",
					"--no-first-run",
					"--no-sandbox",
					"--remote-debugging-address=127.0.0.1",
					"--remote-debugging-port=" + port,
					"--user-data-dir=" + userDataDir,
					"data:text/html;charset=utf-8," + encodeURIComponent(html),
				],
				{ detached: true, stdio: "ignore" },
			);
			await waitForPageTarget(port);

			const adapter = await connectDirectCdpHeadlessRuntime({ port, model: createModel() });
			const initial = await adapter.snapshot();
			expect(initial.snapshot.entries.map((entry) => entry.name)).toEqual(
				expect.arrayContaining(["Untrusted click rejected", "Untrusted fill rejected"]),
			);

			const clickRef = (
				await adapter.locateByRole({ role: "button", name: "Untrusted click rejected" })
			).matches[0]?.refId;
			expect(clickRef).toBeTruthy();
			const clickResult = await adapter.clickRef({ refId: clickRef ?? "missing" });
			expect(clickResult).toMatchObject({
				ok: true,
				execution: {
					kind: "click",
					methods: expect.arrayContaining(["Input.dispatchMouseEvent"]),
				},
			});
			const afterClick = await adapter.snapshot({ query: "Trusted click accepted" });
			expect(afterClick.snapshot.entries[0]?.name).toBe("Trusted click accepted");

			const fillRef = (
				await adapter.locateByRole({ role: "textbox", name: "Untrusted fill rejected" })
			).matches[0]?.refId;
			expect(fillRef).toBeTruthy();
			const fillResult = await adapter.fillRef({ refId: fillRef ?? "missing", value: "CDP text" });
			expect(fillResult).toMatchObject({
				ok: true,
				execution: {
					kind: "fill",
					methods: expect.arrayContaining(["Input.dispatchKeyEvent", "Input.insertText"]),
					textLength: 8,
				},
			});
			const afterFill = await adapter.snapshot({ query: "Trusted fill accepted" });
			expect(afterFill.snapshot.entries.map((entry) => entry.name)).toContain(
				"Trusted fill accepted: CDP text",
			);

			await adapter.close();
		},
		CHROMIUM_TEST_TIMEOUT_MS,
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
					"--disable-dev-shm-usage",
					"--disable-gpu",
					"--no-first-run",
					"--no-sandbox",
					"--remote-debugging-address=127.0.0.1",
					"--remote-debugging-port=" + port,
					"--user-data-dir=" + userDataDir,
					url,
				],
				{ detached: true, stdio: "ignore" },
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
			await adapter.close();
		},
		CHROMIUM_TEST_TIMEOUT_MS,
	);
});
