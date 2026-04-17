# Changelog

## [Unreleased]

## [1.1.4] - 2026-04-17

### Added

- Loopback-only bridge `/bootstrap` endpoint with Host/origin/header hardening so the extension background worker can auto-discover the local bridge token without manual copy/paste.
- Focused bridge settings/bootstrap unit coverage plus expanded bridge server hardening tests.

### Changed

- Bridge settings now use `chrome.storage.local` as the canonical runtime source of truth; the background worker lazily seeds defaults, performs one-time legacy IndexedDB migration, and reconciles live URL/token/sensitive-access changes without sidepanel mirroring.
- BridgeTab is now a management panel with status, bridge blocking, sensitive-access control, and advanced remote override fields instead of a mandatory local setup form.
- Same-host bridge onboarding no longer requires opening the sidepanel first or manually pasting the local token.
- Bridge REPL with the sidepanel closed now exposes the full browserjs()/navigate()/nativeClick-family runtime in the offscreen sandbox. The offscreen document hosts the sandbox iframe but proxies runtime calls to the background service worker, which owns tab/userScripts/debugger access and runs the actual script injection (including domain-scoped skill libraries). Previously only the bare sandbox sandbox was available, so `shuvgeist repl 'return await browserjs(...)'` failed unless the sidepanel was open.

### Fixed

- Background bridge reconnects now react immediately to URL/token/sensitive-access changes even when already connected.
- Bridge `disabled` state now means user-blocked only; token bootstrap failures degrade to disconnected/retryable state instead of masquerading as disabled.
- Bridge REPL no longer advertises itself as unavailable just because the sidepanel is closed. The background worker now treats REPL as dynamically available, serializes offscreen-document setup, and waits for an explicit ping/ready handshake before routing execution there, fixing the false `REPL requires sidepanel or offscreen document` failure window. When the sidepanel is open, the bridge REPL path now also uses the same browser helpers as the normal REPL (`browserjs()`, `navigate()`, native input providers) instead of silently running in a stripped-down sandbox.

## [1.1.3] - 2026-04-06

### Fixed

- CLI stdout pipe truncation: `shuvgeist snapshot --json | ...` and any other command that produced more than ~64 KiB of output was being silently truncated at the Linux pipe buffer size (65536 bytes) because Node writes stdout asynchronously when it is a pipe and `process.exit()` killed the process before the drain completed. The CLI now puts stdout/stderr into libuv blocking mode at `main()` entry (standard workaround for nodejs/node#6456), so piped output matches file-redirected output byte-for-byte.
- `shuvgeist launch --url <url>` previously treated the URL as the bridge WebSocket URL (because `--url` is the global bridge-URL flag), which silently redirected the "already connected" status check to the wrong host and then spawned a redundant headless browser that timed out waiting for extension registration. The launch command now reads the browser URL from `--url` (as its help text documents) or from a positional argument, and `cmdLaunch` strips `flags.url` before resolving the bridge URL so the two meanings of `--url` never collide. Unit tests lock the contract.
- `navigate` waits on `chrome.webNavigation.onDOMContentLoaded`, which never fires for URL schemes that webNavigation skips. The tool now races that listener against `chrome.tabs.onUpdated` with `status === "complete"`, which fires for every scheme that Chromium is actually allowed to navigate to. Top-frame `data:` URLs remain blocked by Chromium itself (phishing mitigation, Chrome 60+) — that is a platform limitation no extension can work around.

### Changed

- Browser benchmark harness now serves the form-fill fixture from a one-shot `python3 -m http.server` on `127.0.0.1:19287` (with an `EXIT` trap that kills the server and cleans the tmpdir) instead of a `data:text/html,...` URL. Chromium silently blocks programmatic top-frame navigation to `data:` URLs, which used to make the form-fill warm-path test hang until the 60s CLI timeout and quietly poison benchmark results under the old `time_cmd` harness.

## [1.1.2] - 2026-04-06

### Added

- Always-on bridge: BridgeClient and BrowserCommandExecutor moved from sidepanel to background service worker, keeping the WebSocket connection alive even when the sidepanel is closed
- Offscreen document for REPL sandbox execution when the sidepanel is not open
- Dynamic capability reporting based on sidepanel state (session commands require sidepanel, REPL works via sidepanel or offscreen)
- Bridge keepalive via chrome.alarms (1-minute interval) to survive MV3 service worker suspension
- Bridge settings mirrored to chrome.storage.local for background service worker access
- Bridge connection state shared via chrome.storage.session for UI reactivity
- `shuvgeist launch` command to start a Chromium browser with the extension loaded
- `shuvgeist close` command to shut down a CLI-launched browser
- Auto-start bridge server when any CLI command needs it
- Multi-tier extension discovery (flag, env, config, dev build, installed extensions)
- Multi-tier browser discovery (flag, env, config, PATH, known locations)
- `--browser`, `--extension-path`, `--profile`, `--headless`, `--foreground` flags for launch command
- PID tracking for launched browsers (~/.shuvgeist/launch.pid) and auto-started bridge (~/.shuvgeist/bridge.pid)
- Benchmark suite for shuvgeist vs agent-browser vs dev-browser, including warm-path comparisons and report generation

### Fixed

- Screenshot regression: `shuvgeist screenshot` timed out (120s) because ExtractImageTool hangs in service worker context. Screenshots now route to sidepanel when open, falling back to CDP Page.captureScreenshot when closed.
- BridgeClient was creating its own BrowserCommandExecutor without replRouter or sessionBridge, causing REPL and session commands to fail from the background service worker. Now passes both through from connect options.
- Removed orphaned commandExecutor variable in background.ts that was never used by the bridge client.
- `shuvgeist navigate` and tab switch commands no longer fail in background bridge mode when AppStorage is unavailable; skills lookup now degrades safely instead of returning exit code 1 after a successful navigation.
- Bridge target resolution: the background service worker no longer registers with the bridge using `windowId=0`, which previously caused screenshot/snapshot to fail fast while other commands silently fell back to current-window semantics. A shared `isUsableWindowId()` helper is now the single source of truth for window-id validity, the executor is rebuilt on focus changes, and bridge connection is deferred until a usable window id is observed (fixes #1).

### Changed

- Bridge status indicator in sidepanel now reads from chrome.storage.session instead of direct BridgeClient state
- BridgeClient supports dynamic capabilities via `capabilitiesProvider` callback
- BrowserCommandExecutor supports `ReplRouter` for delegated REPL execution and `ScreenshotRouter` for delegated screenshot capture
- BridgeTab settings dialog reads state from chrome.storage.session instead of module-level variables
- Tool renderers are split into dedicated files, reducing runtime coupling in core tool modules
- `shuvgeist status` no longer presents `Window ID: 0` as a healthy connected target; non-positive ids are now displayed as `unavailable` (defense-in-depth on top of background-side gating)
- Browser benchmark harness now preflights the extension via `shuvgeist status --json` and runs all shuvgeist warm-path tests in strict mode (`time_cmd_success_required`), aborts on the first benchmark-critical failure, validates screenshot/snapshot artifacts, and exits non-zero when the run is invalid

## [1.1.0] - 2026-03-26

### Breaking Changes

### Added

- Bridge workflow execution and validation commands, including shared workflow schema validation, bounded workflow runs, and structured workflow results.
- Bridge page snapshot, semantic locator, stable ref, and frame inspection commands for semantic targeting across tabs and frames.
- Bridge network capture, device emulation, and performance tracing/metrics commands for debugging and observability from the CLI.

- Import/Export for custom providers in Providers & Models settings tab, with conflict resolution UI for overwrites
- Proxx provider preset in `static/provider-presets/proxx.json` for quick setup after storage resets
- Model favorites in the selector, with star toggles and pinned ordering so frequently used models stay at the top of the list

### Changed

- Bridge browser tooling now resolves active tabs against the extension window instead of relying on whichever Chrome window currently has OS focus, and debugger-backed bridge features now share a coordinated debugger lifecycle manager.

### Fixed

- Anthropic Max subscription login now uses a manual code or callback URL paste flow instead of the broken automatic token-exchange redirect flow, restoring Claude Pro/Max sign-in and clarifying the UI prompts.
- Proxx model catalogs now include the current GPT-5 and Codex families in the shipped preset, imported Proxx providers are backfilled with the built-in OpenAI model metadata so GPT and Codex traffic keeps using the correct upstream API, and the preset now explicitly marks GPT-family entries as `openai-responses`. Proxx credential checks now also honor the custom-provider token instead of opening the providers dialog before send, the selector preserves stored Proxx model metadata instead of replacing it with discovery-only placeholders, the shipped preset points at `http://shuvdev:8789/v1`, and Proxx imports default to discovery disabled so the saved model definitions remain authoritative.

### Removed

## [1.0.7] - 2026-03-22

### Added

- Providers & Models settings tab for configuring built-in API key providers and custom model gateways like `proxx`
- Comprehensive automated test suite with Vitest unit/integration coverage, expanded dialog/component tests, Playwright smoke tests, full proxy runtime coverage, CI jobs, and gated core-module coverage thresholds

### Changed

- Subscription OAuth moved to a dedicated Subscriptions settings tab
- Model selection and default model resolution now include configured custom providers
- Theme toggle moved from the sidebar header into settings, with dark mode as the default

### Fixed

- Custom provider API keys now resolve correctly at runtime so OpenAI-compatible gateways can be used without extension-side OAuth
- Bridge reconnect race that could trigger an infinite 1-second connection replacement loop after session changes

## [1.0.1] - 2026-03-20

### Added

- CLI-to-extension bridge: `shuvgeist serve`, `navigate`, `tabs`, `switch`, `repl`, `screenshot`, `eval`, `select`
- Bridge settings tab in the extension sidepanel (URL, token, connection status)
- WebSocket relay server with token auth, request routing, and abort handling
- `proxy/` — self-hosted CORS proxy service (Node 22, Express, TypeScript, Docker)
  - Supports `GET|POST|OPTIONS /?url=<encoded-url>` and path-based fallback
  - Host allowlist (configurable via `ALLOWED_HOSTS` env var)
  - Optional shared-secret auth via `PROXY_SECRET` env var
  - In-memory rate limiting (`RATE_LIMIT_RPM`, default 300/min per IP)
  - Streaming response passthrough for SSE and large payloads
  - Structured JSON logging (never logs credentials or request bodies)
  - `docker-compose.yml` for one-command local or production deployment

### Changed

- Screenshots now encode as WebP (quality 80) instead of PNG — ~95% size reduction for token efficiency
- Default bridge URL pre-populated to `ws://127.0.0.1:19285/ws`
- Merged upstream: CORS handled locally via `declarativeNetRequest` rules, removing external proxy dependency for OAuth

### Fixed

- Screenshot `captureVisibleTab` failing with `<all_urls>` permission error on bridge-initiated captures
- Screenshot `fetch()` on data URLs failing in recent Chrome versions (manual base64-to-Blob conversion)
- Live-reload WebSocket spam in production builds (gated behind `NODE_ENV === "development"`)
- False "Update Available" notification comparing against upstream shuvgeist version

### Removed

- Proxy settings tab (no longer needed with declarativeNetRequest CORS rules)

## [1.0.0] - 2026-03-15

### Added

- Browser-based OAuth login for Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT Plus/Pro), GitHub Copilot, and Google Gemini CLI
- Combined "API Keys & OAuth" settings tab with subscription login and API key entry
- Welcome setup dialog on first launch when no providers are configured
- Auto-select default model for the first provider with a key
- Provider and auth type indicator in the header bar
- Image extraction tool (`extract_image`) with selector and screenshot modes
- Subsequence-based fuzzy search in the model selector
- CORS proxy warning in OAuth sections (orange when enabled, red when disabled)
- GitHub Actions workflow for tagged releases
- `release.sh` script for version bumping and tagged releases

### Changed

- Default model changed to `claude-sonnet-4-6` with `medium` thinking level
- CORS proxy enabled by default
- Model selector only shows models from providers with configured keys
- API key prompt dialog now shows both OAuth login and API key entry for supported providers
- Tool execution set to sequential mode (parallel caused rendering issues in sidebar)
- Site converted to static (removed backend, admin, waitlist signups)
- Download links point to GitHub Releases
- License changed from MIT to AGPL-3.0

### Fixed

- Settings dialog tabs not responding to clicks (upstream `pi-web-ui` built with `tsgo` broke Lit decorator reactivity)
- CORS proxy toggle not updating (same root cause)
- Proxy not applied to API requests (esbuild bundled duplicate `streamSimple` references, breaking identity check)
- Model selector button not updating after picking a model (added `state_change` event to Agent)
- Duplicate tool component rendering during streaming (cleared streaming container on `message_end`)
- Screenshot tool capturing sidepanel instead of the webpage
