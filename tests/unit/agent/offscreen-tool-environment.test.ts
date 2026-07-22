import { Agent, type AgentMessage, type AgentToolResult } from "@shuv1337/pi-agent-core";
import { type Api, type Model, Type } from "@shuv1337/pi-ai";
import { AttachmentsRuntimeProvider } from "@shuv1337/pi-web-ui/sandbox/AttachmentsRuntimeProvider.js";
import { FileDownloadRuntimeProvider } from "@shuv1337/pi-web-ui/sandbox/FileDownloadRuntimeProvider.js";
import { describe, expect, it, vi } from "vitest";
import {
	ArtifactStore,
	OffscreenArtifactsRuntimeProvider,
	OffscreenBrowserJsRuntimeProvider,
	type OffscreenPrivilegedOperationContext,
	type OffscreenReplTool,
	PureOffscreenAgentToolRuntime,
} from "@shuvgeist/extension/agent/offscreen-tool-environment";
import type { OffscreenRuntimeSessionAdapter } from "@shuvgeist/extension/agent/offscreen-runtime-host";
import type {
	RuntimeAgentMessage,
	RuntimeTargetIdentity,
	RuntimeValue,
} from "@shuvgeist/extension/agent/runtime-protocol";

const target: RuntimeTargetIdentity = { kind: "chrome-tab", tabRef: "window:7", frameId: 0 };

const model: Model<Api> = {
	id: "test-model",
	name: "Test Model",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
};

function createAgent(messages: AgentMessage[] = []): Agent {
	return new Agent({
		initialState: {
			systemPrompt: "Test",
			model,
			thinkingLevel: "low",
			messages,
			tools: [],
		},
	});
}

function context(agent = createAgent(), signal = new AbortController().signal) {
	return {
		clientId: "sidepanel",
		windowId: 7,
		sessionId: "session-1",
		target,
		agent,
		signal,
	};
}

function operationContext(signal = new AbortController().signal) {
	return {
		runtimeEpoch: "runtime-epoch-1",
		clientId: "sidepanel",
		windowId: 7,
		sessionId: "session-1",
		target,
		requestId: "request-1",
		executionId: "execution-1",
		trace: {
			traceId: "trace-1",
			spanId: "span-1",
			traceFlags: "01",
		},
		signal,
		session: {} as OffscreenRuntimeSessionAdapter,
	};
}

function transcriptMessage(value: RuntimeAgentMessage): AgentMessage {
	return value as unknown as AgentMessage;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return {
		promise,
		resolve: () => resolve?.(),
	};
}

describe("ArtifactStore", () => {
	it("owns content and stable descriptors without a rendering panel", () => {
		const timestamps = [
			new Date("2026-01-01T00:00:00.000Z"),
			new Date("2026-01-01T00:00:01.000Z"),
			new Date("2026-01-01T00:00:02.000Z"),
		];
		const store = new ArtifactStore(() => timestamps.shift() ?? new Date("2026-01-01T00:00:03.000Z"));

		const created = store.create("report.json", '{"ok":true}');
		const updated = store.update("report.json", "true", "false");

		expect(created).toMatchObject({
			filename: "report.json",
			mimeType: "application/json",
			content: '{"ok":true}',
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		expect(updated).toMatchObject({
			content: '{"ok":false}',
			createdAt: created.createdAt,
			updatedAt: "2026-01-01T00:00:01.000Z",
		});
		expect(store.listDescriptors()).toEqual([
			{
				filename: "report.json",
				mimeType: "application/json",
				size: 12,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:01.000Z",
			},
		]);
		expect(store.delete("report.json").content).toBe('{"ok":false}');
		expect(store.list()).toEqual([]);
	});

	it("reconstructs direct tool results and explicit REPL artifact messages with pi-web-ui semantics", () => {
		const messages = [
			transcriptMessage({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "artifact-call",
						name: "artifacts",
						arguments: { command: "create", filename: "direct.md", content: "direct" },
					},
				],
			}),
			transcriptMessage({
				role: "toolResult",
				toolCallId: "artifact-call",
				toolName: "artifacts",
				content: [{ type: "text", text: "Created file direct.md" }],
				isError: false,
				timestamp: 1,
			}),
			transcriptMessage({
				role: "artifact",
				action: "create",
				filename: "repl.json",
				content: "{\"n\":1}",
				timestamp: "2026-01-01T00:00:00.000Z",
			}),
			transcriptMessage({
				role: "artifact",
				action: "update",
				filename: "repl.json",
				content: "{\"n\":2}",
				timestamp: "2026-01-01T00:00:01.000Z",
			}),
		];
		const store = new ArtifactStore();

		store.reconstruct(messages);

		expect(store.list().map(({ filename, content }) => ({ filename, content }))).toEqual([
			{ filename: "direct.md", content: "direct" },
			{ filename: "repl.json", content: '{"n":2}' },
		]);
	});
});

describe("PureOffscreenAgentToolRuntime", () => {
	it("keeps direct artifacts tool writes single-sourced in tool-call/tool-result transcript reconstruction", async () => {
		const agent = createAgent();
		const runtime = new PureOffscreenAgentToolRuntime();
		const environment = await runtime.create(context(agent));
		const artifactsTool = environment.tools.find((tool) => tool.name === "artifacts");
		if (!artifactsTool) throw new Error("artifacts tool missing");

		await artifactsTool.execute("call-1", {
			command: "create",
			filename: "direct.md",
			content: "one",
		});

		expect(environment.artifactStore.require("direct.md").content).toBe("one");
		expect(agent.state.messages.filter((message) => message.role === "artifact")).toHaveLength(0);
	});

	it("exposes list/get/put/delete with full content while snapshots use descriptors", async () => {
		const agent = createAgent();
		const runtime = new PureOffscreenAgentToolRuntime();
		const environment = await runtime.create(context(agent));
		const operation = operationContext();

		const put = await runtime.execute(
			{ action: "put", filename: "data.json", content: { ok: true }, mimeType: "application/json" },
			operation,
		);
		const list = await runtime.execute({ action: "list" }, operation);
		const get = await runtime.execute({ action: "get", filename: "data.json" }, operation);

		expect(put).toMatchObject({ artifact: { filename: "data.json", content: '{\n  "ok": true\n}' } });
		expect(list).toMatchObject({ artifacts: [{ filename: "data.json", content: '{\n  "ok": true\n}' }] });
		expect(get).toMatchObject({ artifact: { filename: "data.json", mimeType: "application/json" } });
		expect(environment.listArtifacts()[0]).not.toHaveProperty("content");
		expect(agent.state.messages.filter((message) => message.role === "artifact")).toHaveLength(1);

		const deleted = await runtime.execute({ action: "delete", filename: "data.json" }, operation);
		expect(deleted).toMatchObject({ deleted: true, artifact: { filename: "data.json" } });
		expect(agent.state.messages.filter((message) => message.role === "artifact")).toHaveLength(2);
	});

	it("deduplicates a REPL artifact message and records one authoritative Agent message", async () => {
		const agent = createAgent();
		const runtime = new PureOffscreenAgentToolRuntime();
		const environment = await runtime.create(context(agent));
		const provider = environment
			.getRuntimeProviders()
			.find((candidate) => candidate instanceof OffscreenArtifactsRuntimeProvider);
		if (!(provider instanceof OffscreenArtifactsRuntimeProvider)) throw new Error("artifact provider missing");
		const responses: unknown[] = [];
		const message = {
			type: "artifact-operation",
			action: "createOrUpdate",
			filename: "once.txt",
			content: "one",
			sandboxId: "sandbox-1",
			messageId: "message-1",
		};

		await Promise.all([
			provider.handleMessage(message, (response) => responses.push(response)),
			provider.handleMessage(message, (response) => responses.push(response)),
		]);

		expect(responses).toHaveLength(2);
		expect(environment.artifactStore.require("once.txt").content).toBe("one");
		expect(agent.state.messages.filter((entry) => entry.role === "artifact")).toHaveLength(1);
	});

	it("executes HTML artifacts and durably reconstructs logs without a presentation panel", async () => {
		const executeHtml = vi.fn(async () => ({ logs: [{ type: "log" as const, text: "rendered" }] }));
		const agent = createAgent();
		const runtime = new PureOffscreenAgentToolRuntime({ htmlArtifacts: { execute: executeHtml } });
		const environment = await runtime.create(context(agent));
		const artifactsTool = environment.tools.find((tool) => tool.name === "artifacts");
		if (!artifactsTool) throw new Error("artifacts tool missing");

		const created = await artifactsTool.execute("html-call", {
			command: "create",
			filename: "report.html",
			content: "<html><script>console.log('rendered')</script></html>",
		});
		const logs = await artifactsTool.execute("logs-call", { command: "logs", filename: "report.html" });

		expect(created.content).toEqual([
			{ type: "text", text: "Created file report.html\n[log] rendered" },
		]);
		expect(logs.content).toEqual([{ type: "text", text: "[log] rendered" }]);
		expect(environment.listArtifacts()[0]).not.toHaveProperty("logs");

		const reconstructed = new ArtifactStore();
		reconstructed.reconstruct([
			transcriptMessage({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "html-call",
						name: "artifacts",
						arguments: {
							command: "create",
							filename: "report.html",
							content: "<html></html>",
						},
					},
				],
			}),
			transcriptMessage({
				role: "toolResult",
				toolCallId: "html-call",
				toolName: "artifacts",
				content: created.content,
				details: created.details,
				isError: false,
				timestamp: 1,
			}),
		]);
		expect(reconstructed.require("report.html").logs).toEqual([{ type: "log", text: "rendered" }]);
		expect(executeHtml).toHaveBeenCalledTimes(1);
	});

	it("rehydrates and reexecutes durable HTML artifacts while the sidepanel is closed", async () => {
		const executeHtml = vi.fn(async () => ({ logs: [{ type: "info" as const, text: "ready" }] }));
		const agent = createAgent();
		const firstRuntime = new PureOffscreenAgentToolRuntime({ htmlArtifacts: { execute: executeHtml } });
		const first = await firstRuntime.create(context(agent));
		await firstRuntime.execute(
			{ action: "put", filename: "app.html", content: "<html></html>", mimeType: "text/html" },
			operationContext(),
		);
		first.dispose();

		const restoredAgent = createAgent(agent.state.messages.slice());
		const restoredRuntime = new PureOffscreenAgentToolRuntime({ htmlArtifacts: { execute: executeHtml } });
		const restored = await restoredRuntime.create(context(restoredAgent));

		expect(restored.artifactStore.require("app.html").logs).toEqual([{ type: "info", text: "ready" }]);
		expect(executeHtml).toHaveBeenCalledTimes(2);
	});

	it("builds attachment providers from the current transcript and wires injected local tools", async () => {
		const attachmentMessage = transcriptMessage({
			role: "user-with-attachments",
			content: "read this",
			timestamp: 1,
			attachments: [
				{
					id: "attachment-1",
					type: "document",
					fileName: "notes.txt",
					mimeType: "text/plain",
					size: 5,
					content: "aGVsbG8=",
					extractedText: "hello",
				},
			],
		});
		const auxiliarySchema = Type.Object({});
		const auxiliaryResult: AgentToolResult<null> = { content: [{ type: "text", text: "ok" }], details: null };
		const runtime = new PureOffscreenAgentToolRuntime({
			skillTool: {
				name: "skill",
				label: "Skill",
				description: "skill",
				parameters: auxiliarySchema,
				async execute() {
					return auxiliaryResult;
				},
			},
			createExtractDocumentTool: () => ({
				name: "extract_document",
				label: "Extract document",
				description: "document",
				parameters: auxiliarySchema,
				async execute() {
					return auxiliaryResult;
				},
			}),
		});
		const environment = await runtime.create(context(createAgent([attachmentMessage])));
		const attachmentProvider = environment
			.getRuntimeProviders()
			.find((provider) => provider instanceof AttachmentsRuntimeProvider);

		expect(attachmentProvider?.getData()).toMatchObject({
			attachments: [{ id: "attachment-1", fileName: "notes.txt", extractedText: "hello" }],
		});
		expect(environment.tools.map((tool) => tool.name)).toEqual(["artifacts", "skill", "extract_document"]);
	});

	it("injects exact scope and cancellation into privileged tools and REPL providers", async () => {
		const calls: Array<{
			operation: string;
			params: RuntimeValue;
			context: OffscreenPrivilegedOperationContext;
		}> = [];
		const controller = new AbortController();
		const runtime = new PureOffscreenAgentToolRuntime({
			privilegedOperations: {
				async execute(operation, params, executionContext) {
					calls.push({ operation, params, context: executionContext });
					return { ok: true };
				},
			},
		});
		const environment = await runtime.create(context());
		const navigate = environment.tools.find((tool) => tool.name === "navigate");
		if (!navigate) throw new Error("navigate tool missing");

		const browserProvider = environment
			.getRuntimeProviders()
			.find((provider) => provider instanceof OffscreenBrowserJsRuntimeProvider);
		if (!(browserProvider instanceof OffscreenBrowserJsRuntimeProvider)) throw new Error("browser provider missing");
		await environment.withParentExecution(operationContext(controller.signal), async () => {
			await navigate.execute("tool-call-1", { url: "https://example.test" }, controller.signal);
			browserProvider.onExecutionStart?.("sandbox-1", controller.signal);
			try {
				await browserProvider.handleMessage?.(
					{
						type: "browser-js",
						code: "() => document.title",
						args: "[]",
						sandboxId: "sandbox-1",
						messageId: "message-1",
					},
					() => {},
				);
			} finally {
				browserProvider.onExecutionEnd?.("sandbox-1");
			}
		});

		expect(calls.map(({ operation }) => operation)).toEqual(["navigate", "browser-js"]);
		for (const call of calls) {
			expect(call.context).toMatchObject({
				runtimeEpoch: "runtime-epoch-1",
				clientId: "sidepanel",
				windowId: 7,
				sessionId: "session-1",
				target,
				requestId: "request-1",
				executionId: "execution-1",
				trace: {
					traceId: "trace-1",
					spanId: "span-1",
					traceFlags: "01",
				},
			});
			expect(call.context.signal).toBe(controller.signal);
		}
	});

	it("rejects unbound and late privileged work instead of borrowing a session identity", async () => {
		const execute = vi.fn(async () => ({ ok: true }));
		const runtime = new PureOffscreenAgentToolRuntime({ privilegedOperations: { execute } });
		const environment = await runtime.create(context());
		const navigate = environment.tools.find((tool) => tool.name === "navigate");
		if (!navigate) throw new Error("navigate tool missing");

		await expect(navigate.execute("unbound-tool", { url: "https://example.test" })).rejects.toThrow(
			"no exact parent execution",
		);

		const browserProvider = environment
			.getRuntimeProviders()
			.find((provider) => provider instanceof OffscreenBrowserJsRuntimeProvider);
		if (!(browserProvider instanceof OffscreenBrowserJsRuntimeProvider)) throw new Error("browser provider missing");
		const parent = operationContext();
		await environment.withParentExecution(parent, async () => {
			browserProvider.onExecutionStart?.("late-sandbox", parent.signal);
		});
		browserProvider.onExecutionEnd?.("late-sandbox");

		let response: unknown;
		await browserProvider.handleMessage?.(
			{
				type: "browser-js",
				code: "() => document.title",
				args: "[]",
				sandboxId: "late-sandbox",
				messageId: "late-message",
			},
			(value) => {
				response = value;
			},
		);

		expect(response).toMatchObject({
			success: false,
			error: expect.stringContaining("no exact parent identity"),
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it("cancels a privileged tool with its own signal while preserving exact parent identity", async () => {
		const started = deferred();
		let captured: OffscreenPrivilegedOperationContext | undefined;
		const runtime = new PureOffscreenAgentToolRuntime({
			privilegedOperations: {
				execute(_operation, _params, executionContext) {
					captured = executionContext;
					started.resolve();
					return new Promise((_resolve, reject) => {
						executionContext.signal.addEventListener(
							"abort",
							() => reject(new DOMException("Aborted", "AbortError")),
							{ once: true },
						);
					});
				},
			},
		});
		const environment = await runtime.create(context());
		const navigate = environment.tools.find((tool) => tool.name === "navigate");
		if (!navigate) throw new Error("navigate tool missing");
		const toolAbort = new AbortController();
		const parent = {
			...operationContext(),
			requestId: "cancellation-request",
			executionId: "cancellation-execution",
		};

		const execution = environment.withParentExecution(parent, () =>
			navigate.execute("cancelled-tool", { url: "https://example.test" }, toolAbort.signal),
		);
		await started.promise;
		toolAbort.abort();

		await expect(execution).rejects.toMatchObject({ name: "AbortError" });
		expect(captured).toMatchObject({
			requestId: "cancellation-request",
			executionId: "cancellation-execution",
		});
		expect(captured?.signal).toBe(toolAbort.signal);
	});

	it("preserves full ExtractImageTool selector, screenshot, resize, ImageContent, and details behavior", async () => {
		const createImageBitmap = vi
			.fn()
			.mockResolvedValueOnce({ width: 1600, height: 800, close: vi.fn() })
			.mockResolvedValueOnce({ width: 640, height: 320, close: vi.fn() });
		class TestOffscreenCanvas {
			constructor(
				readonly width: number,
				readonly height: number,
			) {}

			getContext() {
				return { drawImage: vi.fn() };
			}

			async convertToBlob() {
				return new Blob(["webp"], { type: "image/webp" });
			}
		}
		class TestFileReader {
			result: string | null = null;
			onload: (() => void) | null = null;

			readAsDataURL() {
				this.result = "data:image/webp;base64,d2VicA==";
				this.onload?.();
			}
		}
		vi.stubGlobal("createImageBitmap", createImageBitmap);
		vi.stubGlobal("OffscreenCanvas", TestOffscreenCanvas);
		vi.stubGlobal("FileReader", TestFileReader);

		const calls: Array<{ operation: string; params: RuntimeValue }> = [];
		const runtime = new PureOffscreenAgentToolRuntime({
			privilegedOperations: {
				async execute(operation, params) {
					calls.push({ operation, params });
					if (operation === "screenshot") {
						return {
							dataUrl: "data:image/png;base64,cG5n",
							cssWidth: 1000,
							cssHeight: 500,
							devicePixelRatio: 2,
						};
					}
					if (operation === "extract-image-source") {
						return { src: "data:image/png;base64,cG5n", width: 320, height: 160 };
					}
					return null;
				},
			},
		});
		const environment = await runtime.create(context());
		const extractImage = environment.tools.find((tool) => tool.name === "extract_image");
		if (!extractImage) throw new Error("extract_image tool missing");

		const parent = operationContext();
		const { screenshot, selector } = await environment.withParentExecution(parent, async () => ({
			screenshot: await extractImage.execute("screenshot-call", { mode: "screenshot", maxWidth: 800 }),
			selector: await extractImage.execute("selector-call", {
				mode: "selector",
				selector: "img.hero",
				maxWidth: 320,
			}),
		}));

		expect(screenshot).toEqual({
			content: [
				{ type: "image", data: "d2VicA==", mimeType: "image/webp" },
				{ type: "text", text: "Screenshot captured (max 800px width)" },
			],
			details: {
				mode: "screenshot",
				selector: undefined,
				screenshot: {
					imageWidth: 800,
					imageHeight: 400,
					cssWidth: 1000,
					cssHeight: 500,
					devicePixelRatio: 2,
					scale: 0.8,
				},
			},
		});
		expect(selector).toEqual({
			content: [
				{ type: "image", data: "d2VicA==", mimeType: "image/webp" },
				{ type: "text", text: 'Image extracted from "img.hero" (320x160, resized to max 320px)' },
			],
			details: { mode: "selector", selector: "img.hero" },
		});
		expect(calls).toEqual([
			{ operation: "screenshot", params: {} },
			{ operation: "extract-image-source", params: { selector: "img.hero" } },
		]);
		vi.unstubAllGlobals();
	});

	it("gates the exact DebuggerTool proxy on debuggerMode and preserves its content/details result", async () => {
		const execute = vi.fn(async () => ({
			content: [{ type: "text", text: '{"value":42}' }],
			details: { value: { result: 42 } },
		}));
		const disabledRuntime = new PureOffscreenAgentToolRuntime({
			privilegedOperations: { execute },
			debuggerMode: () => false,
		});
		const disabled = await disabledRuntime.create(context());
		expect(disabled.tools.some((tool) => tool.name === "debugger")).toBe(false);

		const enabledRuntime = new PureOffscreenAgentToolRuntime({
			privilegedOperations: { execute },
			debuggerMode: async () => true,
		});
		const enabled = await enabledRuntime.create(context(createAgent(), new AbortController().signal));
		const debuggerTool = enabled.tools.find((tool) => tool.name === "debugger");
		if (!debuggerTool) throw new Error("debugger tool missing");

		await enabled.withParentExecution(operationContext(), async () => {
			await expect(debuggerTool.execute("debug-call", { action: "eval", code: "window.app" })).resolves.toEqual({
				content: [{ type: "text", text: '{"value":42}' }],
				details: { value: { result: 42 } },
			});
		});
		await expect(
			debuggerTool.execute("escape-call", { action: "cookies", tabId: 99 }),
		).rejects.toThrow("cannot override the exact session target");
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0]?.[0]).toBe("debugger");
		expect(execute.mock.calls[0]?.[1]).toEqual({ action: "eval", code: "window.app" });
	});

	it("propagates current attachment and artifact providers into background browserjs execution", async () => {
		const attachmentMessage = transcriptMessage({
			role: "user-with-attachments",
			content: "read this",
			timestamp: 1,
			attachments: [
				{
					id: "attachment-1",
					type: "document",
					fileName: "notes.txt",
					mimeType: "text/plain",
					size: 5,
					content: "aGVsbG8=",
				},
			],
		});
		const calls: RuntimeValue[] = [];
		const runtime = new PureOffscreenAgentToolRuntime({
			privilegedOperations: {
				async execute(_operation, params) {
					calls.push(params);
					return {
						success: true,
						artifactMutations: [
							{ action: "put", filename: "created.json", content: '{"created":true}' },
							{ action: "delete", filename: "report.json" },
						],
					};
				},
			},
		});
		const environment = await runtime.create(context(createAgent([attachmentMessage])));
		await runtime.execute({ action: "put", filename: "report.json", content: { ok: true } }, operationContext());
		const browserProvider = environment
			.getRuntimeProviders()
			.find((provider) => provider instanceof OffscreenBrowserJsRuntimeProvider);
		if (!(browserProvider instanceof OffscreenBrowserJsRuntimeProvider)) throw new Error("browser provider missing");

		const parent = operationContext();
		await environment.withParentExecution(parent, async () => {
			browserProvider.onExecutionStart?.("sandbox-browserjs", parent.signal);
			try {
				await browserProvider.handleMessage?.(
					{
						type: "browser-js",
						code: "() => listAttachments()",
						args: "[]",
						sandboxId: "sandbox-browserjs",
					},
					() => {},
				);
			} finally {
				browserProvider.onExecutionEnd?.("sandbox-browserjs");
			}
		});

		expect(calls[0]).toMatchObject({
			providerData: {
				attachments: [{ id: "attachment-1", fileName: "notes.txt" }],
				artifacts: { "report.json": '{\n  "ok": true\n}' },
			},
			providerRuntimes: [expect.any(String), expect.any(String)],
		});
		expect(environment.artifactStore.require("created.json").content).toBe('{"created":true}');
		expect(() => environment.artifactStore.require("report.json")).toThrow("Artifact not found");
		expect(
			environment
				.getRuntimeProviders()
				.find((provider) => provider instanceof OffscreenArtifactsRuntimeProvider)
				?.getRuntime()
				.toString(),
		).toContain("createOrUpdateArtifact");
	});

	it("keeps an Agent prompt identity separate from an overlapping direct REPL", async () => {
		const calls: Array<{ operation: string; context: OffscreenPrivilegedOperationContext }> = [];
		let replTool: OffscreenReplTool | undefined;
		const runtime = new PureOffscreenAgentToolRuntime({
			privilegedOperations: {
				async execute(operation, _params, executionContext) {
					calls.push({ operation, context: executionContext });
					return { ok: true };
				},
			},
			createReplTool: () => {
				replTool = {
					name: "repl",
					label: "REPL",
					description: "repl",
					parameters: Type.Object({ title: Type.String(), code: Type.String() }),
					async execute(_toolCallId, args, signal) {
						const provider = replTool?.runtimeProvidersFactory?.().find(
							(candidate) => candidate instanceof OffscreenBrowserJsRuntimeProvider,
						);
						if (!(provider instanceof OffscreenBrowserJsRuntimeProvider)) {
							throw new Error("browser provider missing");
						}
						provider.onExecutionStart?.("direct-repl-sandbox", signal);
						try {
							await provider.handleMessage?.(
								{
									type: "browser-js",
									code: `() => ${JSON.stringify(args.code)}`,
									args: "[]",
									sandboxId: "direct-repl-sandbox",
									messageId: "direct-repl-message",
								},
								() => {},
							);
						} finally {
							provider.onExecutionEnd?.("direct-repl-sandbox");
						}
						return { content: [{ type: "text", text: "done" }], details: { files: [] } };
					},
				};
				return replTool;
			},
		});
		const environment = await runtime.create(context());
		const navigate = environment.tools.find((tool) => tool.name === "navigate");
		if (!navigate) throw new Error("navigate tool missing");
		const promptHold = deferred();
		const promptContext = {
			...operationContext(new AbortController().signal),
			requestId: "prompt-request",
			executionId: "prompt-execution",
			trace: { traceId: "prompt-trace", spanId: "prompt-span", traceFlags: "01" },
		};
		const prompt = environment.withParentExecution(promptContext, async () => {
			await navigate.execute(
				"prompt-tool-call",
				{ url: "https://prompt.example" },
				new AbortController().signal,
			);
			await promptHold.promise;
		});
		await vi.waitFor(() => expect(calls).toHaveLength(1));

		const replContext = {
			...operationContext(new AbortController().signal),
			requestId: "repl-request",
			executionId: "repl-execution",
			trace: { traceId: "repl-trace", spanId: "repl-span", traceFlags: "01" },
		};
		await runtime.execute("direct-repl", replContext);
		promptHold.resolve();
		await prompt;

		expect(calls.map(({ operation }) => operation)).toEqual(["navigate", "browser-js"]);
		expect(calls[0]?.context).toMatchObject({
			requestId: "prompt-request",
			executionId: "prompt-execution",
			trace: { traceId: "prompt-trace" },
		});
		expect(calls[1]?.context).toMatchObject({
			requestId: "repl-request",
			executionId: "repl-execution",
			trace: { traceId: "repl-trace" },
		});
	});

	it("snapshots concurrent direct REPL identities per sandbox through reverse completion", async () => {
		const releaseA = deferred();
		const releaseB = deferred();
		const calls: OffscreenPrivilegedOperationContext[] = [];
		let replTool: OffscreenReplTool | undefined;
		const runtime = new PureOffscreenAgentToolRuntime({
			privilegedOperations: {
				async execute(operation, _params, executionContext) {
					if (operation !== "browser-js") throw new Error(`Unexpected operation: ${operation}`);
					calls.push(executionContext);
					await (executionContext.executionId === "execution-a" ? releaseA.promise : releaseB.promise);
					return { executionId: executionContext.executionId };
				},
			},
			createReplTool: () => {
				replTool = {
					name: "repl",
					label: "REPL",
					description: "repl",
					parameters: Type.Object({ title: Type.String(), code: Type.String() }),
					async execute(_toolCallId, args, signal) {
						const provider = replTool?.runtimeProvidersFactory?.().find(
							(candidate) => candidate instanceof OffscreenBrowserJsRuntimeProvider,
						);
						if (!(provider instanceof OffscreenBrowserJsRuntimeProvider)) {
							throw new Error("browser provider missing");
						}
						const sandboxId = `sandbox-${args.code}`;
						provider.onExecutionStart?.(sandboxId, signal);
						try {
							await provider.handleMessage?.(
								{
									type: "browser-js",
									code: `() => ${JSON.stringify(args.code)}`,
									args: "[]",
									sandboxId,
									messageId: `message-${args.code}`,
								},
								() => {},
							);
						} finally {
							provider.onExecutionEnd?.(sandboxId);
						}
						return { content: [{ type: "text", text: "done" }], details: { files: [] } };
					},
				};
				return replTool;
			},
		});
		await runtime.create(context());
		const operationA = {
			...operationContext(new AbortController().signal),
			requestId: "request-a",
			executionId: "execution-a",
			trace: { traceId: "trace-a", spanId: "span-a", traceFlags: "01" },
		};
		const operationB = {
			...operationContext(new AbortController().signal),
			requestId: "request-b",
			executionId: "execution-b",
			trace: { traceId: "trace-b", spanId: "span-b", traceFlags: "01" },
		};

		const executionA = runtime.execute("a", operationA);
		const executionB = runtime.execute("b", operationB);
		await vi.waitFor(() => expect(calls).toHaveLength(2));
		releaseB.resolve();
		await executionB;
		releaseA.resolve();
		await executionA;

		expect(calls).toEqual([
			expect.objectContaining({
				requestId: "request-a",
				executionId: "execution-a",
				trace: expect.objectContaining({ traceId: "trace-a" }),
				origin: expect.objectContaining({ sandboxId: "sandbox-a" }),
			}),
			expect.objectContaining({
				requestId: "request-b",
				executionId: "execution-b",
				trace: expect.objectContaining({ traceId: "trace-b" }),
				origin: expect.objectContaining({ sandboxId: "sandbox-b" }),
			}),
		]);
	});

	it("binds REPL overlay and Skill factory page operations to their exact parents", async () => {
		const calls: Array<{ operation: string; context: OffscreenPrivilegedOperationContext }> = [];
		const runtime = new PureOffscreenAgentToolRuntime({
			privilegedOperations: {
				async execute(operation, _params, executionContext) {
					calls.push({ operation, context: executionContext });
					return { tabs: [] };
				},
			},
			createReplTool(_context, privilegedOperations) {
				if (!privilegedOperations) throw new Error("bound privileged operations missing");
				return {
					name: "repl",
					label: "REPL",
					description: "repl",
					parameters: Type.Object({ title: Type.String(), code: Type.String() }),
					async execute(_toolCallId, _args, signal) {
						await privilegedOperations.execute("repl-overlay-show", { taskName: "Direct REPL" }, {
							operationId: "overlay-show",
							origin: { kind: "repl", sandboxId: "overlay", messageId: "show" },
							...(signal ? { signal } : {}),
						});
						await privilegedOperations.execute("repl-overlay-remove", {}, {
							operationId: "overlay-hide",
							origin: { kind: "repl", sandboxId: "overlay", messageId: "hide" },
							...(signal ? { parentSignal: signal } : {}),
						});
						return { content: [{ type: "text", text: "done" }], details: { files: [] } };
					},
				};
			},
			createSkillTool(_context, privilegedOperations) {
				if (!privilegedOperations) throw new Error("bound privileged operations missing");
				return {
					name: "skill",
					label: "Skill",
					description: "skill",
					parameters: Type.Object({}),
					async execute(_toolCallId, _args, signal) {
						const details = await privilegedOperations.execute("navigate", { listTabs: true }, {
							operationId: "skill:resolve-current-url",
							origin: { kind: "agent-tool", toolCallId: "skill:resolve-current-url" },
							...(signal ? { signal } : {}),
						});
						return { content: [{ type: "text", text: "done" }], details };
					},
				};
			},
		});
		const environment = await runtime.create(context());
		const directContext = {
			...operationContext(new AbortController().signal),
			requestId: "direct-request",
			executionId: "direct-execution",
		};
		await runtime.execute("browserjs(() => true)", directContext);

		const skill = environment.tools.find((tool) => tool.name === "skill");
		if (!skill) throw new Error("skill tool missing");
		const promptContext = {
			...operationContext(new AbortController().signal),
			requestId: "prompt-request",
			executionId: "prompt-execution",
		};
		await environment.withParentExecution(promptContext, async () => {
			await skill.execute("skill-call", {}, new AbortController().signal);
		});

		expect(calls.map(({ operation }) => operation)).toEqual([
			"repl-overlay-show",
			"repl-overlay-remove",
			"navigate",
		]);
		for (const call of calls.slice(0, 2)) {
			expect(call.context).toMatchObject({
				requestId: "direct-request",
				executionId: "direct-execution",
			});
		}
		expect(calls[0]?.context.signal).toBe(directContext.signal);
		expect(calls[1]?.context.signal).not.toBe(directContext.signal);
		expect(calls[2]?.context).toMatchObject({
			requestId: "prompt-request",
			executionId: "prompt-execution",
		});
	});

	it("uses one injected DOM REPL tool for Agent and host delegate execution", async () => {
		const execute = vi.fn(async (): Promise<AgentToolResult<{ files: [] }>> => ({
			content: [{ type: "text", text: "done" }],
			details: { files: [] },
		}));
		let replTool: OffscreenReplTool | undefined;
		const runtime = new PureOffscreenAgentToolRuntime({
			createReplTool: () => {
				replTool = {
					name: "repl",
					label: "REPL",
					description: "repl",
					parameters: Type.Object({ title: Type.String(), code: Type.String() }),
					execute,
				};
				return replTool;
			},
			sandboxUrlProvider: () => "chrome-extension://test/sandbox.html",
		});
		const environment = await runtime.create(context());
		const controller = new AbortController();

		const result = await runtime.execute("return 1", operationContext(controller.signal));

		expect(result).toMatchObject({ content: [{ type: "text", text: "done" }] });
		expect(execute).toHaveBeenCalledWith(
			"execution-1",
			{ title: "Executing JavaScript", code: "return 1" },
			controller.signal,
		);
		expect(replTool?.sandboxUrlProvider?.()).toContain("sandbox.html");
		expect(replTool?.runtimeProvidersFactory?.()).toEqual(environment.getRuntimeProviders());
	});

	it("exposes returnDownloadableFile and preserves non-empty REPL file payloads", async () => {
		let replTool: OffscreenReplTool | undefined;
		const runtime = new PureOffscreenAgentToolRuntime({
			createReplTool: () => {
				replTool = {
					name: "repl",
					label: "REPL",
					description: "repl",
					parameters: Type.Object({ title: Type.String(), code: Type.String() }),
					async execute() {
						const provider = replTool?.runtimeProvidersFactory?.().find(
							(candidate) => candidate instanceof FileDownloadRuntimeProvider,
						);
						if (!(provider instanceof FileDownloadRuntimeProvider)) {
							throw new Error("file download provider missing");
						}
						const sendRuntimeMessage = vi.fn(async (message: Record<string, unknown>) => {
							let response: unknown;
							await provider.handleMessage(message, (value) => {
								response = value;
							});
							return response;
						});
						const sandboxWindow: {
							sendRuntimeMessage: typeof sendRuntimeMessage;
							returnDownloadableFile?: (filename: string, content: string, mimeType?: string) => Promise<void>;
						} = { sendRuntimeMessage };
						vi.stubGlobal("window", sandboxWindow);
						provider.getRuntime()("sandbox-file");
						await sandboxWindow.returnDownloadableFile?.("hello.txt", "hello", "text/plain");
						expect(provider.getFiles()).toEqual([
							{ fileName: "hello.txt", content: "hello", mimeType: "text/plain" },
						]);
						return {
							content: [{ type: "text", text: "[Files returned: 1]" }],
							details: {
								files: [
									{
										fileName: "hello.txt",
										contentBase64: "aGVsbG8=",
										mimeType: "text/plain",
										size: 5,
									},
								],
							},
						};
					},
				};
				return replTool;
			},
		});
		await runtime.create(context());

		await expect(runtime.execute("returnDownloadableFile()", operationContext())).resolves.toMatchObject({
			details: {
				files: [
					{
						fileName: "hello.txt",
						contentBase64: "aGVsbG8=",
						mimeType: "text/plain",
						size: 5,
					},
				],
			},
		});
		vi.unstubAllGlobals();
	});

	it("isolates duplicate identities, exact targets, and disposal", async () => {
		const runtime = new PureOffscreenAgentToolRuntime();
		const environment = await runtime.create(context());

		await expect(runtime.create(context())).rejects.toThrow("already exists");
		await expect(
			runtime.execute(
				{ action: "list" },
				{ ...operationContext(), target: { kind: "chrome-tab", tabRef: "window:other", frameId: 0 } },
			),
		).rejects.toThrow("exact session scope");

		environment.dispose();
		expect(runtime.getEnvironment(context())).toBeUndefined();
	});
});
