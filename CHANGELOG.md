# Changelog

## [Unreleased]

### Added

- Providers & Models settings tab for configuring built-in API key providers and custom model gateways like `proxx`

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
- False "Update Available" notification comparing against upstream sitegeist version

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
