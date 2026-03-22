import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
} from "@mariozechner/pi-agent-core";
import { getModel, getModels, type Model, registerModels } from "@mariozechner/pi-ai";
import {
	ChatPanel,
	createExtractDocumentTool,
	createStreamFn,
	ModelSelector,
	ProvidersModelsTab,
	SettingsDialog,
	// PersistentStorageDialog,
	setAppStorage,
	setShowJsonMode,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { History, Plus, Settings } from "lucide";
import { BridgeClient } from "./bridge/extension-client.js";
import { bridgeLog } from "./bridge/logging.js";
import { ErrorCodes, type SessionInjectParams } from "./bridge/protocol.js";
import {
	projectSessionMessage,
	projectSessionMessages,
	type SessionBridgeAdapter,
	type SessionBridgeEventEnvelope,
	type SessionSnapshot,
	summarizeForBridge,
} from "./bridge/session-bridge.js";
import { AboutTab } from "./dialogs/AboutTab.js";
import { ApiKeyOrOAuthDialog } from "./dialogs/ApiKeyOrOAuthDialog.js";
import { ApiKeysOAuthTab } from "./dialogs/ApiKeysOAuthTab.js";
import { BridgeTab, setBridgeSettingsChangeCallback, setBridgeStateForTab } from "./dialogs/BridgeTab.js";
import { CostsTab } from "./dialogs/CostsTab.js";
import { SessionCostDialog } from "./dialogs/SessionCostDialog.js";
import { SitegeistSessionListDialog } from "./dialogs/SessionListDialog.js";
import { SkillsTab } from "./dialogs/SkillsTab.js";
import { UpdateNotificationDialog } from "./dialogs/UpdateNotificationDialog.js";
import { UserScriptsPermissionDialog } from "./dialogs/UserScriptsPermissionDialog.js";
import { WelcomeSetupDialog } from "./dialogs/WelcomeSetupDialog.js";
import { browserMessageTransformer } from "./messages/message-transformer.js";
import {
	createNavigationMessage,
	type NavigationMessage,
	registerNavigationRenderer,
} from "./messages/NavigationMessage.js";
import { registerUserMessageRenderer } from "./messages/UserMessageRenderer.js";
import { createWelcomeMessage, registerWelcomeRenderer } from "./messages/WelcomeMessage.js";
import { isOAuthCredentials, resolveApiKey } from "./oauth/index.js";
import { SYSTEM_PROMPT } from "./prompts/prompts.js";
import { SitegeistAppStorage } from "./storage/app-storage.js";
import { DebuggerTool } from "./tools/debugger.js";
import { ExtractImageTool, registerExtractImageRenderer } from "./tools/extract-image.js";
import { AskUserWhichElementTool, skillTool } from "./tools/index.js";
import { NativeInputEventsRuntimeProvider } from "./tools/NativeInputEventsRuntimeProvider.js";
import { isToolNavigating, NavigateTool } from "./tools/navigate.js";
import { createReplTool } from "./tools/repl/repl.js";
import { BrowserJsRuntimeProvider, NavigateRuntimeProvider } from "./tools/repl/runtime-providers.js";
import * as port from "./utils/port.js";
import "./utils/i18n-extension.js";
import "./utils/live-reload.js";
import { tutorials } from "./tutorials.js";

// Register custom message renderers
registerNavigationRenderer();
registerExtractImageRenderer();

// Listen for abort messages from REPL overlay
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	console.log("[Sidepanel] Received message:", message, "from:", sender);
	if (message.type === "abort-repl") {
		console.log("[Sidepanel] Abort-repl message received, agent streaming:", agent?.state.isStreaming);
		if (agent?.state.isStreaming) {
			console.log("[Sidepanel] Aborting agent...");
			agent.abort();
			sendResponse({ success: true });
		} else {
			console.log("[Sidepanel] Agent not streaming, ignoring");
			sendResponse({ success: false, reason: "not-streaming" });
		}
		return true; // Keep channel open for async response
	}
});

// ============================================================================
// STORAGE SETUP
// ============================================================================
const storage = new SitegeistAppStorage();
setAppStorage(storage);

// ============================================================================
// APP STATE
// ============================================================================
let currentSessionId: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
let currentWindowId: number;

const getBridgeDebuggerMode = async () => {
	const stored = await chrome.storage.local.get("debuggerMode");
	return Boolean(stored.debuggerMode);
};

const syncBridgeConnection = async () => {
	const bridgeEnabled = (await storage.settings.get<boolean>("bridge.enabled")) ?? false;
	const bridgeUrl = (await storage.settings.get<string>("bridge.url")) ?? "ws://127.0.0.1:19285/ws";
	const bridgeToken = (await storage.settings.get<string>("bridge.token")) ?? "";
	const debuggerEnabled = await getBridgeDebuggerMode();

	if (bridgeEnabled && bridgeUrl && bridgeToken) {
		bridgeClient.connect({
			url: bridgeUrl,
			token: bridgeToken,
			windowId: currentWindowId,
			sessionId: currentSessionId,
			debuggerEnabled,
			sessionBridge: sessionBridgeAdapter,
			onStateChange: (state, detail) => {
				setBridgeStateForTab(state, detail);
				renderApp();
			},
		});
	} else {
		bridgeClient.disconnect();
		setBridgeStateForTab("disabled");
		renderApp();
	}
};

// Track which skills we've shown in full (skillName -> lastUpdated timestamp)
// Reset when a new session/agent is created
const shownSkills = new Map<string, string>();

// Track which messages we've already recorded costs for (avoid duplicates)
// Use Set with message object identity (not cleared on session switch - persists in memory)
const recordedCostMessages = new Set<AgentMessage>();

// Bridge client for CLI-to-extension communication
const bridgeClient = new BridgeClient();
const sessionBridgeListeners = new Set<(event: SessionBridgeEventEnvelope) => void>();

// Cached auth type label for the current provider
let authLabel = "";

const MINIMAX_EXTENSION_MODELS: Model<"anthropic-messages">[] = [
	{
		id: "MiniMax-M2.7",
		name: "MiniMax M2.7",
		api: "anthropic-messages",
		provider: "minimax",
		baseUrl: "https://api.minimax.io/anthropic",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0.3,
			output: 1.2,
			cacheRead: 0.06,
			cacheWrite: 0.375,
		},
		contextWindow: 204800,
		maxTokens: 8192,
	},
	{
		id: "MiniMax-M2.7-highspeed",
		name: "MiniMax M2.7 Highspeed",
		api: "anthropic-messages",
		provider: "minimax",
		baseUrl: "https://api.minimax.io/anthropic",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0.6,
			output: 2.4,
			cacheRead: 0.06,
			cacheWrite: 0.375,
		},
		contextWindow: 204800,
		maxTokens: 8192,
	},
];

registerModels(MINIMAX_EXTENSION_MODELS);

const DEFAULT_MODELS: Record<string, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	anthropic: "claude-sonnet-4-6",
	"azure-openai-responses": "gpt-5.2",
	cerebras: "zai-glm-4.6",
	"github-copilot": "gpt-4o",
	google: "gemini-2.5-flash",
	"google-antigravity": "gemini-3.1-pro-high",
	"google-gemini-cli": "gemini-2.5-pro",
	"google-vertex": "gemini-3-pro-preview",
	groq: "openai/gpt-oss-20b",
	huggingface: "moonshotai/Kimi-K2.5",
	"kimi-coding": "kimi-k2-thinking",
	minimax: "MiniMax-M2.7",
	"minimax-cn": "MiniMax-M2.1",
	mistral: "devstral-medium-latest",
	openai: "gpt-4o-mini",
	"openai-codex": "gpt-5.1-codex-mini",
	opencode: "claude-opus-4-6",
	"opencode-go": "kimi-k2.5",
	openrouter: "openai/gpt-5.1-codex",
	"vercel-ai-gateway": "anthropic/claude-opus-4-6",
	xai: "grok-4-fast-non-reasoning",
	zai: "glm-4.6",
};

async function getCustomProviderByName(providerName: string) {
	const customProviders = await storage.customProviders.getAll();
	return customProviders.find((provider) => provider.name === providerName);
}

async function getAvailableProviderNames(): Promise<string[]> {
	const providers = new Set<string>();

	for (const provider of await storage.providerKeys.list()) {
		const key = await storage.providerKeys.get(provider);
		if (key) providers.add(provider);
	}

	for (const provider of await storage.customProviders.getAll()) {
		const hasModels = (provider.models?.length || 0) > 0;
		if (hasModels || provider.apiKey) {
			providers.add(provider.name);
		}
	}

	return [...providers];
}

async function getApiKeyForProvider(providerName: string): Promise<string | undefined> {
	const stored = await storage.providerKeys.get(providerName);
	if (stored) {
		const proxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
		const proxyUrl = proxyEnabled ? (await storage.settings.get<string>("proxy.url")) || undefined : undefined;
		return resolveApiKey(stored, providerName, storage.providerKeys, proxyUrl);
	}

	const customProvider = await getCustomProviderByName(providerName);
	return customProvider?.apiKey;
}

async function selectDefaultModelForAvailableProvider() {
	const providers = await getAvailableProviderNames();
	if (providers.length === 0 || !agent) return;

	// Try each provider with keys and find a default model
	for (const provider of providers) {
		const modelId = DEFAULT_MODELS[provider];
		if (modelId) {
			const model = getModel(provider as any, modelId);
			if (model) {
				agent.setModel(model);
				await storage.settings.set("lastUsedModel", model);
				await updateAuthLabel();
				renderApp();
				return;
			}
		}
	}

	// If no default found, try the first model for the first available provider
	for (const provider of providers) {
		const models = getModels(provider as any);
		if (models.length > 0) {
			agent.setModel(models[0]);
			await storage.settings.set("lastUsedModel", models[0]);
			await updateAuthLabel();
			renderApp();
			return;
		}

		const customProvider = await getCustomProviderByName(provider);
		const customModel = customProvider?.models?.[0];
		if (customModel) {
			agent.setModel(customModel);
			await storage.settings.set("lastUsedModel", customModel);
			await updateAuthLabel();
			renderApp();
			return;
		}
	}
}

async function getProvidersWithKeys(): Promise<string[]> {
	return getAvailableProviderNames();
}

async function hasAnyApiKey(): Promise<boolean> {
	const providers = await getAvailableProviderNames();
	return providers.length > 0;
}

function openApiKeysDialog(): Promise<void> {
	return new Promise((resolve) => {
		SettingsDialog.open(
			[
				new ProvidersModelsTab(),
				new ApiKeysOAuthTab(),
				new CostsTab(),
				new SkillsTab(),
				new BridgeTab(),
				new AboutTab(),
			],
			resolve,
		);
	});
}

async function updateAuthLabel() {
	if (!agent) {
		authLabel = "";
		return;
	}
	const provider = agent.state.model.provider;
	const stored = await storage.providerKeys.get(provider);
	if (stored) {
		authLabel = isOAuthCredentials(stored) ? "subscription" : "api key";
		return;
	}

	const customProvider = await getCustomProviderByName(provider);
	authLabel = customProvider?.apiKey ? "api key" : customProvider ? "custom" : "";
}

// Export getter for message transformer
export function getShownSkills(): Map<string, string> {
	return shownSkills;
}

// ============================================================================
// HELPERS
// ============================================================================
const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user" || m.role === "user-with-attachments");
	if (!firstUserMsg || (firstUserMsg.role !== "user" && firstUserMsg.role !== "user-with-attachments")) return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c) => c.type === "text");
		text = textBlocks.map((c) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	const hasUserMsg = messages.some((m: AgentMessage) => m.role === "user" || m.role === "user-with-attachments");
	const hasAssistantMsg = messages.some((m: AgentMessage) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent) return;

	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;

	try {
		// Calculate cumulative usage from all assistant messages
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		for (const msg of state.messages) {
			if (msg.role === "assistant") {
				usage.input += msg.usage.input;
				usage.output += msg.usage.output;
				usage.cacheRead += msg.usage.cacheRead;
				usage.cacheWrite += msg.usage.cacheWrite;
				usage.totalTokens += msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
				if (msg.usage.cost) {
					usage.cost.input += msg.usage.cost.input;
					usage.cost.output += msg.usage.cost.output;
					usage.cost.cacheRead += msg.usage.cost.cacheRead;
					usage.cost.cacheWrite += msg.usage.cost.cacheWrite;
					usage.cost.total += msg.usage.cost.total;
				}
			}
		}

		// Generate preview text (first 2KB of user + assistant text)
		let preview = "";
		for (const msg of state.messages) {
			if (preview.length >= 2048) break;
			if (msg.role === "user") {
				const text =
					typeof msg.content === "string"
						? msg.content
						: msg.content
								.filter((c) => c.type === "text")
								.map((c) => c.text)
								.join("\n") || "";
				preview += `${text}\n`;
			} else if (msg.role === "assistant") {
				const text = msg.content
					.filter((c) => c.type === "text" || c.type === "thinking")
					.map((c) => (c.type === "text" ? c.text : c.thinking))
					.join("\n");
				preview += `${text}\n`;
			}
		}
		preview = preview.substring(0, 2048);

		// Preserve createdAt if session already exists
		const existingMetadata = await storage.sessions.getMetadata(currentSessionId);
		const createdAt = existingMetadata?.createdAt || new Date().toISOString();

		const metadata = {
			id: currentSessionId,
			title: currentTitle,
			createdAt,
			lastModified: new Date().toISOString(),
			messageCount: state.messages.length,
			usage,
			modelId: state.model.id,
			thinkingLevel: state.thinkingLevel,
			preview,
		};

		await storage.sessions.saveSession(currentSessionId, state, metadata, currentTitle);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

const emitSessionBridgeEvent = (event: SessionBridgeEventEnvelope) => {
	for (const listener of sessionBridgeListeners) {
		listener(event);
	}
};

const currentSessionSnapshot = (): SessionSnapshot => {
	const messages = agent?.state.messages || [];
	const projectedMessages = projectSessionMessages(messages);
	return {
		sessionId: currentSessionId,
		persisted: Boolean(currentSessionId),
		title: currentTitle,
		model: agent?.state.model ? { provider: agent.state.model.provider, id: agent.state.model.id } : undefined,
		isStreaming: Boolean(agent?.state.isStreaming),
		messageCount: messages.length,
		lastMessageIndex: messages.length > 0 ? messages.length - 1 : -1,
		messages: projectedMessages,
	};
};

const emitSessionChanged = () => {
	const snapshot = currentSessionSnapshot();
	emitSessionBridgeEvent({
		event: "session_changed",
		data: {
			sessionId: snapshot.sessionId,
			persisted: snapshot.persisted,
			title: snapshot.title,
			model: snapshot.model,
			messageCount: snapshot.messageCount,
			lastMessageIndex: snapshot.lastMessageIndex,
		},
	});
};

const emitSessionMessage = (message: AgentMessage, messageIndex?: number) => {
	const resolvedIndex = messageIndex ?? agent.state.messages.indexOf(message);
	if (resolvedIndex < 0) return;
	const projected = projectSessionMessage(message, resolvedIndex);
	if (!projected) return;
	const snapshot = currentSessionSnapshot();
	emitSessionBridgeEvent({
		event: "session_message",
		data: {
			sessionId: snapshot.sessionId,
			persisted: snapshot.persisted,
			message: projected,
		},
	});
};

const appendInjectedMessage = async (params: SessionInjectParams) => {
	if (!currentSessionId) {
		const error = new Error("No active persisted session");
		(error as Error & { code?: number }).code = ErrorCodes.NO_ACTIVE_SESSION;
		throw error;
	}
	if (params.expectedSessionId !== currentSessionId) {
		const error = new Error("Active session changed");
		(error as Error & { code?: number }).code = ErrorCodes.SESSION_MISMATCH;
		throw error;
	}
	if (agent.state.isStreaming) {
		if (params.waitForIdle === false) {
			const error = new Error("Session is busy");
			(error as Error & { code?: number }).code = ErrorCodes.SESSION_BUSY;
			throw error;
		}
		const waitStartedAt = Date.now();
		await agent.waitForIdle();
		bridgeLog("info", "session injection waited for idle", {
			role: "extension",
			method: "session_inject",
			sessionId: currentSessionId,
			durationMs: Date.now() - waitStartedAt,
			outcome: "success",
		});
	}

	const timestamp = Date.now();
	const message =
		params.role === "assistant"
			? {
					role: "assistant" as const,
					content: [{ type: "text" as const, text: params.content }],
					api: agent.state.model.api,
					provider: agent.state.model.provider,
					model: agent.state.model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp,
				}
			: {
					role: "user" as const,
					content: params.content,
					timestamp,
				};

	agent.appendMessage(message);
	if (!currentTitle && shouldSaveSession(agent.state.messages)) {
		currentTitle = generateTitle(agent.state.messages);
	}
	await saveSession();
	renderApp();
	const messageIndex = agent.state.messages.length - 1;
	emitSessionMessage(message, messageIndex);
	emitSessionChanged();
	return {
		ok: true as const,
		sessionId: currentSessionId,
		messageIndex,
	};
};

const sessionBridgeAdapter: SessionBridgeAdapter = {
	getSnapshot: currentSessionSnapshot,
	waitForIdle: () => agent.waitForIdle(),
	appendInjectedMessage,
	subscribe(listener) {
		sessionBridgeListeners.add(listener);
		return () => sessionBridgeListeners.delete(listener);
	},
};

const createAgent = async (initialState?: Partial<AgentState>, shouldSave = true) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	// Mark all loaded messages as already recorded (by object identity)
	for (const msg of initialState?.messages || []) {
		if (msg.role === "assistant" && msg.usage?.cost?.total > 0) {
			recordedCostMessages.add(msg);
		}
	}

	// Reset skill tracking for new session
	// When loading an old session, we intentionally don't reconstruct shownSkills
	// This ensures that new navigations in the continued session show the LATEST
	// version of skills, even if they were updated since the session was created
	shownSkills.clear();

	// Load debugger mode setting
	const stored = await chrome.storage.local.get("debuggerMode");
	const debuggerModeEnabled = stored.debuggerMode || false;

	// Load CORS proxy settings for extract_document tool
	const corsProxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
	const corsProxyUrl = await storage.settings.get<string>("proxy.url");

	// Determine default model: saved > default for a provider with key > gemini flash fallback
	let defaultModel: Model<any> | undefined;
	if (!initialState?.model) {
		const savedModel = await storage.settings.get<Model<any>>("lastUsedModel");
		if (savedModel) {
			defaultModel = savedModel;
		} else {
			// Try to find a default model for a provider the user already has a key for
			const providersWithKeys = await getProvidersWithKeys();
			for (const provider of providersWithKeys) {
				const modelId = DEFAULT_MODELS[provider];
				if (modelId) {
					const model = getModel(provider as any, modelId);
					if (model) {
						defaultModel = model;
						break;
					}
				}
			}
		}
	}
	// Final fallback
	if (!defaultModel && !initialState?.model) {
		defaultModel = getModel("anthropic", "claude-sonnet-4-6");
	}

	agent = new Agent({
		initialState: initialState || {
			systemPrompt: SYSTEM_PROMPT,
			model: defaultModel,
			thinkingLevel: "medium",
			messages: [],
			tools: [],
		},
		convertToLlm: browserMessageTransformer,
		toolExecution: "sequential",
		streamFn: createStreamFn(async () => {
			const enabled = await storage.settings.get<boolean>("proxy.enabled");
			if (!enabled) return undefined;
			return (await storage.settings.get<string>("proxy.url")) || undefined;
		}),
		getApiKey: async (provider: string) => {
			return getApiKeyForProvider(provider);
		},
	});

	await updateAuthLabel();

	if (shouldSave) {
		agentUnsubscribe = agent.subscribe((event: AgentEvent) => {
			const messages = agent.state.messages;

			if (event.type === "agent_start") {
				emitSessionBridgeEvent({
					event: "session_run_state",
					data: { sessionId: currentSessionId, state: "started" },
				});
			}

			if (event.type === "agent_end") {
				emitSessionBridgeEvent({
					event: "session_run_state",
					data: { sessionId: currentSessionId, state: "idle" },
				});
			}

			if (event.type === "message_end") {
				emitSessionMessage(event.message);
			}

			if (
				event.type === "tool_execution_start" ||
				event.type === "tool_execution_update" ||
				event.type === "tool_execution_end"
			) {
				emitSessionBridgeEvent({
					event: "session_tool",
					data: {
						sessionId: currentSessionId,
						phase:
							event.type === "tool_execution_start"
								? "start"
								: event.type === "tool_execution_update"
									? "update"
									: "end",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						isError: event.type === "tool_execution_end" ? event.isError : undefined,
						summary:
							event.type === "tool_execution_start"
								? summarizeForBridge(event.args)
								: event.type === "tool_execution_update"
									? summarizeForBridge(event.partialResult)
									: summarizeForBridge(event.result),
					},
				});
			}

			storage.settings
				.set("lastUsedModel", agent.state.model)
				.catch((err) => console.error("Failed to save lastUsedModel:", err));

			// Update auth label when model changes
			updateAuthLabel().catch(() => {});

			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				event.message.usage?.cost?.total > 0
			) {
				if (!recordedCostMessages.has(event.message)) {
					recordedCostMessages.add(event.message);
					storage.costs
						.recordCost(agent.state.model.provider, agent.state.model.id, event.message.usage.cost.total)
						.catch((err) => console.error("Failed to record cost:", err));
				}
			}

			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
				emitSessionChanged();
			}

			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = crypto.randomUUID();

				port
					.sendMessage({
						type: "acquireLock",
						sessionId: currentSessionId,
						windowId: currentWindowId,
					})
					.then((lockResponse) => {
						if (!lockResponse.success) {
							console.warn("Failed to acquire lock for newly created session", currentSessionId);
						}
					});
				updateUrl(currentSessionId);
				emitSessionChanged();
				void syncBridgeConnection();
			}

			if (currentSessionId) {
				saveSession();
			}

			if (event.type === "message_end" || event.type === "agent_end") {
				emitSessionChanged();
			}

			renderApp();
		});
	}

	await chatPanel.setAgent(agent, {
		sandboxUrlProvider: () => {
			return chrome.runtime.getURL("sandbox.html");
		},
		onApiKeyRequired: async (provider: string) => {
			const customProvider = await getCustomProviderByName(provider);
			if (customProvider) {
				await openApiKeysDialog();
				return Boolean((await getCustomProviderByName(provider))?.apiKey);
			}
			return await ApiKeyOrOAuthDialog.prompt(provider);
		},
		onModelSelect: async () => {
			const providers = await getAvailableProviderNames();
			if (providers.length === 0) {
				openApiKeysDialog();
				return;
			}
			ModelSelector.open(
				agent.state.model,
				(model) => {
					agent.setModel(model);
					chatPanel.agentInterface?.requestUpdate();
					updateAuthLabel().catch(() => {});
					emitSessionChanged();
					renderApp();
				},
				providers,
			);
		},
		onBeforeSend: async () => {
			if (!agent) return;

			// Get current tab info
			const [tab] = await chrome.tabs.query({
				active: true,
				currentWindow: true,
			});
			if (!tab?.url || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("moz-extension://")) return;

			// Find most recent navigation (either nav message or nav tool result)
			let lastUrl: string | undefined;
			for (let i = agent.state.messages.length - 1; i >= 0; i--) {
				const msg = agent.state.messages[i];
				if (msg.role === "navigation") {
					lastUrl = (msg as NavigationMessage).url;
					break;
				}
				if (msg.role === "toolResult" && (msg as any).toolName === "navigate") {
					lastUrl = (msg as any).details?.finalUrl;
					break;
				}
			}

			// Only add if URL changed
			if (!lastUrl || lastUrl !== tab.url) {
				const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
				agent.appendMessage(navMessage);
				emitSessionMessage(navMessage, agent.state.messages.length - 1);
				emitSessionChanged();
			}
		},
		onCostClick: () => {
			if (!agent) return;
			SessionCostDialog.open(agent.state.messages);
		},
		toolsFactory: (_agent, _agentInterface, _artifactsPanel, runtimeProvidersFactory) => {
			const navigateTool = new NavigateTool();
			const selectElementTool = new AskUserWhichElementTool();

			// Create extract_document tool with CORS proxy from settings (loaded above)
			const extractDocumentTool = createExtractDocumentTool();
			if (corsProxyEnabled && corsProxyUrl) {
				extractDocumentTool.corsProxyUrl = `${corsProxyUrl}/?url=`;
			}

			const replTool = createReplTool();
			replTool.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");

			// Extend base providers with browser orchestration capabilities
			replTool.runtimeProvidersFactory = () => {
				// Providers that should be available in page context via browserjs()
				const pageProviders = [
					...runtimeProvidersFactory(), // attachments + artifacts from ChatPanel
					new NativeInputEventsRuntimeProvider(), // trusted browser events
				];

				return [
					...pageProviders, // Make them available in REPL context too
					new BrowserJsRuntimeProvider(pageProviders), // Pass to page context
					new NavigateRuntimeProvider(navigateTool),
				];
			};

			const extractImageTool = new ExtractImageTool();
			extractImageTool.windowId = currentWindowId;

			const tools: AgentTool<any, any>[] = [
				navigateTool,
				selectElementTool,
				replTool,
				skillTool,
				extractDocumentTool,
				extractImageTool,
			];

			// Conditionally add debugger tool if enabled
			if (debuggerModeEnabled) {
				const debuggerTool = new DebuggerTool();
				tools.push(debuggerTool);
			}

			return tools;
		},
	});

	// Register custom message renderers after agentInterface is available
	if (chatPanel.agentInterface) {
		registerWelcomeRenderer(agent, chatPanel.agentInterface);

		// Only disable auto-scroll for new sessions with welcome message
		// Check if this is a fresh session (only has welcome message, no user messages)
		const hasUserMessage = agent.state.messages.some((m) => m.role === "user");
		if (!hasUserMessage) {
			chatPanel.agentInterface.setAutoScroll(false);

			// Re-enable auto-scroll on first user message
			let unsubscribe: (() => void) | undefined;
			unsubscribe = agent.subscribe(() => {
				const hasUserMsg = agent.state.messages.some((m) => m.role === "user");
				if (hasUserMsg && unsubscribe) {
					chatPanel.agentInterface?.setAutoScroll(true);
					unsubscribe();
				}
			});
		}
	}
};

const loadSession = (sessionId: string) => {
	// Navigation will disconnect port and auto-release locks
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.location.href = url.toString();
};

const newSession = () => {
	// Navigation will disconnect port and auto-release locks
	const url = new URL(window.location.href);
	url.search = "?new=true";
	window.location.href = url.toString();
};

// ============================================================================
// RENDER
// ============================================================================
const renderApp = () => {
	const appHtml = html`
		<div class="w-full h-full flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-3 py-2">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => {
							SitegeistSessionListDialog.open(
								(sessionId: string) => {
									loadSession(sessionId);
								},
								(deletedSessionId: string) => {
									// Only reload if the current session was deleted
									if (deletedSessionId === currentSessionId) {
										newSession();
									}
								},
							);
						},
						title: "Sessions",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Plus, "sm"),
						onClick: newSession,
						title: "New Session",
					})}

					${
						currentTitle
							? isEditingTitle
								? html`<div class="flex items-center gap-2">
									${Input({
										type: "text",
										value: currentTitle,
										className: "text-sm w-48",
										/*
										TODO need to add this in Input in mini-lit
										onBlur: async (e: Event) => {
											const newTitle = (e.target as HTMLInputElement).value.trim();
											if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
												await storage.sessions.updateTitle(currentSessionId, newTitle);
												currentTitle = newTitle;
											}
											isEditingTitle = false;
											renderApp();
										},*/
										onKeyDown: async (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
													await storage.sessions.updateTitle(currentSessionId, newTitle);
													currentTitle = newTitle;
													emitSessionChanged();
												}
												isEditingTitle = false;
												renderApp();
											} else if (e.key === "Escape") {
												isEditingTitle = false;
												renderApp();
											}
										},
									})}
								</div>`
								: html`<button
									class="px-2 py-1 text-xs text-foreground hover:bg-secondary rounded transition-colors truncate max-w-[150px]"
									@click=${() => {
										isEditingTitle = true;
										renderApp();
										requestAnimationFrame(() => {
											const input = document.body.querySelector('input[type="text"]') as HTMLInputElement;
											if (input) {
												input.focus();
												input.select();
											}
										});
									}}
									title="Click to edit title"
								>
									${currentTitle}
								</button>`
							: html``
					}
				</div>
				<div class="flex items-center gap-1 px-2">
					${agent ? html`<span class="text-[10px] text-muted-foreground truncate max-w-[120px]" title="${agent.state.model.provider}/${agent.state.model.id}${authLabel ? ` (${authLabel})` : ""}">${agent.state.model.provider}${authLabel ? html` <span class="text-[9px] opacity-70">${authLabel}</span>` : ""}</span>` : ""}
					${
						bridgeClient.connectionState === "connected"
							? html`<span class="w-2 h-2 rounded-full bg-green-500" title="Bridge connected"></span>`
							: bridgeClient.connectionState === "connecting"
								? html`<span class="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" title="Bridge connecting..."></span>`
								: bridgeClient.connectionState === "error"
									? html`<span class="w-2 h-2 rounded-full bg-red-500" title="Bridge error: ${bridgeClient.connectionDetail || "unknown"}"></span>`
									: bridgeClient.connectionState === "disconnected"
										? html`<span class="w-2 h-2 rounded-full bg-gray-500" title="Bridge disconnected"></span>`
										: html``
					}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () =>
							SettingsDialog.open([
								new ProvidersModelsTab(),
								new ApiKeysOAuthTab(),
								new CostsTab(),
								new SkillsTab(),
								new BridgeTab(),
								new AboutTab(),
							]),
						title: "Settings",
					})}
				</div>
			</div>

			<!-- Chat Panel -->
			${chatPanel}
		</div>
	`;

	render(appHtml, document.body);
};

// ============================================================================
// TAB NAVIGATION TRACKING
// ============================================================================

// Listen for tab updates and insert navigation messages only when agent is running
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
	if (tab.active && tab.windowId === currentWindowId && (changeInfo.url || changeInfo.title) && tab.url) {
		bridgeClient.sendEvent("active_tab_changed", {
			url: tab.url,
			title: tab.title || "",
			tabId: tab.id,
		});
	}

	// Only care about URL changes on the active tab while agent is working
	// Ignore chrome-extension:// URLs (extension internal pages)
	// Ignore tool-initiated navigations (handled by the navigate tool itself)
	// Ignore tabs from other windows
	if (
		changeInfo.url &&
		tab.active &&
		tab.url &&
		tab.windowId === currentWindowId &&
		agent?.state.isStreaming &&
		!tab.url.startsWith("chrome-extension://") &&
		!tab.url.startsWith("moz-extension://") &&
		!isToolNavigating()
	) {
		const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
		agent.steer(navMessage);
		console.log("Queued navigation message for tab switch to", tab.url);
	}
});

// Listen for tab activation (user switches tabs) only when agent is running
chrome.tabs.onActivated.addListener(async (activeInfo) => {
	// Ignore tab activations from other windows
	if (activeInfo.windowId !== currentWindowId) return;

	const tab = await chrome.tabs.get(activeInfo.tabId);

	// Notify bridge of tab change
	if (tab.url) {
		bridgeClient.sendEvent("active_tab_changed", {
			url: tab.url,
			title: tab.title || "",
			tabId: tab.id,
		});
	}

	// Ignore chrome-extension:// URLs (extension internal pages)
	// Ignore tool-initiated navigations (handled by the navigate tool itself)
	if (
		tab.url &&
		agent?.state.isStreaming &&
		!tab.url.startsWith("chrome-extension://") &&
		!tab.url.startsWith("moz-extension://") &&
		!isToolNavigating()
	) {
		const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
		agent.steer(navMessage);
		console.log("Queued navigation message for tab switch to", tab.url);
	}
});

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================
window.addEventListener(
	"keydown",
	(e) => {
		// Escape key to abort streaming - works globally in sidepanel
		// Use capturing phase to intercept before MessageEditor handles it
		if (e.key === "Escape" && agent?.state.isStreaming) {
			e.preventDefault();
			e.stopPropagation();
			agent.abort();
		}

		// Cmd+U (Mac) or Ctrl+U (Windows/Linux) to open debug page
		if ((e.metaKey || e.ctrlKey) && e.key === "u") {
			e.preventDefault();
			window.location.href = "./debug.html";
		}

		// Cmd+Shift+K (Mac) or Ctrl+Shift+K (Windows/Linux) to show session costs
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
			e.preventDefault();
			if (agent?.state.messages && agent.state.messages.length > 0) {
				SessionCostDialog.open(agent.state.messages);
			}
		}
	},
	true,
); // Use capture phase to intercept Escape before it reaches MessageEditor

// ============================================================================
// TEST STEPS FROM DEBUGGER.TS
// ============================================================================
async function testSteps(): Promise<boolean> {
	const urlParams = new URLSearchParams(window.location.search);
	const testStepsParam = urlParams.get("teststeps");
	const testProvider = urlParams.get("provider");
	const testModel = urlParams.get("model");

	if (!testStepsParam) return false;

	// Handle test prompts - create temporary session without saving
	try {
		const testSteps = JSON.parse(decodeURIComponent(testStepsParam)) as string[];

		// Set model if specified
		let initialState: Partial<AgentState> | undefined;
		if (testProvider && testModel) {
			const model = getModel(testProvider as any, testModel);
			if (model) {
				initialState = {
					systemPrompt: SYSTEM_PROMPT,
					model,
				};
			}
		}

		await createAgent(initialState, false);
		renderApp();

		// Wait for UI to render
		await new Promise((resolve) => requestAnimationFrame(resolve));

		// Submit prompts sequentially
		for (let i = 0; i < testSteps.length; i++) {
			const step = testSteps[i];
			if (!chatPanel?.agentInterface) break;

			// Send the prompt
			await chatPanel.agentInterface.sendMessage(step);

			// Wait for agent to finish (not streaming anymore)
			if (i < testSteps.length - 1) {
				// Wait for response to complete before sending next step
				await new Promise<void>((resolve) => {
					const checkComplete = () => {
						if (!chatPanel.agent?.state.isStreaming) {
							resolve();
						} else {
							setTimeout(checkComplete, 100);
						}
					};
					checkComplete();
				});
			}
		}
		return true;
	} catch (err) {
		console.error("Failed to run test steps:", err);
		return false;
	}
}

// ============================================================================
// UPDATE CHECK
// ============================================================================
function isNewerVersion(latest: string, current: string): boolean {
	const latestParts = latest.split(".").map(Number);
	const currentParts = current.split(".").map(Number);

	for (let i = 0; i < Math.max(latestParts.length, currentParts.length); i++) {
		const l = latestParts[i] || 0;
		const c = currentParts[i] || 0;
		if (l > c) return true;
		if (l < c) return false;
	}
	return false;
}

async function checkForUpdates() {
	try {
		const currentVersion = chrome.runtime.getManifest().version;

		// Fetch latest version
		const response = await fetch("https://sitegeist.ai/uploads/version.json", {
			cache: "no-cache",
		});
		const data = await response.json();
		const latestVersion = data.version;

		// Show dialog only if server version is newer than current version
		if (isNewerVersion(latestVersion, currentVersion)) {
			// Show update dialog - blocks until extension is updated and restarted
			await UpdateNotificationDialog.show(latestVersion);
		}
	} catch (err) {
		console.warn("[Sidepanel] Failed to check for updates:", err);
		// Silently fail - don't block startup
	}
}

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
	// Show loading
	render(
		html`
			<div class="w-full h-full flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Loading...</div>
			</div>
		`,
		document.body,
	);

	// Load showJsonMode setting
	const stored = await chrome.storage.local.get("showJsonMode");
	const showJsonModeEnabled = (stored.showJsonMode as boolean) || false;
	setShowJsonMode(showJsonModeEnabled);

	// Get current window ID for filtering tab events
	const currentWindow = await chrome.windows.getCurrent();
	if (!currentWindow.id) {
		throw new Error("Failed to get current window ID");
	}
	currentWindowId = currentWindow.id;

	// Initialize port communication system
	port.initialize(currentWindowId);

	// TODO reenable Request persistent storage
	// if (storage.sessions) {
	// 	await PersistentStorageDialog.request();
	// }

	// Request userScripts permission if not available
	if (!chrome.userScripts) {
		await UserScriptsPermissionDialog.request();
	}

	// TODO: re-enable update check when publishing to users
	// await checkForUpdates();

	// Initialize default skills
	const { initializeDefaultSkills } = await import("./tools/skill.js");
	await initializeDefaultSkills();

	// Proxy disabled — CORS is handled locally via declarativeNetRequest rules
	await storage.settings.set("proxy.enabled", false);

	setBridgeSettingsChangeCallback(() => {
		void syncBridgeConnection();
	});

	await syncBridgeConnection();

	// Create ChatPanel
	chatPanel = new ChatPanel();

	// Handle test steps
	if (await testSteps()) {
		return;
	}

	// Check for session in URL
	const urlParams = new URLSearchParams(window.location.search);
	let sessionIdFromUrl = urlParams.get("session");
	const isNewSession = urlParams.get("new") === "true";

	// If no session in URL and not explicitly creating new, try to load the most recent session
	if (!sessionIdFromUrl && !isNewSession && storage.sessions) {
		const latestSessionId = await storage.sessions.getLatestSessionId();
		if (latestSessionId) {
			// Try to acquire lock for latest session
			const lockResponse = await port.sendMessage({
				type: "acquireLock",
				sessionId: latestSessionId,
				windowId: currentWindowId,
			});

			if (lockResponse.success) {
				sessionIdFromUrl = latestSessionId;
				// Update URL to include the latest session
				updateUrl(latestSessionId);
			}
			// If lock fails, fall through to create new session
		}
	}

	if (sessionIdFromUrl && storage.sessions) {
		const sessionData = await storage.sessions.loadSession(sessionIdFromUrl);
		if (sessionData) {
			// Try to acquire lock if we don't already have it (in case user navigated directly via URL)
			const lockResponse = await port.sendMessage({
				type: "acquireLock",
				sessionId: sessionIdFromUrl,
				windowId: currentWindowId,
			});

			if (!lockResponse.success) {
				// Session is locked in another window - show landing page instead
				await createAgent();
				if (agent) {
					const welcomeMessage = createWelcomeMessage(tutorials);
					agent.appendMessage(welcomeMessage);
				}
				renderApp();
				return;
			}

			currentSessionId = sessionIdFromUrl;
			await syncBridgeConnection();
			const metadata = await storage.sessions.getMetadata(sessionIdFromUrl);
			currentTitle = metadata?.title || "";
			emitSessionChanged();

			await createAgent({
				systemPrompt: SYSTEM_PROMPT,
				model: sessionData.model,
				thinkingLevel: sessionData.thinkingLevel,
				messages: sessionData.messages,
				tools: [],
			});

			renderApp();
			return;
		} else {
			// Session doesn't exist, redirect to new session
			newSession();
			return;
		}
	}

	// No session - create new agent with welcome message
	await createAgent();

	// Add welcome message for new sessions
	if (agent) {
		const welcomeMessage = createWelcomeMessage(tutorials);
		agent.appendMessage(welcomeMessage);
	}

	emitSessionChanged();
	renderApp();

	// If no API keys configured, show welcome dialog, open settings, then auto-select model
	if (!(await hasAnyApiKey())) {
		await WelcomeSetupDialog.show();
		await openApiKeysDialog();
		await selectDefaultModelForAvailableProvider();
		renderApp();
	}
}

// Register custom user message renderer early, before any session loads
registerUserMessageRenderer();

initApp();
