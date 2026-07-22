import type { Agent, AgentMessage, AgentTool, AgentToolResult } from "@shuv1337/pi-agent-core";
import { type Static, StringEnum, type TSchema, Type } from "@shuv1337/pi-ai";
import { AttachmentsRuntimeProvider } from "@shuv1337/pi-web-ui/sandbox/AttachmentsRuntimeProvider.js";
import { FileDownloadRuntimeProvider } from "@shuv1337/pi-web-ui/sandbox/FileDownloadRuntimeProvider.js";
import type { SandboxRuntimeProvider } from "@shuv1337/pi-web-ui/sandbox/SandboxRuntimeProvider.js";
import {
	BROWSERJS_RUNTIME_PROVIDER_DESCRIPTION,
	NATIVE_INPUT_EVENTS_DESCRIPTION,
	NAVIGATE_RUNTIME_PROVIDER_DESCRIPTION,
} from "../prompts/prompts.js";
import { DEBUGGER_TOOL_DESCRIPTION, debuggerSchema } from "../tools/debugger.js";
import {
	type ExtractImageScreenshotSource,
	type ExtractImageSourceInfo,
	ExtractImageTool,
} from "../tools/extract-image.js";
import type {
	OffscreenAgentToolEnvironment,
	OffscreenAgentToolRuntime,
	OffscreenAgentToolRuntimeContext,
} from "./offscreen-agent-session.js";
import type {
	OffscreenRuntimeArtifactsDelegate,
	OffscreenRuntimeOperationContext,
	OffscreenRuntimeReplDelegate,
	OffscreenRuntimeSessionScope,
} from "./offscreen-runtime-host.js";
import { sameRuntimeTarget as sameTarget } from "./runtime-identity.js";
import type {
	RuntimeArtifactDescriptor,
	RuntimeArtifactsPayload,
	RuntimeRecord,
	RuntimeTraceContext,
	RuntimeValue,
} from "./runtime-protocol.js";

const ARTIFACTS_TOOL_DESCRIPTION = `Create, read, update, and delete durable session artifacts.

Commands:
- create: create a new file with filename and content
- update: replace old_str with new_str in an existing file
- rewrite: replace an existing file's complete content
- get: read an existing file
- delete: delete an existing file

Artifacts are available to JavaScript REPL code through listArtifacts(), getArtifact(),
createOrUpdateArtifact(), and deleteArtifact().`;

const ARTIFACTS_RUNTIME_DESCRIPTION = `
### Artifacts Storage

Create, read, update, and delete session files.

#### Functions
- listArtifacts() - List artifact filenames
- getArtifact(filename) - Read content; JSON files are parsed automatically
- createOrUpdateArtifact(filename, content, mimeType?) - Create or replace a file
- deleteArtifact(filename) - Delete a file
`;

const artifactsParameters = Type.Object({
	command: StringEnum(["create", "update", "rewrite", "get", "delete", "logs"]),
	filename: Type.String(),
	content: Type.Optional(Type.String()),
	old_str: Type.Optional(Type.String()),
	new_str: Type.Optional(Type.String()),
});

const replParameters = Type.Object({
	title: Type.String(),
	code: Type.String(),
});

const privilegedRecordParameters = Type.Record(Type.String(), Type.Unknown());
const selectElementParameters = Type.Object({ message: Type.Optional(Type.String()) });
const pageSnapshotParameters = Type.Object({
	tabId: Type.Optional(Type.Number()),
	frameId: Type.Optional(Type.Number()),
	maxEntries: Type.Optional(Type.Number()),
	includeHidden: Type.Optional(Type.Boolean()),
	query: Type.Optional(Type.String()),
});
type ArtifactToolParameters = Static<typeof artifactsParameters>;
type ReplParameters = Static<typeof replParameters>;

export interface OffscreenArtifactRecord extends RuntimeArtifactDescriptor {
	content: string;
	createdAt: string;
	updatedAt: string;
	logs: OffscreenArtifactLog[];
}

export interface OffscreenArtifactLog {
	type: "log" | "warn" | "error" | "info";
	text: string;
}

export type OffscreenArtifactMutationAction = "create" | "update";

export interface OffscreenArtifactMutation {
	action: OffscreenArtifactMutationAction;
	artifact: OffscreenArtifactRecord;
}

export type OffscreenPrivilegedOperation =
	| "navigate"
	| "page-snapshot"
	| "select-element"
	| "screenshot"
	| "extract-image-source"
	| "debugger"
	| "browser-js"
	| "native-input"
	| "repl-overlay-show"
	| "repl-overlay-remove";

export type OffscreenPrivilegedOperationOrigin =
	| { kind: "agent-tool"; toolCallId: string }
	| { kind: "repl"; sandboxId: string; messageId?: string };

export interface OffscreenParentExecutionIdentity {
	runtimeEpoch: string;
	requestId: string;
	executionId: string;
	trace?: RuntimeTraceContext;
}

export interface OffscreenPrivilegedOperationContext
	extends OffscreenRuntimeSessionScope,
		OffscreenParentExecutionIdentity {
	operationId: string;
	origin: OffscreenPrivilegedOperationOrigin;
	signal: AbortSignal;
}

export interface OffscreenBoundPrivilegedOperationOptions {
	operationId: string;
	origin: OffscreenPrivilegedOperationOrigin;
	/** Signal used only to resolve the exact parent when cleanup needs a fresh operation signal. */
	parentSignal?: AbortSignal;
	signal?: AbortSignal;
}

/** Resolves the exact prompt or REPL parent before crossing the service-worker boundary. */
export interface OffscreenBoundPrivilegedOperationExecutor {
	execute(
		operation: OffscreenPrivilegedOperation,
		params: RuntimeRecord,
		options: OffscreenBoundPrivilegedOperationOptions,
	): Promise<RuntimeValue>;
}

/**
 * The service-worker boundary is injected here. Implementations must execute
 * against `context.target` and use `context.signal` for exact cancellation.
 */
export interface OffscreenPrivilegedOperationExecutor {
	execute(
		operation: OffscreenPrivilegedOperation,
		params: RuntimeRecord,
		context: OffscreenPrivilegedOperationContext,
	): Promise<RuntimeValue>;
}

export interface OffscreenReplToolResult {
	files?: Array<{
		fileName: string;
		contentBase64: string;
		mimeType: string;
		size: number;
	}>;
}

export interface OffscreenHtmlArtifactExecutionRequest extends OffscreenRuntimeSessionScope {
	artifact: OffscreenArtifactRecord;
	providers: SandboxRuntimeProvider[];
	sandboxUrlProvider?: () => string;
	signal: AbortSignal;
}

export interface OffscreenHtmlArtifactExecutionResult {
	logs: OffscreenArtifactLog[];
}

export interface OffscreenHtmlArtifactExecutor {
	execute(request: OffscreenHtmlArtifactExecutionRequest): Promise<OffscreenHtmlArtifactExecutionResult>;
}

export type OffscreenReplTool = AgentTool<typeof replParameters, OffscreenReplToolResult> & {
	runtimeProvidersFactory?: () => SandboxRuntimeProvider[];
	sandboxUrlProvider?: () => string;
};

export interface OffscreenToolEnvironmentDependencies {
	privilegedOperations?: OffscreenPrivilegedOperationExecutor;
	htmlArtifacts?: OffscreenHtmlArtifactExecutor;
	createReplTool?: (
		context: OffscreenAgentToolRuntimeContext,
		privilegedOperations?: OffscreenBoundPrivilegedOperationExecutor,
	) => OffscreenReplTool;
	sandboxUrlProvider?: () => string;
	skillTool?: AgentTool;
	createSkillTool?: (
		context: OffscreenAgentToolRuntimeContext,
		privilegedOperations?: OffscreenBoundPrivilegedOperationExecutor,
	) => AgentTool;
	createExtractDocumentTool?: (context: OffscreenAgentToolRuntimeContext) => AgentTool;
	debuggerMode?: (context: OffscreenAgentToolRuntimeContext) => boolean | Promise<boolean>;
	createAdditionalTools?: (context: OffscreenAgentToolRuntimeContext) => readonly AgentTool[];
	/** Best-effort persistence notification after a non-Agent-loop transcript mutation. */
	onTranscriptMutation?: (context: OffscreenAgentToolRuntimeContext) => Promise<void> | void;
	onError?: (error: unknown, context: OffscreenAgentToolRuntimeContext) => void;
	now?: () => Date;
}

export interface OffscreenAgentToolEnvironmentRuntime extends OffscreenAgentToolEnvironment {
	readonly artifactStore: ArtifactStore;
	listArtifactRecords(): readonly OffscreenArtifactRecord[];
	executeArtifacts(payload: RuntimeArtifactsPayload, signal: AbortSignal): Promise<RuntimeValue>;
	executeRepl(code: string, operation: OffscreenRuntimeOperationContext): Promise<RuntimeValue>;
	getRuntimeProviders(): SandboxRuntimeProvider[];
}

interface OffscreenArtifactMessage {
	role: "artifact";
	action: "create" | "update" | "delete";
	filename: string;
	content?: string;
	mimeType?: string;
	logs?: OffscreenArtifactLog[];
	title?: string;
	timestamp: string;
}

interface ToolCallRecord {
	id: string;
	name: string;
	arguments: unknown;
}

interface RuntimeMessageRecord {
	type?: unknown;
	sandboxId?: unknown;
	messageId?: unknown;
	[key: string]: unknown;
}

interface TranscriptAttachment {
	id: string;
	type: "image" | "document";
	fileName: string;
	mimeType: string;
	size: number;
	content: string;
	extractedText?: string;
	preview?: string;
}

interface ProviderResponseRecord {
	success: boolean;
	result?: RuntimeValue;
	error?: string;
}

interface RuntimeProviderBundle {
	providerData: RuntimeRecord;
	providerRuntimes: string[];
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortError("Offscreen tool operation was aborted");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseArtifactLogs(value: unknown): OffscreenArtifactLog[] {
	if (!Array.isArray(value)) return [];
	const logs: OffscreenArtifactLog[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.text !== "string") continue;
		if (entry.type !== "log" && entry.type !== "warn" && entry.type !== "error" && entry.type !== "info") {
			continue;
		}
		logs.push({ type: entry.type, text: entry.text });
	}
	return logs;
}

function toRuntimeValue(value: unknown, path = "value", ancestors = new Set<object>()): RuntimeValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite numbers`);
		return value;
	}
	if (typeof value !== "object") throw new Error(`${path} cannot cross the runtime boundary`);
	if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);

	const nextAncestors = new Set(ancestors);
	nextAncestors.add(value);
	if (Array.isArray(value)) {
		return value
			.filter((entry) => entry !== undefined)
			.map((entry, index) => toRuntimeValue(entry, `${path}[${index}]`, nextAncestors));
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${path} must contain only plain objects`);
	}
	const result: RuntimeRecord = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (entry !== undefined) result[key] = toRuntimeValue(entry, `${path}.${key}`, nextAncestors);
	}
	return result;
}

function toRuntimeRecord(value: unknown, path = "value"): RuntimeRecord {
	const normalized = toRuntimeValue(value, path);
	if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
		throw new Error(`${path} must be an object`);
	}
	return normalized;
}

function encodeArtifactContent(content: RuntimeValue): string {
	if (typeof content === "string") return content;
	return JSON.stringify(content, null, 2);
}

function inferMimeType(filename: string): string {
	const extension = filename.split(".").pop()?.toLowerCase();
	const known: Record<string, string> = {
		bmp: "image/bmp",
		css: "text/css",
		csv: "text/csv",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		gif: "image/gif",
		html: "text/html",
		ico: "image/x-icon",
		jpeg: "image/jpeg",
		jpg: "image/jpeg",
		js: "text/javascript",
		json: "application/json",
		markdown: "text/markdown",
		md: "text/markdown",
		pdf: "application/pdf",
		png: "image/png",
		svg: "image/svg+xml",
		txt: "text/plain",
		webp: "image/webp",
		xls: "application/vnd.ms-excel",
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		xml: "application/xml",
		yaml: "application/yaml",
		yml: "application/yaml",
	};
	return (extension && known[extension]) || "application/octet-stream";
}

function isHtmlArtifact(artifact: Pick<OffscreenArtifactRecord, "filename" | "mimeType">): boolean {
	return artifact.mimeType === "text/html" || artifact.filename.toLowerCase().endsWith(".html");
}

function artifactLogsText(artifact: OffscreenArtifactRecord): string {
	if (!isHtmlArtifact(artifact)) {
		throw new Error(`File ${artifact.filename} is not an HTML file. Logs are only available for HTML files.`);
	}
	if (artifact.logs.length === 0) return `No logs for ${artifact.filename}`;
	return artifact.logs.map((log) => `[${log.type}] ${log.text}`).join("\n");
}

function sameArtifactLogs(left: readonly OffscreenArtifactLog[], right: readonly OffscreenArtifactLog[]): boolean {
	return (
		left.length === right.length &&
		left.every((entry, index) => entry.type === right[index]?.type && entry.text === right[index]?.text)
	);
}

function normalizeFilename(filename: string): string {
	const normalized = filename.trim();
	if (!normalized) throw new Error("Artifact filename must not be empty");
	return normalized;
}

function cloneArtifact(artifact: OffscreenArtifactRecord): OffscreenArtifactRecord {
	return { ...artifact, logs: artifact.logs.map((log) => ({ ...log })) };
}

/** Pure, DOM-free storage owned by one offscreen agent session. */
export class ArtifactStore {
	private readonly artifacts = new Map<string, OffscreenArtifactRecord>();

	constructor(private readonly now: () => Date = () => new Date()) {}

	list(): OffscreenArtifactRecord[] {
		return [...this.artifacts.values()].map(cloneArtifact);
	}

	listDescriptors(): RuntimeArtifactDescriptor[] {
		return this.list().map(({ content: _content, logs: _logs, ...descriptor }) => descriptor);
	}

	get(filename: string): OffscreenArtifactRecord | undefined {
		const artifact = this.artifacts.get(normalizeFilename(filename));
		return artifact ? cloneArtifact(artifact) : undefined;
	}

	require(filename: string): OffscreenArtifactRecord {
		const artifact = this.get(filename);
		if (!artifact) throw new Error(`Artifact not found: ${normalizeFilename(filename)}`);
		return artifact;
	}

	create(filename: string, content: string, mimeType?: string): OffscreenArtifactRecord {
		const normalized = normalizeFilename(filename);
		if (!content) throw new Error("Artifact create requires non-empty content");
		if (this.artifacts.has(normalized)) throw new Error(`Artifact already exists: ${normalized}`);
		const timestamp = this.now().toISOString();
		const artifact: OffscreenArtifactRecord = {
			filename: normalized,
			content,
			mimeType: mimeType || inferMimeType(normalized),
			size: new TextEncoder().encode(content).byteLength,
			createdAt: timestamp,
			updatedAt: timestamp,
			logs: [],
		};
		this.artifacts.set(normalized, artifact);
		return cloneArtifact(artifact);
	}

	update(filename: string, oldString: string, newString: string): OffscreenArtifactRecord {
		if (!oldString) throw new Error("Artifact update requires non-empty old_str");
		const current = this.require(filename);
		if (!current.content.includes(oldString)) {
			throw new Error(`String not found in artifact ${current.filename}`);
		}
		return this.replace(current.filename, current.content.replace(oldString, newString), current.mimeType);
	}

	rewrite(filename: string, content: string, mimeType?: string): OffscreenArtifactRecord {
		if (!content) throw new Error("Artifact rewrite requires non-empty content");
		this.require(filename);
		return this.replace(filename, content, mimeType);
	}

	put(filename: string, content: string, mimeType?: string): OffscreenArtifactMutation {
		const normalized = normalizeFilename(filename);
		const existing = this.artifacts.get(normalized);
		return existing
			? { action: "update", artifact: this.replace(normalized, content, mimeType) }
			: { action: "create", artifact: this.create(normalized, content, mimeType) };
	}

	delete(filename: string): OffscreenArtifactRecord {
		const artifact = this.require(filename);
		this.artifacts.delete(artifact.filename);
		return artifact;
	}

	setLogs(filename: string, logs: readonly OffscreenArtifactLog[]): OffscreenArtifactRecord {
		const normalized = normalizeFilename(filename);
		const existing = this.artifacts.get(normalized);
		if (!existing) throw new Error(`Artifact not found: ${normalized}`);
		const artifact = { ...existing, logs: logs.map((log) => ({ ...log })) };
		this.artifacts.set(normalized, artifact);
		return cloneArtifact(artifact);
	}

	/** Rebuilds the store with the same transcript semantics as pi-web-ui. */
	reconstruct(messages: readonly AgentMessage[]): void {
		this.artifacts.clear();
		const toolCalls = new Map<string, ToolCallRecord>();
		for (const message of messages) {
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block.type === "toolCall" && block.name === "artifacts") {
					toolCalls.set(block.id, { id: block.id, name: block.name, arguments: block.arguments });
				}
			}
		}

		for (const message of messages) {
			if (message.role === "artifact") {
				this.replayArtifactMessage(message as OffscreenArtifactMessage);
				continue;
			}
			if (message.role !== "toolResult" || message.toolName !== "artifacts" || message.isError) continue;
			const details = (message as AgentMessage & { details?: unknown }).details;
			if (this.replayToolResultDetails(details)) continue;
			const call = toolCalls.get(message.toolCallId);
			if (call) this.replayToolArguments(call.arguments);
		}
	}

	private replace(filename: string, content: string, mimeType?: string): OffscreenArtifactRecord {
		const normalized = normalizeFilename(filename);
		const existing = this.artifacts.get(normalized);
		if (!existing) throw new Error(`Artifact not found: ${normalized}`);
		const artifact: OffscreenArtifactRecord = {
			...existing,
			content,
			mimeType: mimeType || existing.mimeType || inferMimeType(normalized),
			size: new TextEncoder().encode(content).byteLength,
			updatedAt: this.now().toISOString(),
			logs: [],
		};
		this.artifacts.set(normalized, artifact);
		return cloneArtifact(artifact);
	}

	private replayArtifactMessage(message: OffscreenArtifactMessage): void {
		if (message.action === "delete") {
			this.artifacts.delete(message.filename);
			return;
		}
		if (!message.content) return;
		this.replayPut(message.filename, message.content, message.mimeType, message.timestamp, message.logs);
	}

	private replayToolResultDetails(value: unknown): boolean {
		if (!isRecord(value) || !isRecord(value.artifact)) return false;
		const artifact = value.artifact;
		if (typeof artifact.filename !== "string") return false;
		if (value.action === "delete") {
			this.artifacts.delete(artifact.filename);
			return true;
		}
		if (typeof artifact.content !== "string") return false;
		this.replayPut(
			artifact.filename,
			artifact.content,
			typeof artifact.mimeType === "string" ? artifact.mimeType : undefined,
			typeof artifact.updatedAt === "string" ? artifact.updatedAt : undefined,
			parseArtifactLogs(artifact.logs),
		);
		return true;
	}

	private replayToolArguments(value: unknown): void {
		if (!isRecord(value) || typeof value.command !== "string" || typeof value.filename !== "string") return;
		const filename = value.filename;
		switch (value.command) {
			case "create":
			case "rewrite":
				if (typeof value.content === "string" && value.content) this.replayPut(filename, value.content);
				break;
			case "update": {
				const current = this.artifacts.get(filename);
				if (
					current &&
					typeof value.old_str === "string" &&
					typeof value.new_str === "string" &&
					current.content.includes(value.old_str)
				) {
					this.replayPut(filename, current.content.replace(value.old_str, value.new_str));
				}
				break;
			}
			case "delete":
				this.artifacts.delete(filename);
				break;
		}
	}

	private replayPut(
		filename: string,
		content: string,
		mimeType?: string,
		timestamp?: string,
		logs: readonly OffscreenArtifactLog[] = [],
	): void {
		const normalized = normalizeFilename(filename);
		const existing = this.artifacts.get(normalized);
		const nextTimestamp = timestamp || this.now().toISOString();
		this.artifacts.set(normalized, {
			filename: normalized,
			content,
			mimeType: mimeType || existing?.mimeType || inferMimeType(normalized),
			size: new TextEncoder().encode(content).byteLength,
			createdAt: existing?.createdAt || nextTimestamp,
			updatedAt: nextTimestamp,
			logs: logs.map((log) => ({ ...log })),
		});
	}
}

function appendArtifactMessage(
	agent: Agent,
	mutation: OffscreenArtifactMutation | { action: "delete"; artifact: OffscreenArtifactRecord },
): void {
	const artifact = mutation.artifact;
	const message: OffscreenArtifactMessage = {
		role: "artifact",
		action: mutation.action,
		filename: artifact.filename,
		...(mutation.action === "delete" ? {} : { content: artifact.content }),
		...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
		...(mutation.action === "delete" ? {} : { logs: artifact.logs.map((log) => ({ ...log })) }),
		...(mutation.action === "create" ? { title: artifact.filename } : {}),
		timestamp: artifact.updatedAt,
	};
	agent.state.messages = [...agent.state.messages, message];
}

function extractAttachments(messages: readonly AgentMessage[]): TranscriptAttachment[] {
	const attachments: TranscriptAttachment[] = [];
	for (const message of messages) {
		if (message.role !== "user-with-attachments" || !Array.isArray(message.attachments)) continue;
		for (const attachment of message.attachments) attachments.push({ ...attachment });
	}
	return attachments;
}

function responseKey(message: RuntimeMessageRecord): string | undefined {
	return typeof message.sandboxId === "string" && typeof message.messageId === "string"
		? `${message.sandboxId}\u0000${message.messageId}`
		: undefined;
}

function normalizedProviderResponse(result: RuntimeValue): ProviderResponseRecord | RuntimeRecord {
	if (result !== null && !Array.isArray(result) && typeof result === "object" && typeof result.success === "boolean") {
		return result;
	}
	return { success: true, result };
}

function serializeRuntimeProviders(providers: readonly SandboxRuntimeProvider[]): RuntimeProviderBundle {
	const providerData: RuntimeRecord = {};
	const providerRuntimes: string[] = [];
	for (const provider of providers) {
		for (const [key, value] of Object.entries(provider.getData())) {
			providerData[key] = toRuntimeValue(value, `providerData.${key}`);
		}
		providerRuntimes.push(provider.getRuntime().toString());
	}
	return { providerData, providerRuntimes };
}

type ParentExecutionResolver = (signal?: AbortSignal) => OffscreenParentExecutionIdentity;

function missingParentExecution(): never {
	throw new Error("Privileged page operation has no exact parent execution");
}

interface SandboxExecutionBinding {
	parent: OffscreenParentExecutionIdentity;
	signal: AbortSignal;
}

abstract class DeduplicatingRuntimeProvider implements SandboxRuntimeProvider {
	private readonly executions = new Map<string, SandboxExecutionBinding>();
	private readonly responses = new Map<string, Promise<ProviderResponseRecord | RuntimeRecord>>();

	protected constructor(
		private readonly messageType: string,
		protected readonly scope: OffscreenRuntimeSessionScope,
		protected readonly executor: OffscreenPrivilegedOperationExecutor,
		private readonly resolveParentExecution: ParentExecutionResolver = missingParentExecution,
	) {}

	getData(): Record<string, unknown> {
		return {};
	}

	onExecutionStart(sandboxId: string, signal?: AbortSignal): void {
		if (this.executions.has(sandboxId)) {
			throw new Error(`Sandbox execution is already active: ${sandboxId}`);
		}
		this.executions.set(sandboxId, {
			parent: this.resolveParentExecution(signal),
			signal: signal ?? new AbortController().signal,
		});
	}

	onExecutionEnd(sandboxId: string): void {
		this.executions.delete(sandboxId);
		for (const key of this.responses.keys()) {
			if (key.startsWith(`${sandboxId}\u0000`)) this.responses.delete(key);
		}
	}

	async handleMessage(message: unknown, respond: (response: unknown) => void): Promise<void> {
		if (!isRecord(message) || message.type !== this.messageType) return;
		const record: RuntimeMessageRecord = message;
		const key = responseKey(record);
		let response = key ? this.responses.get(key) : undefined;
		if (!response) {
			response = this.executeMessage(record).catch(
				(error): ProviderResponseRecord => ({
					success: false,
					error: errorMessage(error),
				}),
			);
			if (key) this.responses.set(key, response);
		}
		respond(await response);
	}

	protected contextFor(message: RuntimeMessageRecord): OffscreenPrivilegedOperationContext {
		if (typeof message.sandboxId !== "string") {
			throw new Error(`${this.messageType} message is missing its sandbox execution identity`);
		}
		const sandboxId = message.sandboxId;
		const execution = this.executions.get(sandboxId);
		if (!execution) {
			throw new Error(`Sandbox execution has no exact parent identity: ${sandboxId}`);
		}
		const messageId = typeof message.messageId === "string" ? message.messageId : undefined;
		return {
			...this.scope,
			...execution.parent,
			operationId: messageId ? `${sandboxId}:${messageId}` : `${sandboxId}:${this.messageType}`,
			origin: { kind: "repl", sandboxId, ...(messageId ? { messageId } : {}) },
			signal: execution.signal,
		};
	}

	protected abstract executeMessage(message: RuntimeMessageRecord): Promise<ProviderResponseRecord | RuntimeRecord>;
	abstract getRuntime(): (sandboxId: string) => void;
	abstract getDescription(): string;
}

export class OffscreenBrowserJsRuntimeProvider extends DeduplicatingRuntimeProvider {
	constructor(
		scope: OffscreenRuntimeSessionScope,
		executor: OffscreenPrivilegedOperationExecutor,
		private readonly pageProviders: () => readonly SandboxRuntimeProvider[] = () => [],
		private readonly applyArtifactMutations?: (value: unknown, signal: AbortSignal) => Promise<void>,
		resolveParentExecution?: ParentExecutionResolver,
	) {
		super("browser-js", scope, executor, resolveParentExecution);
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			const sandboxWindow = window as unknown as {
				sendRuntimeMessage?: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
				browserjs?: (func: (...args: unknown[]) => unknown, ...args: unknown[]) => Promise<unknown>;
			};
			const send = sandboxWindow.sendRuntimeMessage;
			if (typeof send !== "function") throw new Error("sendRuntimeMessage is unavailable");
			sandboxWindow.browserjs = async (func: (...args: unknown[]) => unknown, ...args: unknown[]) => {
				if (typeof func !== "function") throw new Error("browserjs() requires a function");
				const response = await send({ type: "browser-js", code: func.toString(), args: JSON.stringify(args) });
				if (Array.isArray(response.console)) {
					for (const entry of response.console) console.log("[browserjs]", entry);
				}
				if (response.success !== true) throw new Error(String(response.error || "browserjs() failed"));
				return response.result;
			};
		};
	}

	getDescription(): string {
		return BROWSERJS_RUNTIME_PROVIDER_DESCRIPTION;
	}

	protected async executeMessage(message: RuntimeMessageRecord): Promise<ProviderResponseRecord | RuntimeRecord> {
		if (typeof message.code !== "string") throw new Error("browser-js requires code");
		if (message.args !== undefined && typeof message.args !== "string") {
			throw new Error("browser-js args must be a JSON string");
		}
		const context = this.contextFor(message);
		throwIfAborted(context.signal);
		const providerBundle = serializeRuntimeProviders(this.pageProviders());
		const result = await this.executor.execute(
			"browser-js",
			{
				code: message.code,
				...(typeof message.args === "string" ? { args: message.args } : {}),
				...providerBundle,
			},
			context,
		);
		throwIfAborted(context.signal);
		if (this.applyArtifactMutations && isRecord(result) && Array.isArray(result.artifactMutations)) {
			await this.applyArtifactMutations(result.artifactMutations, context.signal);
			throwIfAborted(context.signal);
			const { artifactMutations: _artifactMutations, ...response } = result;
			return normalizedProviderResponse(toRuntimeRecord(response, "browser-js response"));
		}
		return normalizedProviderResponse(result);
	}
}

export class OffscreenNavigateRuntimeProvider extends DeduplicatingRuntimeProvider {
	constructor(
		scope: OffscreenRuntimeSessionScope,
		executor: OffscreenPrivilegedOperationExecutor,
		resolveParentExecution?: ParentExecutionResolver,
	) {
		super("navigate", scope, executor, resolveParentExecution);
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			const sandboxWindow = window as unknown as {
				sendRuntimeMessage?: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
				navigate?: (args: Record<string, unknown>) => Promise<unknown>;
			};
			const send = sandboxWindow.sendRuntimeMessage;
			if (typeof send !== "function") throw new Error("sendRuntimeMessage is unavailable");
			sandboxWindow.navigate = async (args: Record<string, unknown>) => {
				const response = await send({ type: "navigate", args });
				if (response.success !== true) throw new Error(String(response.error || "navigate() failed"));
				return response.result;
			};
		};
	}

	getDescription(): string {
		return NAVIGATE_RUNTIME_PROVIDER_DESCRIPTION;
	}

	protected async executeMessage(message: RuntimeMessageRecord): Promise<ProviderResponseRecord | RuntimeRecord> {
		const params = toRuntimeRecord(message.args, "navigate args");
		const context = this.contextFor(message);
		throwIfAborted(context.signal);
		const result = await this.executor.execute("navigate", params, context);
		throwIfAborted(context.signal);
		return normalizedProviderResponse(result);
	}
}

export class OffscreenNativeInputRuntimeProvider extends DeduplicatingRuntimeProvider {
	constructor(
		scope: OffscreenRuntimeSessionScope,
		executor: OffscreenPrivilegedOperationExecutor,
		resolveParentExecution?: ParentExecutionResolver,
	) {
		super("native-input", scope, executor, resolveParentExecution);
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			const sandboxWindow = window as unknown as {
				sendRuntimeMessage?: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
				nativeClick?: (selector: string) => Promise<void>;
				nativeType?: (selector: string, text: string) => Promise<void>;
				nativePress?: (key: string) => Promise<void>;
				nativeKeyDown?: (key: string) => Promise<void>;
				nativeKeyUp?: (key: string) => Promise<void>;
			};
			const send = sandboxWindow.sendRuntimeMessage;
			if (typeof send !== "function") throw new Error("sendRuntimeMessage is unavailable");
			const invoke = async (message: Record<string, unknown>): Promise<void> => {
				const response = await send({ type: "native-input", ...message });
				if (response.success !== true) throw new Error(String(response.error || "native input failed"));
			};
			sandboxWindow.nativeClick = (selector: string) => invoke({ action: "click", selector });
			sandboxWindow.nativeType = (selector: string, text: string) => invoke({ action: "type", selector, text });
			sandboxWindow.nativePress = (key: string) => invoke({ action: "press", key });
			sandboxWindow.nativeKeyDown = (key: string) => invoke({ action: "keyDown", key });
			sandboxWindow.nativeKeyUp = (key: string) => invoke({ action: "keyUp", key });
		};
	}

	getDescription(): string {
		return NATIVE_INPUT_EVENTS_DESCRIPTION;
	}

	protected async executeMessage(message: RuntimeMessageRecord): Promise<ProviderResponseRecord | RuntimeRecord> {
		if (typeof message.action !== "string") throw new Error("native-input requires an action");
		const params: RuntimeRecord = { action: message.action };
		for (const key of ["selector", "text", "key"] as const) {
			const value = message[key];
			if (value !== undefined) params[key] = toRuntimeValue(value, `native-input.${key}`);
		}
		const context = this.contextFor(message);
		throwIfAborted(context.signal);
		const result = await this.executor.execute("native-input", params, context);
		throwIfAborted(context.signal);
		return normalizedProviderResponse(result);
	}
}

export class OffscreenArtifactsRuntimeProvider implements SandboxRuntimeProvider {
	private readonly signals = new Map<string, AbortSignal>();
	private readonly responses = new Map<string, Promise<ProviderResponseRecord>>();

	constructor(
		private readonly environment: OffscreenSessionToolEnvironment,
		private readonly readOnly = false,
	) {}

	getData(): Record<string, unknown> {
		return {
			artifacts: Object.fromEntries(
				this.environment.listArtifactRecords().map((artifact) => [artifact.filename, artifact.content]),
			),
		};
	}

	getRuntime(): (sandboxId: string) => void {
		if (this.readOnly) {
			return (_sandboxId: string) => {
				const sandboxWindow = window as unknown as {
					artifacts?: Record<string, string>;
					listArtifacts?: () => Promise<string[]>;
					getArtifact?: (filename: string) => Promise<unknown>;
					createOrUpdateArtifact?: (filename: string, content: unknown, mimeType?: string) => Promise<void>;
					deleteArtifact?: (filename: string) => Promise<void>;
				};
				const unavailable = async (): Promise<never> => {
					throw new Error("Artifacts are read-only in HTML artifact and browserjs execution");
				};
				sandboxWindow.listArtifacts = async () => Object.keys(sandboxWindow.artifacts || {});
				sandboxWindow.getArtifact = async (filename: string) => {
					const artifacts = sandboxWindow.artifacts || {};
					if (!Object.hasOwn(artifacts, filename)) {
						throw new Error(`Artifact not found: ${filename}`);
					}
					const content = artifacts[filename];
					if (filename.endsWith(".json")) return JSON.parse(content);
					return content;
				};
				sandboxWindow.createOrUpdateArtifact = unavailable;
				sandboxWindow.deleteArtifact = unavailable;
			};
		}
		return (_sandboxId: string) => {
			const sandboxWindow = window as unknown as {
				artifacts?: Record<string, string>;
				sendRuntimeMessage?: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
				listArtifacts?: () => Promise<string[]>;
				getArtifact?: (filename: string) => Promise<unknown>;
				createOrUpdateArtifact?: (filename: string, content: unknown, mimeType?: string) => Promise<void>;
				deleteArtifact?: (filename: string) => Promise<void>;
			};
			const send = sandboxWindow.sendRuntimeMessage;
			if (typeof send !== "function") throw new Error("sendRuntimeMessage is unavailable");
			sandboxWindow.listArtifacts = async () => {
				const response = await send({ type: "artifact-operation", action: "list" });
				if (response.success !== true) throw new Error(String(response.error || "Artifact list failed"));
				return Array.isArray(response.result) ? response.result.map(String) : [];
			};
			sandboxWindow.getArtifact = async (filename: string) => {
				const response = await send({ type: "artifact-operation", action: "get", filename });
				if (response.success !== true) throw new Error(String(response.error || "Artifact read failed"));
				if (filename.endsWith(".json") && typeof response.result === "string") return JSON.parse(response.result);
				return response.result;
			};
			sandboxWindow.createOrUpdateArtifact = async (filename: string, content: unknown, mimeType?: string) => {
				const finalContent = typeof content === "string" ? content : JSON.stringify(content, null, 2);
				const response = await send({
					type: "artifact-operation",
					action: "createOrUpdate",
					filename,
					content: finalContent,
					...(mimeType ? { mimeType } : {}),
				});
				if (response.success !== true) throw new Error(String(response.error || "Artifact write failed"));
			};
			sandboxWindow.deleteArtifact = async (filename: string) => {
				const response = await send({ type: "artifact-operation", action: "delete", filename });
				if (response.success !== true) throw new Error(String(response.error || "Artifact delete failed"));
			};
		};
	}

	getDescription(): string {
		return ARTIFACTS_RUNTIME_DESCRIPTION;
	}

	onExecutionStart(sandboxId: string, signal?: AbortSignal): void {
		if (signal) this.signals.set(sandboxId, signal);
	}

	onExecutionEnd(sandboxId: string): void {
		this.signals.delete(sandboxId);
		for (const key of this.responses.keys()) {
			if (key.startsWith(`${sandboxId}\u0000`)) this.responses.delete(key);
		}
	}

	async handleMessage(message: unknown, respond: (response: unknown) => void): Promise<void> {
		if (!isRecord(message) || message.type !== "artifact-operation") return;
		const record: RuntimeMessageRecord = message;
		const key = responseKey(record);
		let response = key ? this.responses.get(key) : undefined;
		if (!response) {
			response = this.executeMessage(record).catch(
				(error): ProviderResponseRecord => ({
					success: false,
					error: errorMessage(error),
				}),
			);
			if (key) this.responses.set(key, response);
		}
		respond(await response);
	}

	private async executeMessage(message: RuntimeMessageRecord): Promise<ProviderResponseRecord> {
		const signal =
			typeof message.sandboxId === "string"
				? (this.signals.get(message.sandboxId) ?? new AbortController().signal)
				: new AbortController().signal;
		throwIfAborted(signal);
		switch (message.action) {
			case "list":
				return {
					success: true,
					result: this.environment.listArtifactRecords().map((artifact) => artifact.filename),
				};
			case "get": {
				if (typeof message.filename !== "string") throw new Error("Artifact get requires filename");
				return { success: true, result: this.environment.artifactStore.require(message.filename).content };
			}
			case "createOrUpdate": {
				if (this.readOnly) throw new Error("Artifacts are read-only in this execution");
				if (typeof message.filename !== "string" || typeof message.content !== "string") {
					throw new Error("Artifact write requires filename and content");
				}
				const artifact = await this.environment.putAndRecord(
					message.filename,
					message.content,
					typeof message.mimeType === "string" ? message.mimeType : undefined,
					signal,
				);
				return { success: true, result: toRuntimeRecord(artifact, "artifact") };
			}
			case "delete": {
				if (this.readOnly) throw new Error("Artifacts are read-only in this execution");
				if (typeof message.filename !== "string") throw new Error("Artifact delete requires filename");
				const artifact = await this.environment.deleteAndRecord(message.filename, signal);
				return { success: true, result: toRuntimeRecord(artifact, "artifact") };
			}
			default:
				throw new Error(`Unknown artifact action: ${String(message.action)}`);
		}
	}
}

function createArtifactTool(
	environment: OffscreenSessionToolEnvironment,
): AgentTool<typeof artifactsParameters, RuntimeValue> {
	return {
		name: "artifacts",
		label: "Artifacts",
		description: ARTIFACTS_TOOL_DESCRIPTION,
		parameters: artifactsParameters,
		async execute(
			_toolCallId: string,
			params: ArtifactToolParameters,
			signal?: AbortSignal,
		): Promise<AgentToolResult<RuntimeValue>> {
			const operationSignal = signal ?? new AbortController().signal;
			return await environment.executeArtifactTool(params, operationSignal);
		},
	};
}

function formatPrivilegedResult(result: RuntimeValue): AgentToolResult<RuntimeValue> {
	const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
	return { content: [{ type: "text", text }], details: result };
}

function createPrivilegedTool<TParameters extends TSchema>(
	executor: OffscreenBoundPrivilegedOperationExecutor,
	definition: {
		name: string;
		label: string;
		description: string;
		operation: OffscreenPrivilegedOperation;
		parameters: TParameters;
		mapParams?: (params: Static<TParameters>) => RuntimeRecord;
	},
): AgentTool<TParameters, RuntimeValue> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		async execute(toolCallId, params, signal) {
			const operationSignal = signal ?? new AbortController().signal;
			throwIfAborted(operationSignal);
			const result = await executor.execute(
				definition.operation,
				definition.mapParams ? definition.mapParams(params) : toRuntimeRecord(params),
				{
					operationId: toolCallId,
					origin: { kind: "agent-tool", toolCallId },
					signal: operationSignal,
				},
			);
			throwIfAborted(operationSignal);
			return formatPrivilegedResult(result);
		},
	};
}

function createOffscreenExtractImageTool(
	context: OffscreenAgentToolRuntimeContext,
	executor: OffscreenBoundPrivilegedOperationExecutor,
): ExtractImageTool {
	return new ExtractImageTool({
		windowId: context.windowId,
		async resolveSelector(selector, toolCallId, signal): Promise<ExtractImageSourceInfo> {
			const operationSignal = signal ?? new AbortController().signal;
			const result = await executor.execute(
				"extract-image-source",
				{ selector },
				{
					operationId: toolCallId,
					origin: { kind: "agent-tool", toolCallId },
					signal: operationSignal,
				},
			);
			throwIfAborted(operationSignal);
			if (
				!isRecord(result) ||
				typeof result.src !== "string" ||
				typeof result.width !== "number" ||
				typeof result.height !== "number"
			) {
				throw new Error("Background image extraction returned invalid source metadata");
			}
			return { src: result.src, width: result.width, height: result.height };
		},
		async captureScreenshot(toolCallId, signal): Promise<ExtractImageScreenshotSource> {
			const operationSignal = signal ?? new AbortController().signal;
			const result = await executor.execute(
				"screenshot",
				{},
				{
					operationId: toolCallId,
					origin: { kind: "agent-tool", toolCallId },
					signal: operationSignal,
				},
			);
			throwIfAborted(operationSignal);
			if (
				!isRecord(result) ||
				typeof result.dataUrl !== "string" ||
				typeof result.cssWidth !== "number" ||
				typeof result.cssHeight !== "number" ||
				typeof result.devicePixelRatio !== "number"
			) {
				throw new Error("Background screenshot returned invalid image metadata");
			}
			return {
				src: result.dataUrl,
				cssWidth: result.cssWidth,
				cssHeight: result.cssHeight,
				devicePixelRatio: result.devicePixelRatio,
			};
		},
	});
}

function createOffscreenDebuggerTool(
	executor: OffscreenBoundPrivilegedOperationExecutor,
): AgentTool<typeof debuggerSchema, RuntimeValue> {
	return {
		name: "debugger",
		label: "Debugger",
		description: DEBUGGER_TOOL_DESCRIPTION,
		parameters: debuggerSchema,
		async execute(toolCallId, params, signal) {
			if (params.tabId !== undefined || params.frameId !== undefined) {
				throw new Error("Debugger tool cannot override the exact session target");
			}
			const operationSignal = signal ?? new AbortController().signal;
			throwIfAborted(operationSignal);
			const result = await executor.execute("debugger", toRuntimeRecord(params), {
				operationId: toolCallId,
				origin: { kind: "agent-tool", toolCallId },
				signal: operationSignal,
			});
			throwIfAborted(operationSignal);
			if (!isRecord(result) || !Array.isArray(result.content) || !isRecord(result.details)) {
				throw new Error("Background debugger returned an invalid tool result");
			}
			const content = result.content.map((entry) => {
				if (!isRecord(entry) || entry.type !== "text" || typeof entry.text !== "string") {
					throw new Error("Background debugger returned invalid text content");
				}
				return { type: "text" as const, text: entry.text };
			});
			return { content, details: toRuntimeValue(result.details, "debugger details") };
		},
	};
}

function createPrivilegedTools(
	context: OffscreenAgentToolRuntimeContext,
	executor: OffscreenBoundPrivilegedOperationExecutor,
): AgentTool[] {
	return [
		createPrivilegedTool(executor, {
			name: "navigate",
			label: "Navigate",
			description: "Navigate and manage tabs through the service-worker page driver.",
			operation: "navigate",
			parameters: privilegedRecordParameters,
		}),
		createPrivilegedTool(executor, {
			name: "page_snapshot",
			label: "Page Snapshot",
			description: "Capture a semantic page snapshot through the service-worker page driver.",
			operation: "page-snapshot",
			parameters: pageSnapshotParameters,
		}),
		createPrivilegedTool(executor, {
			name: "ask_user_which_element",
			label: "Ask User Which Element",
			description: "Ask the user to select a page element in the exact target.",
			operation: "select-element",
			parameters: selectElementParameters,
		}),
		createOffscreenExtractImageTool(context, executor) as unknown as AgentTool,
	];
}

function scopeKey(scope: Pick<OffscreenRuntimeSessionScope, "clientId" | "windowId" | "sessionId">): string {
	return JSON.stringify([scope.clientId, scope.windowId, scope.sessionId]);
}

export class OffscreenSessionToolEnvironment implements OffscreenAgentToolEnvironmentRuntime {
	readonly artifactStore: ArtifactStore;
	readonly tools: AgentTool[];
	private readonly artifactProvider: OffscreenArtifactsRuntimeProvider;
	private readonly readOnlyArtifactProvider: OffscreenArtifactsRuntimeProvider;
	private readonly privilegedProviders: SandboxRuntimeProvider[];
	private readonly boundPrivilegedOperations?: OffscreenBoundPrivilegedOperationExecutor;
	private readonly parentExecutionsBySignal = new WeakMap<AbortSignal, OffscreenParentExecutionIdentity>();
	private readonly replTool?: OffscreenReplTool;
	private activeAgentParentExecution?: OffscreenParentExecutionIdentity;
	private disposed = false;

	constructor(
		readonly context: OffscreenAgentToolRuntimeContext,
		private readonly dependencies: OffscreenToolEnvironmentDependencies,
		private readonly onDispose: () => void,
	) {
		this.artifactStore = new ArtifactStore(dependencies.now);
		this.artifactStore.reconstruct(context.agent.state.messages);
		this.artifactProvider = new OffscreenArtifactsRuntimeProvider(this);
		this.readOnlyArtifactProvider = new OffscreenArtifactsRuntimeProvider(this, true);
		this.boundPrivilegedOperations = dependencies.privilegedOperations
			? {
					execute: (operation, params, options) =>
						this.executeBoundPrivilegedOperation(operation, params, options),
				}
			: undefined;
		const resolveParentExecution = (signal?: AbortSignal): OffscreenParentExecutionIdentity =>
			this.requireParentExecution(signal);
		this.privilegedProviders = dependencies.privilegedOperations
			? [
					new OffscreenBrowserJsRuntimeProvider(
						context,
						dependencies.privilegedOperations,
						() => this.getBrowserJsContentProviders(),
						(value, signal) => this.applyBrowserJsArtifactMutations(value, signal),
						resolveParentExecution,
					),
					new OffscreenNavigateRuntimeProvider(context, dependencies.privilegedOperations, resolveParentExecution),
					new OffscreenNativeInputRuntimeProvider(
						context,
						dependencies.privilegedOperations,
						resolveParentExecution,
					),
				]
			: [];

		const tools: AgentTool[] = [createArtifactTool(this)];
		if (this.boundPrivilegedOperations) {
			tools.push(...createPrivilegedTools(context, this.boundPrivilegedOperations));
		}
		this.replTool = dependencies.createReplTool?.(context, this.boundPrivilegedOperations);
		if (this.replTool) {
			this.replTool.runtimeProvidersFactory = () => this.getRuntimeProviders();
			if (dependencies.sandboxUrlProvider) this.replTool.sandboxUrlProvider = dependencies.sandboxUrlProvider;
			tools.push(this.replTool);
		}
		const skillTool =
			dependencies.createSkillTool?.(context, this.boundPrivilegedOperations) ?? dependencies.skillTool;
		if (skillTool) tools.push(skillTool);
		const extractDocumentTool = dependencies.createExtractDocumentTool?.(context);
		if (extractDocumentTool) tools.push(extractDocumentTool);
		const additionalTools = dependencies.createAdditionalTools?.(context);
		if (additionalTools) tools.push(...additionalTools);
		this.tools = tools;
	}

	listArtifacts(): readonly RuntimeArtifactDescriptor[] {
		return this.artifactStore.listDescriptors();
	}

	listArtifactRecords(): readonly OffscreenArtifactRecord[] {
		return this.artifactStore.list();
	}

	async withParentExecution<T>(context: OffscreenRuntimeOperationContext, operation: () => Promise<T>): Promise<T> {
		this.assertMatchingScope(context);
		if (this.activeAgentParentExecution) {
			throw new Error("Offscreen Agent prompt already has an active parent execution");
		}
		const parent = this.parentExecutionIdentity(context);
		this.activeAgentParentExecution = parent;
		try {
			return await this.withSignalParentExecution(context, parent, operation);
		} finally {
			if (this.activeAgentParentExecution === parent) this.activeAgentParentExecution = undefined;
		}
	}

	async initialize(signal: AbortSignal): Promise<void> {
		this.assertActive();
		if (
			this.dependencies.privilegedOperations &&
			this.dependencies.debuggerMode &&
			(await this.dependencies.debuggerMode(this.context))
		) {
			throwIfAborted(signal);
			if (!this.boundPrivilegedOperations) {
				throw new Error("Offscreen debugger requires bound privileged operations");
			}
			this.tools.push(createOffscreenDebuggerTool(this.boundPrivilegedOperations));
		}
		const changed = await this.executeHtmlArtifacts(signal);
		if (changed.length === 0) return;
		for (const artifact of changed) {
			appendArtifactMessage(this.context.agent, { action: "update", artifact });
		}
		this.notifyTranscriptMutation();
	}

	async executeArtifactTool(
		params: ArtifactToolParameters,
		signal: AbortSignal,
	): Promise<AgentToolResult<RuntimeValue>> {
		this.assertActive();
		throwIfAborted(signal);
		if (params.command === "get") {
			const artifact = this.artifactStore.require(params.filename);
			return {
				content: [{ type: "text", text: artifact.content }],
				details: { action: "get", artifact: toRuntimeRecord(artifact, "artifact") },
			};
		}
		if (params.command === "logs") {
			const artifact = this.artifactStore.require(params.filename);
			return {
				content: [{ type: "text", text: artifactLogsText(artifact) }],
				details: { action: "logs", artifact: toRuntimeRecord(artifact, "artifact") },
			};
		}

		let mutation: OffscreenArtifactMutation | { action: "delete"; artifact: OffscreenArtifactRecord };
		let verb: string;
		switch (params.command) {
			case "create":
				if (params.content === undefined) throw new Error("Artifact create requires content");
				mutation = { action: "create", artifact: this.artifactStore.create(params.filename, params.content) };
				verb = "Created";
				break;
			case "update":
				if (params.old_str === undefined || params.new_str === undefined) {
					throw new Error("Artifact update requires old_str and new_str");
				}
				mutation = {
					action: "update",
					artifact: this.artifactStore.update(params.filename, params.old_str, params.new_str),
				};
				verb = "Updated";
				break;
			case "rewrite":
				if (params.content === undefined) throw new Error("Artifact rewrite requires content");
				mutation = { action: "update", artifact: this.artifactStore.rewrite(params.filename, params.content) };
				verb = "Rewrote";
				break;
			case "delete":
				mutation = { action: "delete", artifact: this.artifactStore.delete(params.filename) };
				verb = "Deleted";
				break;
			default:
				throw new Error(`Unsupported artifact command: ${String(params.command)}`);
		}

		const changed = await this.executeHtmlArtifacts(signal);
		for (const artifact of changed) {
			if (artifact.filename !== mutation.artifact.filename) {
				appendArtifactMessage(this.context.agent, { action: "update", artifact });
			}
		}
		if (changed.some((artifact) => artifact.filename !== mutation.artifact.filename)) {
			this.notifyTranscriptMutation();
		}
		const artifact =
			mutation.action === "delete" ? mutation.artifact : this.artifactStore.require(mutation.artifact.filename);
		const logs = mutation.action !== "delete" && isHtmlArtifact(artifact) ? `\n${artifactLogsText(artifact)}` : "";
		throwIfAborted(signal);
		return {
			content: [{ type: "text", text: `${verb} file ${artifact.filename}${logs}` }],
			details: { action: mutation.action, artifact: toRuntimeRecord(artifact, "artifact") },
		};
	}

	getRuntimeProviders(): SandboxRuntimeProvider[] {
		this.assertActive();
		const providers: SandboxRuntimeProvider[] = [new FileDownloadRuntimeProvider()];
		const attachments = extractAttachments(this.context.agent.state.messages);
		if (attachments.length > 0) providers.push(new AttachmentsRuntimeProvider(attachments));
		providers.push(this.artifactProvider, ...this.privilegedProviders);
		return providers;
	}

	private getReadOnlyContentProviders(): SandboxRuntimeProvider[] {
		const providers: SandboxRuntimeProvider[] = [];
		const attachments = extractAttachments(this.context.agent.state.messages);
		if (attachments.length > 0) providers.push(new AttachmentsRuntimeProvider(attachments));
		providers.push(this.readOnlyArtifactProvider);
		return providers;
	}

	private getBrowserJsContentProviders(): SandboxRuntimeProvider[] {
		const providers: SandboxRuntimeProvider[] = [];
		const attachments = extractAttachments(this.context.agent.state.messages);
		if (attachments.length > 0) providers.push(new AttachmentsRuntimeProvider(attachments));
		providers.push(this.artifactProvider);
		return providers;
	}

	private async applyBrowserJsArtifactMutations(value: unknown, signal: AbortSignal): Promise<void> {
		if (!Array.isArray(value)) throw new Error("browserjs artifact mutations must be an array");
		for (const mutation of value) {
			if (!isRecord(mutation) || typeof mutation.action !== "string" || typeof mutation.filename !== "string") {
				throw new Error("browserjs returned an invalid artifact mutation");
			}
			if (mutation.action === "put") {
				if (typeof mutation.content !== "string") throw new Error("browserjs artifact put requires content");
				await this.putAndRecord(
					mutation.filename,
					mutation.content,
					typeof mutation.mimeType === "string" ? mutation.mimeType : undefined,
					signal,
				);
				continue;
			}
			if (mutation.action === "delete") {
				await this.deleteAndRecord(mutation.filename, signal);
				continue;
			}
			throw new Error(`Unknown browserjs artifact mutation: ${mutation.action}`);
		}
	}

	async executeArtifacts(payload: RuntimeArtifactsPayload, signal: AbortSignal): Promise<RuntimeValue> {
		this.assertActive();
		throwIfAborted(signal);
		switch (payload.action) {
			case "list":
				return {
					artifacts: this.artifactStore.list().map((artifact) => toRuntimeRecord(artifact, "artifact")),
				};
			case "get":
				return { artifact: toRuntimeRecord(this.artifactStore.require(payload.filename), "artifact") };
			case "put": {
				const artifact = await this.putAndRecord(
					payload.filename,
					encodeArtifactContent(payload.content),
					payload.mimeType,
					signal,
				);
				return { artifact: toRuntimeRecord(artifact, "artifact") };
			}
			case "delete": {
				const artifact = await this.deleteAndRecord(payload.filename, signal);
				return { deleted: true, artifact: toRuntimeRecord(artifact, "artifact") };
			}
		}
	}

	async executeRepl(code: string, operation: OffscreenRuntimeOperationContext): Promise<RuntimeValue> {
		this.assertMatchingScope(operation);
		const replTool = this.replTool;
		if (!replTool) throw new Error("Offscreen REPL tool is unavailable");
		throwIfAborted(operation.signal);
		const parent = this.parentExecutionIdentity(operation);
		return await this.withSignalParentExecution(operation, parent, async () => {
			const result = await replTool.execute(
				parent.executionId,
				{ title: "Executing JavaScript", code },
				operation.signal,
			);
			throwIfAborted(operation.signal);
			return toRuntimeValue(result, "REPL result");
		});
	}

	async putAndRecord(
		filename: string,
		content: string,
		mimeType: string | undefined,
		signal: AbortSignal,
	): Promise<OffscreenArtifactRecord> {
		this.assertActive();
		throwIfAborted(signal);
		const mutation = this.artifactStore.put(filename, content, mimeType);
		const changed = await this.executeHtmlArtifacts(signal);
		const artifact = this.artifactStore.require(mutation.artifact.filename);
		appendArtifactMessage(this.context.agent, { action: mutation.action, artifact });
		for (const changedArtifact of changed) {
			if (changedArtifact.filename !== artifact.filename) {
				appendArtifactMessage(this.context.agent, { action: "update", artifact: changedArtifact });
			}
		}
		this.notifyTranscriptMutation();
		return artifact;
	}

	async deleteAndRecord(filename: string, signal: AbortSignal): Promise<OffscreenArtifactRecord> {
		this.assertActive();
		throwIfAborted(signal);
		const artifact = this.artifactStore.delete(filename);
		appendArtifactMessage(this.context.agent, { action: "delete", artifact });
		for (const changedArtifact of await this.executeHtmlArtifacts(signal)) {
			appendArtifactMessage(this.context.agent, { action: "update", artifact: changedArtifact });
		}
		this.notifyTranscriptMutation();
		return artifact;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.activeAgentParentExecution = undefined;
		this.onDispose();
	}

	private async executeBoundPrivilegedOperation(
		operation: OffscreenPrivilegedOperation,
		params: RuntimeRecord,
		options: OffscreenBoundPrivilegedOperationOptions,
	): Promise<RuntimeValue> {
		this.assertActive();
		const executor = this.dependencies.privilegedOperations;
		if (!executor) throw new Error("Offscreen privileged operations are unavailable");
		const operationSignal = options.signal ?? new AbortController().signal;
		throwIfAborted(operationSignal);
		const parent = this.requireParentExecution(options.parentSignal ?? options.signal);
		const result = await executor.execute(operation, params, {
			clientId: this.context.clientId,
			windowId: this.context.windowId,
			sessionId: this.context.sessionId,
			target: this.context.target,
			...parent,
			operationId: options.operationId,
			origin: options.origin,
			signal: operationSignal,
		});
		throwIfAborted(operationSignal);
		return result;
	}

	private parentExecutionIdentity(context: OffscreenRuntimeOperationContext): OffscreenParentExecutionIdentity {
		if (!context.executionId) {
			throw new Error("Privileged page operation requires an exact parent executionId");
		}
		return {
			runtimeEpoch: context.runtimeEpoch,
			requestId: context.requestId,
			executionId: context.executionId,
			...(context.trace ? { trace: { ...context.trace } } : {}),
		};
	}

	private requireParentExecution(signal?: AbortSignal): OffscreenParentExecutionIdentity {
		this.assertActive();
		const exact = signal ? this.parentExecutionsBySignal.get(signal) : undefined;
		const parent = exact ?? this.activeAgentParentExecution;
		if (!parent) throw new Error("Privileged page operation has no exact parent execution");
		return parent;
	}

	private async withSignalParentExecution<T>(
		context: OffscreenRuntimeOperationContext,
		parent: OffscreenParentExecutionIdentity,
		operation: () => Promise<T>,
	): Promise<T> {
		if (this.parentExecutionsBySignal.has(context.signal)) {
			throw new Error("Abort signal is already bound to an active parent execution");
		}
		this.parentExecutionsBySignal.set(context.signal, parent);
		try {
			return await operation();
		} finally {
			if (this.parentExecutionsBySignal.get(context.signal) === parent) {
				this.parentExecutionsBySignal.delete(context.signal);
			}
		}
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Offscreen tool environment is disposed");
	}

	private async executeHtmlArtifacts(signal: AbortSignal): Promise<OffscreenArtifactRecord[]> {
		if (!this.dependencies.htmlArtifacts) return [];
		const changed: OffscreenArtifactRecord[] = [];
		for (const artifact of this.artifactStore.list()) {
			if (!isHtmlArtifact(artifact)) continue;
			throwIfAborted(signal);
			let logs: OffscreenArtifactLog[];
			try {
				const result = await this.dependencies.htmlArtifacts.execute({
					clientId: this.context.clientId,
					windowId: this.context.windowId,
					sessionId: this.context.sessionId,
					target: this.context.target,
					artifact,
					providers: this.getReadOnlyContentProviders(),
					...(this.dependencies.sandboxUrlProvider
						? { sandboxUrlProvider: this.dependencies.sandboxUrlProvider }
						: {}),
					signal,
				});
				logs = result.logs.map((log) => ({ ...log }));
			} catch (error) {
				if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
				logs = [{ type: "error", text: errorMessage(error) }];
			}
			if (!sameArtifactLogs(artifact.logs, logs)) {
				changed.push(this.artifactStore.setLogs(artifact.filename, logs));
			}
		}
		return changed;
	}

	private assertMatchingScope(scope: OffscreenRuntimeSessionScope): void {
		this.assertActive();
		if (
			scope.clientId !== this.context.clientId ||
			scope.windowId !== this.context.windowId ||
			scope.sessionId !== this.context.sessionId ||
			!sameTarget(scope.target, this.context.target)
		) {
			throw new Error("Offscreen tool operation scope does not match its session environment");
		}
	}

	private notifyTranscriptMutation(): void {
		try {
			Promise.resolve(this.dependencies.onTranscriptMutation?.(this.context)).catch((error) => {
				this.dependencies.onError?.(error, this.context);
			});
		} catch (error) {
			this.dependencies.onError?.(error, this.context);
		}
	}
}

/**
 * Session registry plus delegates consumed directly by OffscreenRuntimeHost.
 * One instance can be passed as `toolRuntime`, `artifacts`, and `repl`.
 */
export class PureOffscreenAgentToolRuntime
	implements OffscreenAgentToolRuntime, OffscreenRuntimeArtifactsDelegate, OffscreenRuntimeReplDelegate
{
	private readonly environments = new Map<string, OffscreenSessionToolEnvironment>();

	constructor(private readonly dependencies: OffscreenToolEnvironmentDependencies = {}) {}

	async create(context: OffscreenAgentToolRuntimeContext): Promise<OffscreenSessionToolEnvironment> {
		throwIfAborted(context.signal);
		const key = scopeKey(context);
		if (this.environments.has(key)) throw new Error("Offscreen tool environment already exists for this session");
		let environment: OffscreenSessionToolEnvironment;
		environment = new OffscreenSessionToolEnvironment(context, this.dependencies, () => {
			if (this.environments.get(key) === environment) this.environments.delete(key);
		});
		await environment.initialize(context.signal);
		throwIfAborted(context.signal);
		this.environments.set(key, environment);
		return environment;
	}

	execute(payload: RuntimeArtifactsPayload, context: OffscreenRuntimeOperationContext): Promise<RuntimeValue>;
	execute(code: string, context: OffscreenRuntimeOperationContext): Promise<RuntimeValue>;
	async execute(
		input: RuntimeArtifactsPayload | string,
		context: OffscreenRuntimeOperationContext,
	): Promise<RuntimeValue> {
		const environment = this.requireEnvironment(context);
		return await (typeof input === "string"
			? environment.executeRepl(input, context)
			: environment.executeArtifacts(input, context.signal));
	}

	getEnvironment(scope: OffscreenRuntimeSessionScope): OffscreenSessionToolEnvironment | undefined {
		const environment = this.environments.get(scopeKey(scope));
		if (!environment || !sameTarget(environment.context.target, scope.target)) return undefined;
		return environment;
	}

	private requireEnvironment(scope: OffscreenRuntimeSessionScope): OffscreenSessionToolEnvironment {
		const environment = this.getEnvironment(scope);
		if (!environment) throw new Error("Offscreen tool environment was not found for the exact session scope");
		return environment;
	}
}
