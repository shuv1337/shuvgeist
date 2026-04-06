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

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { WebSocket } from "ws";
import {
	bridgeStatusUrl,
	type CliFlags,
	createCommandPlan,
	exitCodeForResponse,
	generateRequestId,
	isNetworkOrConfigError,
	parseTimeout,
	resolveBridgeUrl,
	resolveConfig,
} from "./cli-core.js";
import { closeBrowser, type LaunchOptions, launchBrowser, setupForegroundHandlers } from "./launcher.js";
import {
	BridgeDefaults,
	type BridgeEvent,
	type BridgeMethod,
	type BridgeReplResult,
	type BridgeRequest,
	type BridgeResponse,
	type BridgeScreenshotResult,
	type BridgeServerStatus,
	type CliConfigFile,
	type RegisterResult,
	type SessionHistoryResult,
	type WorkflowRunResultWire,
} from "./protocol.js";
import { BridgeServer } from "./server.js";
import { formatWorkflowValidationErrors, validateWorkflowDefinition } from "./workflow-schema.js";

declare const __SHUVGEIST_VERSION__: string;
const VERSION = typeof __SHUVGEIST_VERSION__ !== "undefined" ? __SHUVGEIST_VERSION__ : "dev";

function getConfigPath(): string {
	return join(homedir(), ".shuvgeist", "bridge.json");
}

function readConfigFile(): CliConfigFile {
	const path = getConfigPath();
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as CliConfigFile;
	} catch {
		return {};
	}
}

function sendRequest(url: string, token: string, request: BridgeRequest, timeoutMs?: number): Promise<BridgeResponse> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		if (timeoutMs && timeoutMs > 0) {
			timeout = setTimeout(() => {
				if (!settled) {
					settled = true;
					ws.close();
					reject(Object.assign(new Error(`Connection timeout after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
				}
			}, timeoutMs);
		}

		ws.on("open", () => {
			ws.send(
				JSON.stringify({
					type: "register",
					role: "cli",
					token,
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
					reject(Object.assign(new Error("Registration failed: " + (reg.error || "unknown")), { code: "EAUTH" }));
					return;
				}
				ws.send(JSON.stringify(request));
				return;
			}
			if ("id" in msg && msg.id === request.id) {
				settled = true;
				if (timeout) clearTimeout(timeout);
				ws.close();
				resolve(msg as BridgeResponse);
			}
		});

		ws.on("error", (err: Error) => {
			if (!settled) {
				settled = true;
				if (timeout) clearTimeout(timeout);
				reject(err);
			}
		});

		ws.on("close", () => {
			if (timeout) clearTimeout(timeout);
			if (!settled) {
				settled = true;
				reject(Object.assign(new Error("Connection closed before response"), { code: "ECONNRESET" }));
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

function printFollowEvent(event: BridgeEvent, jsonMode: boolean): void {
	if (jsonMode) {
		console.log(JSON.stringify(event));
		return;
	}
	console.log(`event:${event.event} ${JSON.stringify(event.data || {})}`);
}

async function fetchBridgeStatus(flags: { url?: string; host?: string; port?: string; json?: boolean }): Promise<void> {
	const wsUrl = resolveBridgeUrl(flags, process.env, readConfigFile());
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
		if (jsonMode) {
			console.log(JSON.stringify(status, null, 2));
		} else {
			console.log(`CLI version: ${VERSION}`);
			console.log(`Bridge: ${statusUrl}`);
			console.log(`Extension connected: ${status.extension.connected ? "yes" : "no"}`);
			if (status.extension.connected) {
				// Defensive: never present `0` (or any non-positive id) as a healthy
				// target. The background service worker now gates registration on a
				// usable window id, but if anything ever leaks through we want the
				// status output to call it out instead of pretending it is normal.
				const rawWindowId = status.extension.windowId;
				const windowIdDisplay =
					typeof rawWindowId === "number" && Number.isInteger(rawWindowId) && rawWindowId > 0
						? String(rawWindowId)
						: "unavailable";
				console.log(`Window ID: ${windowIdDisplay}`);
				console.log(`Session ID: ${status.extension.sessionId ?? "unknown"}`);
				console.log(`Capabilities: ${(status.extension.capabilities || []).join(", ") || "none"}`);
				console.log(`Extension address: ${status.extension.remoteAddress ?? "unknown"}`);
			}
			console.log(
				`Clients: cli=${status.clients.cli} extension=${status.clients.extension} total=${status.clients.total}`,
			);
			console.log(`Pending requests: ${status.pendingRequests}`);
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
			host: { type: "string", default: process.env.SHUVGEIST_BRIDGE_HOST || BridgeDefaults.HOST },
			port: { type: "string", default: process.env.SHUVGEIST_BRIDGE_PORT || String(BridgeDefaults.PORT) },
			token: { type: "string", default: process.env.SHUVGEIST_BRIDGE_TOKEN || "" },
		},
		allowPositionals: false,
	});

	// Resolve token: flag > env > config file > auto-generate and persist
	let token = values.token || "";
	if (!token) {
		const existing = readConfigFile();
		token = existing.token || "";
	}
	if (!token) {
		token = generateToken();
		const configDir = join(homedir(), ".shuvgeist");
		mkdirSync(configDir, { recursive: true });
		const configPath = getConfigPath();
		const existing = readConfigFile();
		existing.token = token;
		writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
		console.log("Generated token and saved to " + configPath);
		console.log("");
	}

	await new BridgeServer({ host: values.host!, port: Number.parseInt(values.port!, 10), token }).start();
}

async function cmdOneShot(
	method: BridgeMethod,
	params: Record<string, unknown>,
	flags: { url?: string; host?: string; port?: string; token?: string; json?: boolean; timeout?: string },
	defaultTimeoutMs?: number,
): Promise<BridgeResponse> {
	const resolved = resolveConfig(flags, process.env, readConfigFile(), getConfigPath());
	if (!resolved.ok) {
		throw Object.assign(new Error(resolved.message), { code: "EAUTH" });
	}
	const { url, token } = resolved;
	const timeoutMs = parseTimeout(flags.timeout, defaultTimeoutMs);
	const request: BridgeRequest = {
		id: generateRequestId(),
		method,
		params,
	};
	return sendRequest(url, token, request, timeoutMs);
}

async function runOneShot(
	method: BridgeMethod,
	params: Record<string, unknown>,
	flags: { url?: string; host?: string; port?: string; token?: string; json?: boolean; timeout?: string },
	defaultTimeoutMs?: number,
): Promise<void> {
	const jsonMode = flags.json || false;
	try {
		const response = await cmdOneShot(method, params, flags, defaultTimeoutMs);
		printResult(response, jsonMode);
		process.exit(exitCodeForResponse(response));
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err), jsonMode);
		process.exit(isNetworkOrConfigError(err) ? 3 : 1);
	}
}

async function cmdScreenshot(flags: {
	url?: string;
	host?: string;
	port?: string;
	token?: string;
	json?: boolean;
	out?: string;
	maxWidth?: string;
	timeout?: string;
}): Promise<void> {
	const jsonMode = flags.json || false;
	const params: Record<string, unknown> = {};
	if (flags.maxWidth) params.maxWidth = Number.parseInt(flags.maxWidth, 10);
	try {
		const response = await cmdOneShot("screenshot", params, flags, BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS);
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
			if (!jsonMode) console.log("Screenshot saved to " + flags.out);
		} else {
			printResult(response, jsonMode);
		}
		process.exit(0);
	} catch (err) {
		printError(err instanceof Error ? err.message : String(err), jsonMode);
		process.exit(isNetworkOrConfigError(err) ? 3 : 1);
	}
}

async function cmdRepl(
	code: string,
	flags: {
		url?: string;
		host?: string;
		port?: string;
		token?: string;
		json?: boolean;
		writeFiles?: string;
		timeout?: string;
	},
): Promise<void> {
	const jsonMode = flags.json || false;
	try {
		const response = await cmdOneShot(
			"repl",
			{ title: "CLI REPL", code },
			flags,
			BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS,
		);
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

	const resolved = resolveConfig(flags, process.env, readConfigFile(), getConfigPath());
	if (!resolved.ok) {
		printError(resolved.message, jsonMode);
		process.exit(3);
	}
	const { url, token } = resolved;
	let lastSeen = -1;
	const initialRequest: BridgeRequest = { id: generateRequestId(), method: "session_history", params };
	const ws = new WebSocket(url);

	ws.on("open", () => {
		ws.send(JSON.stringify({ type: "register", role: "cli", token, name: "shuvgeist-cli-follow" }));
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
			const result = response.result as SessionHistoryResult;
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

const BRIDGE_PID_FILE = join(homedir(), ".shuvgeist", "bridge.pid");

/**
 * Ensure the bridge server is running. If not, auto-start it.
 */
async function ensureBridgeServer(flags: {
	url?: string;
	host?: string;
	port?: string;
	token?: string;
}): Promise<void> {
	const wsUrl = resolveBridgeUrl(flags, process.env, readConfigFile());
	const statusUrl = bridgeStatusUrl(wsUrl);

	// Check if bridge is already running
	if (await isBridgeRunning(statusUrl)) return;

	// Resolve token for the new server
	let token = flags.token || process.env.SHUVGEIST_BRIDGE_TOKEN || readConfigFile().token || "";
	if (!token) {
		// Generate a token
		token = generateToken();
		const configDir = join(homedir(), ".shuvgeist");
		mkdirSync(configDir, { recursive: true });
		const configPath = getConfigPath();
		const existing = readConfigFile();
		existing.token = token;
		writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
	}

	const host = flags.host || process.env.SHUVGEIST_BRIDGE_HOST || BridgeDefaults.HOST;
	const port = flags.port || process.env.SHUVGEIST_BRIDGE_PORT || String(BridgeDefaults.PORT);

	// Fork a bridge server process
	const child = spawn(process.execPath, [process.argv[1], "serve", "--host", host, "--port", port, "--token", token], {
		detached: true,
		stdio: "ignore",
	});

	if (child.pid) {
		writeFileSync(BRIDGE_PID_FILE, String(child.pid));
	}
	child.unref();

	// Wait for bridge to become available
	const deadline = Date.now() + 5000;
	let delay = 100;
	while (Date.now() < deadline) {
		await new Promise((r) => {
			setTimeout(r, delay);
		});
		delay = Math.min(delay * 2, 1000);
		if (await isBridgeRunning(statusUrl)) return;
	}
}

async function isBridgeRunning(statusUrl: string): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 3000);
		const response = await fetch(statusUrl, { signal: controller.signal });
		clearTimeout(timeout);
		return response.ok;
	} catch {
		return false;
	}
}

async function cmdLaunch(
	options: LaunchOptions,
	flags: { url?: string; host?: string; port?: string; token?: string; json?: boolean },
): Promise<void> {
	const jsonMode = flags.json || false;
	try {
		// Auto-start bridge first
		await ensureBridgeServer(flags);

		const wsUrl = resolveBridgeUrl(flags, process.env, readConfigFile());
		const statusUrl = bridgeStatusUrl(wsUrl);
		const result = await launchBrowser(options, statusUrl);

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
				}),
			);
		} else {
			console.log(`Launched ${result.browserName} (PID ${result.pid})`);
			console.log(`  Browser: ${result.browserPath}`);
			console.log(`  Extension: ${result.extensionPath}`);
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
		process.exit(1);
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
  shuvgeist launch [--browser path] [--extension-path path] [--url url] [--headless] [--foreground] [--profile name]
  shuvgeist close
  shuvgeist status [--json] [--timeout 10s]
  shuvgeist navigate <url> [--new-tab] [--json] [--timeout 60s]
  shuvgeist tabs [--json] [--timeout 60s]
  shuvgeist switch <tabId> [--json] [--timeout 60s]
  shuvgeist repl <code> [--json] [--write-files <dir>] [--timeout 120s]
  shuvgeist repl -f <file.js> [--json] [--write-files <dir>] [--timeout 120s]
  shuvgeist screenshot [--out file.png] [--max-width N] [--json] [--timeout 120s]
  shuvgeist eval <code> [--json] [--timeout 120s]
  shuvgeist cookies [--json] [--timeout 120s]
  shuvgeist select <message> [--json] [--timeout none]
  shuvgeist workflow <run|validate> (--file workflow.json | --inline '{...}') [--arg key=value]
  shuvgeist snapshot [--tab-id N] [--frame-id N] [--max-entries N] [--json]
  shuvgeist locate <role|text|label> <query> [--tab-id N] [--frame-id N] [--json]
  shuvgeist ref <click|fill> <refId> [--value text] [--tab-id N] [--frame-id N] [--json]
  shuvgeist frame <list|tree> [--tab-id N] [--json]
  shuvgeist network <start|stop|list|get|body|curl|clear|stats> [...] [--json]
  shuvgeist device <emulate|reset> [...] [--json]
  shuvgeist perf <metrics|trace-start|trace-stop> [...] [--json]
  shuvgeist session [--last N] [--json] [--follow]
  shuvgeist inject <text> [--role user|assistant] [--json]
  shuvgeist new-session [provider/model-id] [--json]
  shuvgeist set-model <provider/model-id> [--json]
  shuvgeist artifacts [--json]

Global options:
  --url <ws://...>    Bridge server URL
  --host <host>       Bridge server host (for constructing URL)
  --port <port>       Bridge server port (for constructing URL)
  --token <token>     Bridge auth token
  --timeout <value>   Timeout (e.g. 30s, 2m, 1500ms, none)
  --file <path>       Read REPL or workflow source from file
  --inline <json>     Inline workflow JSON
  --arg key=value     Workflow argument (repeatable)
  --dry-run           Validate workflow locally without bridge execution
  --tab-id <id>       Explicit tab target
  --frame-id <id>     Explicit frame target
  --max-entries <N>   Snapshot entry cap
  --include-hidden    Include hidden snapshot entries
  --limit <N>         Limit locator/network results
  --min-score <n>     Locator minimum score
  --name <text>       Accessible name filter for role locators
  --value <text>      Ref fill value
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
  --json              Machine-readable JSON output

Config file: ~/.shuvgeist/bridge.json
Environment: SHUVGEIST_BRIDGE_URL, SHUVGEIST_BRIDGE_HOST,
             SHUVGEIST_BRIDGE_PORT, SHUVGEIST_BRIDGE_TOKEN

Exit codes:
  0  success
  1  command/runtime error
  2  no extension target connected
  3  auth/configuration/network error
`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		printUsage();
		process.exit(0);
	}
	if (args[0] === "--version" || args[0] === "-v") {
		console.log(VERSION);
		process.exit(0);
	}

	const command = args[0];
	const rest = args.slice(1);
	const globalFlags: CliFlags = {};
	const positionals: string[] = [];
	let i = 0;
	while (i < rest.length) {
		const arg = rest[i];
		if (arg === "--json") globalFlags.json = true;
		else if (arg === "--new-tab") globalFlags.newTab = true;
		else if (arg === "--dry-run") globalFlags.dryRun = true;
		else if (arg === "--follow") globalFlags.follow = true;
		else if (arg === "--include-hidden") globalFlags.includeHidden = true;
		else if (arg === "--include-sensitive") globalFlags.includeSensitive = true;
		else if (arg === "--mobile") globalFlags.mobile = true;
		else if (arg === "--touch") globalFlags.touch = true;
		else if (arg === "--url" && i + 1 < rest.length) globalFlags.url = rest[++i];
		else if (arg === "--host" && i + 1 < rest.length) globalFlags.host = rest[++i];
		else if (arg === "--port" && i + 1 < rest.length) globalFlags.port = rest[++i];
		else if (arg === "--token" && i + 1 < rest.length) globalFlags.token = rest[++i];
		else if (arg === "--timeout" && i + 1 < rest.length) globalFlags.timeout = rest[++i];
		else if (arg === "--out" && i + 1 < rest.length) globalFlags.out = rest[++i];
		else if (arg === "--max-width" && i + 1 < rest.length) globalFlags.maxWidth = rest[++i];
		else if (arg === "--write-files" && i + 1 < rest.length) globalFlags.writeFiles = rest[++i];
		else if (arg === "--last" && i + 1 < rest.length) globalFlags.last = rest[++i];
		else if (arg === "--role" && i + 1 < rest.length) globalFlags.role = rest[++i];
		else if (arg === "--inline" && i + 1 < rest.length) globalFlags.inline = rest[++i];
		else if (arg === "--arg" && i + 1 < rest.length) {
			if (!globalFlags.arg) {
				globalFlags.arg = [];
			}
			globalFlags.arg.push(rest[++i]);
		} else if (arg === "--tab-id" && i + 1 < rest.length) globalFlags.tabId = rest[++i];
		else if (arg === "--frame-id" && i + 1 < rest.length) globalFlags.frameId = rest[++i];
		else if (arg === "--max-entries" && i + 1 < rest.length) globalFlags.maxEntries = rest[++i];
		else if (arg === "--limit" && i + 1 < rest.length) globalFlags.limit = rest[++i];
		else if (arg === "--min-score" && i + 1 < rest.length) globalFlags.minScore = rest[++i];
		else if (arg === "--name" && i + 1 < rest.length) globalFlags.name = rest[++i];
		else if (arg === "--value" && i + 1 < rest.length) globalFlags.value = rest[++i];
		else if (arg === "--search" && i + 1 < rest.length) globalFlags.search = rest[++i];
		else if (arg === "--preset" && i + 1 < rest.length) globalFlags.preset = rest[++i];
		else if (arg === "--width" && i + 1 < rest.length) globalFlags.width = rest[++i];
		else if (arg === "--height" && i + 1 < rest.length) globalFlags.height = rest[++i];
		else if (arg === "--dpr" && i + 1 < rest.length) globalFlags.dpr = rest[++i];
		else if (arg === "--user-agent" && i + 1 < rest.length) globalFlags.userAgent = rest[++i];
		else if (arg === "--auto-stop" && i + 1 < rest.length) globalFlags.autoStop = rest[++i];
		else if (arg === "--browser" && i + 1 < rest.length) globalFlags.browser = rest[++i];
		else if (arg === "--extension-path" && i + 1 < rest.length) globalFlags.extensionPath = rest[++i];
		else if (arg === "--profile" && i + 1 < rest.length) globalFlags.profile = rest[++i];
		else if (arg === "--headless") globalFlags.headless = true;
		else if (arg === "--foreground") globalFlags.foreground = true;
		else if (arg === "-f" && i + 1 < rest.length) globalFlags.file = rest[++i];
		else positionals.push(arg);
		i++;
	}

	const flags = globalFlags;
	const plan = createCommandPlan(command, positionals, flags, (path) => readFileSync(path, "utf-8"));

	// Auto-start bridge for commands that need it
	if (plan.kind !== "serve" && plan.kind !== "usage-error") {
		await ensureBridgeServer(flags);
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
			await runOneShot(plan.method, plan.params, flags, plan.defaultTimeoutMs);
			break;
		case "repl":
			await cmdRepl(plan.code, flags);
			break;
		case "screenshot":
			await cmdScreenshot(flags);
			break;
		case "cookies":
			await runOneShot("cookies", {}, flags, BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS);
			break;
		case "workflow":
			await cmdWorkflow(plan.action, plan.workflow, plan.args, flags, plan.defaultTimeoutMs, plan.dryRun);
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
	process.exit(1);
});
