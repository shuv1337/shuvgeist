# Proxy Architecture

## Overview

Shuvgeist uses a **CORS Proxy** to handle Cross-Origin Resource Sharing restrictions for:

1. **LLM API calls** - When providers block direct browser requests
2. **Document extraction** - When websites block automated downloads from extensions

## Problem Statement

Browser extensions face CORS restrictions when making HTTP requests:

1. **LLM API Calls**: Some providers (Anthropic with OAuth tokens, Z-AI) have CORS headers that block direct browser requests
2. **Document Extraction**: Websites serving PDFs/DOCX files often have CORS policies that block automated downloads

Without a CORS proxy, these requests would fail in the browser environment.

## Current Implementation

### Architecture

```
┌─────────────┐
│   Browser   │
│  Extension  │
└──────┬──────┘
       │
       ├──────────────────────────────────────────────────┐
       │                                                  │
       v                                                  v
┌──────────────────┐                           ┌──────────────────┐
│ provider-runtime  │                          │ extract_document │
│ (LLM requests)    │                          │ (fetch docs)     │
└──────┬───────────┘                           └──────┬───────────┘
       │                                               │
       │  Load proxy settings                          │  Check corsProxyUrl
       │  from storage                                 │  property
       │                                               │
       v                                               v
   applyProxyIfNeeded()                         Try direct fetch first
       │                                               │
       │  Provider-specific logic:                     │
       │  - Z-AI: always proxy                         ├─ Success → Done
       │  - Anthropic sk-ant-oat: proxy                │
       │  - Others: no proxy                           ├─ CORS error + proxy
       │                                               │   configured?
       v                                               │
   If proxy needed:                                    v
   baseUrl = proxy/?url=...                     Retry with proxy
       │                                               │
       └───────────────────┬───────────────────────────┘
                           │
                           v
                  ┌────────────────┐
                  │  CORS Proxy    │
                  │  (strips CORS) │
                  └────────────────┘
```

### File Structure

#### Shuvgeist (Extension)

- **`packages/extension/src/agent/provider-runtime.ts`**:
  - Loads proxy settings for each LLM stream and credential-resolution request
  - Supplies the configured URL to pi-web-ui's `createStreamFn()`

- **`packages/extension/src/offscreen.ts`**:
  - Configures the `extract_document` tool with the proxy URL when enabled

- **`packages/extension/src/sidepanel.ts`**:
  - Loads proxy settings while resolving provider credentials
  - Explicitly disables the legacy proxy toggle during current startup

- **`packages/extension/src/tutorials.ts`**:
  - Explains CORS proxy behavior to users in the welcome tutorial

- **`packages/extension/src/storage/persistent-settings.ts`**:
  - Owns typed access to the retained `proxy.enabled` and `proxy.url` keys

#### pi-web-ui Package

- **`packages/web-ui/src/utils/proxy-utils.ts`**:
  - Centralized proxy decision logic
  - `shouldUseProxyForProvider(provider, apiKey)`: Returns true for Z-AI (always) and Anthropic with OAuth tokens (`sk-ant-oat-*`), false for others
  - `applyProxyIfNeeded(model, apiKey, proxyUrl)`: Applies proxy to model's baseUrl only if provider/key combination requires it
  - `isCorsError(error)`: Detects CORS errors by checking for `TypeError: Failed to fetch`, `NetworkError`, or messages containing "cors"/"cross-origin"

- **`packages/web-ui/src/tools/extract-document.ts`**:
  - Tool has optional `corsProxyUrl` property set by Shuvgeist if proxy is enabled
  - Implements try-first-fallback pattern:
    1. Attempts direct fetch to document URL
    2. If CORS error occurs and proxy is configured, retries with proxy
    3. If CORS error and no proxy, shows error message suggesting proxy configuration or manual download
    4. If non-CORS error, re-throws immediately
  - **Behavior**: Direct fetch preferred; proxy only used when CORS error occurs

- **`packages/web-ui/src/components/ProviderKeyInput.ts`**:
  - Uses `applyProxyIfNeeded()` when testing API keys
  - **Behavior**: Only Z-AI and Anthropic OAuth tokens test through proxy; others test directly

- **`packages/web-ui/src/dialogs/SettingsDialog.ts`**:
  - Provides the reusable proxy settings tab backed by the web-ui settings store

### Default Configuration

**Location**: `packages/extension/src/sidepanel.ts`

```typescript
await setProxyEnabled(false);
```

**Defaults**:
- Proxy is **disabled by default and explicitly disabled at current startup**
- A previously stored URL is retained but has no effect while disabled
- Run your own proxy using the `proxy/` directory in this repo

### Storage Schema

Settings stored in IndexedDB under `shuvgeist-storage` database:

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `proxy.enabled` | `boolean` | `false` | Whether CORS proxy is enabled |
| `proxy.url` | `string` | absent | CORS proxy server URL |

## Provider-Specific Proxy Logic

The proxy system uses hardcoded provider rules to determine when proxy is necessary:

### Providers That Require Proxy

1. **Z-AI** - Always uses proxy (CORS blocked)
2. **Anthropic with OAuth tokens** - API keys starting with `sk-ant-oat-` use proxy
   - Regular Anthropic API keys (`sk-ant-api-*`) do NOT use proxy
3. **OpenAI Codex subscription login** - The `openai-codex` provider uses the ChatGPT backend and requires the proxy path

### Providers That Work Without Proxy

These providers have proper CORS headers and connect directly:
- OpenAI
- Google Gemini
- Groq
- OpenRouter
- Cerebras
- xAI (Grok)
- Ollama
- LM Studio

### Unknown Providers

For providers not in the hardcoded list, the system defaults to NOT using proxy. This allows new providers to work by default without proxy configuration.

## Document Extraction Proxy Behavior

The `extract_document` tool implements a try-first-fallback strategy:

1. **First attempt**: Direct fetch to the document URL
2. **On CORS error**: If proxy is configured, retry the fetch through proxy
3. **On success**: Return extracted document text
4. **On failure**:
   - If proxy available but also failed: Show error about both attempts
   - If no proxy configured: Show error suggesting proxy setup or manual download
   - If non-CORS error: Re-throw immediately without proxy retry

This approach minimizes proxy usage since many document URLs don't have CORS restrictions.

## Technical Details

### Proxy URL Format

The CORS proxy expects URLs in this format:
```
http://localhost:3001/?url=<encoded-target-url>
```

Example:
```typescript
const targetUrl = "https://api.anthropic.com/v1/messages";
const proxyUrl = "http://localhost:3001";
const proxiedUrl = `${proxyUrl}/?url=${encodeURIComponent(targetUrl)}`;
// Result: "http://localhost:3001/?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmessages"
```

### How the Proxy Works

1. Browser makes request to proxy server
2. Proxy server receives request with target URL
3. Proxy makes request to target URL from server (no CORS issues)
4. Proxy strips CORS headers from response
5. Proxy returns response to browser

This bypasses browser CORS restrictions because:
- The actual cross-origin request is made by the server (not subject to CORS)
- The browser only communicates with the proxy (same-origin or CORS-enabled)

### Privacy Considerations

From tutorials.ts:
> CORS proxy: Some subscription logins (Anthropic, GitHub Copilot) and providers (Z-AI) require a CORS proxy. Configure your proxy URL in Settings > Proxy. See the project README for instructions on running your own proxy

Users can:
1. Disable the proxy (if using providers that don't need it)
2. Run their own proxy using the `proxy/` directory in this repo
3. Use any compatible CORS proxy service

## Benefits of Current Implementation

### Minimal Proxy Usage
- Only Z-AI and Anthropic OAuth tokens use proxy for LLM requests
- Document extraction tries direct fetch first
- Most requests (OpenAI, Google, etc.) connect directly

### Better Performance
- Direct connections are faster (no proxy hop)
- Reduced load on proxy infrastructure
- Less bandwidth through proxy

### Clearer Error Messages
- CORS errors detected and handled specifically
- Users get helpful messages about proxy configuration
- Distinguishes CORS issues from other network errors

### User Control
- Proxy can be disabled completely if not needed
- Custom proxy URLs supported
- Settings clearly explain when proxy is required

## Related Files

### Shuvgeist Extension
- `packages/extension/src/agent/provider-runtime.ts` - LLM stream and credential proxy integration
- `packages/extension/src/offscreen.ts` - Document extraction tool configuration
- `packages/extension/src/sidepanel.ts` - Credential resolution and current startup policy
- `packages/extension/src/tutorials.ts` - User-facing proxy explanation
- `packages/extension/src/storage/persistent-settings.ts` - Typed proxy settings access
- `docs/settings.md` - Proxy settings documentation

### pi-web-ui Package
- `packages/web-ui/src/utils/proxy-utils.ts` - Centralized proxy decision and stream logic
- `packages/web-ui/src/tools/extract-document.ts` - Document extraction with try-first-fallback proxy
- `packages/web-ui/src/components/ProviderKeyInput.ts` - API key testing with selective proxy
- `packages/web-ui/src/dialogs/SettingsDialog.ts` - Proxy settings UI
- `packages/web-ui/src/storage/stores/settings-store.ts` - Settings persistence
