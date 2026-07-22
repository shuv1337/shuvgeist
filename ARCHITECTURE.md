# Shuvgeist Architecture Guide

## Overview

Shuvgeist is a Chrome/Edge browser extension (Manifest v3) that provides an AI-powered browser automation assistant in Chrome's side panel. It uses an agent-loop architecture from `@mariozechner/pi-agent-core` with browser-specific tools for navigation, JavaScript execution, screenshot capture, and DOM interaction.

The repository is an npm workspace. Shared wire contracts live in `packages/protocol`, target-neutral browser automation lives in `packages/driver`, and the extension, local server, and public CLI each have a separate runtime package. Those package edges are one-way and checked by `scripts/check-workspace-boundaries.mjs`.

---

## Extension Structure (`packages/extension/`)

```
Chrome Extension (Manifest v3, minimum Chrome 141)
├── background.ts          Service worker (sidebar toggle, session locks, bridge runtime, abort relay)
├── offscreen.ts           Persistent agent, REPL sandbox, artifact, and TTS runtime
├── sidepanel.ts           Thin UI client (intents, rendering, settings, session presentation)
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

### Agent System (`packages/extension/src/agent/`, `packages/extension/src/offscreen.ts`)

The persistent offscreen document owns every `Agent` instance and its REPL/tool environment. The sidepanel never constructs an agent or executes a tool. It binds a `RemoteAgentFacade` to a window-scoped `RemoteSessionClient`, sends typed intents, and renders snapshots and stream events.

Runtime ownership is split by capability:

- `OffscreenRuntimeHost` owns session state, request ordering, cancellation, replay, and snapshots.
- `OffscreenAgentSessionAdapter` owns the real `@mariozechner/pi-agent-core` `Agent`.
- `PureOffscreenAgentToolRuntime` owns one tool/REPL/artifact environment per exact client/window/session target.
- `AgentRuntimeCoordinator` in the background authenticates the sidepanel route, persists accepted descriptors and checkpoints in `chrome.storage.session`, and relays correlated envelopes.
- `AgentRuntimePageController` is the only path from the offscreen runtime to privileged tab/window operations in the service worker.
- `ChromeRuntimeSessionTransport` and `RemoteAgentFacade` make the sidepanel a replaceable presentation client; closing it does not release the offscreen session.

Every envelope carries protocol version, runtime epoch, client ID, window ID, session ID, logical target, and request/event correlation IDs. Reconnects resynchronize from the last acknowledged event sequence, while stale descriptors and foreign window/tab targets fail closed.

### Agent Loop Flow

1. ChatPanel sends a prompt intent through `RemoteAgentFacade`.
2. `ChromeRuntimeSessionTransport` sends a correlated request to the background coordinator.
3. The coordinator routes it to `OffscreenRuntimeController` and the exact offscreen session.
4. The runtime prepares current navigation context, then `agent.prompt()` starts the loop.
5. The LLM streams a response and tools execute sequentially in the offscreen tool environment.
6. Privileged page work crosses the typed page-operation channel to the background and returns to the same execution.
7. Runtime events and snapshots stream back through the coordinator to the active sidepanel client.
8. Session persistence and the runtime checkpoint are updated independently of sidepanel lifetime.

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

### Navigate Tool (`packages/extension/src/tools/navigate.ts`)

Controls browser tab navigation. Its actions include:

| Action | Parameters | Description |
|--------|-----------|-------------|
| Navigate to URL | `{ url: string, newTab?: boolean }` | Opens URL in current or new tab |
| List tabs | `{ listTabs: true }` | Returns all open tabs with IDs |
| Switch tab | `{ switchToTab: number }` | Activates a specific tab by ID |

After navigation, the tool queries `SkillsStore` for domain-matching skills and returns them alongside the page title, URL, and favicon.

The offscreen runtime invokes navigation through its privileged page-operation channel. The background owns active-tab listeners and injects deduplicated navigation context into only the matching streaming session; the sidepanel does not observe tab events.

### REPL Tool (`packages/extension/src/tools/repl/repl.ts`)

Executes JavaScript in a sandboxed iframe. The sandbox is loaded from `sandbox.html` (extension's sandboxed page with relaxed CSP).

**Execution flow:**

1. Code is checked for restricted navigation patterns
2. If code uses `browserjs(`, an overlay is injected into the active tab
3. A `SandboxIframe` is created and appended to the offscreen document (hidden)
4. Code is executed via `sandbox.execute()` with runtime providers
5. Results (console output, return value, files) are collected
6. Overlay is removed, sandbox iframe is cleaned up

**Parameters:** `{ title: string, code: string }`

### Runtime Providers (`packages/extension/src/agent/offscreen-tool-environment.ts`)

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

#### OffscreenBrowserJsRuntimeProvider

Provides `browserjs(fn, ...args)` to REPL scripts. Executes functions in the active tab's page context via `chrome.userScripts.execute()`.

**Execution path:**
1. REPL code calls `browserjs(() => document.title)`
2. The call is serialized as a runtime message (`type: "browser-js"`)
3. `OffscreenBrowserJsRuntimeProvider.handleMessage()` sends one correlated privileged operation to the background
4. The background resolves the exact authorized tab and loads matching skills from `SkillsStore`
5. The single wrapper builder adds skills, providers, artifacts, console capture, and arguments
6. The background executes it in the `USER_SCRIPT` world via `chrome.userScripts.execute()`
7. Results and artifact mutations return through the same offscreen execution

**Key details:**
- Uses a fixed `worldId: "shuvgeist-browser-script"` for all executions
- Configures CSP on the userScript world to block network/media access
- Supports `chrome.userScripts.terminate()` for cancellation (Chrome 138+)
- Injects `ConsoleRuntimeProvider` for each execution to capture page console output

#### OffscreenNavigateRuntimeProvider

Provides `navigate(args)` to REPL scripts. Wraps the `NavigateTool` so REPL code can trigger navigation:

```javascript
await navigate({ url: 'https://example.com' });
```

#### NativeInputEventsRuntimeProvider (`packages/extension/src/tools/NativeInputEventsRuntimeProvider.ts`)

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

### Extract Image Tool (`packages/extension/src/tools/extract-image.ts`)

Two modes:
- **`screenshot`**: Captures visible tab via `chrome.tabs.captureVisibleTab()`
- **`selector`**: Gets image src from DOM via `chrome.userScripts.execute()`, then fetches and resizes in extension context

Images are resized to `maxWidth` (default 800px) using `OffscreenCanvas`, converted to PNG base64, and returned as `ImageContent` for the LLM.

### Debugger Tool (`packages/extension/src/tools/debugger.ts`)

Two actions:
- **`eval`**: Executes JavaScript in the MAIN world via `chrome.debugger.sendCommand("Runtime.evaluate")`. Required for accessing page-scoped variables, framework state (React, Vue), and `window` properties set by page scripts.
- **`cookies`**: Gets all cookies for current domain via `chrome.cookies.getAll()`, including HttpOnly cookies when the extension has the `cookies` permission.

### Bridge Execution Helpers

Bridge-mode browser execution composes target-neutral engines from `packages/driver/src/` with Chrome adapters under `packages/extension/src/tools/helpers/`:

- `browser-target.ts` resolves explicit `tabId` / `frameId` targets and defaults to the active tab in the registered extension `windowId`. Bridge code never uses `currentWindow: true`.
- `debugger-manager.ts` centralizes Chrome debugger attach/detach ownership and domain enablement so `eval`, native input, network capture, screenshots, device emulation, and performance tracing can share one debugger lifecycle safely.
- `frame-resolver.ts` builds stable frame lists and frame trees from `chrome.webNavigation.getAllFrames()`.
- `page-driver.ts` is the target-neutral page boundary for evaluation, snapshots, ref resolution/actions, network capture, and screencast recording. Chrome debugger, bridge-local Electron WebSocket CDP, and direct-CDP runtimes compose the same driver rather than exposing raw CDP.
- `page-driver-identity.ts` scopes every result to a concrete session/window/page plus a navigation generation. Wire adapters map that scope to strict resolved Chrome-tab or Electron-window identities; numeric tab sentinels are not part of the neutral contract.
- `page-ref-engine.ts` owns in-memory semantic refs and fails closed on ambiguous matches, stale generations, or changed targets. `page-action-runtime.ts` implements DOM actions and `page-trusted-input.ts` implements renderer-scoped `Input.*` actions.
- `page-network-engine.ts` and `page-screencast-engine.ts` are the single capture implementations shared by all PageDriver bindings.
- `waits.ts` provides reusable navigation / DOM / network quiet waits for deterministic workflows.

### Bridge Target Routing

Bridge requests carry an optional top-level target. Chrome/Edge through the extension is the default target when the field is absent. Electron targets are explicit and use strings such as `electron:e1:w1`, `electron:e1:main`, `electron:vscode:w1`, or `electron:e1/w1` from the CLI.

Routing has three PageDriver bindings:

- Extension-relayed Chrome requests: `BridgeServer -> ExtensionClient -> BrowserCommandExecutor -> PageDriver -> chrome.debugger`.
- Bridge-local Electron requests: `BridgeServer -> ElectronSessionManager -> PageDriver -> renderer WebSocket CDP`.
- Direct-CDP runtime requests: `DirectCdpAgentSessionAdapter -> PageDriver -> renderer WebSocket CDP`.

Only the transport bindings issue CDP commands. PageDriver consumers receive target-neutral typed operations and cannot use a raw-CDP escape hatch.

Server-local Electron management commands (`electron list`, `electron allow`, `electron launch`, `electron attach`, `electron detach`, `electron windows`, and `electron label`) do not wait for an extension connection. Target-dispatched commands (`eval`, `screenshot`, `snapshot`, `locate`, `ref`, and `record`) use the Electron path only when an Electron target is present.

Bridge and Electron support is owned by `packages/server/src/` and `packages/server/src/electron/`:

- `node-config.ts`: the Node-side owner for bridge/discovery paths, client and serve resolution, OTEL, schema validation, and atomic unknown-preserving writes.
- `electron/app-registry.ts`: known app IDs, aliases, and executable resolution.
- `electron/config.ts`: Electron policy normalization and narrow adapters over the injected Node config owner.
- `electron/session-manager.ts`: launch/attach/detach state, stable window refs, labels, and cached per-window PageDriver ownership.
- `electron/cdp-client.ts`: minimal WebSocket CDP client for renderer commands and screencast events.

### Bridge Runtime Ownership

Bridge connection ownership now lives entirely in `packages/extension/src/background.ts`:

- canonical bridge settings live in `chrome.storage.local[BRIDGE_SETTINGS_KEY]`
- bridge connection state lives in `chrome.storage.session[BRIDGE_STATE_KEY]`
- the background worker lazily seeds default local settings and performs a one-time legacy IndexedDB migration when needed
- loopback bridge URLs bootstrap the local token from `GET /bootstrap` on the bridge server
- live changes to `enabled`, `url`, `token`, and `sensitiveAccessEnabled` are reconciled in background without sidepanel mirroring

The sidepanel no longer mirrors bridge config. `BridgeTab` reads and writes the canonical local-storage settings directly.

The Node server has a separate composition root in `packages/server/src/node-config.ts`, consumed by `packages/cli`. One injected owner supplies CLI connections, manual serve bindings, strict source-tree autostart, Node OTEL, Electron policy, doctor and snapshot paths, and ordered browser/extension discovery. Malformed Node config fails closed. Automatic startup accepts only the exact `/ws` path with no query or fragment, plain `ws://` transport, and exact host `localhost`, `127.0.0.1`, or `::1`; every other endpoint requires an explicitly managed server.

### Bridge Capability Surface

Bridge protocol registration remains flat-string based, while command metadata is schema-derived:

- `BridgeCommandDefinitions` is the declaration source for command identity, parameter/result schemas, routing, target support, capabilities, timeout policy, and CLI bindings.
- `BridgeMethods`, `BridgeCapabilities`, runtime validators, typed handler registries, and CLI planners are derived from those definitions.
- A target is advertised only when a handler exists for that target kind.

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
- `page-snapshot.ts` supplies the semantic snapshot surface consumed by PageDriver's shared ref engine.
- `page-network-engine.ts` maintains bounded per-page request capture and exports curl commands with default header redaction.
- `page-screencast-engine.ts` emits bounded image frames; the CLI alone performs ffmpeg encoding, keeping raw `sourceBytes` distinct from final `encodedSizeBytes`.
- `device-presets.ts` applies named or custom emulation profiles through the debugger-backed `Emulation.*` CDP commands.
- `performance-tools.ts` exposes one-shot metrics and bounded trace capture.

### Skill Tool (`packages/extension/src/tools/skill.ts`)

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

### Ask User Which Element (`packages/extension/src/tools/ask-user-which-element.ts`)

Interactive tool that lets users visually select DOM elements. Injects a picker UI into the page.

---

## Message Passing Architecture

### 1. Sidepanel Ports: Presentation and Runtime

The sidepanel opens a `sidepanel:${windowId}:${documentNonce}:${continuationToken}:${transactionId}:${leaseId}` port for session locks and live document/window tracking, plus an `agent-runtime:${clientId}:${windowId}:${documentNonce}:${continuationToken}:${transactionId}:${leaseId}` port for typed intents, snapshots, and stream events.

```
Sidepanel                          Background Service Worker
   │                                        │
   ├─── connect("sidepanel:${windowId}:${nonce}:${token}:${tx}:${lease}") >│  locks + authenticated document/window tracking
   │                                        │
   ├─── acquireLock { sessionId, windowId } >│
   │<── lockResult { success, ownerWindowId }│
   │                                        │
   ├─── getLockedSessions ────────────────> │
   │<── lockedSessions { locks } ───────────│
   │                                        │
   ├─── connect("agent-runtime:${clientId}:${windowId}:${nonce}:${token}:${tx}:${lease}") >│
   ├─── descriptor + typed intents ─────────>│
   │<── snapshots + stream envelopes ───────────│
```

Chrome can report `windowId: -1` for a real side-panel context. The background therefore treats `chrome.sidePanel.onOpened` as the only source of browser-window authority and binds its window to exactly one newly live sidepanel document identity; ambiguous or overlapping openings fail closed. Each document generates a canonical random nonce and installs it with `history.replaceState`, allowing `chrome.runtime.getContexts()` to expose a unique join key without putting a credential in the URL.

Before either port opens, the sidepanel and background complete a staged capability ratchet. Authority is persisted in `chrome.storage.session` as one strict `opened`, `pending`, or `active` record per window. An initial open or authenticated reload first persists a pending document, fresh verifier, transaction, and lease. The background returns the corresponding cryptographically random raw token only after that write; the sidepanel retains raw current and pending tokens only in its top-level `sessionStorage`, then explicitly confirms the pending transaction. Pending records authenticate no ports. Confirmation persists the active record before either named port can connect. This prepare/confirm split permits safe recovery if the service worker stops before delivering a token or acknowledgement, while a pre-confirm document reload advances the pending capability in one direction rather than falling back to browser focus or a claimed window.

A full reload rotates the exact `contextId`/`documentId` identity, document nonce, continuation token verifier, and lease generation. Port admission transiently hashes the presented token, joins the nonce to exactly one raw live `SIDE_PANEL` context, and requires the claimed window plus active document and lease to match. Chrome may expose only `id`, `origin`, and a stale committed URL on `MessageSender`/`Port.sender`, so that URL is checked against a strict sidepanel route grammar but its nonce is never used as authority; the fresh nonce comes only from the unique raw `getContexts()` match. The raw token is never retained in authority state, runtime descriptors, checkpoints, registries, telemetry, or logs. Replacing or closing a browser window revokes its verifier and lease. Runtime messages, stream delivery, tracking state writes, and disconnect handlers are generation-fenced, so a delayed old-document message or disconnect cannot affect its replacement. Browser focus and tracking-port state are never sources of window authority.

Closing the sidepanel disconnects presentation ports but intentionally leaves its accepted descriptor and offscreen session alive. Closing the browser window releases both. Both ports reconnect after service-worker suspension.

**Request/response typing:** `REQUEST_TO_RESPONSE_TYPE` maps presentation requests to responses; the agent runtime uses validated protocol envelopes and explicit request/event correlation.

### 2. Runtime Message Router: Offscreen Sandbox <-> Providers

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
   │   OffscreenBrowserJsRuntimeProvider.handleMessage()
   │       │
   │       ▼
   │   correlated page operation → Background → authorized active tab
   │       │
   │       ▼
   │   respond({ success, result, console })
   │
   ├── sendRuntimeMessage({ type: "navigate", args })
   │       ▼
   │   OffscreenNavigateRuntimeProvider.handleMessage()
   │
   ├── sendRuntimeMessage({ type: "native-input", action, ... })
   │       ▼
   │   OffscreenNativeInputRuntimeProvider.handleMessage()
```

The old `BrowserJsRuntimeProvider` and `NavigateRuntimeProvider` exports remain as deprecated compatibility adapters, but inherit these canonical implementations and contain no second sandbox runtime body.

### 3. userScript Messages: Page <-> Runtime

The REPL overlay carries its exact parent execution identity. Abort messages are validated and routed to one offscreen request rather than broadcast to whichever sidepanel happens to exist:

```
Page (USER_SCRIPT world)
   │
   ├── chrome.runtime.sendMessage({ type: "agent-runtime-abort-intent", ...identity })
   │       │
   │       ▼
   │   Background (chrome.runtime.onUserScriptMessage)
   │       │
   │       ▼
   │   AgentRuntimeCoordinator validates descriptor + execution correlation
   │       │
   │       ▼
   │   OffscreenRuntimeController aborts the exact active request
```

### 4. Tab Event Steering

`background.ts` listens for tab activation and completed navigation. `AgentRuntimeNavigationSteering` serializes events per window, rechecks the accepted descriptor after asynchronous snapshot/skill work, and steers only a matching streaming session.

```typescript
chrome.tabs.onUpdated.addListener(...)   // URL changes on active tab
chrome.tabs.onActivated.addListener(...) // User switches tabs
```

The pure `createNavigationMessage()` builder is safe in the service worker. The sidepanel owns no tab listeners and does not mutate navigation context.

---

## Storage (`packages/extension/src/storage/`)

All data is stored locally in IndexedDB via `ShuvgeistAppStorage`:

| Store | Contents |
|-------|----------|
| `SessionsStore` | Conversation history, metadata (title, usage, preview) |
| `SkillsStore` | Domain-specific automation libraries with glob patterns |
| `CostStore` | Per-model token costs |
| `SettingsStore` | Typed durable preferences owned by `packages/extension/src/storage/persistent-settings.ts` and domain accessors |
| `ProviderKeysStore` | API keys and OAuth credentials per provider |
| `CustomProvidersStore` | User-defined AI provider configurations |

Session locking prevents concurrent editing: `background.ts` tracks `sessionId -> windowId` mapping through the typed transient-state adapter in `packages/extension/src/bridge/runtime-state.ts`. `chrome.storage.session` survives service-worker suspension but is cleared with the browser session; it is not a durable settings store.

---

## Execution Contexts

The extension operates across multiple isolated JavaScript contexts:

| Context | Access | Used By |
|---------|--------|---------|
| **Sidepanel extension page** | Chrome runtime/storage APIs and UI DOM | Thin remote-agent presentation, settings, session selection |
| **Background service worker** | Privileged Chrome APIs, IndexedDB, no DOM | Runtime coordination, bridge ownership, page authorization/execution |
| **Offscreen document** (offscreen.html) | DOM + iframe creation, `chrome.runtime` messaging, IndexedDB — but **no** `chrome.tabs` / `chrome.userScripts` / `chrome.debugger` | Persistent Agent sessions, REPL sandboxes, artifacts, TTS |
| **Sandbox** (sandbox.html iframe) | `unsafe-eval`, CDN access, no Chrome APIs | REPL code execution |
| **USER_SCRIPT world** | Page DOM (isolated JS scope), `chrome.runtime.sendMessage` | `browserjs()`, overlay, extract_image |
| **MAIN world** | Page's actual JS scope (variables, frameworks, localStorage) | Debugger tool `eval` action |

Key isolation: USER_SCRIPT world can see the DOM but not page JavaScript variables. MAIN world access requires the debugger tool (attaches Chrome debugger).

### Persistent Agent and REPL Runtime

Sidepanel prompts and bridge `repl` requests use the same offscreen session and the same provider instances. `PureOffscreenAgentToolRuntime` creates the REPL sandbox, provider set, tool set, shown-skill state, planner memory, and artifact store for one exact client/window/session target.

The offscreen document has the DOM needed for the sandbox but intentionally does not own privileged Chrome page APIs. Providers send typed `agent-runtime-page-operation` messages through `OffscreenRuntimeController`; `AgentRuntimePageController` authorizes the descriptor window and concrete tab targets before delegating to background-owned PageDriver, navigation, browserjs, screenshot, element selection, image extraction, or debugger code.

There is no `bg-runtime-exec` protocol and no hand-written offscreen proxy module. BrowserJS wrapper generation has one canonical builder shared by every entry point. The provider/runtime channel also carries nested native input, page console output, attachment data, and artifact mutations back to the owning offscreen session.

Session state is durable in IndexedDB and the background stores a typed runtime checkpoint in `chrome.storage.session`. The offscreen host therefore survives sidepanel close, and can recover the same session and replay cursor after a service-worker restart.

---

## Build System

### Entry Points (`packages/extension/scripts/build.mjs`)

```javascript
{
    sidepanel: 'packages/extension/src/sidepanel.ts',
    debug: 'packages/extension/src/debug.ts',
    icons: 'packages/extension/src/icons.ts',
    background: 'packages/extension/src/background.ts',
    offscreen: 'packages/extension/src/offscreen.ts'
}
```

### Build Pipeline

1. **esbuild** bundles TypeScript to ESM (target: Chrome 120+)
2. **Tailwind CSS** compiles `packages/extension/src/app.css` to `dist-chrome/app.css`
3. Static assets copied from `static/` (manifest, icons, HTML shells)
4. PDF.js worker copied for document preview

### Dev Mode (`npm run dev`)

Three concurrent watchers:
1. esbuild watch (TypeScript)
2. Tailwind CSS watch
3. Dev server with hot reload injection

### Quality Checks (`./check.sh`)

1. **Biome** formats and lints package, root-script, and test sources.
2. **Workspace boundary guard** verifies the declared package DAG, exact internal versions, source exports, and import isolation.
3. **TypeScript** delegates to each workspace's local `tsconfig.json`.
4. **Vitest** runs the root unit and integration suites, followed by the independent site check.

Pre-commit hook via Husky runs `check.sh`.

---

## Linked Dependencies

The extension intentionally links Mini Lit from a sibling checkout. Pi packages use explicit lockstep registry versions:

| Package | Source | Purpose |
|---------|--------|---------|
| `@mariozechner/mini-lit` | `../../../mini-lit` from `packages/extension` | Intentional local development link |
| `@shuv1337/pi-agent-core` | npm, exact lockstep version | Agent class, tool interfaces, agent loop |
| `@shuv1337/pi-ai` | npm, exact lockstep version | Model/provider abstractions, streaming |
| `@shuv1337/pi-web-ui` | npm, exact lockstep version | ChatPanel, SandboxIframe, settings UI |

Local Mini Lit changes and sibling Pi development changes must be rebuilt before rebuilding Shuvgeist. See `docs/dependencies.md` for the dependency policy.

---

## Key File Map

```
packages/
├── protocol/src/                    Command schemas, protocol contracts, targets, version
├── driver/src/                      PageDriver, semantic refs, capture engines, injected driver code
├── extension/src/
│   ├── background.ts                Service-worker coordinator and authorized page operations
│   ├── offscreen.ts                 Persistent agent/tool runtime composition root
│   ├── sidepanel.ts                 Thin remote-session UI and settings composition root
│   ├── agent/                       Offscreen session runtime and presentation transport
│   ├── tools/                       Chrome tools, adapters, REPL, renderers
│   ├── storage/                     IndexedDB and typed browser-storage owners
│   ├── dialogs/                     Settings and first-run UI
│   └── injected/                    Chrome-only injected entry points and generated descriptor
├── server/src/
│   ├── server.ts                    Local bridge server
│   ├── node-config.ts               Node configuration authority
│   ├── electron/                    Electron discovery, policy, sessions, and execution
│   └── mcp/                         Streamable-HTTP MCP server and tool adapter
└── cli/src/
    ├── cli.ts                       Public command entry point
    ├── cli-core.ts                  CLI planning and response handling
    ├── bridge-autostart.ts          Strict development-source bridge startup
    └── headless/                    Direct-CDP runtime
scripts/
├── injected-artifacts.mjs           Cross-package injected-artifact generator
├── check-workspace-boundaries.mjs   Package graph and boundary guard
└── count-tokens.ts                  Prompt token estimation
static/manifest.chrome.json          Core version authority and extension manifest
```
