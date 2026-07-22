# Plan: CLI-to-Extension Bridge

Allow external CLI coding agents (Pi, Claude Code, etc.) to control the browser through the installed Shuvgeist extension.

This revision reflects the current codebase and updates the plan so that **LAN connectivity is a first-class V1 requirement**. The MVP must support the CLI, bridge server, and extension running on different hosts within the same secure local test network.

## Relevant Codebase Alignment

- Browser tool construction currently happens in `src/sidepanel.ts`
- Browser control tools already exist:
  - `src/tools/navigate.ts`
  - `src/tools/repl/repl.ts`
  - `src/tools/extract-image.ts`
  - `src/tools/debugger.ts`
  - `src/tools/ask-user-which-element.ts`
- Current settings UI tabs live under `src/dialogs/`
- Current extension permissions/CSP live in `static/manifest.chrome.json`
- Current build pipeline is Chrome-only in `scripts/build.mjs`
- Current repo typecheck is browser-oriented in `tsconfig.build.json`

---

## Goals

1. Let a CLI send browser commands to the Shuvgeist sidepanel.
2. Reuse existing Shuvgeist tool behavior instead of reimplementing browser automation.
3. Support both:
   - same-host operation
   - multi-host operation on the same secure local network
4. Keep the initial version explicit, debuggable, and low-risk for a trusted local test LAN.
5. Avoid hidden background processes and minimize changes to the current dev workflow.

## Non-Goals for V1

- internet-exposed bridge deployments
- public/WAN access
- multi-profile or multi-browser orchestration
- natural-language prompt streaming into the sidepanel agent
- daemon/process-manager behavior
- publishing a separate npm package immediately
- cookie extraction in the MVP unless explicitly enabled later
- production-grade transport hardening; that is Phase 2

---

## Deployment Model for V1

The architecture must support all of these topologies:

### A. Same host

- browser + extension on Host A
- bridge server on Host A
- CLI on Host A

### B. Split host

- browser + extension on Host A
- bridge server on Host A or Host B
- CLI on Host B

### C. Third host relay

- browser + extension on Host A
- bridge server on Host B
- CLI on Host C

Constraint: all participating hosts must be reachable on the same trusted local test network.

The bridge server is always the rendezvous point. The extension and CLI never connect directly to each other.

---

## Core Constraints

### 1. The bridge must live in the sidepanel, not the background worker

`NavigateTool`, REPL/browserjs, screenshot capture, debugger access, and element selection all depend on sidepanel-owned state and APIs. The background worker does not currently own those tool instances or the supporting DOM/runtime environment.

Implication: the bridge only works while a Shuvgeist sidepanel is open.

### 2. V1 must define a single active extension target

The current app can be opened in multiple Chrome windows. Each sidepanel instance is tied to its own window/tab context. A relay that simply forwards to “the extension” is underspecified.

V1 rule:
- only one extension bridge client may be active at a time
- the bridge server tracks that client as the active target
- if another sidepanel connects, it either replaces the existing one explicitly or is rejected with a clear error

This avoids ambiguous execution against the wrong browser window.

### 3. V1 must support non-loopback network addresses

The earlier local-only assumption is no longer valid. The bridge server must support a host/address that is reachable from other machines on the LAN.

Implications:
- server bind host must be configurable
- extension bridge URL must support remote LAN hosts, not just localhost
- CLI must support remote bridge URLs
- documentation and settings UX must assume bridge host/IP entry is normal, not exceptional

### 4. The extension CSP must explicitly allow LAN bridge traffic

Current `static/manifest.chrome.json` only defines `script-src`/`object-src` for `extension_pages`. The plan cannot assume sidepanel WebSockets to arbitrary LAN bridge URLs work without a CSP update.

### 5. Node bridge code needs separate build/typecheck support

Current TS config is browser-only (`types: ["chrome"]`). New Node entry points under `src/bridge/` would fail `tsc --noEmit` unless we add separate Node typing/build support.

### 6. V1 security is based on trusted-network assumptions

The user explicitly wants LAN connectivity in the MVP and hardening later. That means V1 must be designed around a **secure local test network** assumption.

Implications:
- no TLS in V1
- no public-network posture in V1
- no claim that V1 is safe for hostile/untrusted networks
- Phase 2 must harden the design before broader deployment

---

## Revised Architecture

```text
CLI Agent                    Bridge Server                Shuvgeist Sidepanel
(Pi, Claude Code)            (Node.js, LAN host)          (active browser window)
      │                            │                             │
      ├── ws connect ─────────────>│<──────── ws connect ───────┤
      │                            │                             │
      │   request(id, method)      │                             │
      │───────────────────────────>│──────── forward ───────────>│
      │                            │                             │
      │                            │    execute existing tool    │
      │                            │<────── result/error ────────│
      │<──────── result/error ─────│                             │
      │                            │                             │
      │<────────── events ─────────│<──────── status events ─────│
```

Three components:

1. **Bridge Server** — lightweight relay process reachable from the trusted LAN.
2. **Extension Bridge Client** — WebSocket client in the sidepanel that executes commands against existing Shuvgeist tool behavior.
3. **CLI Client** — standalone `shuvgeist` command for one-shot browser commands.

---

## Trust and Security Model

## V1 baseline trust model

V1 is intended for a **secure local test network**.

That means:
- bridge traffic may traverse the LAN in plaintext
- the bridge may bind to a non-loopback interface
- the operator is responsible for running it only on a trusted private network
- the bridge is not intended for coffee-shop Wi‑Fi, the public internet, or general untrusted environments

## Minimum safeguards retained in V1

Even with hardening deferred, V1 should still keep the lowest-cost safeguards that materially reduce accidental misuse:

- shared bridge token required for registration
- single active extension target
- non-sensitive command set only
- structured logs for connection and command activity

These are baseline safety measures, not the full hardening phase.

## Explicitly deferred to Phase 2 hardening

- TLS / `wss://`
- mutual authentication / stronger client identity
- host allowlists / subnet restrictions
- pairing or approval UX in the extension
- token rotation and revocation UX
- rate limiting / abuse controls
- transport encryption
- sensitive commands such as cookie access
- production/public-network deployment guidance

## Sensitive commands policy

`cookies` is not part of the MVP command set.

Reasons:
- current manifest does not include the `cookies` permission
- cookie exfiltration materially increases risk
- the bridge feature is already opening remote control over the LAN

If cookie access is added later, it must require:
- manifest permission addition
- Phase 2 hardening work at minimum
- explicit enablement in settings
- CLI/extension UX that makes the sensitivity obvious

---

## Protocol

JSON-RPC-inspired over WebSocket.

### Registration

#### Extension → Server

```json
{
  "type": "register",
  "role": "extension",
  "token": "...",
  "windowId": 123,
  "sessionId": "optional-session-id",
  "capabilities": ["navigate", "tabs", "repl", "screenshot", "eval", "select_element", "status"]
}
```

#### CLI → Server

```json
{
  "type": "register",
  "role": "cli",
  "token": "...",
  "name": "pi-agent"
}
```

### Requests

```json
{
  "id": 1,
  "method": "navigate",
  "params": { "url": "https://example.com" }
}
```

### Responses

```json
{
  "id": 1,
  "result": {
    "url": "https://example.com",
    "title": "Example Domain",
    "tabId": 456
  }
}
```

### Errors

```json
{
  "id": 1,
  "error": {
    "code": -32000,
    "message": "No active extension target connected"
  }
}
```

### Events

```json
{ "type": "event", "event": "extension_connected", "data": { "windowId": 123 } }
{ "type": "event", "event": "extension_disconnected" }
{ "type": "event", "event": "active_tab_changed", "data": { "url": "...", "title": "...", "tabId": 123 } }
```

### Command Set for V1

#### `status`
Returns bridge + target-sidepanel status.

#### `navigate`
Maps to `NavigateTool` behavior.

Supported params:
- `{ "url": "..." }`
- `{ "url": "...", "newTab": true }`
- `{ "listTabs": true }`
- `{ "switchToTab": 123 }`

#### `repl`
Runs JavaScript through existing REPL/browserjs plumbing.

```json
{
  "id": 5,
  "method": "repl",
  "params": {
    "title": "Get page title",
    "code": "const title = await browserjs(() => document.title); return title;"
  }
}
```

#### `screenshot`
Thin wrapper around `extract_image` in screenshot mode.

```json
{ "id": 6, "method": "screenshot", "params": { "maxWidth": 1024 } }
```

#### `eval`
Thin wrapper around debugger `eval` action.

```json
{ "id": 7, "method": "eval", "params": { "code": "JSON.stringify(window.__NEXT_DATA__)" } }
```

#### `select_element`
Thin wrapper around `AskUserWhichElementTool`.

```json
{ "id": 8, "method": "select_element", "params": { "message": "Click the login button" } }
```

### Deferred from V1

- `cookies`
- prompt/streaming APIs
- file upload/download over the bridge
- multiple concurrent extension targets
- multi-extension target selection

---

## Implementation Plan

Phases are numbered by dependency order. Each phase must be complete before the next begins, with one exception: Phase 0 (types) and Phase 1 (server) can proceed in parallel with Phase 2 (build scaffolding) since they have no mutual dependencies.

## Phase 0: Shared Types, Network Assumptions, and Logging Contract

**Files:**
- `src/bridge/protocol.ts`
- `src/bridge/logging.ts`

- [x] Define shared request/response/event types
- [x] Define registration payloads including token and extension metadata
- [x] Define network/config types for bind host, advertised URL, and bridge endpoint
- [x] Define a small structured logging helper used by server/CLI/extension bridge code
- [x] Define stable log fields: `connectionId`, `role`, `remoteAddress`, `windowId`, `requestId`, `method`, `durationMs`, `outcome`

### Telemetry / Observability requirement

Even though this is an MVP, it introduces distributed behavior across hosts.

Minimum V1 contract:
- structured logs on connect/disconnect/register/auth failure
- structured logs for every command execution and relay error
- latency measurement for forwarded commands
- explicit logging when no extension target is connected
- log the server bind address and effective public LAN URL on startup

If Maple/OTEL wiring is later added to extension or CLI runtime, reuse these same fields.

---

## Phase 1: Bridge Server with LAN Reachability

**File:** `src/bridge/server.ts`

Use a dedicated Node HTTP server plus `ws`, not a WebSocket-only abstraction with ad-hoc health checks.

- [x] Start HTTP server on configurable host/port
  - host default: `0.0.0.0`
  - port default: `19285`
  - env overrides: `SHUVGEIST_BRIDGE_HOST`, `SHUVGEIST_BRIDGE_PORT`
- [x] Expose `GET /status` returning JSON health + active target info
- [x] Attach WebSocket upgrade handling for `/ws`
- [x] Require successful `register` message within a short timeout or close socket
- [x] Authenticate clients using shared token
- [x] Track clients by role (`cli`, `extension`)
- [x] Enforce single active extension target in V1
- [x] Maintain pending request map: `requestId -> cli connection`
- [x] Forward CLI requests to active extension
- [x] Forward extension responses back to originating CLI
- [x] Broadcast extension lifecycle events to all CLIs
- [x] Return immediate CLI error when no extension target exists
- [x] Handle CLI disconnect during pending request: signal cancellation to extension via an `abort` message so long-running commands (e.g. REPL) are not orphaned
- [x] Emit structured logs for auth, routing, disconnects, and timeouts
- [x] Log remote client address for diagnostics
- [x] Add startup output that clearly shows:
  - bind host/port
  - one or more candidate LAN URLs if determinable
  - reminder that V1 is intended for a trusted local network only

### Explicit server behavior decisions

- No `--daemon` mode in V1.
- No attempt to manage background lifetime from inside the CLI.
- Foreground process only; users can run it in tmux/systemd later if desired.

### Host selection guidance for V1

The server may run on:
- the browser host
- the CLI host
- a third host on the same LAN

Requirement: both the CLI host and the extension host must be able to reach it.

---

## Phase 2: Node Build and Typecheck Integration

**Why this phase is early**

The bridge server (Phase 1) and CLI (Phase 5) are Node code. They cannot be built or typechecked without Node-specific TS config and a build script. This must exist before any Node code can be validated.

**Files:**
- `scripts/build-cli.mjs`
- `package.json`
- `tsconfig.node.json`

### Required changes

- [x] Add Node-specific TS config (`tsconfig.node.json`) with Node types, targeting `src/bridge/**/*.ts`
- [x] Add `@types/node` to `devDependencies`
- [x] Ensure `src/bridge/**/*.ts` typechecks in Node context, not Chrome-only context
- [x] Add dedicated CLI build script (`scripts/build-cli.mjs`) targeting Node 22
  - Bundle `ws` into the output via esbuild so it does not need to be a runtime dependency
  - `ws` remains in `devDependencies` — it is consumed at build time only
- [x] Output to `dist-cli/`
- [x] Add hashbang (`#!/usr/bin/env node`) to CLI entry output
- [x] Add `"bin": { "shuvgeist": "dist-cli/shuvgeist.mjs" }` to `package.json` for `npm link` usage
- [x] Add package script(s):
  - `build:cli`
  - `typecheck:node`
- [x] Update `./check.sh` so Node bridge code is covered by validation alongside the existing browser typecheck

### Important repo-specific decision

Do **not** fold bridge builds into the existing dev watcher immediately.

Current repo guidance says the user already runs `./dev.sh` in a separate tmux session. To minimize churn:
- keep `npm run dev` focused on the extension/site flow
- add `build:cli` separately
- only merge build pipelines later if it is clearly helpful

---

## Phase 3: Shared Browser Command Execution Layer

**Why this phase exists**

Right now, tool instances are created inside the `toolsFactory` closure in `src/sidepanel.ts`. The bridge cannot cleanly call those same behaviors unless we refactor tool construction.

**Files:**
- `src/bridge/browser-command-executor.ts`
- `src/bridge/command-types.ts` (optional if it keeps things cleaner)
- modifications to `src/sidepanel.ts`

- [x] Extract reusable browser-command execution helpers from the current `toolsFactory` wiring
- [x] Build a `BrowserCommandExecutor` class that accepts `windowId` as a constructor parameter and instantiates the same tools used by the agent
- [x] The executor owns the same dependencies the sidepanel already sets up:
  - `NavigateTool` — no special wiring needed
  - `ReplTool` — wire `runtimeProvidersFactory` and `sandboxUrlProvider` (see below)
  - `ExtractImageTool` — set `windowId` from constructor parameter
  - `DebuggerTool` — no special wiring needed (eval action only in V1)
  - `AskUserWhichElementTool` — no special wiring needed
- [x] Expose bridge-friendly methods that accept an `AbortSignal`:
  - `status()`
  - `navigate(params, signal)`
  - `repl(params, signal)`
  - `screenshot(params, signal)`
  - `eval(params, signal)`
  - `selectElement(params, signal)`
- [x] Keep agent chat tooling and bridge tooling backed by the same underlying construction path where practical
- [x] Avoid duplicating browser orchestration logic in two separate places

### REPL wiring for bridge mode

The REPL tool requires two properties set after construction:

1. **`runtimeProvidersFactory`** — In the sidepanel agent, this includes providers from the `ChatPanel` (for artifact handling) plus `NativeInputEventsRuntimeProvider`, `BrowserJsRuntimeProvider`, and `NavigateRuntimeProvider`. Bridge mode does not have a `ChatPanel`. The bridge executor should wire:
   - `BrowserJsRuntimeProvider` (core page interaction)
   - `NavigateRuntimeProvider` (navigation from within REPL code)
   - `NativeInputEventsRuntimeProvider` (input simulation via debugger API)
   - Chat/artifact-related providers from the agent UI are **not** needed in bridge mode.

2. **`sandboxUrlProvider`** — Must return `chrome.runtime.getURL("sandbox.html")`. This is required for the sandbox iframe execution model. The bridge executor sets this at construction time using the same `chrome.runtime.getURL` call the sidepanel uses.

### Notes

- `screenshot` is a bridge command name, but internally it should call `ExtractImageTool` with `{ mode: "screenshot" }`.
- `select_element` is a bridge command name, but internally it maps to `AskUserWhichElementTool`.
- `eval` maps to `DebuggerTool` with `{ action: "eval" }`.

---

## Phase 4: Extension Bridge Client + Settings

**Files:**
- `src/bridge/extension-client.ts`
- `src/dialogs/BridgeTab.ts`
- modifications to `src/sidepanel.ts`
- modifications to `static/manifest.chrome.json`

### `extension-client.ts`

- [x] Implement `BridgeClient` with:
  - `connect(url, token)`
  - `disconnect()`
  - connection state tracking
  - exponential backoff reconnect while enabled
  - command dispatch callback
  - event send helpers
- [x] Refuse to connect if bridge is disabled or token missing
- [x] Register with `windowId`, optional `sessionId`, and capabilities
- [x] Surface network/auth errors in a way that is understandable when connecting across hosts

### Sidepanel integration

- [x] Add bridge settings reads/writes:
  - `bridge.enabled` (default `false`)
  - `bridge.url` (default empty or sensible example, not hardcoded localhost-only)
  - `bridge.token` (default empty)
- [x] Instantiate `BridgeClient` after sidepanel initialization and after current window/session are known
- [x] Pass the sidepanel's `currentWindowId` to the `BrowserCommandExecutor` at construction time — this is the same value used by the agent tools
- [x] Wire `BridgeClient` to the shared browser command executor
- [x] When the bridge server sends an `abort` message for a pending request, propagate cancellation via the `AbortSignal` passed to the command executor method
- [x] Emit `active_tab_changed` events when relevant
- [x] Show bridge connection state in the sidepanel header
  - hidden when disabled
  - gray when disconnected
  - green when connected
  - optional warning color when auth/network fails

### Settings UI

Add a dedicated settings tab instead of hiding this under the existing proxy tab.

**`BridgeTab` contents:**
- enable toggle
- bridge URL input
- bridge token input
- help text describing same-host and LAN-hosted usage
- live connection status text
- network warning stating V1 assumes a trusted local network
- optional “copy sample URL” / debug info if useful

### Manifest / CSP changes

`static/manifest.chrome.json` must be updated.

The current CSP is:
```
script-src 'self'; object-src 'self'
```

There is **no `connect-src` directive**. Without one, Chrome extension pages fall back to restrictive defaults that block WebSocket connections to any host. The existing `host_permissions` (`http://*/*`, `https://*/*`) cover fetch/XHR but do **not** govern WebSocket `connect-src` in the extension CSP — those are separate gates.

Because the extension must connect to arbitrary LAN bridge addresses in V1, the CSP must add a `connect-src` directive.

Target CSP for V1:
```
script-src 'self'; object-src 'self'; connect-src ws://*:* wss://*:* http://*:* https://*:*
```

- [x] Update `content_security_policy.extension_pages` to include the `connect-src` directive above
- [x] Validate that the directive works for both `ws://` (V1 LAN) and `wss://` (Phase 2 TLS) schemes
- [x] Add a comment in `manifest.chrome.json` noting this broad `connect-src` is a V1 LAN-enablement tradeoff
- [ ] Phase 2 hardening should revisit whether `connect-src` can be narrowed while preserving intended deployment patterns

Do not leave the plan assuming localhost-only CSP entries.

---

## Phase 5: CLI Client

**File:** `src/bridge/cli.ts`

A lightweight Node entry point.

### Supported commands for V1

```text
shuvgeist serve
shuvgeist status
shuvgeist navigate <url>
shuvgeist navigate --new-tab <url>
shuvgeist tabs
shuvgeist switch <tabId>
shuvgeist repl <code>
shuvgeist repl -f <file.js>
shuvgeist screenshot [--out file.png]
shuvgeist eval <code>
shuvgeist select <message>
```

### CLI requirements

- [x] Parse args with `node:util.parseArgs` or equivalent lightweight logic
- [x] Read token from `~/.shuvgeist/bridge.json` by default
- [x] Allow env/flag overrides for URL, host, port, token
- [x] Make remote bridge URLs normal in the UX, e.g. `ws://192.168.1.50:19285/ws`
- [x] Connect to bridge server over WebSocket
- [x] Send one request, await one response, print, exit
- [x] Support `--json` for machine-readable output
- [x] Return exit codes:
  - `0` success
  - `1` command/runtime error
  - `2` no extension target connected
  - `3` auth/configuration/network error

### `serve` behavior

- [x] Start the bridge server in the foreground
- [x] Accept `--host` and `--port`
- [x] Print reachable LAN URL guidance on startup

### REPL file-return behavior

The existing REPL can return files. CLI behavior must define what happens.

V1 behavior:
- default human mode prints text output and notes returned files count
- `--json` includes returned files metadata/base64
- optional `--write-files <dir>` writes returned REPL files to disk

### Screenshot behavior

- [x] If `--out` is provided, decode base64 PNG and write to file
- [ ] Otherwise print JSON or a concise success message

---

## Phase 6: Hardening Plan (Post-MVP)

This phase is explicitly required before treating the bridge as suitable for broader deployment outside a secure local test LAN.

Potential hardening work:
- [ ] add `wss://` / TLS support
- [ ] add stronger client authentication beyond a shared token
- [ ] add extension pairing / approval UX
- [ ] add host/IP allowlists or subnet restrictions
- [ ] narrow CSP if possible while preserving intended deployment patterns
- [ ] add token rotation/revocation UX
- [ ] add rate limiting / abuse protection
- [ ] add explicit audit/event history if needed
- [ ] revisit whether sensitive commands like `cookies` can be allowed safely

---

## File Layout

```text
src/
├── bridge/
│   ├── protocol.ts
│   ├── logging.ts
│   ├── server.ts
│   ├── extension-client.ts
│   ├── browser-command-executor.ts
│   └── cli.ts
├── dialogs/
│   └── BridgeTab.ts
├── sidepanel.ts             (modified)
└── ...existing files...

scripts/
├── build.mjs                (existing chrome build)
└── build-cli.mjs            (new node build)

dist-chrome/                 (existing)
dist-cli/
└── shuvgeist.mjs
```

---

## Detailed Design Decisions

### Sidepanel-only execution is acceptable for V1

The bridge is only available when the user has the sidepanel open. This matches the existing architecture and keeps the first implementation simple and aligned with how tools already work.

### One active extension target is safer than implicit fan-out

A relay with multiple extension clients but no explicit target selection is hazardous. V1 therefore keeps a single active target model.

### LAN connectivity is a V1 requirement, not a follow-up

The bridge must be deployable across machines on the same trusted LAN from the start. That affects bind host defaults, CLI UX, extension settings UX, and CSP design.

### V1 uses a trusted-LAN posture, not a hardened-network posture

This is the most important architectural shift from the previous draft. The MVP is now LAN-capable by design, but it is not positioned as secure for hostile networks.

### No daemon mode in V1

Foreground `serve` is easier to reason about, test, and stop. Users can supervise it with tmux or other tooling if they want persistence.

### Keep packaging decisions separate from bridge functionality

Current `package.json` is still named `shuvgeist`. The executable can still be `shuvgeist`, but publish/install UX should be settled after the bridge works locally.

Phase 2 adds `"bin": { "shuvgeist": "dist-cli/shuvgeist.mjs" }` to `package.json`. This enables `npm link` for local global command exposure during development. The mismatch between the package name (`shuvgeist`) and the binary name (`shuvgeist`) is acceptable for now but should be resolved before any npm publish.

Practical dev usage for V1:
- `node dist-cli/shuvgeist.mjs serve --host 0.0.0.0`
- `npm link` for local global command exposure

Do not document `npx shuvgeist` unless the published package name is also `shuvgeist`.

---

## Implementation Order

Phases 0–1 and Phase 2 can proceed in parallel. All other phases are sequential.

1. **Phase 0** — `protocol.ts` + `logging.ts` (shared types and logging contract)
2. **Phase 1** — `server.ts` with LAN binding, token auth, single-target routing, abort-on-disconnect, and `/status`
3. **Phase 2** — Node typecheck/build scaffolding (`tsconfig.node.json`, `build-cli.mjs`, `@types/node`, `./check.sh` update)
4. **Phase 3** — `browser-command-executor.ts` with REPL provider wiring, `sandboxUrlProvider`, and `AbortSignal` plumbing
5. **Phase 4** — `extension-client.ts`, `BridgeTab`, sidepanel integration, manifest CSP update, header status indicator
6. **Phase 5** — `cli.ts` with all commands, `serve` subcommand, exit codes, `--json` output
7. End-to-end validation across two hosts
8. **Phase 6** — hardening (post-MVP)

---

## Testing Strategy

## Automated

Use the lightest meaningful validation possible.

- [ ] Node-level tests for server auth and request routing using `node:test` or a simple integration harness
- [ ] Typecheck both browser and Node bridge code
- [ ] Confirm `./check.sh` still passes after integration

Suggested automated cases:
- CLI rejected with bad token
- CLI gets clear error when no extension target connected
- second extension target is rejected or replaces first according to chosen policy
- request/response correlation works with multiple simultaneous CLI clients
- non-loopback bind configuration starts successfully

## Manual End-to-End

### Same-host smoke test

1. Build CLI: `npm run build:cli`
2. Start bridge server: `node dist-cli/shuvgeist.mjs serve --host 127.0.0.1`
3. Open Chrome and the Shuvgeist sidepanel
4. Open Settings → Bridge, enable it, set URL/token
5. Run `node dist-cli/shuvgeist.mjs status`
6. Run `node dist-cli/shuvgeist.mjs navigate https://example.com`

### Two-host LAN test

1. On Host A, start bridge server: `node dist-cli/shuvgeist.mjs serve --host 0.0.0.0`
2. Determine Host A LAN IP, e.g. `192.168.1.50`
3. On Host B, open Chrome and the Shuvgeist sidepanel
4. In Settings → Bridge, set URL to `ws://192.168.1.50:19285/ws` and enter the shared token
5. On Host C or Host A, run `shuvgeist status --url ws://192.168.1.50:19285/ws`
6. Run:
   - `shuvgeist navigate https://example.com`
   - `shuvgeist repl "const t = await browserjs(() => document.title); return t;"`
   - `shuvgeist screenshot --out /tmp/shuvgeist-test.png`
7. Confirm disconnect/reconnect behavior by closing/reopening the sidepanel on Host B

### Important manual validation

- [ ] Verify LAN connectivity works with IP address and hostname
- [ ] Verify clear errors for unreachable host / refused connection / bad token
- [ ] Verify only one sidepanel target is active at a time

---

## Approval Status

**READY TO IMPLEMENT**

Latest revision addresses:
- LAN/multi-host deployment is in scope for V1
- server bind and bridge URL assumptions are no longer localhost-only
- extension CSP has a concrete `connect-src` directive for V1 LAN mode
- trusted-LAN posture is explicit
- low-cost baseline safeguards remain in V1
- stronger transport/security hardening is deferred to a clearly defined Phase 6
- phase numbering matches actual dependency order (build scaffolding before CLI)
- REPL runtime providers and `sandboxUrlProvider` wiring are explicitly specified for bridge mode
- `AbortSignal` / cancellation plumbing defined for CLI-disconnect-during-pending-request
- `windowId` flow from sidepanel to command executor is documented
- `ws` bundling strategy clarified (esbuild bundles it; stays in devDependencies)
- `"bin"` field addition and package naming clarified
- `./check.sh` used as the canonical validation command
