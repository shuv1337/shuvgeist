# Shuvgeist Architecture Guide

## Overview

Shuvgeist is a Chrome/Edge browser extension (Manifest v3) that provides an AI-powered browser automation assistant in Chrome's side panel. It uses an agent-loop architecture from `@mariozechner/pi-agent-core` with browser-specific tools for navigation, JavaScript execution, screenshot capture, and DOM interaction.

---

## Extension Structure

```
Chrome Extension (Manifest v3, minimum Chrome 141)
├── background.ts          Service worker (sidebar toggle, session locks, bridge runtime, abort relay)
├── sidepanel.ts           Main UI entry point (agent setup, rendering, event wiring)
├── debug.ts               Debug panel for REPL testing
├── icons.ts               Icon generation utilities
├── sandbox.html           Sandboxed iframe for REPL code execution
├── sidepanel.html         Side panel HTML shell
└── dist-chrome/           Build output (loaded as unpacked extension)
```

### Manifest Permissions

```
storage, unlimitedStorage, activeTab, scripting, sidePanel,
userScripts, webNavigation, debugger, cookies
```

Host permissions: `http://*/*`, `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`

---

## Core Architecture

### Agent System (`@mariozechner/pi-agent-core`)

The agent is the central orchestrator. It lives in `sidepanel.ts` and is created via:

```typescript
agent = new Agent({
    initialState: { systemPrompt, model, thinkingLevel, messages, tools },
    convertToLlm: browserMessageTransformer,
    toolExecution: "sequential",
    streamFn: createStreamFn(...),
    getApiKey: async (provider) => resolveApiKey(...)
});
```

Key `Agent` class features:
- **`prompt(message)`** - Send a user message, triggers the agent loop
- **`subscribe(fn)`** - Listen for `AgentEvent`s (message_start/update/end, tool_execution_start/end, agent_start/end)
- **`steer(message)`** - Inject a message mid-run (used for tab navigation events)
- **`abort()`** - Cancel the current run via AbortController
- **`waitForIdle()`** - Returns a promise that resolves when the agent finishes
- **`state`** - Current `AgentState` (messages, model, isStreaming, tools, pendingToolCalls)

### Agent Loop Flow

1. User sends message via ChatPanel
2. `agent.prompt()` starts the loop
3. Loop calls `convertToLlm()` to transform `AgentMessage[]` to LLM `Message[]`
4. LLM streams response via `streamFn`
5. If response contains tool calls, they execute sequentially
6. After tool execution, loop checks `getSteeringMessages()` for injected messages
7. If more tool calls or steering messages exist, loop continues
8. When done, checks `getFollowUpMessages()` for queued follow-ups
9. Emits `agent_end` event

### Tool Interface

```typescript
interface AgentTool<TParameters, TDetails> {
    label: string;           // Human-readable label for UI
    name: string;            // Tool name sent to LLM
    description: string;     // Tool description for LLM
    parameters: TParameters; // TypeBox schema for arguments
    execute(
        toolCallId: string,
        params: Static<TParameters>,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<TDetails>
    ): Promise<AgentToolResult<TDetails>>;
}

interface AgentToolResult<T> {
    content: (TextContent | ImageContent)[];  // Sent to LLM
    details: T;                                // For UI rendering
}
```

---

## Tools

### Navigate Tool (`src/tools/navigate.ts`)

Controls browser tab navigation. Four actions:

| Action | Parameters | Description |
|--------|-----------|-------------|
| Navigate to URL | `{ url: string, newTab?: boolean }` | Opens URL in current or new tab |
| List tabs | `{ listTabs: true }` | Returns all open tabs with IDs |
| Switch tab | `{ switchToTab: number }` | Activates a specific tab by ID |

After navigation, the tool queries `SkillsStore` for domain-matching skills and returns them alongside the page title, URL, and favicon.

The tool sets `isNavigating = true` during execution to prevent duplicate navigation messages from the tab event listeners in `sidepanel.ts`.

### REPL Tool (`src/tools/repl/repl.ts`)

Executes JavaScript in a sandboxed iframe. The sandbox is loaded from `sandbox.html` (extension's sandboxed page with relaxed CSP).

**Execution flow:**

1. Code is checked for restricted navigation patterns
2. If code uses `browserjs(`, an overlay is injected into the active tab
3. A `SandboxIframe` is created and appended to the sidepanel DOM (hidden)
4. Code is executed via `sandbox.execute()` with runtime providers
5. Results (console output, return value, files) are collected
6. Overlay is removed, sandbox iframe is cleaned up

**Parameters:** `{ title: string, code: string }`

### Runtime Providers (`src/tools/repl/runtime-providers.ts`)

Runtime providers inject additional capabilities into the REPL sandbox. They follow the `SandboxRuntimeProvider` interface:

```typescript
interface SandboxRuntimeProvider {
    getData(): Record<string, any>;
    getRuntime(): (sandboxId: string) => void;  // Stringified and injected
    getDescription(): string;
    handleMessage?(message: any, respond: (response: any) => void): Promise<void>;
    onExecutionStart?(sandboxId: string, signal?: AbortSignal): void;
    onExecutionEnd?(sandboxId: string): void;
}
```

#### BrowserJsRuntimeProvider

Provides `browserjs(fn, ...args)` to REPL scripts. Executes functions in the active tab's page context via `chrome.userScripts.execute()`.

**Execution path:**
1. REPL code calls `browserjs(() => document.title)`
2. The call is serialized as a runtime message (`type: "browser-js"`)
3. `handleMessage()` receives it in the extension context
4. Loads matching skills from `SkillsStore` for the current URL
5. Builds wrapper code with skills, providers, and arguments via `buildWrapperCode()`
6. Executes in `USER_SCRIPT` world via `chrome.userScripts.execute()`
7. Result is serialized back through the runtime message channel

**Key details:**
- Uses a fixed `worldId: "shuvgeist-browser-script"` for all executions
- Configures CSP on the userScript world to block network/media access
- Supports `chrome.userScripts.terminate()` for cancellation (Chrome 138+)
- Injects `ConsoleRuntimeProvider` for each execution to capture page console output

#### NavigateRuntimeProvider

Provides `navigate(args)` to REPL scripts. Wraps the `NavigateTool` so REPL code can trigger navigation:

```javascript
await navigate({ url: 'https://example.com' });
```

#### NativeInputEventsRuntimeProvider (`src/tools/NativeInputEventsRuntimeProvider.ts`)

Provides trusted browser input events via Chrome Debugger API (CDP). Functions injected:

| Function | Description |
|----------|-------------|
| `nativeClick(selector)` | Finds element, dispatches mousePressed/mouseReleased at center |
| `nativeType(selector, text)` | Focuses element, dispatches keyDown/keyUp for each character |
| `nativePress(key)` | Single key press (keyDown + keyUp) |
| `nativeKeyDown(key)` | Key down only (for modifier combos) |
| `nativeKeyUp(key)` | Key up only (for modifier combos) |

These generate `isTrusted: true` events, required for sites with anti-bot detection.

**Implementation:** Attaches Chrome debugger to the active tab, uses `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` CDP commands, then detaches.

### Extract Image Tool (`src/tools/extract-image.ts`)

Two modes:
- **`screenshot`**: Captures visible tab via `chrome.tabs.captureVisibleTab()`
- **`selector`**: Gets image src from DOM via `chrome.userScripts.execute()`, then fetches and resizes in extension context

Images are resized to `maxWidth` (default 800px) using `OffscreenCanvas`, converted to PNG base64, and returned as `ImageContent` for the LLM.

### Debugger Tool (`src/tools/debugger.ts`)

Two actions:
- **`eval`**: Executes JavaScript in the MAIN world via `chrome.debugger.sendCommand("Runtime.evaluate")`. Required for accessing page-scoped variables, framework state (React, Vue), and `window` properties set by page scripts.
- **`cookies`**: Gets all cookies for current domain via `chrome.cookies.getAll()`, including HttpOnly cookies when the extension has the `cookies` permission.

### Bridge Execution Helpers

Bridge-mode browser execution now uses shared helper modules under `src/tools/helpers/`:

- `browser-target.ts` resolves explicit `tabId` / `frameId` targets and defaults to the active tab in the registered extension `windowId`. Bridge code never uses `currentWindow: true`.
- `debugger-manager.ts` centralizes Chrome debugger attach/detach ownership and domain enablement so `eval`, native input, network capture, screenshots, device emulation, and performance tracing can share one debugger lifecycle safely.
- `frame-resolver.ts` builds stable frame lists and frame trees from `chrome.webNavigation.getAllFrames()`.
- `ref-map.ts` stores in-memory ref locator bundles keyed by `tabId` + `frameId`, with explicit stale-ref failure reasons.
- `waits.ts` provides reusable navigation / DOM / network quiet waits for deterministic workflows.

### Bridge Target Routing

Bridge requests carry an optional top-level target. Chrome/Edge through the extension is the default target when the field is absent. Electron targets are explicit and use strings such as `electron:e1:w1`, `electron:e1:main`, `electron:vscode:w1`, or `electron:e1/w1` from the CLI.

Routing has two paths:

- Extension-relayed Chrome requests: `BridgeServer -> ExtensionClient -> CommandDispatcher -> Chrome APIs`.
- Bridge-local Electron requests: `BridgeServer -> ElectronSessionManager -> ElectronCdpClient -> Electron CDP endpoint`.

Server-local Electron management commands (`electron list`, `electron allow`, `electron launch`, `electron attach`, `electron detach`, `electron windows`, and `electron label`) do not wait for an extension connection. Target-dispatched commands (`eval`, `screenshot`, `snapshot`, `locate`, `ref`, and `record`) use the Electron path only when an Electron target is present.

Electron support lives under `src/bridge/electron/`:

- `app-registry.ts`: known app IDs, aliases, and executable resolution.
- `config.ts`: `~/.shuvgeist/bridge.json` Electron allowlist, port range, and default flags.
- `session-manager.ts`: launch/attach/detach state, stable window refs, labels, snapshots, refs, CDP eval/screenshot, and recording.
- `cdp-client.ts`: minimal WebSocket CDP client for renderer commands and screencast events.

### Bridge Runtime Ownership

Bridge connection ownership now lives entirely in `src/background.ts`:

- canonical bridge settings live in `chrome.storage.local[BRIDGE_SETTINGS_KEY]`
- bridge connection state lives in `chrome.storage.session[BRIDGE_STATE_KEY]`
- the background worker lazily seeds default local settings and performs a one-time legacy IndexedDB migration when needed
- loopback bridge URLs bootstrap the local token from `GET /bootstrap` on the bridge server
- live changes to `enabled`, `url`, `token`, and `sensitiveAccessEnabled` are reconciled in background without sidepanel mirroring

The sidepanel no longer mirrors bridge config. `BridgeTab` reads and writes the canonical local-storage settings directly.

### Bridge Capability Surface

Bridge protocol registration is still flat-string based:

- `BridgeMethods` enumerates every command the server will route.
- `BridgeCapabilities` enumerates every command the extension advertises.
- Adding a new bridge command requires adding it to both arrays in `src/bridge/protocol.ts`.

Sensitive commands are filtered by `getBridgeCapabilities()` when bridge settings disable sensitive browser access. The current sensitive set includes:

- `eval`
- `cookies`
- `network_get`
- `network_body`
- `network_curl`

Session-mutating commands remain the only write-locked bridge methods. Browser-state commands such as workflows, snapshots, network capture, device emulation, and perf tracing are not session write methods.

### Bridge Feature Modules

The bridge now exposes several extension-side execution modules beyond the original navigation / REPL / screenshot surface:

- `workflow-schema.ts` and `workflow-engine.ts` implement shared workflow validation plus extension-side deterministic workflow execution.
- `page-snapshot.ts` captures compact semantic page snapshots and powers role/text/label lookup plus ref creation.
- `network-capture.ts` maintains bounded in-memory request capture per tab and exports curl commands with default header redaction.
- `device-presets.ts` applies named or custom emulation profiles through the debugger-backed `Emulation.*` CDP commands.
- `performance-tools.ts` exposes one-shot metrics and bounded trace capture.

### Skill Tool (`src/tools/skill.ts`)

CRUD operations on domain-specific automation libraries stored in IndexedDB:

| Action | Description |
|--------|-------------|
| `get` | Retrieve a skill by name (optionally with library code) |
| `list` | List skills, optionally filtered by URL domain |
| `create` | Create a new skill with validation |
| `rewrite` | Full replacement of an existing skill |
| `update` | Surgical find/replace edits on skill fields |
| `delete` | Remove a skill |

Skills have: `name`, `domainPatterns` (glob), `shortDescription`, `description`, `examples`, `library` (JavaScript code). Library code is auto-injected into `browserjs()` context when the current URL matches a skill's domain patterns.

### Ask User Which Element (`src/tools/ask-user-which-element.ts`)

Interactive tool that lets users visually select DOM elements. Injects a picker UI into the page.

---

## Message Passing Architecture

### 1. Port Communication: Sidepanel <-> Background (`src/utils/port.ts`)

Used for session locking across multiple browser windows.

```
Sidepanel                          Background Service Worker
   │                                        │
   ├─── connect("sidepanel:${windowId}") ──>│  (chrome.runtime.onConnect)
   │                                        │
   ├─── acquireLock { sessionId, windowId } >│
   │<── lockResult { success, ownerWindowId }│
   │                                        │
   ├─── getLockedSessions ────────────────> │
   │<── lockedSessions { locks } ───────────│
   │                                        │
   │    (port.onDisconnect) ──────────────> │  releases locks for windowId
```

**Auto-reconnection:** Port can disconnect after ~5min Chrome inactivity. `sendMessage()` retries once with a fresh connection.

**Request/response typing:** `REQUEST_TO_RESPONSE_TYPE` maps request types to expected response types. `sendMessage<T>()` infers the return type from the request message type.

### 2. Runtime Message Router: Sandbox <-> Providers

The `SandboxIframe` and runtime providers communicate via `postMessage`. The `RUNTIME_MESSAGE_ROUTER` dispatches messages to registered providers based on `sandboxId`.

```
REPL Sandbox (iframe)
   │
   ├── sendRuntimeMessage({ type: "browser-js", code, args })
   │       │
   │       ▼
   │   RUNTIME_MESSAGE_ROUTER
   │       │
   │       ▼
   │   BrowserJsRuntimeProvider.handleMessage()
   │       │
   │       ▼
   │   chrome.userScripts.execute() in active tab
   │       │
   │       ▼
   │   respond({ success, result, console })
   │
   ├── sendRuntimeMessage({ type: "navigate", args })
   │       ▼
   │   NavigateRuntimeProvider.handleMessage()
   │
   ├── sendRuntimeMessage({ type: "native-input", action, ... })
   │       ▼
   │   NativeInputEventsRuntimeProvider.handleMessage()
```

### 3. userScript Messages: Page <-> Background

The REPL overlay in the page context can send abort signals:

```
Page (USER_SCRIPT world)
   │
   ├── chrome.runtime.sendMessage({ type: "abort-repl" })
   │       │
   │       ▼
   │   Background (chrome.runtime.onUserScriptMessage)
   │       │
   │       ▼
   │   chrome.runtime.sendMessage() → broadcasts to all sidepanels
   │       │
   │       ▼
   │   Sidepanel (chrome.runtime.onMessage) → agent.abort()
```

### 4. Tab Event Steering

`sidepanel.ts` listens for tab changes while the agent is streaming:

```typescript
chrome.tabs.onUpdated.addListener(...)   // URL changes on active tab
chrome.tabs.onActivated.addListener(...) // User switches tabs
```

When detected (and not caused by the navigate tool), a `NavigationMessage` is injected via `agent.steer()` so the LLM knows the context changed.

---

## Storage (`src/storage/`)

All data is stored locally in IndexedDB via `ShuvgeistAppStorage`:

| Store | Contents |
|-------|----------|
| `SessionsStore` | Conversation history, metadata (title, usage, preview) |
| `SkillsStore` | Domain-specific automation libraries with glob patterns |
| `CostStore` | Per-model token costs |
| `SettingsStore` | User preferences (last model, proxy settings, etc.) |
| `ProviderKeysStore` | API keys and OAuth credentials per provider |
| `CustomProvidersStore` | User-defined AI provider configurations |

Session locking prevents concurrent editing: `background.ts` tracks `sessionId -> windowId` mapping in `chrome.storage.session`.

---

## Execution Contexts

The extension operates across multiple isolated JavaScript contexts:

| Context | Access | Used By |
|---------|--------|---------|
| **Extension pages** (sidepanel, background) | Chrome APIs, IndexedDB, full extension permissions | Agent, tools, storage, UI |
| **Offscreen document** (offscreen.html) | DOM + iframe creation, `chrome.runtime` messaging, IndexedDB — but **no** `chrome.tabs` / `chrome.userScripts` / `chrome.debugger` | Hosts REPL sandbox iframe when sidepanel is closed (bridge REPL path) |
| **Sandbox** (sandbox.html iframe) | `unsafe-eval`, CDN access, no Chrome APIs | REPL code execution |
| **USER_SCRIPT world** | Page DOM (isolated JS scope), `chrome.runtime.sendMessage` | `browserjs()`, overlay, extract_image |
| **MAIN world** | Page's actual JS scope (variables, frameworks, localStorage) | Debugger tool `eval` action |

Key isolation: USER_SCRIPT world can see the DOM but not page JavaScript variables. MAIN world access requires the debugger tool (attaches Chrome debugger).

### Bridge REPL Runtime Providers (sidepanel-closed path)

When the bridge dispatches `shuvgeist repl '...'` and the sidepanel is not open, execution runs in the offscreen document. The offscreen document has DOM (so it can host the sandbox iframe) but no `chrome.tabs` / `chrome.userScripts` / `chrome.debugger`. To still expose the full browser runtime to user code, the offscreen sandbox is injected with **proxy** runtime providers (`src/bridge/offscreen-runtime-providers.ts`):

- `OffscreenBrowserJsProxy` — injects `browserjs()` with the same surface as the sidepanel provider.
- `OffscreenNavigateProxy` — injects `navigate()`.
- `OffscreenNativeInputProxy` — injects `nativeClick` / `nativeType` / `nativePress` / `nativeKeyDown` / `nativeKeyUp`.

Each proxy forwards its `handleMessage()` payload to the background service worker via `chrome.runtime.sendMessage({ type: "bg-runtime-exec", ... })`. The background-side handler (`src/bridge/background-runtime-handler.ts`) runs the real Chrome API operations: `NavigateTool.execute()`, `NativeInputEventsRuntimeProvider.handleMessage()`, and a self-contained `chrome.userScripts.execute()` wrapper that does **not** depend on the sidepanel's DOM-bound `RUNTIME_MESSAGE_ROUTER`. Nested native-input calls from inside skill code running in the background-launched user script are routed back via the same `chrome.runtime.onUserScriptMessage` listener.

This mirrors the sidepanel's provider wiring (`NativeInputEventsRuntimeProvider` + `BrowserJsRuntimeProvider` + `NavigateRuntimeProvider`) so the CLI REPL surface is identical regardless of sidepanel state.

---

## Build System

### Entry Points (`scripts/build.mjs`)

```javascript
{
    sidepanel: 'src/sidepanel.ts',
    debug: 'src/debug.ts',
    icons: 'src/icons.ts',
    background: 'src/background.ts',
    offscreen: 'src/offscreen.ts'
}
```

### Build Pipeline

1. **esbuild** bundles TypeScript to ESM (target: Chrome 120+)
2. **Tailwind CSS** compiles `src/app.css` to `dist-chrome/app.css`
3. Static assets copied from `static/` (manifest, icons, HTML shells)
4. PDF.js worker copied for document preview

### Dev Mode (`npm run dev`)

Three concurrent watchers:
1. esbuild watch (TypeScript)
2. Tailwind CSS watch
3. Dev server with hot reload injection

### Quality Checks (`./check.sh`)

1. **Biome** (formatter + linter): `biome check --write .`
2. **TypeScript**: `tsc --noEmit`
3. **Site checks** (if applicable)

Pre-commit hook via Husky runs `check.sh`.

---

## Linked Dependencies

These packages are linked via `file:` in `package.json` to sibling repos:

| Package | Source | Purpose |
|---------|--------|---------|
| `@mariozechner/mini-lit` | `../mini-lit` | Lightweight web component library |
| `@mariozechner/pi-agent-core` | `../pi-mono/packages/agent` | Agent class, tool interfaces, agent loop |
| `@mariozechner/pi-ai` | `../pi-mono/packages/ai` | Model/provider abstractions, streaming |
| `@mariozechner/pi-web-ui` | `../pi-mono/packages/web-ui` | ChatPanel, SandboxIframe, settings UI |

Changes to these require rebuilding (the dev watcher handles this).

---

## Key File Map

```
src/
├── background.ts                    Service worker entry
├── sidepanel.ts                     Main app: agent creation, tool wiring, UI rendering
├── tools/
│   ├── index.ts                     Tool exports and renderer registration
│   ├── navigate.ts                  Tab navigation tool + renderer
│   ├── extract-image.ts            Screenshot/image extraction tool
│   ├── debugger.ts                  MAIN world eval + cookies tool
│   ├── skill.ts                     Skill CRUD tool + renderer
│   ├── ask-user-which-element.ts   Visual element picker tool
│   ├── NativeInputEventsRuntimeProvider.ts  Trusted input events via CDP
│   └── repl/
│       ├── repl.ts                  REPL tool: sandboxed JS execution
│       ├── runtime-providers.ts     BrowserJs + Navigate providers
│       ├── overlay-inject.ts        Injects/removes REPL overlay in page
│       ├── overlay-content.ts       Overlay HTML/CSS/JS content
│       └── userscripts-helpers.ts   Wrapper code generation for userScripts
├── storage/
│   ├── app-storage.ts              ShuvgeistAppStorage (all stores)
│   └── stores/
│       ├── sessions-store.ts        Session persistence
│       ├── skills-store.ts          Skills with domain matching
│       └── cost-store.ts           Token cost tracking
├── messages/
│   ├── NavigationMessage.ts        Custom navigation context message
│   ├── WelcomeMessage.ts           Onboarding message
│   ├── UserMessageRenderer.ts      Custom user message rendering
│   ├── custom-messages.ts          Type declarations for custom messages
│   └── message-transformer.ts     Converts AgentMessages to LLM Messages
├── dialogs/                        Settings, API keys, skills, costs, welcome
├── oauth/                          OAuth flows (Anthropic, OpenAI, GitHub, Gemini)
├── prompts/
│   ├── prompts.ts                  System prompt + tool descriptions
│   └── count-tokens.ts            Token estimation
├── components/                     UI components (Toast, TabPill, SkillPill, etc.)
└── utils/
    ├── port.ts                     Sidepanel <-> background port communication
    ├── live-reload.ts              Dev mode hot reload
    └── favicon.ts                  Favicon utilities
```
