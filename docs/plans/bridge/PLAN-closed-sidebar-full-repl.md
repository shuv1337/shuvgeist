# Plan: Closed Sidebar + Full browserjs REPL

Enable `browserjs()`, `navigate()`, and native input helpers (`nativeClick`, `nativeType`, `nativePress`, `nativeKeyDown`, `nativeKeyUp`) in REPL when the sidepanel is closed. Currently the offscreen-document path executes sandbox-only JavaScript with no page interaction.

## Problem Analysis

### Current Architecture (sidepanel open)

```
CLI → Bridge Server → Background SW → chrome.runtime.sendMessage → Sidepanel
  Sidepanel creates:
    SandboxIframe (in sidepanel DOM)
      → sandbox code calls browserjs()
      → sendRuntimeMessage({type:"browser-js"}) via window.parent.postMessage
      → RuntimeMessageRouter in sidepanel routes to BrowserJsRuntimeProvider
      → BrowserJsRuntimeProvider calls chrome.userScripts.execute() in page
      → Result flows back through router → sandbox → sidepanel → background → CLI
```

### Current Architecture (sidepanel closed)

```
CLI → Bridge Server → Background SW → chrome.runtime.sendMessage → Offscreen doc
  Offscreen doc creates:
    SandboxIframe (in offscreen DOM)
      → sandbox.execute(sandboxId, code, [], [])  ← EMPTY PROVIDERS
      → browserjs is undefined, navigate is undefined, nativeClick is undefined
```

### Chrome API Constraints

| API | Background SW | Offscreen Doc | Sidepanel |
|-----|:---:|:---:|:---:|
| DOM / iframe creation | ✗ | ✓ | ✓ |
| `chrome.tabs` | ✓ | ✗ | ✓ |
| `chrome.userScripts` | ✓ | ✗ | ✓ |
| `chrome.debugger` | ✓ | ✗ | ✓ |
| `chrome.webNavigation` | ✓ | ✗ | ✓ |
| `chrome.runtime` messaging | ✓ | ✓ | ✓ |
| IndexedDB | ✓ | ✓ | ✓ |

The offscreen document has DOM access (can host SandboxIframe) but no Chrome extension APIs beyond `chrome.runtime`. The background service worker has full Chrome API access but no DOM. Neither can do both.

### Key Insight

The offscreen document is the right place to host the SandboxIframe (it already does). It needs **proxy runtime providers** that inject the same `browserjs()` / `navigate()` / `nativeClick()` globals into the sandbox but relay their `handleMessage()` calls to the background service worker via `chrome.runtime.sendMessage`. Background handles the actual Chrome API operations and responds.

## Architecture

```
Offscreen doc                         Background SW
  SandboxIframe                           │
    sandbox code calls browserjs()        │
      ↓                                   │
    sendRuntimeMessage({type:"browser-js"})│
      ↓ (window.parent.postMessage)       │
    RuntimeMessageRouter                  │
      ↓                                   │
    OffscreenBrowserJsProxy.handleMessage()│
      ↓                                   │
    chrome.runtime.sendMessage ──────────→│ onMessage handler
      ({type:"bg-runtime-exec",           │   ↓
        runtimeType:"browser-js", ...})   │ handleBrowserJs()
                                          │   ↓
                                          │ resolveTabTarget()
                                          │ loadSkills()
                                          │ buildDirectWrapperCode()
                                          │ chrome.userScripts.execute()
                                          │   ↓
                                          │ (page USER_SCRIPT world runs code)
                                          │   ↓
                                          │ result returned
    ←──────────── sendResponse ───────────│
      ↓                                   │
    proxy responds to sandbox              │
      ↓                                   │
    browserjs() returns value              │
```

Same relay pattern for `navigate()` and `nativeClick()` etc.

## Implementation Plan

### Task 1: Background Storage Initialization

`BrowserJsRuntimeProvider.handleMessage()` calls `getShuvgeistStorage().skills` to load domain-matched skill libraries. Background currently has no `ShuvgeistAppStorage` instance.

- [ ] In `src/background.ts`, lazily initialize `ShuvgeistAppStorage` and call `setAppStorage()` on first use
- [ ] Gate behind a helper: `function ensureBackgroundStorage(): ShuvgeistAppStorage`
- [ ] IndexedDB is available in service workers; `ShuvgeistAppStorage` should work without changes
- [ ] Validate: skills loaded via `storage.skills.getSkillsForUrl(url)` return correct results

**Files:**
- `src/background.ts` — add lazy storage init

**Validation:** Write a minimal test or manual check that background can read skills from IndexedDB.

---

### Task 2: Internal Message Types

Define the message shapes for offscreen → background runtime proxy communication.

- [ ] Add `BgRuntimeExecMessage` type to `src/bridge/internal-messages.ts`:
  ```typescript
  export interface BgRuntimeExecMessage {
    type: "bg-runtime-exec";
    runtimeType: "browser-js" | "navigate" | "native-input";
    payload: Record<string, unknown>;
    windowId?: number;
  }

  export interface BgRuntimeExecResponse {
    success: boolean;
    result?: unknown;
    error?: string;
    stack?: string;
    console?: Array<{ type: string; text: string }>;
  }
  ```
- [ ] Add to `BridgeToOffscreenMessage` union? No — this goes offscreen → background, not background → offscreen. It uses `chrome.runtime.sendMessage` which is a broadcast; background receives it in `chrome.runtime.onMessage`.

**Files:**
- `src/bridge/internal-messages.ts`

---

### Task 3: Background `browserjs` Handler

Implement the core of `BrowserJsRuntimeProvider.handleMessage()` in background without depending on `RUNTIME_MESSAGE_ROUTER` or DOM.

- [ ] Create `src/bridge/background-runtime-handler.ts`
- [ ] Implement `handleBgBrowserJs(payload, windowId)`:
  1. Resolve active tab via `resolveTabTarget({ windowId })`
  2. Validate tab URL (reject chrome://, about:, etc.)
  3. Load skills for tab URL from `ensureBackgroundStorage().skills.getSkillsForUrl(url)`
  4. Build a self-contained wrapper code string via a new `buildDirectBrowserJsCode()` function (see Task 4)
  5. Configure `chrome.userScripts.configureWorld({ worldId, messaging: true, csp: ... })`
  6. Call `chrome.userScripts.execute({ js: [{code}], target: {tabId}, world: "USER_SCRIPT", worldId, injectImmediately: true })`
  7. Extract `result[0].result` → `{ success, lastValue, console, error, stack }`
  8. Register a temporary `onUserScriptMessage` handler for native-input calls from within skills (scoped by sandboxId, cleaned up after execute resolves)
  9. Return `BgRuntimeExecResponse`

**Key difference from `BrowserJsRuntimeProvider.handleMessage()`:** Does NOT use `RUNTIME_MESSAGE_ROUTER`, does NOT create `ConsoleRuntimeProvider` instance, captures console output inside the wrapper code itself.

**Files:**
- `src/bridge/background-runtime-handler.ts` (new)

---

### Task 4: Direct Wrapper Code Builder

`buildWrapperCode()` in `userscripts-helpers.ts` calls `RUNTIME_MESSAGE_ROUTER.registerSandbox()` which requires `window`. We need a variant that skips router registration.

- [ ] Create `buildDirectBrowserJsCode()` in `src/bridge/background-runtime-handler.ts` (or a shared helper):
  - Generates `RuntimeMessageBridge.generateBridgeCode({ context: "user-script", sandboxId })` for `sendRuntimeMessage` (needed by native input calls from within skills)
  - Injects `NativeInputEventsRuntimeProvider.getRuntime()` (stringified, injects `nativeClick` etc.)
  - Overrides `console.log/warn/error/info` to capture into a local array (not via `sendRuntimeMessage`)
  - Injects skill library code
  - Wraps user function code with args
  - Returns `{ success, lastValue, console: [...], error, stack }`
  - Does NOT call `RUNTIME_MESSAGE_ROUTER.registerSandbox()`
  - Does NOT inject `ConsoleRuntimeProvider` (console captured locally in the wrapper)

- [ ] The wrapper template:
  ```javascript
  (async function() {
    const __consoleLogs = [];
    const __origConsole = { log: console.log.bind(console), ... };
    console.log = (...args) => {
      const text = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      __consoleLogs.push({ type: 'log', text });
      __origConsole.log(...args);
    };
    // ... same for warn, error, info

    // Bridge code (for sendRuntimeMessage used by nativeClick etc.)
    BRIDGE_CODE_HERE

    // NativeInput runtime injection
    NATIVE_INPUT_RUNTIME_HERE

    // Skills
    SKILL_LIBRARY_HERE

    try {
      const __func = USER_CODE;
      const __result = await __func(ARGS);
      return { success: true, lastValue: __result, console: __consoleLogs };
    } catch (e) {
      return { success: false, error: e.message, stack: e.stack, console: __consoleLogs };
    }
  })()
  ```

**Files:**
- `src/bridge/background-runtime-handler.ts`

**Validation:** Unit test that `buildDirectBrowserJsCode()` produces valid, self-contained JavaScript.

---

### Task 5: Background `navigate` Handler

- [ ] In `src/bridge/background-runtime-handler.ts`, implement `handleBgNavigate(payload, windowId)`:
  1. Create `NavigateTool({ windowId })`
  2. Call `navigateTool.execute("bridge-navigate", payload)`
  3. Return `{ success: true, result: { finalUrl, title, skills } }`
  4. Catch errors → `{ success: false, error: message }`

**Files:**
- `src/bridge/background-runtime-handler.ts`

---

### Task 6: Background `native-input` Handler

- [ ] In `src/bridge/background-runtime-handler.ts`, implement `handleBgNativeInput(payload, windowId)`:
  1. Create `NativeInputEventsRuntimeProvider({ windowId, debuggerManager: getSharedDebuggerManager() })`
  2. Call `provider.handleMessage(payload, respond)` where `respond` resolves a Promise
  3. Return the response

`NativeInputEventsRuntimeProvider.handleMessage()` uses `chrome.debugger` and `resolveTabTarget` — both available in the service worker.

**Files:**
- `src/bridge/background-runtime-handler.ts`

---

### Task 7: Background `onUserScriptMessage` Routing for Active Executions

When background-initiated `chrome.userScripts.execute()` runs code that calls `nativeClick()` (from within a skill), the page sends a `chrome.runtime.sendMessage({type: "native-input", ...})` message. Background's existing `onUserScriptMessage` handler only processes `abort-repl`. It needs to also route runtime messages for active executions.

- [ ] In `src/background.ts`, maintain a `Map<string, { providers: Map<string, handler> }>` keyed by sandboxId for active background-initiated executions
- [ ] Extend `chrome.runtime.onUserScriptMessage.addListener` to check if the message's `sandboxId` matches an active execution
- [ ] If matched, route to the appropriate handler (native-input → NativeInputEventsRuntimeProvider, console → respond with {success: true})
- [ ] Clean up map entry after `chrome.userScripts.execute()` resolves
- [ ] If no match, fall through to existing abort-repl handling

**Files:**
- `src/background.ts`

---

### Task 8: Background Message Listener for Offscreen Proxy

- [ ] In `src/background.ts`, add handler in `chrome.runtime.onMessage.addListener` for `type: "bg-runtime-exec"`:
  ```typescript
  if (message.type === "bg-runtime-exec") {
    const { runtimeType, payload, windowId } = message;
    handleBgRuntimeExec(runtimeType, payload, windowId ?? currentWindowId)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async
  }
  ```
- [ ] Import and call handlers from `background-runtime-handler.ts`

**Files:**
- `src/background.ts`

---

### Task 9: Offscreen Proxy Runtime Providers

Create providers that mirror the real provider interfaces but relay to background.

- [ ] Create `src/bridge/offscreen-runtime-providers.ts`
- [ ] `OffscreenBrowserJsProxy` implements `SandboxRuntimeProvider`:
  - `getRuntime()`: Injects `browserjs()` function identical to `BrowserJsRuntimeProvider.getRuntime()` — calls `sendRuntimeMessage({type: "browser-js", code, args})`
  - `handleMessage()`: If `message.type === "browser-js"`, forward to background via `chrome.runtime.sendMessage({type: "bg-runtime-exec", runtimeType: "browser-js", payload: message})`, await response, call `respond()`
  - `getDescription()`: Returns `BROWSERJS_RUNTIME_PROVIDER_DESCRIPTION`

- [ ] `OffscreenNavigateProxy` implements `SandboxRuntimeProvider`:
  - `getRuntime()`: Injects `navigate()` function identical to `NavigateRuntimeProvider.getRuntime()`
  - `handleMessage()`: If `message.type === "navigate"`, forward to background `{type: "bg-runtime-exec", runtimeType: "navigate", payload: message.args}`
  - `getDescription()`: Returns `NAVIGATE_RUNTIME_PROVIDER_DESCRIPTION`

- [ ] `OffscreenNativeInputProxy` implements `SandboxRuntimeProvider`:
  - `getRuntime()`: Injects `nativeClick`, `nativeType`, `nativePress`, `nativeKeyDown`, `nativeKeyUp` — identical to `NativeInputEventsRuntimeProvider.getRuntime()`
  - `handleMessage()`: If `message.type === "native-input"`, forward to background `{type: "bg-runtime-exec", runtimeType: "native-input", payload: message}`
  - `getDescription()`: Returns `NATIVE_INPUT_EVENTS_DESCRIPTION`

- [ ] Export `buildOffscreenRuntimeProviders(): SandboxRuntimeProvider[]`

**Files:**
- `src/bridge/offscreen-runtime-providers.ts` (new)

---

### Task 10: Wire Providers into Offscreen Document

- [ ] In `src/offscreen.ts`, import `buildOffscreenRuntimeProviders`
- [ ] In `executeRepl()`, replace `sandbox.execute(sandboxId, code, [], [])` with:
  ```typescript
  const providers = buildOffscreenRuntimeProviders();
  const result = await sandbox.execute(sandboxId, code, providers, []);
  ```

**Files:**
- `src/offscreen.ts`

**Validation:** `shuvgeist repl 'return 1+1'` works with sidepanel closed (basic sanity). `shuvgeist repl 'return await browserjs(() => document.title)'` returns the page title with sidepanel closed.

---

### Task 11: Pass `windowId` to Offscreen

The offscreen proxy providers need to tell background which window to target. The offscreen document does not know the current window.

- [ ] Option A: Include `windowId` in the `bridge-repl-execute` message from background → offscreen. Background already knows `currentWindowId`.
  - Modify `BridgeToOffscreenMessage` to include optional `windowId`
  - Modify background replRouter to include `windowId` in the message
  - Offscreen passes `windowId` through to proxy providers
  - Proxy providers include `windowId` in `bg-runtime-exec` messages

- [ ] Option B: Background handler resolves windowId itself from its own `currentWindowId` cache. Simpler but slightly less explicit.

Recommend Option A for correctness.

**Files:**
- `src/bridge/internal-messages.ts` — add `windowId` to `BridgeToOffscreenMessage` repl message
- `src/background.ts` — include `windowId` when sending to offscreen
- `src/offscreen.ts` — pass `windowId` through to providers
- `src/bridge/offscreen-runtime-providers.ts` — accept and forward `windowId`

---

### Task 12: Overlay Injection (Optional Enhancement)

When code uses `browserjs(`, the sidepanel path injects a visual overlay into the active tab (`injectOverlayForActiveTab`). This requires `chrome.userScripts.execute()` which the offscreen document lacks.

- [ ] Option A: Background handles overlay injection via a new message type. Offscreen sends `bg-runtime-exec` with `runtimeType: "overlay-inject"` / `"overlay-remove"`, background calls `injectOverlay()` / `removeOverlay()`.
- [ ] Option B: Skip overlay for offscreen path. The overlay is cosmetic (shows task name, abort button). CLI users may not need it.

Recommend Option B initially; add Option A later if needed.

**Files:** None initially.

---

### Task 13: Build Entry Point for Offscreen

The build script (`scripts/build.mjs`) bundles `src/offscreen.ts` as a separate entry point. Adding new imports to `offscreen.ts` will automatically include them in the bundle. Verify the new imports don't pull in DOM-dependent code that would fail at import time in the offscreen context.

- [ ] Check that `offscreen-runtime-providers.ts` does not transitively import anything that accesses `window` at module load time
- [ ] The prompts import (`BROWSERJS_RUNTIME_PROVIDER_DESCRIPTION` etc.) should be side-effect-free
- [ ] `RuntimeMessageBridge` import is fine (static class, no side effects)
- [ ] Run `npm run build` and verify `dist-chrome/offscreen.js` builds cleanly

**Files:**
- `scripts/build.mjs` — verify `offscreen` entry point (likely already present)

---

### Task 14: CHANGELOG and Documentation

- [ ] Update `CHANGELOG.md` `[Unreleased]` section
- [ ] Update `ARCHITECTURE.md` execution contexts table to note offscreen now has proxy providers
- [ ] Update `skills/shuvgeist/SKILL.md` if any CLI behavior changes

**Files:**
- `CHANGELOG.md`
- `ARCHITECTURE.md`

---

## Implementation Order

```
Task 2  (message types)           ─── foundation
Task 1  (background storage)      ─── foundation
Task 4  (direct wrapper builder)  ─── depends on nothing, can parallel with 1-2
Task 3  (bg browserjs handler)    ─── depends on 1, 2, 4
Task 5  (bg navigate handler)     ─── depends on 1, 2
Task 6  (bg native-input handler) ─── depends on 2
Task 7  (bg onUserScriptMessage)  ─── depends on 3
Task 8  (bg message listener)     ─── depends on 3, 5, 6
Task 9  (offscreen proxies)       ─── depends on 2
Task 11 (windowId passing)        ─── depends on 9
Task 10 (wire offscreen)          ─── depends on 9, 11
Task 13 (build verification)      ─── depends on 10
Task 12 (overlay, optional)       ─── independent, defer
Task 14 (docs)                    ─── last
```

Parallel tracks:
- **Track A** (Tasks 1, 3, 4, 7): Background browserjs execution
- **Track B** (Tasks 5, 6): Background navigate + native-input
- **Track C** (Tasks 9, 11): Offscreen proxy providers
- **Join** (Tasks 2, 8, 10, 13): Wire everything together

## Validation Plan

### Smoke Tests (manual)

1. `shuvgeist repl 'return 1+1'` with sidepanel closed → `=> 2`
2. `shuvgeist repl 'return await browserjs(() => document.title)'` with sidepanel closed → page title
3. `shuvgeist repl 'await navigate({url: "https://example.com"}); return await browserjs(() => document.title)'` → `"Example Domain"`
4. `shuvgeist repl 'return await browserjs(() => { console.log("hello"); return 42; })'` → output includes `[browserjs] hello` and `=> 42`
5. Repeat tests 2-4 with sidepanel open → same results (regression check)
6. `shuvgeist status --json` shows `repl` in capabilities regardless of sidepanel state

### Automated Tests

- [ ] Unit test for `buildDirectBrowserJsCode()` output validity
- [ ] Unit test for background runtime handler message routing
- [ ] Unit test for offscreen proxy provider message forwarding
- [ ] Integration test: mock chrome APIs, verify end-to-end message flow

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `chrome.userScripts.execute()` behaves differently from SW vs extension page | Low | High | Chrome 135+ docs confirm SW support; test early |
| IndexedDB in SW has stale data after extension update | Low | Medium | Skills rarely change; acceptable for bridge use |
| `chrome.runtime.sendMessage` race between offscreen and sidepanel handlers | Medium | Medium | Background already routes to sidepanel first; offscreen only receives when sidepanel is closed |
| Native-input messages from user scripts during background-initiated execution arrive after execute() resolves | Medium | High | Use a timeout or track pending responses; ensure wrapper awaits all sendRuntimeMessage calls before returning |
| Bundle size increase from new offscreen imports | Low | Low | Proxy providers are thin; prompts module already shared |
