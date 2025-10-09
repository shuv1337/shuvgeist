import { Button, Input, icon } from "@mariozechner/mini-lit";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { getModel } from "@mariozechner/pi-ai";
import {
	Agent,
	type AgentState,
	ApiKeyPromptDialog,
	ApiKeysTab,
	type AppMessage,
	ChatPanel,
	// PersistentStorageDialog,
	ProviderTransport,
	ProxyTab,
	SessionListDialog,
	SettingsDialog,
	setAppStorage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { History, Plus, Settings } from "lucide";
import { SkillsTab } from "./dialogs/SkillsTab.js";
import { UserScriptsPermissionDialog } from "./dialogs/UserScriptsPermissionDialog.js";
import { browserMessageTransformer } from "./message-transformer.js";
import {
	createNavigationMessage,
	type NavigationMessage,
	registerNavigationRenderer,
} from "./messages/NavigationMessage.js";
import { SYSTEM_PROMPT } from "./prompts/tool-prompts.js";
import { SitegeistAppStorage } from "./storage/app-storage.js";
import { BrowserJavaScriptTool, skillTool } from "./tools/index.js";
import "./utils/i18n-extension.js";
import "./utils/live-reload.js";

// Register custom message renderers
registerNavigationRenderer();

// Cross-browser API compatibility
// @ts-expect-error - browser global exists in Firefox, chrome in Chrome
const browserAPI = globalThis.browser || globalThis.chrome;

// Get sandbox URL for extension CSP restrictions
const getSandboxUrl = () => {
	return browserAPI.runtime.getURL("sandbox.html");
};

const systemPrompt = SYSTEM_PROMPT;

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

// ============================================================================
// HELPERS
// ============================================================================

const generateTitle = (messages: AppMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user");
	if (!firstUserMsg || firstUserMsg.role !== "user") return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c: any) => c.type === "text");
		text = textBlocks.map((c: any) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AppMessage[]): boolean => {
	const hasUserMsg = messages.some((m: any) => m.role === "user");
	const hasAssistantMsg = messages.some((m: any) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;

	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;

	try {
		await storage.sessions.saveSession(
			currentSessionId,
			state,
			undefined,
			currentTitle,
		);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

const createAgent = async (initialState?: Partial<AgentState>) => {
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	const transport = new ProviderTransport();

	agent = new Agent({
		initialState: initialState || {
			systemPrompt,
			model: getModel("anthropic", "claude-sonnet-4-5-20250929"),
			thinkingLevel: "off",
			messages: [],
			tools: [],
		},
		transport,
		messageTransformer: browserMessageTransformer,
	});

	agentUnsubscribe = agent.subscribe((event: any) => {
		if (event.type === "state-update") {
			const messages = event.state.messages;

			// Generate title after first successful response
			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
			}

			// Create session ID on first successful save
			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = crypto.randomUUID();
				updateUrl(currentSessionId);
			}

			// Auto-save
			if (currentSessionId) {
				saveSession();
			}

			renderApp();
		}
	});

	await chatPanel.setAgent(agent, {
		sandboxUrlProvider: getSandboxUrl,
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyPromptDialog.prompt(provider);
		},
		onBeforeSend: async () => {
			if (!agent) return;

			// Get current tab info
			const [tab] = await browserAPI.tabs.query({
				active: true,
				currentWindow: true,
			});
			if (
				!tab?.url ||
				tab.url.startsWith("chrome-extension://") ||
				tab.url.startsWith("moz-extension://")
			)
				return;

			// Find most recent navigation message (reverse iteration for compatibility)
			let lastNav: NavigationMessage | undefined;
			for (let i = agent.state.messages.length - 1; i >= 0; i--) {
				if (agent.state.messages[i].role === "navigation") {
					lastNav = agent.state.messages[i] as NavigationMessage;
					break;
				}
			}

			// Only add if URL changed
			if (!lastNav || lastNav.url !== tab.url) {
				const navMessage = createNavigationMessage(
					tab.url,
					tab.title || "Untitled",
					tab.favIconUrl,
					tab.index,
				);
				agent.appendMessage(navMessage);
			}
		},
		toolsFactory: (agent, _agentInterface, artifactsPanel) => {
			const browserJavaScriptTool = new BrowserJavaScriptTool(
				artifactsPanel,
				agent,
			);
			return [browserJavaScriptTool, skillTool];
		},
	});
};

const loadSession = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.location.href = url.toString();
};

const newSession = () => {
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
							SessionListDialog.open(
								(sessionId) => {
									loadSession(sessionId);
								},
								(deletedSessionId) => {
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
												const newTitle = (
													e.target as HTMLInputElement
												).value.trim();
												if (
													newTitle &&
													newTitle !== currentTitle &&
													storage.sessions &&
													currentSessionId
												) {
													await storage.sessions.updateTitle(
														currentSessionId,
														newTitle,
													);
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
											const input = document.body.querySelector(
												'input[type="text"]',
											) as HTMLInputElement;
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
							: html`<span class="text-sm font-semibold text-foreground">pi-ai</span>`
					}
				</div>
				<div class="flex items-center gap-1 px-2">
					<theme-toggle></theme-toggle>
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () =>
							SettingsDialog.open([
								new ApiKeysTab(),
								new ProxyTab(),
								new SkillsTab(),
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
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
	// Only care about URL changes on the active tab while agent is working
	// Ignore chrome-extension:// URLs (extension internal pages)
	if (
		changeInfo.url &&
		tab.active &&
		tab.url &&
		agent?.state.isStreaming &&
		!tab.url.startsWith("chrome-extension://")
	) {
		const navMessage = createNavigationMessage(
			tab.url,
			tab.title || "Untitled",
			tab.favIconUrl,
			tab.index,
		);
		agent.appendMessage(navMessage);
	}
});

// Listen for tab activation (user switches tabs) only when agent is running
chrome.tabs.onActivated.addListener(async (activeInfo) => {
	const tab = await chrome.tabs.get(activeInfo.tabId);
	// Ignore chrome-extension:// URLs (extension internal pages)
	if (
		tab.url &&
		agent?.state.isStreaming &&
		!tab.url.startsWith("chrome-extension://")
	) {
		const navMessage = createNavigationMessage(
			tab.url,
			tab.title || "Untitled",
			tab.favIconUrl,
			tab.index,
		);
		agent.appendMessage(navMessage);
	}
});

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================
window.addEventListener("keydown", (e) => {
	// Cmd+U (Mac) or Ctrl+U (Windows/Linux) to open debug page
	if ((e.metaKey || e.ctrlKey) && e.key === "u") {
		e.preventDefault();
		window.location.href = "./debug.html";
	}
});

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

	// Request persistent storage
	// if (storage.sessions) {
	// 	await PersistentStorageDialog.request();
	// }

	// Request userScripts permission if not available
	// @ts-expect-error - browser global exists in Firefox, chrome in Chrome
	const browserAPIForPermissions = globalThis.browser || globalThis.chrome;
	if (!browserAPIForPermissions.userScripts) {
		await UserScriptsPermissionDialog.request();
	}

	// Create ChatPanel
	chatPanel = new ChatPanel();

	// Check for session in URL
	const urlParams = new URLSearchParams(window.location.search);
	let sessionIdFromUrl = urlParams.get("session");
	const isNewSession = urlParams.get("new") === "true";

	// If no session in URL and not explicitly creating new, try to load the most recent session
	if (!sessionIdFromUrl && !isNewSession && storage.sessions) {
		const latestSessionId = await storage.sessions.getLatestSessionId();
		if (latestSessionId) {
			sessionIdFromUrl = latestSessionId;
			// Update URL to include the latest session
			updateUrl(latestSessionId);
		}
	}

	if (sessionIdFromUrl && storage.sessions) {
		const sessionData = await storage.sessions.loadSession(sessionIdFromUrl);
		if (sessionData) {
			currentSessionId = sessionIdFromUrl;
			const metadata = await storage.sessions.getMetadata(sessionIdFromUrl);
			currentTitle = metadata?.title || "";

			await createAgent({
				systemPrompt,
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

	// No session - create new agent
	await createAgent();
	renderApp();
}

initApp();
