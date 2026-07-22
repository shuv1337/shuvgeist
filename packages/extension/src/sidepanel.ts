import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import type { AgentMessage } from "@shuv1337/pi-agent-core";
import { type Api, type Model, registerModels } from "@shuv1337/pi-ai";
import {
	ChatPanel,
	ModelSelector,
	SettingsDialog,
	// PersistentStorageDialog,
	setAppStorage,
	setShowJsonMode,
} from "@shuv1337/pi-web-ui";
import type { ElementInfo } from "@shuvgeist/driver/injected-contracts";
import { html, render } from "lit";
import { Crosshair, History, Plus, Settings, Volume2 } from "lucide";
import { ChromeRuntimeSessionTransport } from "./agent/chrome-runtime-session-transport.js";
import { modelToRuntimeDescriptor } from "./agent/provider-runtime.js";
import { asPiWebUiAgent, RemoteAgentFacade } from "./agent/remote-agent-facade.js";
import { RemoteSessionClient } from "./agent/remote-session-client.js";
import { runtimeClientRouteKey, sameRuntimeTarget } from "./agent/runtime-identity.js";
import type {
	RuntimeAgentMessage,
	RuntimeArtifactDescriptor,
	RuntimeSessionSnapshot,
	RuntimeTargetIdentity,
	RuntimeThinkingLevel,
	RuntimeValue,
} from "./agent/runtime-protocol.js";
import {
	confirmSidepanelWindowIdentity,
	isSidepanelCapabilityMaterial,
	planSidepanelDocumentBootstrap,
	prepareSidepanelWindowIdentity,
	type SidepanelCapabilityMaterial,
	type SidepanelResolvedIdentity,
	type SidepanelWindowAuthorityMessenger,
} from "./agent/sidepanel-context-identity.js";
import type { AgentRuntimeConnectionDescriptor, BridgeStateData } from "./bridge/internal-messages.js";
import { BRIDGE_RUNTIME_STATE_KEYS, readBridgeRuntimeState } from "./bridge/runtime-state.js";
import { Toast } from "./components/Toast.js";
import { ApiKeyOrOAuthDialog } from "./dialogs/ApiKeyOrOAuthDialog.js";
import { SessionCostDialog } from "./dialogs/SessionCostDialog.js";
import { ShuvgeistSessionListDialog } from "./dialogs/SessionListDialog.js";
import { createSettingsTabs, type SettingsInitialTab } from "./dialogs/settings-tabs.js";
import { UpdateNotificationDialog } from "./dialogs/UpdateNotificationDialog.js";
import { UserScriptsPermissionDialog } from "./dialogs/UserScriptsPermissionDialog.js";
import { WelcomeSetupDialog } from "./dialogs/WelcomeSetupDialog.js";
import { registerNavigationRenderer } from "./messages/NavigationMessage.js";
import { registerUserMessageRenderer } from "./messages/UserMessageRenderer.js";
import { registerWelcomeRenderer } from "./messages/WelcomeMessage.js";
import {
	isOAuthCredentials,
	parseProviderCredential,
	resolveApiKey,
	serializeFreeTierCredential,
} from "./oauth/index.js";
import { SYSTEM_PROMPT } from "./prompts/prompts.js";
import {
	BUNDLED_FREE_TIER_KEY,
	BUNDLED_FREE_TIER_PROVIDER,
	createBundledFreeTierProvider,
} from "./providers/free-tier.js";
import { ArtifactHydrationQueue } from "./sidepanel/artifact-hydration-queue.js";
import {
	normalizeModelForRuntime,
	resolveDefaultModel,
	resolveModelSpec as resolveModelSpecFromSources,
	resolveProviderCredential,
} from "./sidepanel/model-resolution.js";
import { detachRemotePresentation, selectRemoteDescriptor } from "./sidepanel/remote-session-policy.js";
import { generateSessionTitle, shouldSaveSession } from "./sidepanel/session-metadata.js";
import { ShuvgeistAppStorage } from "./storage/app-storage.js";
import { loadDeveloperSettings } from "./storage/developer-settings.js";
import { loadProxySettings, setProxyEnabled } from "./storage/persistent-settings.js";
import { registerAskUserWhichElementRenderer } from "./tools/ask-user-which-element-renderer.js";
import { registerExtractImageRenderer } from "./tools/extract-image-renderer.js";
import { isProtectedTabUrl, resolveTabTarget } from "./tools/helpers/browser-target.js";
import { elementToAttachment } from "./tools/helpers/element-attachment.js";
import { registerReplRenderer } from "./tools/repl/repl-renderer.js";
import { checkUserScriptsAvailability } from "./tools/repl/userscripts-helpers.js";
import { initializeDefaultSkills } from "./tools/skill.js";
import { registerSkillRenderer } from "./tools/skill-renderer.js";
import * as port from "./utils/port.js";
import "./utils/i18n-extension.js";
import "./utils/live-reload.js";
import { tutorials } from "./tutorials.js";

// Register custom tool renderers
registerNavigationRenderer();
registerExtractImageRenderer();
registerAskUserWhichElementRenderer();
registerSkillRenderer();
registerReplRenderer();

// ============================================================================
// STORAGE SETUP
// ============================================================================
const storage = new ShuvgeistAppStorage();
setAppStorage(storage);

// ============================================================================
// APP STATE
// ============================================================================
let currentSessionId: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: RemoteAgentFacade | undefined;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
let stateUnsubscribe: (() => void) | undefined;
let remoteTransport: ChromeRuntimeSessionTransport | undefined;
let remoteClient: RemoteSessionClient | undefined;
let remoteGeneration = 0;
const artifactHydrationQueue = new ArtifactHydrationQueue();
let currentWindowId: number;
let currentDocumentNonce: string;
let currentContinuationToken: string;
let currentTransactionId: string;
let currentLeaseId: string;
const SIDEPANEL_AGENT_CLIENT_ID = "sidepanel";
const SIDEPANEL_CONTINUATION_SESSION_KEY = "shuvgeist.sidepanelContinuation.v1";

interface StoredSidepanelCapability extends SidepanelCapabilityMaterial {
	stage: "pending" | "active";
}

function readStoredSidepanelCapability(): StoredSidepanelCapability | undefined {
	const value = window.sessionStorage.getItem(SIDEPANEL_CONTINUATION_SESSION_KEY);
	if (value === null) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const record = parsed as Record<string, unknown>;
			const material = {
				continuationToken: record.continuationToken,
				transactionId: record.transactionId,
				leaseId: record.leaseId,
			};
			if (
				Object.keys(record).length === 4 &&
				(record.stage === "pending" || record.stage === "active") &&
				isSidepanelCapabilityMaterial(material)
			) {
				return { stage: record.stage, ...material };
			}
		}
	} catch {
		// Malformed local continuation material is discarded below.
	}
	window.sessionStorage.removeItem(SIDEPANEL_CONTINUATION_SESSION_KEY);
	return undefined;
}

function storeSidepanelCapability(
	stage: StoredSidepanelCapability["stage"],
	material: SidepanelCapabilityMaterial,
): void {
	window.sessionStorage.setItem(SIDEPANEL_CONTINUATION_SESSION_KEY, JSON.stringify({ stage, ...material }));
}

/** Cached bridge connection state read from chrome.storage.session. */
let cachedBridgeState: BridgeStateData = { state: "disabled" };

// Cached auth type label for the current provider
let authLabel = "";

// Fireworks is an OpenAI-completions-compatible provider. pi-ai has no built-in
// KnownProvider for Fireworks, so we register models at runtime. This mirrors
// MINIMAX_EXTENSION_MODELS below.
//
// Fireworks recommends an `x-session-affinity` header so a single
// conversation sticks to the same backend replica (keeps prefix caches warm).
// In pi-cli this is generated per request via `!uuidgen`, but shuvgeist's
// model registry only supports static headers. Generating one UUID per
// browser session is a good middle ground: the whole chat stays on one
// replica without leaking UUIDs across sessions.
const FIREWORKS_SESSION_AFFINITY =
	typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: Math.random().toString(36).slice(2) + Date.now().toString(36);

const FIREWORKS_EXTENSION_MODELS: Model<"openai-completions">[] = [
	{
		id: "accounts/fireworks/routers/kimi-k2p6-turbo",
		name: "Kimi K2.6 Turbo (Fireworks)",
		api: "openai-completions",
		provider: "fireworks",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: 0.6,
			output: 3,
			cacheRead: 0.1,
			cacheWrite: 0,
		},
		contextWindow: 262144,
		maxTokens: 32768,
		headers: {
			"x-session-affinity": FIREWORKS_SESSION_AFFINITY,
		},
		compat: {
			maxTokensField: "max_tokens",
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: true,
		},
	},
];

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

registerModels(FIREWORKS_EXTENSION_MODELS);
registerModels(MINIMAX_EXTENSION_MODELS);

async function getCustomProviderByName(providerName: string) {
	const customProviders = await storage.customProviders.getAll();
	return customProviders.find((provider) => provider.name === providerName);
}

function getModelResolutionSources() {
	return {
		getCustomProviderByName,
		getAllCustomProviders: () => storage.customProviders.getAll(),
	};
}

async function getAvailableProviderNames(): Promise<string[]> {
	const providers = new Set<string>();

	for (const provider of await storage.providerKeys.list()) {
		const key = await storage.providerKeys.get(provider);
		if (key) providers.add(provider);
	}

	for (const provider of await storage.customProviders.getAll()) {
		const hasModels = (provider.models?.length || 0) > 0;
		const hasCredentials = Boolean(provider.apiKey || (await storage.providerKeys.get(provider.name)));
		if (hasModels || hasCredentials) {
			providers.add(provider.name);
		}
	}

	return [...providers];
}

async function getApiKeyForProvider(providerName: string): Promise<string | undefined> {
	const credential = await resolveProviderCredential(providerName, {
		getStoredProviderKey: async (provider) => (await storage.providerKeys.get(provider)) || undefined,
		getCustomProviderByName,
		resolveStoredCredential: async (stored, provider) => {
			const proxy = await loadProxySettings();
			return resolveApiKey(stored, provider, storage.providerKeys, proxy.enabled ? proxy.url : undefined);
		},
	});
	return credential?.apiKey;
}

async function selectDefaultModelForAvailableProvider() {
	const providers = await getAvailableProviderNames();
	if (providers.length === 0 || !agent) return;

	const model = await resolveDefaultModel(providers, getModelResolutionSources());
	if (!model) return;
	await agent.setModel(modelToRuntimeDescriptor(normalizeModelForRuntime(model)));
	await updateAuthLabel();
	renderApp();
}

async function enableBundledFreeTier() {
	await storage.customProviders.set(createBundledFreeTierProvider());
	await storage.providerKeys.set(BUNDLED_FREE_TIER_PROVIDER, serializeFreeTierCredential(BUNDLED_FREE_TIER_KEY));
	await selectDefaultModelForAvailableProvider();
}

async function hasAnyApiKey(): Promise<boolean> {
	const providers = await getAvailableProviderNames();
	return providers.length > 0;
}

function openApiKeysDialog(initialTab: SettingsInitialTab = "providers"): Promise<void> {
	return new Promise((resolve) => {
		SettingsDialog.open(createSettingsTabs(initialTab), resolve);
	});
}

async function updateAuthLabel() {
	const model = agent?.state.model;
	if (!model) {
		authLabel = "";
		return;
	}
	const provider = model.provider;
	const stored = await storage.providerKeys.get(provider);
	if (stored) {
		const credential = parseProviderCredential(stored);
		authLabel =
			credential.kind === "free-tier" ? "free tier" : isOAuthCredentials(stored) ? "subscription" : "api key";
		return;
	}

	const customProvider = await getCustomProviderByName(provider);
	authLabel = customProvider?.apiKey ? "api key" : customProvider ? "custom" : "";
}

// ============================================================================
// HELPERS
// ============================================================================
const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	url.searchParams.delete("new");
	window.history.replaceState({}, "", url);
};

/**
 * Resolve a model spec string like "anthropic/claude-sonnet-4-6" or "gpt-4o"
 * into a Model object, checking built-in models and custom providers.
 */
const resolveModelSpec = async (spec: string, providerHint?: string): Promise<Model<Api>> => {
	return resolveModelSpecFromSources(spec, providerHint, {
		getCustomProviderByName,
		getAllCustomProviders: () => storage.customProviders.getAll(),
	});
};

interface RemoteSessionStartOptions {
	sessionId: string;
	mode: "create" | "load";
	model?: Model<Api>;
	thinkingLevel?: RuntimeThinkingLevel;
	initialMessages?: RuntimeAgentMessage[];
}

interface RemoteSessionBinding {
	transport: ChromeRuntimeSessionTransport;
	client: RemoteSessionClient;
	facade: RemoteAgentFacade;
}

function sidepanelTarget(windowId: number): RuntimeTargetIdentity {
	return { kind: "chrome-tab", tabRef: `window:${windowId}` };
}

function descriptorRegistryKey(windowId: number): string {
	return runtimeClientRouteKey(SIDEPANEL_AGENT_CLIENT_ID, windowId);
}

function buildConnectionDescriptor(options: RemoteSessionStartOptions): AgentRuntimeConnectionDescriptor {
	const model = options.model ? modelToRuntimeDescriptor(normalizeModelForRuntime(options.model)) : undefined;
	return {
		clientId: SIDEPANEL_AGENT_CLIENT_ID,
		windowId: currentWindowId,
		sessionId: options.sessionId,
		target: sidepanelTarget(currentWindowId),
		mode: options.mode,
		systemPrompt: SYSTEM_PROMPT,
		...(model ? { model } : {}),
		...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
		...(options.initialMessages ? { initialMessages: structuredClone(options.initialMessages) } : {}),
	};
}

async function acceptedDescriptorForWindow(): Promise<AgentRuntimeConnectionDescriptor | undefined> {
	const registry = await readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.agentRuntimeConnections);
	return registry?.[descriptorRegistryKey(currentWindowId)];
}

function descriptorBootstrap(descriptor: AgentRuntimeConnectionDescriptor) {
	return descriptor.mode === "load"
		? ({ mode: "load" } as const)
		: ({
				mode: "create",
				systemPrompt: descriptor.systemPrompt,
				...(descriptor.model ? { model: structuredClone(descriptor.model) } : {}),
				...(descriptor.thinkingLevel ? { thinkingLevel: descriptor.thinkingLevel } : {}),
				...(descriptor.initialMessages ? { initialMessages: structuredClone(descriptor.initialMessages) } : {}),
			} as const);
}

function createRemoteBinding(descriptor: AgentRuntimeConnectionDescriptor): RemoteSessionBinding {
	const reportError = (error: unknown) => console.error("[Sidepanel:RemoteAgent]", error);
	const transport = new ChromeRuntimeSessionTransport({
		descriptor,
		documentNonce: currentDocumentNonce,
		continuationToken: currentContinuationToken,
		transactionId: currentTransactionId,
		leaseId: currentLeaseId,
		portFactory: ({ name }) => chrome.runtime.connect({ name }),
		onError: reportError,
	});
	const client = new RemoteSessionClient({
		transport,
		clientId: descriptor.clientId,
		windowId: descriptor.windowId,
		sessionId: descriptor.sessionId,
		target: descriptor.target,
		bootstrap: descriptorBootstrap(descriptor),
		createRequestId: () => crypto.randomUUID(),
		createExecutionId: () => crypto.randomUUID(),
		onError: reportError,
	});
	return { transport, client, facade: new RemoteAgentFacade(client, reportError) };
}

function isRuntimeRecord(value: unknown): value is { [key: string]: RuntimeValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runtimeStringRecordValue(value: RuntimeValue | undefined): value is { [key: string]: string } {
	return isRuntimeRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function runtimeElementInfo(value: RuntimeValue): ElementInfo | undefined {
	if (!isRuntimeRecord(value) || !isRuntimeRecord(value.boundingBox)) return undefined;
	const box = value.boundingBox;
	if (
		typeof value.selector !== "string" ||
		typeof value.xpath !== "string" ||
		typeof value.html !== "string" ||
		typeof value.tagName !== "string" ||
		!runtimeStringRecordValue(value.attributes) ||
		typeof value.text !== "string" ||
		!["x", "y", "width", "height"].every((key) => typeof box[key] === "number" && Number.isFinite(box[key])) ||
		!runtimeStringRecordValue(value.computedStyles) ||
		!Array.isArray(value.parentChain) ||
		!value.parentChain.every((entry) => typeof entry === "string")
	) {
		return undefined;
	}
	return structuredClone(value) as unknown as ElementInfo;
}

function artifactMessagesFromList(result: RuntimeValue): AgentMessage[] {
	if (!isRuntimeRecord(result) || !Array.isArray(result.artifacts)) return [];
	const messages: AgentMessage[] = [];
	for (const value of result.artifacts) {
		if (!isRuntimeRecord(value) || typeof value.filename !== "string" || typeof value.content !== "string") continue;
		messages.push({
			role: "artifact",
			action: "create",
			filename: value.filename,
			content: value.content,
			title: value.filename,
			timestamp:
				typeof value.updatedAt === "string"
					? value.updatedAt
					: typeof value.createdAt === "string"
						? value.createdAt
						: new Date().toISOString(),
		});
	}
	return messages;
}

function queueArtifactHydration(
	facade: RemoteAgentFacade,
	artifacts: readonly RuntimeArtifactDescriptor[],
	generation: number,
	force = false,
): Promise<void> {
	const signature = JSON.stringify([generation, artifacts]);
	const hydration = artifactHydrationQueue.enqueue(
		signature,
		async () => {
			if (generation !== remoteGeneration || facade !== agent || !chatPanel.artifactsPanel) return;
			const result = await facade.client.executeArtifacts({ action: "list" });
			if (generation !== remoteGeneration || facade !== agent || !chatPanel.artifactsPanel) return;
			await chatPanel.artifactsPanel.reconstructFromMessages(artifactMessagesFromList(result));
			chatPanel.requestUpdate();
		},
		force,
	);
	void hydration.catch((error: unknown) => console.error("Failed to hydrate remote artifacts:", error));
	return hydration;
}

function synchronizeRemoteSnapshot(
	facade: RemoteAgentFacade,
	snapshot: RuntimeSessionSnapshot,
	generation: number,
): void {
	if (generation !== remoteGeneration || facade !== agent) return;
	const messages = facade.state.messages;
	if (!currentTitle && shouldSaveSession(messages)) currentTitle = generateSessionTitle(messages);
	chatPanel.agentInterface?.requestUpdate();
	if (chatPanel.artifactsPanel) void queueArtifactHydration(facade, snapshot.artifacts, generation);
	void updateAuthLabel().then(() => {
		if (generation === remoteGeneration && facade === agent) renderApp();
	});
	renderApp();
}

function disposeRemotePresentation(): void {
	if (!agent && !remoteTransport && !remoteClient) return;
	remoteGeneration++;
	const resources = {
		agentUnsubscribe,
		stateUnsubscribe,
		facade: agent,
		transport: remoteTransport,
	};
	agentUnsubscribe = undefined;
	stateUnsubscribe = undefined;
	agent = undefined;
	remoteClient = undefined;
	remoteTransport = undefined;
	detachRemotePresentation(resources);
}

// Panel lifecycle is presentation-only. Disconnect its subscriptions and port,
// but leave the offscreen session running and owned by the browser window.
window.addEventListener("pagehide", disposeRemotePresentation);
window.addEventListener("beforeunload", disposeRemotePresentation);

async function releaseBinding(binding: RemoteSessionBinding, reason: string): Promise<void> {
	try {
		await binding.client.connect();
		await binding.client.release({ force: true, reason });
	} finally {
		binding.facade.dispose();
		binding.transport.dispose();
	}
}

async function releaseCurrentSessionForSwitch(): Promise<void> {
	if (!remoteClient) return;
	await remoteClient.release({ force: true, reason: "session-switch" });
	disposeRemotePresentation();
}

async function acquireSessionLock(sessionId: string): Promise<boolean> {
	const lock = await port.sendMessage({ type: "acquireLock", sessionId, windowId: currentWindowId });
	return lock.success;
}

function welcomeRuntimeMessage(): RuntimeAgentMessage {
	return {
		role: "welcome",
		tutorials: tutorials.map((tutorial) => ({ label: tutorial.label, prompt: tutorial.prompt })),
	};
}

async function startFreshRemoteSession(model?: Model<Api>, includeWelcome = true): Promise<void> {
	const sessionId = crypto.randomUUID();
	if (!(await acquireSessionLock(sessionId))) throw new Error("Failed to acquire a lock for the new session");
	currentSessionId = sessionId;
	currentTitle = "";
	await connectRemoteSession({
		sessionId,
		mode: "create",
		...(model ? { model } : {}),
		...(includeWelcome ? { initialMessages: [welcomeRuntimeMessage()] } : {}),
	});
	updateUrl(sessionId);
}

async function connectRemoteSession(options: RemoteSessionStartOptions): Promise<void> {
	const desired = buildConnectionDescriptor(options);
	const accepted = await acceptedDescriptorForWindow();
	const selection = selectRemoteDescriptor(desired, accepted);
	if (selection.staleAccepted) {
		await releaseBinding(createRemoteBinding(selection.staleAccepted), "session-switch");
	}
	const descriptor = selection.descriptor;
	const binding = createRemoteBinding(descriptor);
	const generation = ++remoteGeneration;
	remoteTransport = binding.transport;
	remoteClient = binding.client;
	agent = binding.facade;

	agentUnsubscribe = binding.facade.subscribe(() => {
		if (generation !== remoteGeneration || binding.facade !== agent) return;
		chatPanel.agentInterface?.requestUpdate();
		renderApp();
	});
	stateUnsubscribe = binding.facade.subscribeState((snapshot) =>
		synchronizeRemoteSnapshot(binding.facade, snapshot, generation),
	);

	try {
		// connect() resolves only after an authoritative snapshot has been applied.
		await binding.client.connect();
		if (generation !== remoteGeneration || binding.facade !== agent) return;
		await chatPanel.setAgent(asPiWebUiAgent(binding.facade), {
			sandboxUrlProvider: () => chrome.runtime.getURL("sandbox.html"),
			onApiKeyRequired: async (provider: string) => {
				if (await getApiKeyForProvider(provider)) return true;
				const customProvider = await getCustomProviderByName(provider);
				if (customProvider) {
					await openApiKeysDialog();
					return Boolean(await getApiKeyForProvider(provider));
				}
				return await ApiKeyOrOAuthDialog.prompt(provider);
			},
			onModelSelect: async () => {
				const providers = await getAvailableProviderNames();
				if (providers.length === 0) {
					await openApiKeysDialog();
					return;
				}
				ModelSelector.open(
					binding.facade.state.model,
					async (model) => {
						await binding.facade.setModel(modelToRuntimeDescriptor(normalizeModelForRuntime(model)));
						if (generation !== remoteGeneration || binding.facade !== agent) return;
						chatPanel.agentInterface?.requestUpdate();
						await updateAuthLabel();
						renderApp();
					},
					providers,
				);
			},
			onCostClick: () => SessionCostDialog.open(binding.facade.state.messages),
			toolsFactory: () => [],
		});
		if (generation !== remoteGeneration || binding.facade !== agent) return;

		if (chatPanel.agentInterface) {
			registerWelcomeRenderer(() => binding.facade.state.messages, chatPanel.agentInterface);
			if (!binding.facade.state.messages.some((message) => message.role === "user")) {
				chatPanel.agentInterface.setAutoScroll(false);
				let unsubscribe: (() => void) | undefined;
				unsubscribe = binding.facade.subscribe(() => {
					if (binding.facade.state.messages.some((message) => message.role === "user")) {
						chatPanel.agentInterface?.setAutoScroll(true);
						unsubscribe?.();
					}
				});
			}
			chatPanel.agentInterface.requestUpdate();
		}
		await queueArtifactHydration(binding.facade, binding.client.state.artifacts, generation, true);
		await updateAuthLabel();
	} catch (error) {
		if (generation === remoteGeneration && binding.facade === agent) disposeRemotePresentation();
		throw error;
	}
}

// Poll for bridge state changes from background
setInterval(async () => {
	try {
		const state = await readBridgeRuntimeState(BRIDGE_RUNTIME_STATE_KEYS.bridge);
		if (state && state.state !== cachedBridgeState.state) {
			cachedBridgeState = state;
			renderApp();
		}
	} catch {
		// Ignore storage errors
	}
}, 2000);

async function onInspectElementClick(): Promise<void> {
	if (!chatPanel?.agentInterface) {
		Toast.show("Chat is not ready yet", "error");
		return;
	}

	let resolved: Awaited<ReturnType<typeof resolveTabTarget>>;
	try {
		resolved = await resolveTabTarget({ windowId: currentWindowId });
	} catch (err) {
		Toast.show((err as Error).message || "No active tab", "error");
		return;
	}
	const { tab } = resolved;

	if (isProtectedTabUrl(tab.url)) {
		Toast.show("Can't inspect this page", "error");
		return;
	}

	const editor = chatPanel.agentInterface.querySelector("message-editor") as
		| (HTMLElement & { attachments: any[]; maxFiles: number })
		| null;
	if (!editor) {
		Toast.show("Composer not ready", "error");
		return;
	}
	if (editor.attachments.length >= editor.maxFiles) {
		Toast.show(`Max ${editor.maxFiles} attachments reached`, "error");
		return;
	}

	const toast = Toast.show("Click an element in the page to attach it", "info", 30000);
	const client = remoteClient;
	if (!client) {
		toast.remove();
		Toast.show("Agent session is not ready yet", "error");
		return;
	}
	try {
		const result = await client.executePageOperation("select-element", {
			message: "Click an element in the page to attach it",
		});
		if (client !== remoteClient) return;
		const info = runtimeElementInfo(result);
		if (!info) throw new Error("Remote element selection returned an invalid result");
		const att = elementToAttachment(info, { url: tab.url || "", title: tab.title });
		editor.attachments = [...editor.attachments, att];
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!message.toLowerCase().includes("selection was cancelled")) Toast.show(message || "Inspect failed", "error");
	} finally {
		toast.remove();
	}
}

const loadSession = async (sessionId: string) => {
	try {
		await releaseCurrentSessionForSwitch();
		const url = new URL(window.location.href);
		url.searchParams.set("session", sessionId);
		url.searchParams.delete("new");
		window.location.href = url.toString();
	} catch (error) {
		Toast.show(error instanceof Error ? error.message : String(error), "error");
	}
};

const newSession = async () => {
	try {
		await releaseCurrentSessionForSwitch();
		const url = new URL(window.location.href);
		url.search = "?new=true";
		window.location.href = url.toString();
	} catch (error) {
		Toast.show(error instanceof Error ? error.message : String(error), "error");
	}
};

const openSettingsDialog = () => SettingsDialog.open(createSettingsTabs());

const onOpenTtsOverlayClick = async () => {
	const availability = await checkUserScriptsAvailability();
	if (!availability.available) {
		await UserScriptsPermissionDialog.request();
		const retry = await checkUserScriptsAvailability();
		if (!retry.available) {
			Toast.show(retry.message || availability.message || "userScripts API is unavailable", "error");
			return;
		}
	}

	const response = await chrome.runtime.sendMessage({
		type: "tts-open-overlay",
		windowId: currentWindowId,
	});
	if (!response?.ok) {
		Toast.show(response?.error || "Failed to open TTS overlay", "error");
		return;
	}
	Toast.success("TTS overlay opened");
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
							ShuvgeistSessionListDialog.open(
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
					${agent?.state.model ? html`<span class="text-[10px] text-muted-foreground truncate max-w-[120px]" title="${agent.state.model.provider}/${agent.state.model.id}${authLabel ? ` (${authLabel})` : ""}">${agent.state.model.provider}${authLabel ? html` <span class="text-[9px] opacity-70">${authLabel}</span>` : ""}</span>` : ""}
					${
						cachedBridgeState.state === "connected"
							? html`<span class="w-2 h-2 rounded-full bg-green-500" title="Bridge connected"></span>`
							: cachedBridgeState.state === "connecting"
								? html`<span class="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" title="Bridge connecting..."></span>`
								: cachedBridgeState.state === "error"
									? html`<span class="w-2 h-2 rounded-full bg-red-500" title="Bridge error: ${cachedBridgeState.detail || "unknown"}"></span>`
									: cachedBridgeState.state === "disconnected"
										? html`<span class="w-2 h-2 rounded-full bg-gray-500" title="Bridge disconnected"></span>`
										: html``
					}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Crosshair, "sm"),
						onClick: onInspectElementClick,
						title: "Inspect element",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Volume2, "sm"),
						onClick: onOpenTtsOverlayClick,
						title: "Text to speech",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () => openSettingsDialog(),
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

	// Handle test prompts through the same offscreen runtime as the real UI.
	try {
		const testSteps = JSON.parse(decodeURIComponent(testStepsParam)) as string[];

		// Set model if specified
		let model: Model<Api> | undefined;
		if (testProvider && testModel) {
			model = await resolveModelSpec(testModel, testProvider);
		}

		await startFreshRemoteSession(model, false);
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
						if (!agent?.state.isStreaming) {
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
		const response = await fetch("https://geist.shuv.ai/uploads/version.json", {
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
function bootstrapSidepanelDocumentIdentity(): string {
	const plan = planSidepanelDocumentBootstrap(window.location.href, () => crypto.randomUUID());
	window.history.replaceState(window.history.state, "", plan.url);
	return plan.nonce;
}

async function initApp() {
	currentDocumentNonce = bootstrapSidepanelDocumentIdentity();

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
	const { showJsonMode: showJsonModeEnabled } = await loadDeveloperSettings();
	setShowJsonMode(showJsonModeEnabled);

	// Resolve the browser-owned window through a background-issued continuation
	// capability. sessionStorage survives an explicit panel reload but is scoped
	// to this sidepanel browsing context; the raw token is never persisted by the
	// service worker.
	const storedCapability = readStoredSidepanelCapability();
	const storedProof: SidepanelCapabilityMaterial | undefined = storedCapability
		? {
				continuationToken: storedCapability.continuationToken,
				transactionId: storedCapability.transactionId,
				leaseId: storedCapability.leaseId,
			}
		: undefined;
	const messenger: SidepanelWindowAuthorityMessenger = {
		sendMessage: (message) => chrome.runtime.sendMessage(message),
	};
	let pendingIdentity: SidepanelResolvedIdentity;
	try {
		pendingIdentity = await prepareSidepanelWindowIdentity(messenger, window.location.href, storedProof);
	} catch (error) {
		if (storedCapability === undefined) throw error;
		window.sessionStorage.removeItem(SIDEPANEL_CONTINUATION_SESSION_KEY);
		pendingIdentity = await prepareSidepanelWindowIdentity(messenger, window.location.href, undefined);
	}
	const pendingMaterial: SidepanelCapabilityMaterial = {
		continuationToken: pendingIdentity.continuationToken,
		transactionId: pendingIdentity.transactionId,
		leaseId: pendingIdentity.leaseId,
	};
	// This synchronous write is the recovery handoff: if the document reloads
	// before confirmation, the next document can only advance this pending hop.
	storeSidepanelCapability("pending", pendingMaterial);
	const identity = await confirmSidepanelWindowIdentity(messenger, window.location.href, pendingMaterial);
	storeSidepanelCapability("active", {
		continuationToken: identity.continuationToken,
		transactionId: identity.transactionId,
		leaseId: identity.leaseId,
	});
	currentWindowId = identity.windowId;
	currentContinuationToken = identity.continuationToken;
	currentTransactionId = identity.transactionId;
	currentLeaseId = identity.leaseId;

	// Initialize port communication system
	port.initialize(
		currentWindowId,
		currentDocumentNonce,
		currentContinuationToken,
		currentTransactionId,
		currentLeaseId,
	);

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
	await initializeDefaultSkills();

	// Proxy disabled — CORS is handled locally via declarativeNetRequest rules
	await setProxyEnabled(false);

	// Create ChatPanel
	chatPanel = new ChatPanel();

	// Handle test steps
	if (await testSteps()) {
		return;
	}

	const urlParams = new URLSearchParams(window.location.search);
	const explicitlyNew = urlParams.get("new") === "true";
	const accepted = explicitlyNew ? undefined : await acceptedDescriptorForWindow();
	const requestedSessionId = explicitlyNew ? undefined : (urlParams.get("session") ?? accepted?.sessionId);
	if (requestedSessionId && storage.sessions) {
		const persisted = await storage.sessions.loadSession(requestedSessionId);
		const acceptedMatches =
			accepted?.sessionId === requestedSessionId &&
			sameRuntimeTarget(accepted.target, sidepanelTarget(currentWindowId));
		if ((persisted || acceptedMatches) && (await acquireSessionLock(requestedSessionId))) {
			currentSessionId = requestedSessionId;
			currentTitle = (await storage.sessions.getMetadata(requestedSessionId))?.title || "";
			await connectRemoteSession({
				sessionId: requestedSessionId,
				mode: acceptedMatches ? accepted.mode : "load",
			});
			updateUrl(requestedSessionId);
			renderApp();
			return;
		}
	}

	// Session identity and lock ownership exist before the runtime port connects.
	await startFreshRemoteSession();
	renderApp();

	// If no API keys configured, show welcome dialog, open settings, then auto-select model
	if (!(await hasAnyApiKey())) {
		const setupChoice = await WelcomeSetupDialog.show();
		if (setupChoice === "free-tier") {
			await enableBundledFreeTier();
		} else if (setupChoice === "subscription-settings") {
			await openApiKeysDialog("subscriptions");
			await selectDefaultModelForAvailableProvider();
		} else {
			await openApiKeysDialog();
			await selectDefaultModelForAvailableProvider();
		}
		renderApp();
	}
}

// Register custom user message renderer early, before any session loads
registerUserMessageRenderer();

initApp();
