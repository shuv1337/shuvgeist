---
name: shuvgeist
description: "Control Chrome/Edge through the Shuvgeist extension and CLI bridge, allowed local Electron apps through bridge-local CDP targets, or no-extension headless Chromium through the direct-CDP runtime. Use whenever the user needs real browser automation, authenticated page access, Electron app inspection, page-context JavaScript, semantic element targeting, workflows, screenshots, MCP observe/act/extract/agent control, network inspection, device emulation, performance tracing, recording, cookie import with consent, or sidepanel session/artifact control from the terminal. Prefer this as the default browser skill."
---

# Shuvgeist

Shuvgeist is both:

1. a Chrome/Edge sidepanel AI assistant
2. a CLI bridge for terminal-driven browser control

Use this skill whenever the task needs a real browser instead of plain HTTP requests or static scraping.

## When to use this skill

Use Shuvgeist for browser tasks such as:

- navigating real pages in Chrome/Edge
- working inside the user's already-authenticated browser state
- inspecting allowed local Electron app renderer windows
- opening or launching a browser when no suitable session exists yet
- taking screenshots or inspecting the visible page
- running JavaScript in page context with `browserjs()`
- accessing MAIN-world state or cookies through debugger-backed commands
- locating elements semantically instead of guessing brittle CSS selectors
- working across tabs and iframes
- running deterministic multi-step workflows
- exposing browser targets to MCP clients as observe/act/extract/agent tools
- capturing network requests and exporting curl reproductions
- importing consented cookies into an isolated Chrome profile
- emulating mobile devices or custom viewport/user-agent settings
- collecting performance metrics or traces
- recording browser or Electron target video repros
- inspecting Electron main-process metadata, IPC taps, main-process network taps, app source layouts, doctor probes, and auto-attach shims
- using the repo's no-extension direct-CDP headless runtime when the extension is not part of the target surface
- interacting with the live sidepanel chat session from the terminal
- listing or retrieving Shuvgeist-generated artifacts

Prefer this skill when the user mentions browser automation, using their logged-in browser, inspecting what is on screen, driving a real webpage, debugging client-side behavior, reproducing an authenticated flow, or coordinating with the Shuvgeist sidepanel session.

## Mental model

Shuvgeist has several related layers:

- **Extension layer:** the browser sidepanel assistant, local skills, artifacts, provider/model selection, session history, inspect-element UI, and other browser-native features
- **CLI bridge layer:** terminal commands that talk to the extension background worker and active tab
- **Electron target layer:** bridge-local CDP commands for explicitly allowed local Electron apps, routed without a Chrome/Edge extension target
- **MCP/HTTP layer:** authenticated Streamable HTTP tools that front extension-routed bridge targets as `shuvgeist_observe`, `shuvgeist_act`, `shuvgeist_extract`, and `shuvgeist_agent`
- **Direct-CDP headless layer:** supported library/runtime entry for no-extension Chromium page targets; this is not a top-level CLI command

Important operational facts:

- The CLI can auto-start the local bridge when needed.
- Most browser commands work even when the sidepanel is closed.
- REPL execution can run with the sidepanel closed through the offscreen runtime.
- **Session commands** such as `session`, `inject`, `new-session`, `set-model`, and `artifacts` require an accepted offscreen-backed session. Once created, that session remains available while its sidepanel is closed.
- Sensitive commands are gated by Bridge settings.
- Chrome/Edge is the default target. Electron commands require `--target electron:...` unless they are `shuvgeist electron ...` management commands.
- Some bridge methods are server-local or MCP-only and do not have a first-class CLI wrapper. Do not invent CLI commands for `snapshot_store`, `snapshot_read`, `cookie_import`, or the direct-CDP headless adapter.

## First command

Start with structured status:

```bash
shuvgeist status --json
```

Use this to confirm:

- extension connectivity
- active bridge-local Electron sessions and renderer-window health
- current capabilities
- target window/tab state
- whether a sidepanel session is available

If you only need a quick human-readable check:

```bash
shuvgeist status
```

### Discovering commands

Every command and flag is listed in the built-in help. Treat it as the authoritative reference:

```bash
shuvgeist --help       # full usage: all commands + global options
shuvgeist --version    # CLI version (tracks the extension build)
```

The CLI keeps this skill available to agents automatically: on every run it syncs the packaged skill into `~/.agents/skills/shuvgeist` (version-gated and silent). Manage it explicitly with:

```bash
shuvgeist skill install          # (re)install/refresh the skill into ~/.agents/skills
shuvgeist skill install --force  # force a re-copy even if the version matches
shuvgeist skill path             # print the install path
```

## Prerequisites

### Required for Chrome/Edge targets

- Shuvgeist extension installed or built and loaded in Chrome/Edge
- A browser target connected to the extension

### Required for Electron targets

- A known local Electron app with a CDP-enabled renderer
- The app explicitly added to the Shuvgeist Electron allowlist

Electron targets do not require the Chrome/Edge extension to be installed or connected.

### Usually not required manually

You normally **do not** need to start the bridge yourself. The CLI can auto-start it when a command needs it.

Manual bridge startup is mainly for debugging bridge/server behavior:

```bash
shuvgeist serve
```

### If no browser is open yet

Shuvgeist can launch one for you:

```bash
shuvgeist launch
shuvgeist launch --url https://example.com
shuvgeist launch --headless
shuvgeist launch --url http://127.0.0.1:3000 --headless --user-data-dir "${RUNNER_TEMP:-/tmp}/shuvgeist-profile"
```

Close a CLI-launched browser with:

```bash
shuvgeist close
```

### Config resolution

The CLI talks to the local bridge over WebSocket. By default it connects to `ws://127.0.0.1:19285` (the `serve` listener binds `0.0.0.0:19285`). Connection settings resolve in this order:

1. CLI flags: `--url`, `--token`, `--host`, `--port`
2. Environment: `SHUVGEIST_BRIDGE_URL`, `SHUVGEIST_BRIDGE_TOKEN`, `SHUVGEIST_BRIDGE_HOST`, `SHUVGEIST_BRIDGE_PORT`
3. Config file: `~/.shuvgeist/bridge.json` (keys: `url`, `token`, `host`, `port`, and an optional `otel` object)

`--url ws://...` overrides host/port entirely.

Browser and extension discovery for `launch` can also come from flags, env, config, local dev paths, or installed browser locations.

#### Optional OpenTelemetry

The bridge can emit OTEL traces. Configure via env or the `otel` block in `bridge.json`:

- `SHUVGEIST_OTEL_ENABLED` (`true`/`false`) — `otel.enabled`
- `SHUVGEIST_OTEL_INGEST_URL` (default `http://localhost:3474`) — `otel.ingestUrl`
- `SHUVGEIST_OTEL_PRIVATE_INGEST_KEY` — `otel.privateIngestKey`

## Core command surface

### Browser lifecycle

```bash
shuvgeist launch
shuvgeist launch --url https://example.com --foreground
shuvgeist launch --headless
shuvgeist launch --use-default-profile               # share the user's normal browser profile
shuvgeist launch --user-data-dir /tmp/shuvgeist-x    # explicit isolated profile path
shuvgeist close
shuvgeist status --json
```

Use `launch` when the user does not already have a suitable browser session open.
Use the existing browser session when the user specifically wants their current authenticated tabs, extensions, or state.

Profile isolation: by default, `launch` opens the browser against an isolated, persistent user-data-dir under `~/.shuvgeist/profile/<browser-name>`. This avoids fighting an already-open instance of the same browser using its default profile (which would otherwise cause `--load-extension` to be silently ignored and `launch` to time out). Logins inside the Shuvgeist-managed profile persist across runs. Pass `--use-default-profile` to share the user's normal profile instead, or `--user-data-dir <path>` to point at a specific directory.

### Electron targets

Use Electron targets when the task is about a local desktop app renderer rather than a Chrome/Edge tab. Electron targets are bridge-local CDP connections and do not require the browser extension to be connected.

Start by listing and allowlisting the app:

```bash
shuvgeist electron list --json
shuvgeist electron allow vscode
```

Known app references include `vscode`, `shuvscode`, `codex`, `codex-desktop`, `slack`, `legcord`, `signal`, `signal-desktop`, and `obsidian`.

Codex Desktop on Linux is registered through the packaged `/usr/bin/codex-desktop` launcher and `/opt/codex-desktop/codex-desktop-electron` runtime. Use the alias for the minimal attach flow:

```bash
shuvgeist electron allow codex
shuvgeist electron doctor codex --json
shuvgeist electron attach codex --json
```

Targeted doctor checks require an exact registered-app process match and confirm that process owns its listening `--remote-debugging-port`, so they can find Codex Desktop outside the configured Shuvgeist launch range without probing unrelated apps. `shuvgeist status` reports extension and live Electron health separately; a disconnected extension does not block bridge-local Electron control.

Attach to an already running CDP-enabled app, or launch a known app with a debugging port:

```bash
shuvgeist electron attach vscode --json
shuvgeist electron attach --pid 12345 --json
shuvgeist electron attach --port 9229 --json
shuvgeist electron launch vscode --inspect-main --json
shuvgeist electron attach vscode --inspect-port 9230 --json
shuvgeist electron launch vscode --json
```

Inspect windows and label the intended renderer when there are multiple candidates:

```bash
shuvgeist electron windows --json
shuvgeist electron label e1 w1 main
shuvgeist electron main e1 --json
```

Inspect the main process, tap IPC traffic, capture main-process network, and detach when done:

```bash
shuvgeist electron main e1 --json                       # main-process info
shuvgeist electron ipc tap e1 --channel update --json   # stream IPC messages (filter by channel substring)
shuvgeist electron ipc untap e1 --json                  # stop the IPC tap
shuvgeist electron network-main start e1 --json         # capture main-process network
shuvgeist electron network-main stop e1 --json
shuvgeist electron launch vscode --inspect-main --json  # also expose a main-process inspector
shuvgeist electron attach --pid 12345 --inspect-port 9229 --json
shuvgeist electron detach e1 --json                     # disconnect the session
```

Read or extract the app's bundled source (asar / resources) for inspection:

```bash
shuvgeist electron source layout vscode --json                      # source directory tree
shuvgeist electron source list vscode --json                        # list source files
shuvgeist electron source read out/main.js vscode --json            # read one file (base64)
shuvgeist electron source extract /tmp/vscode-src vscode --json      # extract sources to a dir (or --extract-to)
shuvgeist electron source list --source-path /path/app.asar --json  # point at an explicit asar / resources path
```

Diagnose attach/launch problems and manage the auto-attach helper:

```bash
shuvgeist electron doctor vscode --json                  # diagnose setup (ports, paths, permissions)
shuvgeist electron doctor codex --json                   # discover a running Codex Desktop CDP endpoint
shuvgeist electron auto-attach status vscode --json
shuvgeist electron auto-attach install vscode --json     # auto-attach when the app starts
shuvgeist electron auto-attach uninstall vscode --json
```

Target syntax:

```bash
--target electron:e1:w1
--target electron:e1:main
--target electron:vscode:w1
--target electron:e1/w1
```

Supported target-scoped commands include:

```bash
shuvgeist eval "document.title" --target electron:e1:main --json
shuvgeist screenshot --target electron:e1:w1 --out /tmp/electron.png
shuvgeist snapshot --target electron:e1:w1 --json
shuvgeist locate role button --name "Run" --target electron:e1:w1 --json
shuvgeist ref click <refId> --target electron:e1:w1
shuvgeist ref click <refId> --trusted --target electron:e1:w1
shuvgeist record start --target electron:e1:w1 --out /tmp/electron.webm --max-duration 5s
```

Electron trusted input is renderer-scoped CDP synthesis, not OS input. `--trusted` and `--cdp-input` are aliases and require the exact app's `cdp_input` capability to be `true` in `~/.shuvgeist/bridge.json`:

```json
{
  "electron": {
    "capabilities": {
      "com.microsoft.VSCode": { "cdp_input": true }
    }
  }
}
```

Electron `--native` is explicitly unsupported. Do not treat trusted CDP input as an OS mouse/keyboard action or silently fall back to DOM events.

Deeper Electron diagnostics and source inspection:

```bash
shuvgeist electron ipc tap e1 --channel auth --json
shuvgeist electron ipc untap e1 --json
shuvgeist electron network-main start e1 --json
shuvgeist electron network-main stop e1 --json
shuvgeist electron source layout vscode --json
shuvgeist electron source list vscode --json
shuvgeist electron source read src/main.js vscode --json
shuvgeist electron source extract /tmp/app-source vscode --json
shuvgeist electron doctor vscode --json
shuvgeist electron auto-attach status vscode --json
shuvgeist electron auto-attach install vscode --json
shuvgeist electron auto-attach uninstall vscode --json
shuvgeist electron detach e1 --json
```

Electron safety notes:

- Main-process inspection, IPC taps, main-network taps, and source extraction can expose sensitive local app state. Use only on apps the user has explicitly asked to inspect.
- `shuvgeist cookies` is a Chrome/Edge extension command, not an Electron target command. The parsed Electron `cookies` capability key is compatibility-only and does not enable Electron cookie access.
- `electron ipc tap` and `electron network-main start` are diagnostic instrumentation. Stop them when done.
- `electron source extract` can copy app source or ASAR contents. Choose a deliberate destination and avoid publishing extracted secrets.
- `electron auto-attach install` modifies launch behavior for that local app; use `auto-attach status` first and `auto-attach uninstall` when the shim is no longer needed.

Troubleshooting:

- Unknown app: run `shuvgeist electron list --json` and use a listed ID or alias.
- Not allowlisted: run `shuvgeist electron allow <app-id-or-alias>`.
- No CDP port: restart the app with `--remote-debugging-port=<port>` and pass `--port <port>`.
- Main process unavailable: relaunch with `--inspect-main` or attach with `--inspect-port`.
- Wrong window: run `shuvgeist electron windows --json`, label the window, then target the label.
- Extension disconnected errors: add an Electron `--target`; Chrome/Edge is the default route.

### Navigation and tab control

```bash
shuvgeist navigate "https://example.com"
shuvgeist navigate "https://example.com" --new-tab
shuvgeist tabs --json
shuvgeist tabs list --json
shuvgeist switch <tabId>
```

Use `tabs --json` to capture stable `tabId` values for later `--tab-id` targeting. Each tab includes `windowId`, `index`, `pinned`, and `status`. Multiple `"active": true` rows are normal (one focused tab per window). A `windows` summary is included.

### Tab lifecycle (close tabs / windows)

Prefer first-class tab close. Never improvise with `eval window.close()`, `nativePress("Control+w")`, or OS/compositor kill on the browser PID (that can destroy every window sharing the Chromium process).

```bash
# Close by explicit Chrome tab IDs (no --yes required)
shuvgeist tabs close 1825584691 1825584692 --json

# Filter close: always preview, then apply with --yes
shuvgeist tabs close --title-match shuvplan --dry-run --json
shuvgeist tabs close --title-match shuvplan --yes --json

# Other filters
shuvgeist tabs close --url-match localhost:43393 --yes --json
shuvgeist tabs close --title-pattern 'shuvplan$' --yes --json
shuvgeist tabs close --window-id 1825584693 --yes --json

# Optional: include pinned or chrome:// / extension pages in filter matches
shuvgeist tabs close --title-match Settings --include-pinned --include-protected --yes --json

# Windows (browser API — closes one window's tabs only)
shuvgeist windows --json
shuvgeist windows close <windowId> --dry-run --json
shuvgeist windows close <windowId> --yes --json
```

Safety:

- Explicit numeric tab IDs never need `--yes`.
- Filter closes without `--yes` or `--dry-run` fail with a usage error.
- Filters skip pinned tabs and protected URLs (`chrome://`, extension pages, `about:*` except bare `about:blank`, etc.) unless overridden with `--include-pinned` / `--include-protected`.
- Bare `about:blank` is closable via filters without `--include-protected`.
- Closing the last tab in a window closes that window only (Chrome behavior), not the browser process.
- `shuvgeist close` still means quit a CLI-launched browser process — do not overload it for tabs.

Agent / navigate tool equivalents:

```json
{ "listTabs": true }
{ "closeTab": 123 }
{ "closeTabs": [123, 456] }
{ "closeTabFilter": { "titleIncludes": "shuvplan" }, "dryRun": true }
{ "closeTabFilter": { "titleIncludes": "shuvplan" } }
{ "listWindows": true }
{ "closeWindow": 99, "dryRun": true }
```

Workflow steps may pass `closeTabFilter` without CLI `--yes` (workflow JSON is explicit agent intent):

```json
{
  "steps": [
    { "method": "navigate", "params": { "listTabs": true }, "as": "tabs" },
    {
      "method": "navigate",
      "params": {
        "closeTabFilter": { "titleIncludes": "shuvplan" },
        "dryRun": false
      }
    }
  ]
}
```

Ref handles: `refId` from `locate` and `snapshotId` from `snapshot` are the same identifier. Use `refId` as the canonical name.

### Screenshots

```bash
shuvgeist screenshot --out /tmp/page.webp
shuvgeist screenshot --json
shuvgeist screenshot --out /tmp/page.webp --max-width 800
```

Prefer `--json` when another tool needs inline image data. Prefer `--out` when you want a file artifact.

#### Annotated screenshots

`screenshot --out file.png` also writes a sibling `viewport.json` unless `--no-viewport-json` is set. The sidecar contains `cssWidth`, `cssHeight`, `imageWidth`, `imageHeight`, `devicePixelRatio`, and `scale`. Use `scale = imageWidth / cssWidth` to convert CSS-pixel coordinates from `snapshot`, `locate`, or DOM APIs into screenshot image pixels. `screenshot --json` includes the same metadata fields directly in the response.

### REPL and page-context JavaScript

The REPL runs in a sandbox. Use `browserjs()` to execute in the actual page context.

```bash
shuvgeist repl 'return await browserjs(() => document.title)'

shuvgeist repl 'return await browserjs(() => {
  return Array.from(document.querySelectorAll("h2")).map((h) => h.textContent)
})'

shuvgeist repl -f scrape.js --write-files ./output
```

Important:

- Code outside `browserjs()` runs in the sandbox, not the page.
- Code inside `browserjs()` runs in the browser script world against the live DOM.
- Matching Shuvgeist site skills may be auto-injected into `browserjs()` runs for supported domains.
- REPL is available even with the sidepanel closed.

### Native trusted input from the REPL

When synthetic DOM events are insufficient, use debugger-backed native input helpers from the REPL runtime:

```bash
shuvgeist repl 'await nativeClick("button[type=submit]"); return "clicked"'
shuvgeist repl 'await nativeType("input[type=email]", "user@example.com"); return "typed"'
shuvgeist repl 'await nativePress("Enter"); return "submitted"'
```

Use these for sites that reject ordinary scripted DOM events.

### MAIN-world eval

Requires sensitive browser access enabled in Bridge settings.

```bash
shuvgeist eval "document.title"
shuvgeist eval "window.__APP_STATE__" --tab-id 123
```

Use this when data lives in the page's real JS world and is not visible to `browserjs()`.

### Cookies

Requires sensitive browser access enabled in Bridge settings.

```bash
shuvgeist cookies
shuvgeist cookies --json
```

This can expose current-site cookies, including HttpOnly cookies.

### Consented cookie import

Cookie import is a bridge/server-local capability, not a top-level CLI command and not a current MCP tool. Use it only from raw bridge integrations or custom bridge clients that can send bridge requests.

Requirements:

- sensitive browser access enabled in Bridge settings
- a Chrome extension target connected
- explicit per-site consent in the request
- a source cookie database/profile path and a site URL

Bridge method shape:

```json
{
  "method": "cookie_import",
  "params": {
    "sourcePath": "/path/to/source/profile-or-cookie-db",
    "siteUrl": "https://app.example.test/settings",
    "consent": true
  },
  "target": { "kind": "chrome-tab", "tabRef": "window:65" }
}
```

The server filters cookies to the requested site and relays `cookie_import_apply` to the extension target. Do not use this for broad profile copying; keep it site-scoped and consented.

### Interactive element picking

```bash
shuvgeist select "Click the login button"
```

Use this when a human can disambiguate the target faster than the model can.

## Deterministic automation surface

### Page assertions

Use `shuvgeist assert ...` for CI-style pass/fail checks. Prefer this over `repl 'document...'` for page assertions because `assert` runs against the page context by default, auto-waits, and maps failures to exit code `1`.

```bash
shuvgeist status --json
shuvgeist assert text "Welcome" --timeout 10s
shuvgeist assert selector "button[type=submit]" --visible --enabled
shuvgeist assert role button --name "Continue" --visible
shuvgeist assert label "Email" --visible
shuvgeist assert url "https://example.com/dashboard"
shuvgeist assert url --url-pattern "/dashboard"
shuvgeist assert expr 'document.title.includes("Dashboard")'
```

Use `--json` for automation. A failed assertion is a successful bridge response with `ok: false`; it is not a transport error.

Before relying on assertions in CI, `status --json` should show a connected extension and include `page_assert` in extension capabilities. If `assert` reports `Unknown method: page_assert`, rebuild/reload the extension and CLI so the bridge surfaces match.

Assertion options:

- `--timeout <value>` (default `5s`) and `--interval <value>` control how long and how often `assert` retries before failing
- `--visible` / `--enabled` require the matched element to be visible / enabled
- `--exact` switches `text` and `url` matching from substring to exact
- `--count <N>`, `--min-count <N>`, `--max-count <N>` assert how many elements match
- `--name <text>` filters `role` assertions by accessible name; `--url-pattern <regex>` matches the URL by regex
- `--tab-id` / `--frame-id` scope the assertion; `--world <user|main>` selects the `expr` evaluation world

Expression assertions default to the user-script world. Use MAIN-world assertions only when app state is not visible from DOM/user-script context:

```bash
shuvgeist assert expr 'window.__APP_STATE__.ready === true' --world main
```

`--world main` uses the sensitive `eval` path and requires sensitive browser access in Bridge settings.

### Workflows

Use workflows when you want one bounded bridge request to own a multi-step browser flow.

```bash
shuvgeist workflow validate --file workflow.json
shuvgeist workflow run --file workflow.json
shuvgeist workflow run --file workflow.json --arg query=shoes --arg urls='["https://a","https://b"]'
shuvgeist workflow run --file workflow.json --dry-run
```

Workflow model highlights:

- `steps` execute sequentially
- target modes are `active`, `new-tab`, and `pinned-tab`
- CI workflows should usually use `"target": { "mode": "new-tab" }`
- `assert` steps delegate to `page_assert`, halt by default on failure, and can continue with `onError: "continue"`
- `repeat` and `each` loops are supported
- exact token substitution like `"%{urls}"` preserves type
- interpolated strings like `"hello %{name}"` produce strings
- `as` captures prior results
- `defaultWait` and per-step `wait` are supported
- disallowed in workflows: nested workflow commands and interactive element selection

Use workflows when repeated round trips would be brittle or wasteful.

### MCP control plane

The bridge exposes authenticated Streamable HTTP MCP at `/mcp` for external agents. It currently supports extension-routed browser targets; server-local and Electron-target bridge methods return an invalid-target error through MCP.

MCP tools:

- `shuvgeist_observe` -> `page_snapshot`
- `shuvgeist_act` -> `ref_click` or `ref_fill`
- `shuvgeist_extract` -> `repl`
- `shuvgeist_agent` -> `workflow_run`

Operational notes:

- Use the same bridge token as the CLI; HTTP requests require `Authorization: Bearer <token>`.
- Use `target` objects to pin a Chrome tab/window instead of relying on focus.
- Use MCP when another agent or tool host needs a browser tool surface without shelling out to the CLI for every step.

Minimal request pattern:

```bash
curl -sS -H "Authorization: Bearer $SHUVGEIST_BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://127.0.0.1:8787/mcp
```

### Page snapshots

Use snapshots when you need a compact semantic representation of the current page.

```bash
shuvgeist snapshot --json
shuvgeist snapshot --tab-id 123 --frame-id 7 --max-entries 80 --json
shuvgeist snapshot --include-hidden --json
```

Options: `--max-entries <N>` caps how many entries are returned; `--include-hidden` adds hidden / `aria-hidden` elements (omitted by default).

Snapshots return semantic entries, candidate selectors, page metadata, and stable `snapshotId` values. Each entry's `snapshotId` is the same value as the `refId` returned by `locate` — pass it directly to `shuvgeist ref click|fill <id>`.

### Server-side snapshot store

The normal CLI `snapshot --json` returns the current compact snapshot directly. The bridge also has server-local `snapshot_store` and `snapshot_read` methods for clients that need to persist raw pre-filter snapshot records without dumping them into every response.

This is not exposed as a top-level CLI command and is not a current MCP tool. Use it from raw bridge integrations or custom WebSocket clients.

Bridge method shapes:

```json
{ "method": "snapshot_store", "params": { "tabId": 42, "frameId": 7, "maxEntries": 80, "query": "save" } }
{ "method": "snapshot_read", "params": { "id": "chrome:active:42:frame:7:snapshot:12345" } }
{ "method": "snapshot_read", "params": { "snapshotId": "e1" } }
```

`snapshot_store` relays `page_snapshot` to the target, stores the raw result in the local bridge, and returns a record summary. `snapshot_read` returns matching stored records with raw entries.

### Semantic locate

Use locators when you know what an element means, not what selector it has.

```bash
shuvgeist locate role button --name "Sign in" --json
shuvgeist locate text "Add to cart" --json
shuvgeist locate label "Email address" --json
shuvgeist locate role link --name "Docs" --limit 5 --min-score 0.4 --json
```

Options: `--name <text>` adds an accessible-name filter for `role` mode; `--limit <N>` caps results; `--min-score <0-1>` drops low-confidence matches.

Locator results include ranked matches, scores, reasons, and `refId` values. `refId` is the canonical ref-handle name; `snapshot` calls the same value `snapshotId` for legacy compatibility.

### Ref actions

Operate on prior semantic matches without repeating the search. `<refId>` may be a `refId` from `locate` or a `snapshotId` from `snapshot`.

```bash
shuvgeist ref click <refId>
shuvgeist ref fill <refId> --value "user@example.com"
shuvgeist ref fill <refId> --value "Low to High"
shuvgeist ref click <refId> --timeout 5s
shuvgeist ref click <refId> --native
shuvgeist ref fill <refId> --value "user@example.com" --native
shuvgeist ref click <refId> --trusted
shuvgeist ref fill <refId> --value "user@example.com" --cdp-input
```

Ref caveats:

- refs are scoped to the resolved session/window/page/frame and its navigation generation
- refs are in-memory only
- navigation invalidates refs
- stale or ambiguous refs should fail instead of guessing
- `ref fill` handles text inputs, textareas, selects, and editable elements (`contenteditable`, empty `contenteditable`, and `contenteditable="plaintext-only"`); explicit ARIA roles take precedence
- editable fills focus and replace the current content, dispatch cancelable `beforeinput` before `input`, and report a canceled `beforeinput` as failure
- `ref click --timeout <duration>` waits for bounded same-tab page stability and reports the final URL in JSON output
- `--native` is the legacy Chrome debugger-backed mode; it is intentionally unsupported for Electron because Shuvgeist does not synthesize OS input
- `--trusted` and `--cdp-input` are the same renderer-scoped `Input.*` mode, never fall back to DOM events, and are mutually exclusive with `--native`
- Electron trusted actions are fail-closed unless the per-app `cdp_input` policy is exactly `true`
- trusted refs can target iframe refs when Shuvgeist can resolve frame coordinates; inaccessible frames fail clearly
- structured failures include the reason and safe match diagnostics, but never expose the internal selector or raw input point

### Frame inspection

Inspect iframe structure before operating inside it:

```bash
shuvgeist frame list --json
shuvgeist frame tree --json
```

Then pass `--frame-id` to supported commands such as `snapshot`, `locate`, `ref`, `eval`, `network`, `device`, and `perf`.

## Diagnostics and observability

### Network capture

```bash
shuvgeist network start
shuvgeist network list --json
shuvgeist network get <requestId> --json
shuvgeist network body <requestId> --json
shuvgeist network curl <requestId> --json
shuvgeist network curl <requestId> --include-sensitive --json
shuvgeist network stats --json
shuvgeist network clear
shuvgeist network stop
```

Important:

- capture is explicit and bounded in memory
- capture continues until `network stop`
- JSON results include the resolved target and navigation generation; `network list` returns `requests`, and `network get` returns one `request`, inside that scoped result
- `curl` redacts sensitive headers by default
- `network get`, `network body`, and `network curl` are sensitive capabilities

Typical pattern:

1. `shuvgeist network start`
2. trigger the browser action
3. `shuvgeist network list --json`
4. inspect or export the interesting request
5. `shuvgeist network stop`

### Device emulation

```bash
shuvgeist device emulate --preset iphone-14-pro --json
shuvgeist device emulate --width 390 --height 844 --dpr 3 --mobile --touch --user-agent "..."
shuvgeist device reset
```

Use this for responsive bugs, mobile-only flows, touch behavior, or user-agent-sensitive pages.

### Performance tools

```bash
shuvgeist perf metrics --json
shuvgeist perf trace-start --auto-stop 10000 --json
shuvgeist perf trace-stop --json
```

Use `perf metrics` for quick timing data and `trace-start/trace-stop` for deeper investigations.

### Recording

Capture a WebM video repro of a browser tab or Electron renderer. Requires `ffmpeg` installed locally for final encoding.

```bash
shuvgeist record start --out /tmp/repro.webm
shuvgeist record start --out /tmp/repro.webm --max-duration 60s --fps 30 --quality 90
shuvgeist record status --json
shuvgeist record stop --json
shuvgeist record start --target electron:e1:w1 --out /tmp/app.webm --max-duration 5s
```

Recording options:

- `--out <path>` — output `.webm` file (required for `start`)
- `--max-duration <value>` — recording length; default `30s`, hard cap `120s`
- `--fps <n>` — frames per second, `1`–`30`
- `--quality <n>` — capture JPEG quality, `1`–`100`
- `--max-width <px>` / `--max-height <px>` — scale the output
- `--video-bitrate <n>` — encoder bitrate (bits/sec)
- `--mime-type <type>` — WebM codec, e.g. `video/webm;codecs=vp9` (vp8 also supported)
- `--tab-id <N>` — record a specific tab; `stop` and `status` accept `--tab-id` to match the `start`

Recording is bounded by `--max-duration`; use `record stop` to end early or `record status` to check whether a capture is active.

Recording JSON reports `sourceBytes` as the decoded JPEG/PNG bytes received from CDP and `encodedSizeBytes` as the final ffmpeg WebM size. Deprecated `sizeBytes`, when present, means encoded output size; never compare it to `sourceBytes` as though they were the same measurement.

## Direct-CDP headless runtime

Shuvgeist 2.0.0 includes a supported no-extension direct-CDP library/runtime entry for headless Chromium. It composes the same PageDriver as Chrome and Electron; it is not a top-level CLI command.

Use it when the task is to develop or test Shuvgeist itself against a Chromium target where no extension is present. For normal browser automation, prefer `shuvgeist launch --headless`, which still loads the extension and exposes the CLI bridge.

Key files:

- `packages/cli/src/headless/direct-cdp-runtime.ts`
- `packages/driver/src/trusted-input-provider.ts`
- `tests/integration/bridge/headless-direct-cdp-runtime.test.ts`
- `tests/unit/bridge/trusted-input-provider.test.ts`
- `tests/unit/bridge/direct-cdp-vision-baseline.test.ts`

Capabilities:

- discover page targets from `/json/list`
- connect to page websocket targets through `ElectronWsCdpSession`
- run a full agent loop: `page_snapshot` -> `locate_by_role` -> `ref_click` -> `page_snapshot`
- dispatch trusted clicks through `Input.dispatchMouseEvent`
- keep `Runtime.enable` off the direct-CDP action path
- capture screenshots and pair them with structured candidate JSON for vision-capable fallback

Vision baseline constraints:

- Requires a `Model.input` containing `image`.
- Requires an explicit fallback trigger: `planner-validator-failure` or `ambiguous-ref`.
- Does not add numbered badge overlays.
- Does not prove live model accuracy by itself; live model comparison remains separate evidence.

## Sidepanel session control

Shuvgeist is not only low-level browser automation. It can also collaborate with the live sidepanel assistant session.

These commands are especially useful when you want to inspect or steer the extension's own AI conversation from the terminal.

### Session history

```bash
shuvgeist session --json
shuvgeist session --last 20 --json
shuvgeist session --follow
```

Use this to inspect the active persisted sidepanel conversation, tail live updates, or correlate browser actions with the assistant's state.

### Inject messages into the live session

```bash
shuvgeist inject "Summarize this page and save a CSV artifact"
shuvgeist inject "Done. The file is in /tmp/output.csv" --role assistant
```

Use this to hand off findings between terminal automation and the sidepanel assistant.

### Create or reconfigure sessions

```bash
shuvgeist new-session
shuvgeist new-session provider/model-id --json
shuvgeist set-model provider/model-id --json
```

Use these when you want the browser-native assistant to continue under a fresh session or different model.

### Artifacts

```bash
shuvgeist artifacts --json
```

Use this to list artifacts created in the active sidepanel session.

### Session limitations

Session commands are unavailable before any session has been accepted for the target browser window, or after that window and its runtime ownership have been released. Closing the sidepanel alone does not release the offscreen-backed session.

## Targeting flags

Prefer explicit routing when multiple tabs or frames are in play:

```bash
--tab-id <id>
--frame-id <id>
```

Use them with page-scoped commands, including:

- `repl`, `eval`, `screenshot`
- `assert`
- `snapshot`, `locate`, `ref click`, `ref fill`
- `frame list`, `frame tree`
- `network ...`, `device ...`, `perf ...`
- `record start` / `record stop` / `record status`

`--target <spec>` routes to a non-default surface (e.g. `electron:e1:w1`); Chrome/Edge is the default. Do not assume the currently focused browser window is the intended target.

## JSON mode

Prefer `--json` whenever output will feed follow-up commands or another tool:

```bash
shuvgeist status --json
shuvgeist tabs --json
shuvgeist snapshot --json
shuvgeist locate role button --name "Checkout" --json
shuvgeist network list --json
shuvgeist perf metrics --json
shuvgeist session --json
shuvgeist artifacts --json
```

## Timeouts

Override defaults on slow or long-running operations:

```bash
shuvgeist workflow run --file workflow.json --timeout 10m
shuvgeist repl -f scrape.js --timeout 5m
shuvgeist select "Pick an element" --timeout none
shuvgeist perf trace-start --timeout 2m
```

## Exit codes

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Success | Continue |
| 1 | Assertion failed or command/runtime error | Inspect the returned assertion result or error |
| 2 | No extension target connected | Connect or launch a browser target |
| 3 | Auth/configuration/network error | Check token, URL, local bridge config, or discovery |

## Recommended operating patterns

### Robust semantic interaction

```bash
shuvgeist snapshot --json
shuvgeist locate role button --name "Sign in" --json
shuvgeist assert role button --name "Sign in" --visible
shuvgeist ref click <refId>
```

Use this instead of guessing selectors on unstable pages.

### Frame-aware interaction

```bash
shuvgeist frame tree --json
shuvgeist snapshot --frame-id 12 --json
shuvgeist locate label "Search" --frame-id 12 --json
shuvgeist ref fill <refId> --value "query" --frame-id 12
```

### Capture authenticated API traffic

```bash
shuvgeist network start
shuvgeist ref click <submitRef>
shuvgeist network list --json
shuvgeist network curl <requestId> --json
shuvgeist network stop
```

### Workflow-driven automation

```bash
shuvgeist workflow run --file workflow.json --arg category=boots --json
```

### Responsive reproduction

```bash
shuvgeist device emulate --preset pixel-7
shuvgeist navigate "https://example.com/mobile-flow"
shuvgeist screenshot --out /tmp/mobile.webp
shuvgeist device reset
```

### Sidepanel handoff loop

```bash
shuvgeist session --json
shuvgeist inject "I captured the pricing table. Please turn it into an artifact."
shuvgeist artifacts --json
```

Use this when terminal automation and the sidepanel assistant should collaborate instead of duplicating work.

## Decision rules

- Use `launch` when no suitable browser session exists yet.
- Use `navigate` / `tabs` / `switch` for straightforward browser movement.
- Use `tabs close` to dispose tabs; use `windows close` for an entire browser window.
- Use `shuvgeist close` only to quit a browser started by `shuvgeist launch`.
- Never close tabs via `eval window.close()`, `nativePress Control+w`, hyprctl/ydotool, or kill on the browser PID.
- Use `repl` when you know the DOM operations or need custom page logic.
- Use REPL native input helpers when sites reject synthetic DOM events (not for tab close).
- Use `eval` when the needed data only exists in MAIN world.
- Use `snapshot` + `locate` + `ref` when selectors are unknown, fragile, or dynamic.
- Use `frame list/tree` before touching iframe-heavy pages.
- Use `workflow` when multiple deterministic steps should happen in one request.
- Use `network` when request/response behavior matters more than rendered DOM.
- Use `device` when layout or behavior depends on viewport, touch, or user agent.
- Use `perf` when timing, runtime metrics, or traces matter.
- Use `record` when you need a shareable video repro of a bug or flow.
- Use `electron list/allow/attach/launch` plus `--target electron:...` to drive a local desktop app instead of a Chrome/Edge tab.
- Use `session` / `inject` / `artifacts` when you need to collaborate with the Shuvgeist sidepanel assistant, not just automate the page.

### Tab / window disposal decision tree

```text
Need to dispose browser UI state?
├─ Close specific tabs by id
│    → shuvgeist tabs close <id> [id…] --json
├─ Close tabs matching title/url (e.g. "shuvplan")
│    → shuvgeist tabs close --title-match shuvplan --dry-run --json
│    → shuvgeist tabs close --title-match shuvplan --yes --json
├─ Close entire browser window (all its tabs)
│    → shuvgeist windows close <windowId> --yes --json
├─ Quit a browser started by `shuvgeist launch`
│    → shuvgeist close
└─ NEVER
     → eval window.close()
     → nativePress Control+w as tab close
     → hyprctl / ydotool / kill on browser PID
```
