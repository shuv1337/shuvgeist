---
name: shuvgeist
description: "Control Chrome/Edge through the Shuvgeist extension and CLI bridge. Use whenever the user needs real browser automation, authenticated page access, page-context JavaScript, semantic element targeting, workflows, screenshots, network inspection, device emulation, performance tracing, or sidepanel session/artifact control from the terminal. Prefer this as the default browser skill."
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
- opening or launching a browser when no suitable session exists yet
- taking screenshots or inspecting the visible page
- running JavaScript in page context with `browserjs()`
- accessing MAIN-world state or cookies through debugger-backed commands
- locating elements semantically instead of guessing brittle CSS selectors
- working across tabs and iframes
- running deterministic multi-step workflows
- capturing network requests and exporting curl reproductions
- emulating mobile devices or custom viewport/user-agent settings
- collecting performance metrics or traces
- interacting with the live sidepanel chat session from the terminal
- listing or retrieving Shuvgeist-generated artifacts

Prefer this skill when the user mentions browser automation, using their logged-in browser, inspecting what is on screen, driving a real webpage, debugging client-side behavior, reproducing an authenticated flow, or coordinating with the Shuvgeist sidepanel session.

## Mental model

Shuvgeist has two layers:

- **Extension layer:** the browser sidepanel assistant, local skills, artifacts, provider/model selection, session history, inspect-element UI, and other browser-native features
- **CLI bridge layer:** terminal commands that talk to the extension background worker and active tab

Important operational facts:

- The CLI can auto-start the local bridge when needed.
- Most browser commands work even when the sidepanel is closed.
- REPL execution can run with the sidepanel closed through the offscreen runtime.
- **Session commands** such as `session`, `inject`, `new-session`, `set-model`, and `artifacts` depend on the sidepanel session surface.
- Sensitive commands are gated by Bridge settings.

## First command

Start with structured status:

```bash
shuvgeist status --json
```

Use this to confirm:

- extension connectivity
- current capabilities
- target window/tab state
- whether a sidepanel session is available

If you only need a quick human-readable check:

```bash
shuvgeist status
```

## Prerequisites

### Required

- Shuvgeist extension installed or built and loaded in Chrome/Edge
- A browser target connected to the extension

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
```

Close a CLI-launched browser with:

```bash
shuvgeist close
```

### Config resolution

Bridge config is resolved in this order:

1. CLI flags: `--token`, `--url`, `--host`, `--port`
2. Environment: `SHUVGEIST_BRIDGE_TOKEN`, `SHUVGEIST_BRIDGE_URL`, `SHUVGEIST_BRIDGE_HOST`, `SHUVGEIST_BRIDGE_PORT`
3. Config file: `~/.shuvgeist/bridge.json`

Browser and extension discovery for `launch` can also come from flags, env, config, local dev paths, or installed browser locations.

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

### Navigation and tab control

```bash
shuvgeist navigate "https://example.com"
shuvgeist navigate "https://example.com" --new-tab
shuvgeist tabs --json
shuvgeist switch <tabId>
```

Use `tabs --json` to capture stable `tabId` values for later `--tab-id` targeting.

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

### Interactive element picking

```bash
shuvgeist select "Click the login button"
```

Use this when a human can disambiguate the target faster than the model can.

## Deterministic automation surface

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
- `repeat` and `each` loops are supported
- exact token substitution like `"%{urls}"` preserves type
- interpolated strings like `"hello %{name}"` produce strings
- `as` captures prior results
- `defaultWait` and per-step `wait` are supported
- disallowed in workflows: nested workflow commands and interactive element selection

Use workflows when repeated round trips would be brittle or wasteful.

### Page snapshots

Use snapshots when you need a compact semantic representation of the current page.

```bash
shuvgeist snapshot --json
shuvgeist snapshot --tab-id 123 --frame-id 7 --max-entries 80 --json
```

Snapshots return semantic entries, candidate selectors, page metadata, and stable `snapshotId` values. Each entry's `snapshotId` is the same value as the `refId` returned by `locate` — pass it directly to `shuvgeist ref click|fill <id>`.

### Semantic locate

Use locators when you know what an element means, not what selector it has.

```bash
shuvgeist locate role button --name "Sign in" --json
shuvgeist locate text "Add to cart" --json
shuvgeist locate label "Email address" --json
```

Locator results include ranked matches, scores, reasons, and `refId` values. `refId` is the canonical ref-handle name; `snapshot` calls the same value `snapshotId` for legacy compatibility.

### Ref actions

Operate on prior semantic matches without repeating the search. `<refId>` may be a `refId` from `locate` or a `snapshotId` from `snapshot`.

```bash
shuvgeist ref click <refId>
shuvgeist ref fill <refId> --value "user@example.com"
```

Ref caveats:

- refs are scoped to `tabId + frameId`
- refs are in-memory only
- navigation invalidates refs
- stale or ambiguous refs should fail instead of guessing

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

Session commands are the main place where sidepanel availability matters. If the sidepanel session surface is unavailable, these commands should be treated as unavailable rather than retried blindly.

## Targeting flags

Prefer explicit routing when multiple tabs or frames are in play:

```bash
--tab-id <id>
--frame-id <id>
```

Use them with:

- `eval`
- `snapshot`
- `locate`
- `ref click`
- `ref fill`
- `frame list`
- `frame tree`
- `network ...`
- `device ...`
- `perf ...`

Do not assume the currently focused browser window is the intended target.

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
| 1 | Command/runtime error | Inspect the returned error |
| 2 | No extension target connected | Connect or launch a browser target |
| 3 | Auth/configuration/network error | Check token, URL, local bridge config, or discovery |

## Recommended operating patterns

### Robust semantic interaction

```bash
shuvgeist snapshot --json
shuvgeist locate role button --name "Sign in" --json
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
- Use `repl` when you know the DOM operations or need custom page logic.
- Use REPL native input helpers when sites reject synthetic DOM events.
- Use `eval` when the needed data only exists in MAIN world.
- Use `snapshot` + `locate` + `ref` when selectors are unknown, fragile, or dynamic.
- Use `frame list/tree` before touching iframe-heavy pages.
- Use `workflow` when multiple deterministic steps should happen in one request.
- Use `network` when request/response behavior matters more than rendered DOM.
- Use `device` when layout or behavior depends on viewport, touch, or user agent.
- Use `perf` when timing, runtime metrics, or traces matter.
- Use `session` / `inject` / `artifacts` when you need to collaborate with the Shuvgeist sidepanel assistant, not just automate the page.
