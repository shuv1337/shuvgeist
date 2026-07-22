/**
 * CLI client for the Shuvgeist bridge.
 *
 * Usage:
 *   shuvgeist serve [--host HOST] [--port PORT] [--token TOKEN]
 *   shuvgeist status
 *   shuvgeist navigate <url> [--new-tab]
 *   shuvgeist tabs
 *   shuvgeist switch <tabId>
 *   shuvgeist repl <code>
 *   shuvgeist repl -f <file.js>
 *   shuvgeist screenshot [--out file.png]
 *   shuvgeist eval <code>
 *   shuvgeist cookies
 *   shuvgeist select <message>
 *
 * Exit codes:
 *   0 — success
 *   1 — command/runtime error
 *   2 — no extension target connected
 *   3 — auth/configuration/network error
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
	BRIDGE_PROTOCOL_MIN_VERSION,
	BRIDGE_PROTOCOL_VERSION,
	BridgeDefaults,
	type BridgeEvent,
	type BridgeMethod,
	type BridgeReplResult,
	type BridgeRequest,
	type BridgeResponse,
	type BridgeScreenshotResult,
	type BridgeServerStatus,
	formatBridgeCommandValidationErrors,
	formatBridgeProtocolMismatch,
	isBridgeProtocolCompatible,
	type RecordChunkEventData,
	type RecordFrameEventData,
	type RecordStartResult,
	type RecordStopResult,
	type RegisterResult,
	type SessionHistoryResult,
	validateBridgeCommandParams,
	validateBridgeCommandResult,
	type WorkflowRunResultWire,
} from "@shuvgeist/protocol/protocol";
import type { BridgeTarget } from "@shuvgeist/protocol/target";
import { BridgeTelemetry } from "@shuvgeist/protocol/telemetry";
import { formatWorkflowValidationErrors, validateWorkflowDefinition } from "@shuvgeist/protocol/workflow-schema";
import { BridgeServer } from "@shuvgeist/server/server";
import { WebSocket } from "ws";
import {
	bridgeStatusUrl,
	createCommandPlan,
	exitCodeForResponse,
	generateRequestId,
	isNetworkOrConfigError,
	parseCliArguments,
	parseTimeout,
	withEncodedRecordingSize,
} from "./cli-core.js";
import { type CliNodeRuntime, createCliNodeRuntime } from "./cli-node-runtime.js";
import { formatBridgeStatusText, isBridgeStatusReady } from "./cli-status.js";
import { closeBrowser, type LaunchOptions, launchBrowser, setupForegroundHandlers } from "./launcher.js";
import { assertFfmpegAvailable, FfmpegWebmEncoder } from "./recording/ffmpeg-encoder.js";
import { ensureSkillInstalled, installSkill, resolveSkillTargetDir } from "./skill-install.js";

declare const __SHUVGEIST_VERSION__: string;
const VERSION = typeof __SHUVGEIST_VERSION__ !== "undefined" ? __SHUVGEIST_VERSION__ : "dev";
const DEFAULT_NODE_CONFIG_DIRECTORY = join(homedir(), ".shuvgeist");
let nodeRuntime: CliNodeRuntime | undefined;

function requireNodeRuntime(): CliNodeRuntime {
	if (!nodeRuntime) throw new Error("CLI Node runtime was used before initialization");
	return nodeRuntime;
}

function resolveCliTelemetry(): BridgeTelemetry {
	const otel = requireNodeRuntime().resolveOtelConfig();
	return new BridgeTelemetry({
		serviceName: "shuvgeist-cli",
		serviceVersion: VERSION,
		enabled: otel.enabled,
		ingestUrl: otel.ingestUrl,
		ingestKey: otel.privateIngestKey,
	});
}

function sendRequest(
	url: string,
	token: string,
	request: BridgeRequest,
	timeoutMs?: number,
	telemetry?: BridgeTelemetry,
): Promise<BridgeResponse> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const span = telemetry?.startSpan(`bridge.cli.${request.method}`, {
			kind: "client",
			attributes: {
				"bridge.method": request.method,
				"bridge.request_id": request.id,
			},
		});
		const tracedRequest: BridgeRequest = span ? { ...request, ...span.toTraceHeaders() } : request;

		const finalize = (handler: () => void) => {
			try {
				handler();
			} finally {
				void telemetry?.flush();
			}
		};

		if (timeoutMs && timeoutMs > 0) {
			timeout = setTimeout(() => {
				if (!settled) {
					settled = true;
					ws.close();
					span?.recordError(new Error(`Connection timeout after ${timeoutMs}ms`));
					span?.setAttribute("bridge.outcome", "timeout");
					span?.end("error");
					finalize(() =>
						reject(Object.assign(new Error(`Connection timeout after ${timeoutMs}ms`), { code: "ETIMEDOUT" })),
					);
				}
			}, timeoutMs);
		}

		ws.on("open", () => {
			ws.send(
				JSON.stringify({
					type: "register",
					role: "cli",
					token,
					protocolVersion: BRIDGE_PROTOCOL_VERSION,
					minProtocolVersion: BRIDGE_PROTOCOL_MIN_VERSION,
					appVersion: VERSION,
					name: "shuvgeist-cli",
				}),
			);
		});

		ws.on("message", (data: Buffer | string) => {
			const msg = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
			if (msg.type === "register_result") {
				const reg = msg as RegisterResult;
				if (!reg.ok) {
					settled = true;
					if (timeout) clearTimeout(timeout);
					ws.close();
					span?.recordError(new Error("Registration failed: " + (reg.error || "unknown")));
					span?.setAttribute("bridge.outcome", "error");
					span?.end("error");
					finalize(() =>
						reject(
							Object.assign(new Error("Registration failed: " + (reg.error || "unknown")), { code: "EAUTH" }),
						),
					);
					return;
				}
				ws.send(JSON.stringify(tracedRequest));
				return;
			}
			if ("id" in msg && msg.id === tracedRequest.id) {
				settled = true;
				if (timeout) clearTimeout(timeout);
				ws.close();
				const response = msg as BridgeResponse;
				if (!response.error) {
					const resultValidation = validateBridgeCommandResult(request.method, response.result);
					if (!resultValidation.ok) {
						const error = new Error(
							`Invalid result for '${request.method}': ${formatBridgeCommandValidationErrors(resultValidation.errors)}`,
						);
						span?.recordError(error);
						span?.setAttribute("bridge.outcome", "error");
						span?.end("error");
						finalize(() => reject(error));
						return;
					}
					response.result = resultValidation.value;
				}
				span?.setAttribute("bridge.outcome", response.error ? "error" : "success");
				if (response.error) {
					span?.recordError(new Error(response.error.message));
					span?.end("error");
				} else {
					span?.end("ok");
				}
				finalize(() => resolve(response));
			}
		});

		ws.on("error", (err: Error) => {
			if (!settled) {
				settled = true;
				if (timeout) clearTimeout(timeout);
				span?.recordError(err);
				span?.setAttribute("bridge.outcome", "error");
				span?.end("error");
				finalize(() => reject(err));
			}
		});

		ws.on("close", () => {
			if (timeout) clearTimeout(timeout);
			if (!settled) {
				settled = true;
				span?.recordError(new Error("Connection closed before response"));
				span?.setAttribute("bridge.outcome", "error");
				span?.end("error");
				finalize(() =>
					reject(Object.assign(new Error("Connection closed before response"), { code: "ECONNRESET" })),
				);
			}
		});
	});
}

function printError(message: string, jsonMode: boolean): void {
	if (jsonMode) console.log(JSON.stringify({ error: { code: -1, message } }, null, 2));
	else console.error("Error: " + message);
}

function printResult(response: BridgeResponse, jsonMode: boolean): void {
	if (response.error) {
		if (jsonMode) console.log(JSON.stringify({ error: response.error }, null, 2));
		else console.error("Error: " + response.error.message);
		return;
	}
	if (jsonMode) {
		console.log(JSON.stringify(response.result, null, 2));
		return;
	}
	const result = response.result as unknown;
	if (result === null || result === undefined) console.log("OK");
	else if (typeof result === "string") console.log(result);
	else console.log(JSON.stringify(result, null, 2));
}

function printSessionHistory(result: SessionHistoryResult, jsonMode: boolean): void {
	if (jsonMode) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	console.log(`Session: ${result.title || "(untitled)"}`);
	console.log(`Persisted: ${result.persisted ? "yes" : "no"}`);
	console.log(`Session ID: ${result.sessionId ?? "(none)"}`);
	if (result.model) {
		console.log(`Model: ${result.model.provider}/${result.model.id}`);
	}
	console.log(`Streaming: ${result.isStreaming ? "yes" : "no"}`);
	console.log(`Messages: ${result.messageCount}`);
	if (result.messages.length > 0) {
		console.log("");
		for (const message of result.messages) {
			console.log(`[${message.messageIndex}] ${message.role}: ${message.text}`);
		}
	}
}

function printRecordStopSummary(result: RecordStopResult, jsonMode: boolean, outPath?: string): void {
	if (jsonMode) {
		console.log(JSON.stringify({ ...result, out: outPath }, null, 2));
		return;
	}
	console.log(`Recording stopped: ${result.outcome}`);
	console.log(`  File: ${outPath ?? "(not written by this command)"}`);
	console.log(`  Duration: ${result.durationMs}ms`);
	console.log(`  Frames: ${result.frameCount}`);
	console.log(`  Source bytes: ${result.sourceBytes}`);
	if (typeof result.encodedSizeBytes === "number") {
		console.log(`  Encoded size: ${result.encodedSizeBytes} bytes`);
	}
}

function isResolvedRecordTarget(value: unknown): value is RecordFrameEventData["target"] {
	if (typeof value !== "object" || value === null || !("kind" in value)) return false;
	const candidate = value as Record<string, unknown>;
	if (candidate.kind === "chrome-tab") {
		return typeof candidate.tabId === "number" && candidate.tabId >= 0;
	}
	return (
		candidate.kind === "electron-window" &&
		typeof candidate.sessionId === "string" &&
		candidate.sessionId.length > 0 &&
		typeof candidate.windowRef === "string" &&
		candidate.windowRef.length > 0 &&
		typeof candidate.targetId === "string" &&
		candidate.targetId.length > 0
	);
}

function isRecordFrameEvent(event: BridgeEvent): event is BridgeEvent & { data: RecordFrameEventData } {
	const data = event.data as Partial<RecordFrameEventData> | undefined;
	return (
		event.event === "record_frame" &&
		data !== undefined &&
		typeof data.recordingId === "string" &&
		isResolvedRecordTarget(data.target) &&
		typeof data.navigationGeneration === "number" &&
		Number.isSafeInteger(data.navigationGeneration) &&
		data.navigationGeneration >= 0 &&
		typeof data.seq === "number" &&
		(data.format === "jpeg" || data.format === "png") &&
		typeof data.dataBase64 === "string" &&
		typeof data.capturedAtMs === "number"
	);
}

function isLegacyRecordChunkEvent(event: BridgeEvent): event is BridgeEvent & { data: RecordChunkEventData } {
	const data = event.data as Partial<RecordChunkEventData> | undefined;
	return (
		event.event === "record_chunk" &&
		data !== undefined &&
		typeof data.recordingId === "string" &&
		isResolvedRecordTarget(data.target) &&
		typeof data.navigationGeneration === "number" &&
		Number.isSafeInteger(data.navigationGeneration) &&
		data.navigationGeneration >= 0 &&
		typeof data.seq === "number" &&
		typeof data.mimeType === "string" &&
		typeof data.chunkBase64 === "string"
	);
}

function printFollowEvent(event: BridgeEvent, jsonMode: boolean): void {
	if (jsonMode) {
		console.log(JSON.stringify(event));
		return;
	}
	console.log(`event:${event.event} ${JSON.stringify(event.data || {})}`);
}

async function fetchBridgeStatus(flags: { url?: string; host?: string; port?: string; json?: boolean }): Promise<void> {
	const wsUrl = requireNodeRuntime().resolveConnection(flags).url;
	const statusUrl = bridgeStatusUrl(wsUrl);
	const jsonMode = flags.json || false;
	try {
		const controller = new AbortController();
		const timeoutMs = parseTimeout((flags as { timeout?: string }).timeout, BridgeDefaults.STATUS_TIMEOUT_MS);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		if (timeoutMs && timeoutMs > 0) {
			timeout = setTimeout(() => controller.abort(), timeoutMs);
		}
		const response = await fetch(statusUrl, { signal: controller.signal });
		if (timeout) clearTimeout(timeout);
		if (!response.ok) {
			throw new Error(`Status request failed: HTTP ${response.status}`);
		}
		const status = (await response.json()) as BridgeServerStatus;
		assertBridgeStatusProtocol(status);
		if (jsonMode) {
			console.log(JSON.stringify(status, null, 2));
		} else {
			for (const line of formatBridgeStatusText(status, { cliVersion: VERSION, statusUrl })) {
				console.log(line);
			}
		}
		process.exit(0);
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err), jsonMode);
		process.exit(3);
	}
}

async function cmdServe(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			host: { type: "string" },
			port: { type: "string" },
			token: { type: "string" },
		},
		allowPositionals: false,
	});

	const runtime = requireNodeRuntime();
	const binding = runtime.resolveServeBinding(values);
	let token = binding.token;
	if (!token) {
		token = generateToken();
		runtime.owner.updateBridgeConfig({ token });
		console.log("Generated token and saved to " + runtime.owner.paths.bridge);
		console.log("");
	}

	const otel = runtime.resolveOtelConfig();
	await new BridgeServer(
		{
			host: binding.host,
			port: binding.port,
			token,
			serverVersion: VERSION,
			otel: {
				enabled: otel.enabled,
				ingestUrl: otel.ingestUrl,
				ingestKey: otel.privateIngestKey,
			},
		},
		{ nodeConfig: runtime.owner },
	).start();
}

async function cmdOneShot(
	method: BridgeMethod,
	params: Record<string, unknown>,
	flags: { url?: string; host?: string; port?: string; token?: string; json?: boolean; timeout?: string },
	defaultTimeoutMs?: number,
	target?: BridgeTarget,
): Promise<BridgeResponse> {
	const paramsValidation = validateBridgeCommandParams(method, params);
	if (!paramsValidation.ok) {
		throw Object.assign(
			new Error(
				`Invalid parameters for '${method}': ${formatBridgeCommandValidationErrors(paramsValidation.errors)}`,
			),
			{ code: "EINVAL" },
		);
	}
	const resolved = requireNodeRuntime().requireConnection(flags);
	const { url, token } = resolved;
	const timeoutMs = parseTimeout(flags.timeout, defaultTimeoutMs);
	const request: BridgeRequest = {
		id: generateRequestId(),
		method,
		params: paramsValidation.value,
		target,
	};
	return sendRequest(url, token, request, timeoutMs, resolveCliTelemetry());
}

async function runOneShot(
	method: BridgeMethod,
	params: Record<string, unknown>,
	flags: { url?: string; host?: string; port?: string; token?: string; json?: boolean; timeout?: string },
	defaultTimeoutMs?: number,
	target?: BridgeTarget,
): Promise<void> {
	const jsonMode = flags.json || false;
	try {
		const response = await cmdOneShot(method, params, flags, defaultTimeoutMs, target);
		printResult(response, jsonMode);
		process.exit(exitCodeForResponse(response));
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err), jsonMode);
		process.exit(isNetworkOrConfigError(err) ? 3 : 1);
	}
}

function screenshotViewportPayload(
	result: BridgeScreenshotResult,
): Omit<BridgeScreenshotResult, "mimeType" | "dataUrl"> {
	return {
		cssWidth: result.cssWidth,
		cssHeight: result.cssHeight,
		imageWidth: result.imageWidth,
		imageHeight: result.imageHeight,
		devicePixelRatio: result.devicePixelRatio,
		scale: result.scale,
	};
}

function formatScreenshotMetadata(result: BridgeScreenshotResult): string {
	return `Image ${result.imageWidth}x${result.imageHeight} (CSS ${result.cssWidth}x${result.cssHeight}, DPR ${result.devicePixelRatio}, scale ${result.scale})`;
}

async function cmdScreenshot(flags: {
	url?: string;
	host?: string;
	port?: string;
	token?: string;
	json?: boolean;
	out?: string;
	maxWidth?: string;
	tabId?: string;
	frameId?: string;
	timeout?: string;
	noViewportJson?: boolean;
	target?: BridgeTarget;
}): Promise<void> {
	const jsonMode = flags.json || false;
	const params: Record<string, unknown> = {};
	if (flags.maxWidth) params.maxWidth = Number.parseInt(flags.maxWidth, 10);
	if (flags.tabId) params.tabId = Number.parseInt(flags.tabId, 10);
	if (flags.frameId) params.frameId = Number.parseInt(flags.frameId, 10);
	try {
		const response = await cmdOneShot(
			"screenshot",
			params,
			flags,
			BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS,
			flags.target,
		);
		if (response.error) {
			printResult(response, jsonMode);
			process.exit(exitCodeForResponse(response));
		}
		const result = response.result as BridgeScreenshotResult;
		if (flags.out) {
			if (!result?.dataUrl) {
				throw new Error("Screenshot response did not include dataUrl");
			}
			const base64 = result.dataUrl.replace(/^data:image\/[^;]+;base64,/, "");
			writeFileSync(flags.out, Buffer.from(base64, "base64"));
			if (!flags.noViewportJson) {
				const sidecarPath = join(dirname(flags.out), "viewport.json");
				writeFileSync(sidecarPath, JSON.stringify(screenshotViewportPayload(result), null, 2) + "\n");
			}
			if (jsonMode) {
				printResult(response, true);
			} else {
				console.log("Screenshot saved to " + flags.out);
				if (!flags.noViewportJson)
					console.log("Viewport metadata saved to " + join(dirname(flags.out), "viewport.json"));
			}
		} else {
			if (!jsonMode && result?.dataUrl) console.error(formatScreenshotMetadata(result));
			printResult(response, jsonMode);
		}
		process.exit(0);
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err), jsonMode);
		process.exit(isNetworkOrConfigError(err) ? 3 : 1);
	}
}

async function cmdRepl(
	params: Record<string, unknown>,
	flags: {
		url?: string;
		host?: string;
		port?: string;
		token?: string;
		json?: boolean;
		writeFiles?: string;
		timeout?: string;
		target?: BridgeTarget;
	},
): Promise<void> {
	const jsonMode = flags.json || false;
	try {
		const response = await cmdOneShot("repl", params, flags, BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS, flags.target);
		if (response.error) {
			printResult(response, jsonMode);
			process.exit(exitCodeForResponse(response));
		}
		const result = response.result as BridgeReplResult;
		if (jsonMode) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			if (result?.output) console.log(result.output);
			if (result?.files?.length > 0) {
				console.log(`\n${result.files.length} file(s) returned`);
				if (flags.writeFiles) {
					mkdirSync(flags.writeFiles, { recursive: true });
					for (const file of result.files) {
						const outPath = join(flags.writeFiles, file.fileName || "file");
						writeFileSync(outPath, Buffer.from(file.contentBase64 || "", "base64"));
						console.log("  wrote " + outPath);
					}
				}
			}
		}
		process.exit(0);
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err), jsonMode);
		process.exit(isNetworkOrConfigError(err) ? 3 : 1);
	}
}

async function cmdRecord(
	action: "start" | "stop" | "status",
	params: Record<string, unknown>,
	flags: {
		url?: string;
		host?: string;
		port?: string;
		token?: string;
		json?: boolean;
		timeout?: string;
		out?: string;
		target?: BridgeTarget;
	},
	defaultTimeoutMs?: number,
): Promise<void> {
	const jsonMode = flags.json || false;
	if (action === "stop" || action === "status") {
		const method: BridgeMethod = action === "stop" ? "record_stop" : "record_status";
		try {
			const response = await cmdOneShot(method, params, flags, defaultTimeoutMs, flags.target);
			printResult(response, jsonMode);
			process.exit(exitCodeForResponse(response));
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err), jsonMode);
			process.exit(isNetworkOrConfigError(err) ? 3 : 1);
		}
	}

	if (!flags.out) {
		printError("record start requires --out", jsonMode);
		process.exit(1);
	}
	try {
		assertFfmpegAvailable();
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error), jsonMode);
		process.exit(1);
	}

	const resolved = requireNodeRuntime().requireConnection(flags);
	const { url, token } = resolved;
	const outPath = flags.out;
	const startParamsValidation = validateBridgeCommandParams("record_start", params);
	if (!startParamsValidation.ok) {
		printError(
			`Invalid parameters for 'record_start': ${formatBridgeCommandValidationErrors(startParamsValidation.errors)}`,
			jsonMode,
		);
		process.exit(1);
	}
	const requestId = generateRequestId();
	let recordingId: string | undefined;
	let settled = false;
	let started = false;
	let stopRequested = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let encoder: FfmpegWebmEncoder | undefined;
	let encoderQueue = Promise.resolve();
	const pendingFrames: Array<{ frame: Buffer; capturedAtMs: number }> = [];
	const telemetry = resolveCliTelemetry();
	const span = telemetry?.startSpan("bridge.cli.record_start", {
		kind: "client",
		attributes: {
			"bridge.method": "record_start",
			"bridge.request_id": requestId,
		},
	});
	const request: BridgeRequest = {
		id: requestId,
		method: "record_start",
		params: startParamsValidation.value,
		target: flags.target,
		...(span ? span.toTraceHeaders() : {}),
	};
	const ws = new WebSocket(url);

	const finish = (code: number): void => {
		if (settled) return;
		settled = true;
		if (timeout) clearTimeout(timeout);
		ws.close();
		void telemetry?.flush().finally(() => process.exit(code));
	};

	const fail = (message: string, code: number): void => {
		encoder?.abort();
		span?.recordError(new Error(message));
		span?.end("error");
		printError(message, jsonMode);
		finish(code);
	};

	const sendStop = (): void => {
		if (!recordingId || ws.readyState !== WebSocket.OPEN || stopRequested) return;
		stopRequested = true;
		const stopRequest: BridgeRequest = {
			id: generateRequestId(),
			method: "record_stop",
			params: {
				...(typeof params.tabId === "number" ? { tabId: params.tabId } : {}),
				...(typeof params.frameId === "number" ? { frameId: params.frameId } : {}),
			},
			target: flags.target,
		};
		ws.send(JSON.stringify(stopRequest));
	};

	const stopOnSignal = (): void => {
		if (!recordingId || ws.readyState !== WebSocket.OPEN) {
			encoder?.abort();
			finish(130);
			return;
		}
		sendStop();
	};
	process.once("SIGINT", stopOnSignal);

	const timeoutMs = parseTimeout(flags.timeout, BridgeDefaults.STATUS_TIMEOUT_MS);
	if (timeoutMs && timeoutMs > 0) {
		timeout = setTimeout(() => {
			if (!started) fail(`Connection timeout after ${timeoutMs}ms`, 3);
		}, timeoutMs);
	}

	ws.on("open", () => {
		ws.send(
			JSON.stringify({
				type: "register",
				role: "cli",
				token,
				protocolVersion: BRIDGE_PROTOCOL_VERSION,
				minProtocolVersion: BRIDGE_PROTOCOL_MIN_VERSION,
				appVersion: VERSION,
				name: "shuvgeist-cli-record",
			}),
		);
	});

	ws.on("message", (data: Buffer | string) => {
		const msg = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
		if (msg.type === "register_result") {
			const reg = msg as RegisterResult;
			if (!reg.ok) {
				fail("Registration failed: " + (reg.error || "unknown"), 3);
				return;
			}
			ws.send(JSON.stringify(request));
			return;
		}
		if (typeof msg.id === "number" && msg.id === requestId) {
			const response = msg as BridgeResponse;
			if (response.error) {
				fail(response.error.message, exitCodeForResponse(response));
				return;
			}
			const resultValidation = validateBridgeCommandResult("record_start", response.result);
			if (!resultValidation.ok) {
				fail(
					`Invalid result for 'record_start': ${formatBridgeCommandValidationErrors(resultValidation.errors)}`,
					3,
				);
				return;
			}
			const result: RecordStartResult = resultValidation.value;
			recordingId = result.recordingId;
			started = true;
			encoder = new FfmpegWebmEncoder();
			encoder.start({
				outPath,
				fps: typeof params.fps === "number" ? params.fps : BridgeDefaults.RECORD_DEFAULT_FPS,
				mimeType: result.mimeType,
				videoBitsPerSecond: result.videoBitsPerSecond,
			});
			for (const pendingFrame of pendingFrames.splice(0)) {
				encoderQueue = encoderQueue
					.then(() => encoder?.pushFrame(pendingFrame.frame, pendingFrame.capturedAtMs))
					.then(() => undefined);
			}
			span?.setAttributes({
				"record.recording_id": result.recordingId,
				"record.target_kind": result.target.kind,
				...(typeof result.tabId === "number" ? { "record.tab_id": result.tabId } : {}),
				"record.mime_type": result.mimeType,
				"record.video_bits_per_second": result.videoBitsPerSecond,
			});
			if (!jsonMode) {
				const targetLabel =
					result.target.kind === "chrome-tab"
						? `tab ${result.target.tabId}`
						: `Electron window ${result.target.sessionId}:${result.target.windowRef}`;
				console.log(`Recording ${targetLabel} to ${outPath}`);
				console.log(`Recording ID: ${result.recordingId}`);
			}
			return;
		}
		if (msg.type !== "event") return;
		const event = msg as BridgeEvent;
		if (isRecordFrameEvent(event)) {
			if (recordingId && event.data.recordingId !== recordingId) return;
			if (!recordingId) recordingId = event.data.recordingId;
			if (event.data.dataBase64) {
				const frame = Buffer.from(event.data.dataBase64, "base64");
				if (encoder) {
					encoderQueue = encoderQueue
						.then(() => encoder?.pushFrame(frame, event.data.capturedAtMs))
						.then(() => undefined);
				} else {
					pendingFrames.push({ frame, capturedAtMs: event.data.capturedAtMs });
				}
			}
			if (event.data.final && event.data.summary) {
				const summaryValidation = validateBridgeCommandResult("record_stop", event.data.summary);
				if (!summaryValidation.ok) {
					fail(
						`Invalid result for 'record_stop': ${formatBridgeCommandValidationErrors(summaryValidation.errors)}`,
						3,
					);
					return;
				}
				const summary = summaryValidation.value;
				encoderQueue = encoderQueue
					.then(async () => {
						if (!encoder) return summary;
						const finished = await encoder.finish(Date.parse(summary.endedAt));
						return withEncodedRecordingSize(summary, finished.encodedSizeBytes);
					})
					.then((finalSummary) => {
						span?.setAttributes({
							"record.duration_ms": finalSummary.durationMs,
							"record.size_bytes": finalSummary.sizeBytes,
							"record.source_bytes": finalSummary.sourceBytes,
							"record.encoded_size_bytes": finalSummary.encodedSizeBytes,
							"record.frame_count": finalSummary.frameCount,
							"record.outcome": finalSummary.outcome,
						});
						span?.end(finalSummary.outcome === "stopped_error" ? "error" : "ok");
						printRecordStopSummary(finalSummary, jsonMode, outPath);
						finish(finalSummary.outcome === "stopped_error" ? 1 : 0);
					})
					.catch((error: unknown) => fail(error instanceof Error ? error.message : String(error), 1));
			}
			return;
		}
		if (isLegacyRecordChunkEvent(event)) {
			fail("Bridge sent legacy record_chunk data; restart the extension to use debugger screencast recording.", 3);
		}
	});

	ws.on("error", (err) => {
		fail(err instanceof Error ? err.message : String(err), 3);
	});

	ws.on("close", () => {
		process.removeListener("SIGINT", stopOnSignal);
		if (!settled) {
			encoder?.abort();
			fail("Connection closed before recording completed", 3);
		}
	});
}

async function cmdSession(flags: {
	url?: string;
	host?: string;
	port?: string;
	token?: string;
	json?: boolean;
	last?: string;
	follow?: boolean;
	timeout?: string;
}): Promise<void> {
	const jsonMode = flags.json || false;
	const params: Record<string, unknown> = {};
	if (flags.last) params.last = Number.parseInt(flags.last, 10);

	if (!flags.follow) {
		try {
			const response = await cmdOneShot("session_history", params, flags, BridgeDefaults.REQUEST_TIMEOUT_MS);
			if (response.error) {
				printResult(response, jsonMode);
				process.exit(exitCodeForResponse(response));
			}
			printSessionHistory(response.result as SessionHistoryResult, jsonMode);
			process.exit(0);
		} catch (err) {
			printError(err instanceof Error ? err.message : String(err), jsonMode);
			process.exit(isNetworkOrConfigError(err) ? 3 : 1);
		}
	}

	const resolved = requireNodeRuntime().requireConnection(flags);
	const { url, token } = resolved;
	let lastSeen = -1;
	const paramsValidation = validateBridgeCommandParams("session_history", params);
	if (!paramsValidation.ok) {
		printError(
			`Invalid parameters for 'session_history': ${formatBridgeCommandValidationErrors(paramsValidation.errors)}`,
			jsonMode,
		);
		process.exit(1);
	}
	const initialRequest: BridgeRequest = {
		id: generateRequestId(),
		method: "session_history",
		params: paramsValidation.value,
	};
	const ws = new WebSocket(url);

	ws.on("open", () => {
		ws.send(
			JSON.stringify({
				type: "register",
				role: "cli",
				token,
				protocolVersion: BRIDGE_PROTOCOL_VERSION,
				minProtocolVersion: BRIDGE_PROTOCOL_MIN_VERSION,
				appVersion: VERSION,
				name: "shuvgeist-cli-follow",
			}),
		);
	});

	ws.on("message", (data: Buffer | string) => {
		const msg = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
		if (msg.type === "register_result") {
			const reg = msg as RegisterResult;
			if (!reg.ok) {
				printError("Registration failed: " + (reg.error || "unknown"), jsonMode);
				process.exit(3);
			}
			ws.send(JSON.stringify(initialRequest));
			return;
		}
		if (msg.id === initialRequest.id) {
			const response = msg as BridgeResponse;
			if (response.error) {
				printResult(response, jsonMode);
				process.exit(exitCodeForResponse(response));
			}
			const resultValidation = validateBridgeCommandResult("session_history", response.result);
			if (!resultValidation.ok) {
				printError(
					`Invalid result for 'session_history': ${formatBridgeCommandValidationErrors(resultValidation.errors)}`,
					jsonMode,
				);
				process.exit(3);
			}
			const result: SessionHistoryResult = resultValidation.value;
			printSessionHistory(result, jsonMode);
			lastSeen = result.lastMessageIndex;
			return;
		}
		if (msg.type === "event") {
			const event = msg as BridgeEvent;
			if (event.event === "session_message") {
				const maybeIndex = (event.data as { message?: { messageIndex?: number } } | undefined)?.message
					?.messageIndex;
				if (typeof maybeIndex === "number") lastSeen = Math.max(lastSeen, maybeIndex);
			}
			printFollowEvent(event, jsonMode);
		}
	});

	ws.on("error", (err) => {
		printError(err instanceof Error ? err.message : String(err), jsonMode);
		process.exit(3);
	});

	ws.on("close", () => {
		process.exit(0);
	});
}

async function cmdInject(
	text: string,
	flags: {
		url?: string;
		host?: string;
		port?: string;
		token?: string;
		json?: boolean;
		role?: string;
		timeout?: string;
	},
): Promise<void> {
	const jsonMode = flags.json || false;
	try {
		const historyResponse = await cmdOneShot("session_history", {}, flags, BridgeDefaults.REQUEST_TIMEOUT_MS);
		if (historyResponse.error) {
			printResult(historyResponse, jsonMode);
			process.exit(exitCodeForResponse(historyResponse));
		}
		const history = historyResponse.result as SessionHistoryResult;
		if (!history.sessionId) {
			printError("No active persisted session", jsonMode);
			process.exit(1);
		}
		const response = await cmdOneShot(
			"session_inject",
			{
				expectedSessionId: history.sessionId,
				role: flags.role === "assistant" ? "assistant" : "user",
				content: text,
				waitForIdle: true,
			},
			flags,
			BridgeDefaults.REQUEST_TIMEOUT_MS,
		);
		if (response.error) {
			printResult(response, jsonMode);
			process.exit(exitCodeForResponse(response));
		}
		printResult(response, jsonMode);
		process.exit(0);
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err), jsonMode);
		process.exit(isNetworkOrConfigError(err) ? 3 : 1);
	}
}

async function cmdWorkflow(
	action: "run" | "validate",
	workflow: unknown,
	args: Record<string, unknown>,
	flags: {
		url?: string;
		host?: string;
		port?: string;
		token?: string;
		json?: boolean;
		timeout?: string;
	},
	defaultTimeoutMs: number,
	dryRun?: boolean,
): Promise<void> {
	const jsonMode = flags.json || false;
	const validation = validateWorkflowDefinition(workflow);
	if (!validation.ok) {
		const errors = formatWorkflowValidationErrors(validation.errors);
		if (jsonMode) {
			console.log(JSON.stringify({ ok: false, errors }, null, 2));
		} else {
			for (const error of errors) console.error(error);
		}
		process.exit(1);
	}

	if (action === "validate" || dryRun) {
		const result = { ok: true, errors: [] as string[] };
		if (jsonMode) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(dryRun ? "Workflow dry-run validation passed" : "Workflow validation passed");
		}
		process.exit(0);
	}

	try {
		const response = await cmdOneShot(
			"workflow_run",
			{
				workflow,
				args,
			},
			flags,
			defaultTimeoutMs,
		);
		if (response.error) {
			printResult(response, jsonMode);
			process.exit(exitCodeForResponse(response));
		}
		const result = response.result as WorkflowRunResultWire;
		if (jsonMode) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(`Workflow: ${result.name || "(unnamed)"}`);
			console.log(`OK: ${result.ok ? "yes" : "no"}`);
			console.log(`Aborted: ${result.aborted ? "yes" : "no"}`);
			console.log(`Duration: ${result.durationMs}ms`);
			console.log(`Steps: ${result.steps.length}`);
			if (result.errors.length > 0) {
				console.log("");
				for (const error of result.errors) {
					console.log(`error: ${error}`);
				}
			}
		}
		process.exit(result.ok ? 0 : 1);
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err), jsonMode);
		process.exit(isNetworkOrConfigError(err) ? 3 : 1);
	}
}

function generateToken(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let result = "";
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	for (const b of bytes) result += chars[b % chars.length];
	return result;
}

/**
 * How long to wait for the browser extension to (re)connect to the bridge
 * after the server has come up. The extension-side BridgeClient uses
 * exponential backoff capped at 15 seconds plus a keepalive alarm nudge, so
 * 30 seconds comfortably covers the worst case where the extension just hit
 * its backoff ceiling right before the bridge process came back up. Most
 * warm paths connect in well under 2 seconds.
 */
const EXTENSION_CONNECT_WAIT_MS = 30_000;

/**
 * After this long without the extension connecting, print a single stderr
 * hint so the user knows we are still waiting (instead of silently hanging).
 */
const EXTENSION_CONNECT_HINT_MS = 1_500;

async function fetchStatusSnapshot(statusUrl: string): Promise<BridgeServerStatus | null> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 3000);
		const response = await fetch(statusUrl, { signal: controller.signal });
		clearTimeout(timeout);
		if (!response.ok) return null;
		return (await response.json()) as BridgeServerStatus;
	} catch {
		return null;
	}
}

function assertBridgeStatusProtocol(status: BridgeServerStatus): void {
	if (!isBridgeProtocolCompatible(status.protocolVersion, status.minProtocolVersion)) {
		throw new Error(formatBridgeProtocolMismatch("server", status.protocolVersion, status.minProtocolVersion));
	}
	if (status.extension.connected && typeof status.extension.protocolVersion === "number") {
		const extensionMinProtocolVersion = status.extension.minProtocolVersion ?? status.extension.protocolVersion;
		if (!isBridgeProtocolCompatible(status.extension.protocolVersion, extensionMinProtocolVersion)) {
			throw new Error(
				formatBridgeProtocolMismatch("extension", status.extension.protocolVersion, extensionMinProtocolVersion),
			);
		}
	}
}

/**
 * Poll the bridge's /status endpoint until the extension has registered, an
 * Electron session is usable when explicitly accepted, or the timeout elapses.
 * Returns `true` when one of the accepted target surfaces is ready.
 *
 * Called after ensureBridgeServer() so that even cold-start commands like
 * `shuvgeist status` reflect the live extension state instead of reporting
 * "not connected" during the normal extension reconnect window.
 */
async function waitForExtensionConnection(
	statusUrl: string,
	timeoutMs: number,
	options: { silent?: boolean; acceptElectron?: boolean } = {},
): Promise<boolean> {
	const startedAt = Date.now();
	let hintPrinted = false;
	let delay = 100;
	while (true) {
		const status = await fetchStatusSnapshot(statusUrl);
		if (status && isBridgeStatusReady(status, options.acceptElectron === true)) return true;

		const elapsed = Date.now() - startedAt;
		if (elapsed >= timeoutMs) return false;

		if (!hintPrinted && !options.silent && elapsed >= EXTENSION_CONNECT_HINT_MS) {
			process.stderr.write("Waiting for Shuvgeist extension to connect...\n");
			hintPrinted = true;
		}

		const remaining = timeoutMs - elapsed;
		const sleepMs = Math.min(delay, remaining);
		if (sleepMs <= 0) return false;
		await new Promise((resolve) => {
			setTimeout(resolve, sleepMs);
		});
		delay = Math.min(delay * 2, 500);
	}
}

async function cmdLaunch(
	options: LaunchOptions,
	flags: { url?: string; host?: string; port?: string; token?: string; json?: boolean },
): Promise<void> {
	const jsonMode = flags.json || false;
	try {
		const runtime = requireNodeRuntime();
		// For the `launch` command, `flags.url` is the URL to open in the launched
		// browser, NOT the bridge WebSocket URL. Strip it before passing flags to
		// bridge startup/resolution so we do not accidentally point at
		// the wrong bridge host (e.g. `shuvgeist launch --url https://example.com`
		// would otherwise resolve the bridge URL as `http://example.com/status`).
		const bridgeFlags = { host: flags.host, port: flags.port, token: flags.token };

		// Auto-start bridge first
		const connection = await runtime.ensureServer(bridgeFlags);
		if (!bridgeFlags.token && connection.token) bridgeFlags.token = connection.token;

		const wsUrl = runtime.resolveConnection(bridgeFlags).url;
		const statusUrl = bridgeStatusUrl(wsUrl);
		const result = await launchBrowser(options, statusUrl, { discovery: { configOwner: runtime.owner } });

		if (result.alreadyRunning) {
			if (jsonMode) {
				console.log(JSON.stringify({ alreadyRunning: true, browser: result.browserName }));
			} else {
				console.log("Browser already running with extension connected.");
			}
			process.exit(0);
		}

		if (jsonMode) {
			console.log(
				JSON.stringify({
					pid: result.pid,
					browserPath: result.browserPath,
					extensionPath: result.extensionPath,
					browserName: result.browserName,
					userDataDir: result.userDataDir,
				}),
			);
		} else {
			console.log(`Launched ${result.browserName} (PID ${result.pid})`);
			console.log(`  Browser: ${result.browserPath}`);
			console.log(`  Extension: ${result.extensionPath}`);
			if (result.userDataDir) {
				console.log(`  Profile dir: ${result.userDataDir}`);
			} else {
				console.log("  Profile dir: (default profile, --use-default-profile)");
			}
		}

		if (options.foreground) {
			setupForegroundHandlers(result.pid);
			// Keep alive until browser exits
			const checkAlive = () => {
				try {
					process.kill(result.pid, 0);
					setTimeout(checkAlive, 1000);
				} catch {
					process.exit(0);
				}
			};
			setTimeout(checkAlive, 1000);
		} else {
			process.exit(0);
		}
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err), jsonMode);
		process.exit(isNetworkOrConfigError(err) ? 3 : 1);
	}
}

async function cmdClose(flags: { json?: boolean }): Promise<void> {
	const jsonMode = flags.json || false;
	try {
		const result = await closeBrowser();
		if (jsonMode) {
			console.log(JSON.stringify(result));
		} else {
			console.log(`Browser (PID ${result.pid}) closed via ${result.signal}`);
		}
		process.exit(0);
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err), jsonMode);
		process.exit(1);
	}
}

function printUsage(): void {
	console.log(`shuvgeist ${VERSION} — CLI bridge for the Shuvgeist browser extension

Usage:
  shuvgeist serve [--host HOST] [--port PORT] [--token TOKEN]
  shuvgeist launch [<url>] [--browser path] [--extension-path path] [--url url]
                   [--headless] [--foreground] [--profile name]
                   [--user-data-dir path] [--use-default-profile]
  shuvgeist close
  shuvgeist status [--json] [--timeout 10s]
  shuvgeist navigate <url> [--new-tab] [--json] [--timeout 60s]
  shuvgeist tabs [list] [--json] [--timeout 60s]
  shuvgeist tabs close <tabId...> [--json]
  shuvgeist tabs close --title-match <s> | --url-match <s> | --title-pattern <re>
                       | --url-pattern <re> | --window-id <n>
                       [--yes | --dry-run] [--include-pinned] [--include-protected]
                       [--require-match] [--json]
  shuvgeist windows [list] [--json]
  shuvgeist windows close <windowId> [--yes | --dry-run] [--json]
  shuvgeist switch <tabId> [--json] [--timeout 60s]
  shuvgeist repl <code> [--tab-id N] [--frame-id N] [--json] [--write-files <dir>] [--timeout 120s]
  shuvgeist repl -f <file.js> [--tab-id N] [--frame-id N] [--json] [--write-files <dir>] [--timeout 120s]
  shuvgeist screenshot [--out file.png] [--tab-id N] [--max-width N] [--no-viewport-json] [--json] [--timeout 120s]
  shuvgeist eval <code> [--tab-id N] [--frame-id N] [--json] [--timeout 120s]
  shuvgeist assert <expr|text|selector|role|label|url> <query> [--tab-id N] [--frame-id N] [--json]
  shuvgeist cookies [--json] [--timeout 120s]
  shuvgeist select <message> [--json] [--timeout none]
  shuvgeist workflow <run|validate> (--file workflow.json | --inline '{...}') [--arg key=value]
  shuvgeist snapshot [--tab-id N] [--frame-id N] [--max-entries N] [--json]
                    (snapshotIds are usable as refIds)
  shuvgeist locate <role|text|label> <query> [--tab-id N] [--frame-id N] [--json]
  shuvgeist ref <click|fill> <refId> [--value text] [--native | --trusted] [--tab-id N] [--frame-id N] [--timeout 5s] [--json]
  shuvgeist frame <list|tree> [--tab-id N] [--json]
  shuvgeist network <start|stop|list|get|body|curl|clear|stats> [...] [--json]
  shuvgeist device <emulate|reset> [...] [--json]
  shuvgeist perf <metrics|trace-start|trace-stop> [...] [--json]
  shuvgeist record start --out file.webm [--tab-id N] [--max-duration 30s]
                         [--fps N] [--quality N] [--max-width N] [--max-height N]
                         [--video-bitrate N] [--mime-type video/webm;codecs=vp9]
  shuvgeist record stop [--tab-id N] [--json]
  shuvgeist record status [--tab-id N] [--json]
  shuvgeist electron list [--json]
  shuvgeist electron allow <app-id-or-alias> [--json]
  shuvgeist electron launch <app-id-or-alias> [--inspect-main] [--json]
  shuvgeist electron attach [app-id-or-alias] [--pid PID] [--port PORT] [--inspect-port PORT] [--json]
  shuvgeist electron ipc <tap|untap> <session-id> [--channel FILTER] [--json]
  shuvgeist electron network-main <start|stop> <session-id> [--json]
  shuvgeist electron source <layout|list> [app-id-or-alias] [--source-path PATH] [--json]
  shuvgeist electron source read <file> [app-id-or-alias] [--source-path PATH] [--json]
  shuvgeist electron source extract <destination> [app-id-or-alias] [--source-path PATH] [--json]
  shuvgeist electron doctor [app-id-or-alias] [--json]
  shuvgeist electron auto-attach <status|install|uninstall> <app-id-or-alias> [--json]
  shuvgeist electron detach <session-id> [--json]
  shuvgeist electron windows [app-id-or-alias] [--json]
  shuvgeist electron label <session-id> <window-ref> <label> [--json]
  shuvgeist electron main <session-id> [--json]
  shuvgeist session [--last N] [--json] [--follow]
  shuvgeist inject <text> [--role user|assistant] [--json]
  shuvgeist new-session [provider/model-id] [--json]
  shuvgeist set-model <provider/model-id> [--json]
  shuvgeist artifacts [--json]
  shuvgeist skill <install|path> [--force] [--json]

Global options:
  --url <ws://...>    Bridge server URL
  --host <host>       Bridge server host (for constructing URL)
  --port <port>       Bridge server port (for constructing URL)
  --token <token>     Bridge auth token
  --timeout <value>   Timeout (e.g. 30s, 2m, 1500ms, none)
  --interval <value>  Assertion retry interval
  --file <path>       Read REPL or workflow source from file
  --inline <json>     Inline workflow JSON
  --arg key=value     Workflow argument (repeatable)
  --dry-run           Validate workflow locally without bridge execution
  --tab-id <id>       Explicit tab target
  --frame-id <id>     Explicit frame target
  --target <spec>     Explicit bridge target; chrome is the default.
                      Electron: electron:<session>[:<window-or-label>],
                      electron:<app-ref>[:<window-or-label>], or
                      electron:<session>/<window-or-label>
  --pid <pid>         Electron attach: process id to inspect for CDP port
  --port <port>       Electron attach: explicit CDP remote debugging port
  --inspect-main      Electron launch: also request a main-process inspector
  --inspect-port <p>  Electron attach: explicit main-process inspector port
  --channel <filter>  Electron IPC tap channel substring filter
  --source-path <p>   Electron source root, resources dir, or app.asar path
  --extract-to <p>    Electron source extract destination
  --max-entries <N>   Snapshot entry cap
  --include-hidden    Include hidden snapshot entries
  --limit <N>         Limit locator/network results
  --min-score <n>     Locator minimum score
  --name <text>       Accessible name filter for role locators
  --value <text>      Ref fill value
  --world <user|main> Assertion expression world
  --exact             Exact text/url assertion matching
  --visible           Require visible assertion target
  --enabled           Require enabled assertion target
  --native            Use legacy Chrome debugger ref input (Electron: unsupported)
  --trusted           Use renderer-scoped trusted CDP input (alias: --cdp-input)
  --timeout <value>   For ref click, wait up to this long for same-tab page stability
  --count <N>         Assertion exact match count
  --min-count <N>     Assertion minimum match count
  --max-count <N>     Assertion maximum match count
  --url-pattern <re>  URL assertion regex
  --search <text>     Network list filter
  --include-sensitive Include sensitive data in network curl export
  --preset <name>     Device preset
  --width <px>        Device viewport width
  --height <px>       Device viewport height
  --dpr <n>           Device scale factor
  --mobile            Mark viewport as mobile
  --touch             Enable touch emulation
  --user-agent <ua>   Override user agent
  --auto-stop <ms>    Perf trace auto-stop window
  --max-duration <v>  Recording duration (e.g. 30s, 30000ms, max 120s)
  --fps <n>           Recording frames per second (1-30)
  --quality <n>       Recording JPEG quality (1-100)
  --video-bitrate <n> Recording encoder video bitrate
  --mime-type <type>  Recording WebM mime type
  --user-data-dir <path>     Launch: explicit Chromium user-data-dir
                             (default: ~/.shuvgeist/profile/<browser>)
  --use-default-profile      Launch: share the user's existing browser profile
                             instead of an isolated Shuvgeist-managed one
  --no-viewport-json Suppress screenshot viewport.json sidecar when using --out
  --json              Machine-readable JSON output

Notes:
  Ref handles: refId (from locate) and snapshotId (from snapshot) are the same identifier.
  Electron targets route bridge-local through CDP and do not require a connected browser extension.
  Electron --trusted/--cdp-input requires that app's cdp_input capability to be true.
  Electron --native is intentionally unsupported; Shuvgeist never synthesizes OS-level input.
  Example: shuvgeist screenshot --target electron:e1:w1 --out app.png
  screenshot --out writes a sibling viewport.json with css/image size, DPR, and scale;
  screenshot --json includes those same metadata fields in the response.
  The packaged agent skill auto-installs to ~/.agents/skills/shuvgeist on each run
  (run "shuvgeist skill install --force" to reinstall it explicitly).

Examples:
  shuvgeist launch --url http://127.0.0.1:3000 --headless --user-data-dir /tmp/shuvgeist-profile --json
  shuvgeist status --json
  shuvgeist assert text "Welcome" --timeout 10s --json
  shuvgeist assert role button --name "Continue" --visible --json
  shuvgeist assert expr 'window.__APP_STATE__.ready === true' --world main --json
  shuvgeist workflow run --file smoke.workflow.json --json
  shuvgeist locate label "Email" --json
  shuvgeist ref fill <refId> --value "Low to High" --json
  shuvgeist ref fill <refId> --value "user@example.com" --native --json
  shuvgeist ref click <refId> --trusted --target electron:e1:w1 --json
  shuvgeist ref fill <refId> --value "user@example.com" --cdp-input --target electron:e1:w1 --json
  shuvgeist ref click <refId> --timeout 5s --json

Bridge config: ${join(DEFAULT_NODE_CONFIG_DIRECTORY, "bridge.json")}
  Override path: SHUVGEIST_BRIDGE_CONFIG
  Connection: SHUVGEIST_BRIDGE_URL, SHUVGEIST_BRIDGE_HOST,
              SHUVGEIST_BRIDGE_PORT, SHUVGEIST_BRIDGE_TOKEN
  Telemetry:  SHUVGEIST_OTEL_ENABLED, SHUVGEIST_OTEL_INGEST_URL,
              SHUVGEIST_OTEL_PRIVATE_INGEST_KEY
Discovery config: ${join(DEFAULT_NODE_CONFIG_DIRECTORY, "config.json")}
  Override path: SHUVGEIST_CONFIG (SHUVGEIST_DISCOVERY_CONFIG is also accepted)
  Candidates: SHUVGEIST_EXTENSION_PATH, SHUVGEIST_BROWSER

Automatic bridge startup requires the exact /ws path with no query or fragment,
plain ws:// transport, and host localhost, 127.0.0.1, or ::1. It runs this
checkout's source CLI through tsx. Start every other endpoint explicitly with
"shuvgeist serve".
For a reusable or concurrent flag/environment endpoint, pass --token or
SHUVGEIST_BRIDGE_TOKEN; a generated transient token is not written over an
unrelated persisted URL.

Exit codes:
  0  success
  1  assertion failed or command/runtime error
  2  no extension target connected
  3  auth/configuration/network/invalid-method/registration error
`);
}

/**
 * Handle the local `skill` command: install/refresh the packaged agent skill
 * into ~/.agents/skills, or print its install path. Runs without a bridge.
 */
function runSkillCommand(args: string[]): void {
	const sub = args[0];
	const json = args.includes("--json");
	const force = args.includes("--force");

	if (sub === "path") {
		const dir = resolveSkillTargetDir();
		console.log(json ? JSON.stringify({ path: dir }) : dir);
		return;
	}

	if (sub === "install") {
		const result = installSkill({ version: VERSION, force });
		if (json) {
			console.log(JSON.stringify(result));
		} else if (result.action === "installed") {
			console.log(`Installed shuvgeist skill to ${result.targetDir} (v${result.installedVersion})`);
		} else if (result.action === "updated") {
			console.log(
				`Updated shuvgeist skill at ${result.targetDir} (v${result.previousVersion ?? "?"} -> v${result.installedVersion})`,
			);
		} else if (result.action === "unchanged") {
			console.log(`shuvgeist skill already up to date at ${result.targetDir} (v${result.installedVersion})`);
		} else {
			console.error(`Could not install shuvgeist skill: ${result.reason ?? "unknown error"}`);
		}
		if (result.action === "skipped") process.exitCode = 1;
		return;
	}

	const usage = "Usage: shuvgeist skill <install|path> [--force] [--json]";
	if (sub === undefined || sub === "--help" || sub === "-h") {
		console.log(usage);
	} else {
		console.error(`Unknown skill subcommand: ${sub}\n${usage}`);
		process.exitCode = 1;
	}
}

/**
 * Force stdout/stderr into blocking mode at startup.
 *
 * Node's `process.stdout.write()` is *non-blocking* when the stream is a pipe
 * (e.g. `shuvgeist snapshot --json | python3 ...`), which means a subsequent
 * `process.exit()` can terminate the process before the OS pipe buffer has
 * been fully drained. On Linux the kernel pipe buffer is 64 KiB, so any
 * output larger than that gets silently truncated at exactly 65536 bytes.
 *
 * Putting the underlying libuv handle into blocking mode makes `console.log`
 * / `write` synchronous again, matching the behavior when stdout is a TTY or
 * redirected to a file. This is the standard, long-stable workaround for
 * https://github.com/nodejs/node/issues/6456.
 */
function forceBlockingStdio(): void {
	for (const stream of [process.stdout, process.stderr] as const) {
		const handle = (stream as unknown as { _handle?: { setBlocking?(blocking: boolean): void } })._handle;
		if (handle && typeof handle.setBlocking === "function") {
			try {
				handle.setBlocking(true);
			} catch {
				// Best-effort; if libuv rejects blocking mode (e.g. on an unusual
				// stream type) we fall back to Node's default behavior.
			}
		}
	}
}

async function main(): Promise<void> {
	forceBlockingStdio();
	const args = process.argv.slice(2);
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		printUsage();
		process.exit(0);
	}
	if (args[0] === "--version" || args[0] === "-v") {
		console.log(VERSION);
		process.exit(0);
	}

	// `skill` is a local management command (no bridge needed): it syncs the
	// packaged agent skill into ~/.agents/skills so coding agents discover it.
	if (args[0] === "skill") {
		runSkillCommand(args.slice(1));
		return;
	}

	// Explicit config-path overrides are validated only for commands that use
	// Node runtime state. Keeping construction here puts failures under the CLI
	// error boundary while help, version, and skill remain recovery-safe.
	nodeRuntime = createCliNodeRuntime();

	// Best-effort: keep the packaged skill synced to ~/.agents/skills on every
	// real command run (version-gated, silent, never fatal).
	ensureSkillInstalled(VERSION);

	const command = args[0];
	const rest = args.slice(1);
	const { flags, positionals } = parseCliArguments(rest);
	const plan = createCommandPlan(command, positionals, flags, (path) => readFileSync(path, "utf-8"));

	// Auto-start bridge for commands that need it. For the `launch` command,
	// `flags.url` is the URL to open in the launched browser (not the bridge
	// URL), so strip it before passing to the bridge server helpers.
	//
	// After the bridge process is up, also wait for the browser extension to
	// (re)register. Status may return as soon as an Electron session is usable,
	// because bridge-local Electron control does not depend on the extension.
	//
	// `launch` has its own extension-registration wait inside launchBrowser()
	// and `close` is a local browser-lifecycle operation, so both skip the
	// extra wait here. JSON callers still get a single-shot view: the wait is
	// silent and bounded, and commands that do not require an extension target
	// (e.g. a disconnected `status --json`) still complete after the timeout.
	if (plan.kind !== "serve" && plan.kind !== "usage-error") {
		const runtime = requireNodeRuntime();
		const bridgeFlags = plan.kind === "launch" ? { host: flags.host, port: flags.port, token: flags.token } : flags;
		const connection = await runtime.ensureServer(bridgeFlags);
		if (!bridgeFlags.token && connection.token) bridgeFlags.token = connection.token;
		if (!flags.token && connection.token) flags.token = connection.token;

		const skipsExtensionWait =
			plan.kind === "launch" ||
			plan.kind === "close" ||
			(plan.kind === "one-shot" && plan.method.startsWith("electron_")) ||
			("target" in plan && plan.target?.kind === "electron-window");
		if (!skipsExtensionWait) {
			const wsUrl = runtime.resolveConnection(bridgeFlags).url;
			const statusUrl = bridgeStatusUrl(wsUrl);
			await waitForExtensionConnection(statusUrl, EXTENSION_CONNECT_WAIT_MS, {
				silent: flags.json === true,
				acceptElectron: plan.kind === "status",
			});
			const status = await fetchStatusSnapshot(statusUrl);
			if (status) assertBridgeStatusProtocol(status);
		}
	}

	switch (plan.kind) {
		case "serve":
			await cmdServe(rest);
			break;
		case "launch":
			await cmdLaunch(plan.options, flags);
			break;
		case "close":
			await cmdClose(flags);
			break;
		case "status":
			await fetchBridgeStatus(flags);
			break;
		case "one-shot":
			await runOneShot(
				plan.method,
				plan.params,
				plan.method.startsWith("electron_") ? { ...flags, port: undefined } : flags,
				plan.defaultTimeoutMs,
				plan.target,
			);
			break;
		case "assert":
			await runOneShot(
				"page_assert",
				plan.params,
				{ ...flags, timeout: undefined },
				plan.defaultTimeoutMs,
				plan.target,
			);
			break;
		case "repl":
			await cmdRepl(plan.params, { ...flags, target: plan.target });
			break;
		case "screenshot":
			await cmdScreenshot({ ...flags, target: plan.target });
			break;
		case "cookies":
			await runOneShot("cookies", {}, flags, BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS, plan.target);
			break;
		case "workflow":
			await cmdWorkflow(plan.action, plan.workflow, plan.args, flags, plan.defaultTimeoutMs, plan.dryRun);
			break;
		case "record":
			await cmdRecord(plan.action, plan.params, { ...flags, target: plan.target }, plan.defaultTimeoutMs);
			break;
		case "session":
			await cmdSession(flags);
			break;
		case "inject":
			await cmdInject(plan.text, { ...flags, role: plan.role });
			break;
		case "usage-error":
			if (plan.message.startsWith("Unknown command:")) {
				console.error(plan.message);
				console.error("Run 'shuvgeist --help' for usage.");
			} else {
				console.error(plan.message);
			}
			process.exit(1);
			break;
	}
}

main().catch((err) => {
	console.error("Fatal: " + (err instanceof Error ? err.message : String(err)));
	process.exit(isNetworkOrConfigError(err) ? 3 : 1);
});
