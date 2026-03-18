# Plan: Run Our Own CORS Proxy for Sitegeist

## Objective

Replace the default third-party proxy dependency with an operator-controlled CORS proxy that supports Sitegeist's browser-based auth and fetch flows.

This plan covers:
- the current proxy usage in Sitegeist
- the required proxy contract
- a secure self-hosted implementation approach
- deployment/integration steps
- validation and rollout

This is a plan only. No implementation is included here.

## TL;DR

Sitegeist needs a proxy because some provider endpoints do not allow browser-origin requests via CORS. The proxy is not Helium-specific; it is a generic browser-to-provider bridge.

We should stand up a small authenticated proxy service that accepts requests in the existing format:

```text
<proxy-base-url>/?url=<encoded-target-url>
```

Then we should:
- restrict it to approved upstream hosts
- avoid logging credentials/bodies
- add basic telemetry, rate limiting, and timeouts
- point Sitegeist at the new proxy URL
- test Anthropic OAuth, GitHub Copilot OAuth, proxied model calls, and document extraction fallback

## Current State Review

### Where the proxy is used today

#### OAuth helpers
- `src/oauth/browser-oauth.ts`
  - `postTokenRequest()` posts token requests either directly or through `proxyUrl`
- `src/oauth/anthropic.ts`
  - Anthropic token exchange and refresh require a proxy
- `src/oauth/github-copilot.ts`
  - GitHub device-code and access-token steps use a proxy

#### Runtime model requests
- `../pi-mono/packages/web-ui/src/utils/proxy-utils.ts`
  - `shouldUseProxyForProvider()` currently proxies:
    - `zai`
    - `anthropic` OAuth tokens
    - `openai-codex`
  - `applyProxyIfNeeded()` rewrites `model.baseUrl` to:
    - `${proxyUrl}/?url=${encodeURIComponent(model.baseUrl)}`

#### Document extraction fallback
- `../pi-mono/packages/web-ui/src/tools/extract-document.ts`
  - direct fetch first
  - proxy fallback on CORS errors if `corsProxyUrl` is configured

#### App integration
- `src/sidepanel.ts`
  - loads `proxy.enabled` and `proxy.url`
  - passes proxy to model streaming and OAuth resolution
  - configures `extract_document` fallback proxy

#### User settings and warnings
- `../pi-mono/packages/web-ui/src/dialogs/SettingsDialog.ts`
  - stores `proxy.enabled` and `proxy.url`
- `src/dialogs/ApiKeysOAuthTab.ts`
- `src/dialogs/ApiKeyOrOAuthDialog.ts`
  - display warnings about proxy trust and credential exposure

## Problem Statement

The current default proxy is third-party infrastructure. That creates an unnecessary trust dependency because proxied requests may contain:
- OAuth token exchange payloads
- refresh tokens
- provider Authorization headers
- document fetches from private or semi-private URLs

We need a proxy we control.

## Requirements

## Functional requirements

The proxy must:
- accept `GET`, `POST`, and `OPTIONS` at minimum
- accept the existing query format:
  - `/?url=<encoded-target-url>`
- forward request method, allowed headers, and request body to the upstream URL
- return upstream status code and response body
- add permissive browser CORS headers on the proxy response
- correctly handle preflight (`OPTIONS`) requests

## Non-functional requirements

The proxy should:
- be private to our org or product
- not log secrets, access tokens, refresh tokens, or request bodies
- restrict outbound targets to an allowlist of known hosts
- enforce timeouts and payload size limits
- rate limit abusive use
- emit basic telemetry for success/failure/latency without leaking secrets

## Compatibility requirements

The proxy must remain compatible with the current Sitegeist code path, which expects:

```text
${proxyUrl}/?url=${encodeURIComponent(targetUrl)}
```

No client-side API shape changes should be required for initial rollout.

## Recommended Architecture

## Recommendation

Implement a small Node/Express proxy service first.

Rationale:
- easiest to control request/response passthrough
- easiest to support POST bodies and provider-specific headers
- simple to containerize and self-host
- simplest path for debugging OAuth and provider traffic

Cloudflare Worker or another edge runtime can be considered later, but the initial plan assumes a Node service because it is the least ambiguous for auth/body forwarding.

## Service contract

### Request
- Method: `GET | POST | PUT | PATCH | DELETE | OPTIONS` (supporting more than current immediate need is fine)
- URL: `/`
- Query parameter:
  - `url` = full encoded upstream URL

### Behavior
- validate and decode `url`
- reject malformed URLs
- reject hosts not on allowlist
- forward allowed headers and body to upstream
- follow redirects when appropriate
- stream or buffer upstream response back to caller

### Response headers
Must include browser CORS support, e.g.:
- `Access-Control-Allow-Origin`
- `Access-Control-Allow-Headers`
- `Access-Control-Allow-Methods`

### Authentication to our proxy
One of these should be chosen before deployment:
- shared secret header from the extension
- session/service token
- IP restriction for private-only environments
- access gateway in front of the service

For initial deployment, a shared secret header plus infra-level network protection is acceptable.

## Security Plan

## 1. Host allowlist

Restrict outbound requests to a curated set of upstream hosts required by Sitegeist.

Initial likely allowlist:
- `platform.claude.com`
- `github.com`
- `api.github.com`
- any provider hosts needed for proxied runtime calls, for example:
  - ZAI API host(s)
  - OpenAI Codex backend host(s) if still needed through proxy

Exact runtime host list must be confirmed from current model/base URL definitions before implementation.

## 2. Header filtering

Do not blindly forward all browser headers.

Do forward required headers such as:
- `authorization`
- `content-type`
- `accept`
- provider-specific required headers

Do not forward or should explicitly strip:
- `host`
- `origin`
- `referer`
- `content-length` if recomputed by fetch/client
- browser-only internal headers

## 3. Secret-safe logging

Never log:
- request bodies
- `Authorization` headers
- cookies
- OAuth token payloads
- query strings containing secrets

If request metadata is logged, redact:
- target URL query values where sensitive
- auth-bearing headers
- response bodies

## 4. Abuse prevention

Add:
- rate limiting per client key/IP
- body size limits
- request timeout
- concurrency limits if needed

## 5. Transport security

Production deployment must use HTTPS.

## Telemetry Plan

Per project rules, telemetry is required day one.

The proxy should emit enough observability to answer:
- what target host was requested?
- by which client/app environment?
- how long did the upstream call take?
- did it fail, and at what stage?
- how many requests are using each upstream host/path category?

### Minimum telemetry fields
- request ID
- timestamp
- client/app identifier
- upstream hostname
- upstream path category (redacted/generalized if needed)
- method
- response status
- duration ms
- timeout yes/no
- allowlist rejection yes/no
- auth failure yes/no

### Secret-handling rule
Telemetry must not contain:
- raw access tokens
- refresh tokens
- raw request bodies
- full sensitive URLs

## Implementation Plan

## Phase 1: Confirm current proxy surface area

### 1.1 Audit current proxied destinations
- [ ] Review provider base URLs used in proxied flows
- [ ] Confirm exact hosts needed for:
  - [ ] Anthropic OAuth token exchange/refresh
  - [ ] GitHub Copilot device-code flow
  - [ ] ZAI runtime calls
  - [ ] OpenAI Codex proxied runtime calls
  - [ ] document extraction fallback, if we intend to allow it through the same proxy
- [ ] Produce an initial allowlist of approved upstream hosts

### 1.2 Decide product scope
- [ ] Decide whether document extraction fallback should use the same proxy or a separate path
- [ ] Decide whether the proxy remains user-configurable or should default to operator-controlled infrastructure
- [ ] Decide whether to support local development proxy and production proxy separately

## Phase 2: Build the proxy service

### 2.1 Create service scaffold
- [ ] Create a new small service package/repo for the proxy
- [ ] Use Node 22+ and Express/Fastify/Hono-on-Node
- [ ] Add config handling for:
  - [ ] bind address/port
  - [ ] shared secret or auth token
  - [ ] allowlisted hosts
  - [ ] timeout values
  - [ ] max request body size
  - [ ] telemetry/export config

### 2.2 Implement request handling
- [ ] Support `OPTIONS` and return CORS allow headers
- [ ] Support `GET` and `POST` first
- [ ] Parse `url` query param
- [ ] Validate it is a well-formed absolute URL
- [ ] Reject URLs whose host is not allowlisted
- [ ] Forward method, filtered headers, and body to upstream
- [ ] Return upstream status/body/content-type to caller

### 2.3 Implement security controls
- [ ] Require proxy authentication from approved clients
- [ ] Add header filtering/redaction logic
- [ ] Add request timeout handling
- [ ] Add body size limits
- [ ] Add rate limiting
- [ ] Ensure logs are secret-safe

### 2.4 Implement telemetry
- [ ] Add structured logs
- [ ] Add request timing metrics
- [ ] Add success/failure counters
- [ ] Add allowlist-rejection counters
- [ ] Add timeout counters
- [ ] Ensure secret redaction in all telemetry paths

## Phase 3: Package and deploy the proxy

### 3.1 Containerization
- [ ] Add `Dockerfile`
- [ ] Add runtime env var documentation
- [ ] Add healthcheck endpoint if useful

### 3.2 Deployment target
- [ ] Choose deployment location:
  - [ ] internal VM/container host
  - [ ] managed container platform
  - [ ] existing API infrastructure
- [ ] Provision DNS, e.g. `proxy.<our-domain>`
- [ ] Terminate TLS
- [ ] Restrict inbound access as appropriate

### 3.3 Runtime hardening
- [ ] Disable verbose production logging
- [ ] configure restart policy
- [ ] configure resource limits
- [ ] add alerting for error-rate spikes or downtime

## Phase 4: Integrate Sitegeist with the new proxy

### 4.1 Configure proxy in Sitegeist settings
- [ ] Set `proxy.url` to our proxy base URL in the app
- [ ] Keep format compatible with current code (`/?url=` added client-side)
- [ ] Ensure `proxy.enabled` behavior is documented clearly

### 4.2 Decide default behavior
- [ ] Decide whether our proxy becomes the default configured proxy
- [ ] Decide whether proxy remains enabled by default or only when needed
- [ ] Decide whether any third-party proxy references should be removed from defaults/docs

### 4.3 Update copy and docs
- [ ] Update user-facing warning text to refer to the configured proxy generically or our operator-controlled proxy specifically
- [ ] Update proxy documentation to explain:
  - [ ] why the proxy exists
  - [ ] which flows use it
  - [ ] how trust works
  - [ ] how operators run their own proxy

Relevant files:
- `src/dialogs/ApiKeysOAuthTab.ts`
- `src/dialogs/ApiKeyOrOAuthDialog.ts`
- `src/tutorials.ts`
- `docs/proxy.md`
- `src/sidepanel.ts`

## Phase 5: Validation

### 5.1 Low-level proxy validation
- [ ] Test preflight handling with `OPTIONS`
- [ ] Test `GET /?url=...` against an allowlisted host
- [ ] Test `POST /?url=...` with JSON body passthrough
- [ ] Test auth failure path
- [ ] Test allowlist rejection path
- [ ] Test timeout behavior

### 5.2 Sitegeist integration validation
- [ ] Anthropic OAuth login succeeds using our proxy
- [ ] Anthropic token refresh succeeds using our proxy
- [ ] GitHub Copilot device code flow succeeds using our proxy
- [ ] proxied model request succeeds for a provider that needs it
- [ ] document extraction fallback succeeds on a CORS-blocked document URL, if enabled through this proxy

### 5.3 Negative testing
- [ ] host not on allowlist is rejected
- [ ] missing/invalid proxy auth is rejected
- [ ] oversized body is rejected
- [ ] provider downtime surfaces a sane error to the client

## Phase 6: Rollout

### 6.1 Internal rollout
- [ ] Deploy proxy in non-public/internal environment first
- [ ] configure Sitegeist test install to use it
- [ ] run smoke tests with real provider accounts

### 6.2 Production rollout
- [ ] deploy production proxy endpoint
- [ ] switch Sitegeist default config or operator instructions to new proxy
- [ ] monitor telemetry for auth failures, timeout spikes, and upstream host mismatches

### 6.3 Cleanup
- [ ] remove dependence on the previous third-party default proxy in our environment/docs
- [ ] document incident/debug workflow for proxy failures

## Suggested File/Artifact Deliverables

### Proxy service
- [ ] `proxy-service/package.json`
- [ ] `proxy-service/src/server.ts`
- [ ] `proxy-service/src/config.ts`
- [ ] `proxy-service/src/allowlist.ts`
- [ ] `proxy-service/src/auth.ts`
- [ ] `proxy-service/src/logging.ts`
- [ ] `proxy-service/src/telemetry.ts`
- [ ] `proxy-service/Dockerfile`
- [ ] `proxy-service/README.md`

### Sitegeist changes
- [ ] `docs/proxy.md`
- [ ] `src/dialogs/ApiKeysOAuthTab.ts`
- [ ] `src/dialogs/ApiKeyOrOAuthDialog.ts`
- [ ] `src/tutorials.ts`
- [ ] optionally `src/sidepanel.ts` if default proxy behavior changes

## Open Decisions

### 1. Should document extraction use the same proxy?
Pros:
- one service to operate

Cons:
- broader attack surface and broader host allowlist

Recommendation:
- keep same service only if document hosts can be tightly constrained or if the extraction fallback remains optional and clearly bounded

### 2. Should the proxy be user-configurable in production builds?
Recommendation:
- operator-controlled default for production
- user-configurable only for advanced/dev builds if needed

### 3. Should proxy auth be extension-bundled secret or backend-issued token?
Recommendation:
- start with infra gating + static secret only if exposure risk is acceptable
- move to a stronger client auth mechanism if the proxy will be publicly reachable at scale

## Acceptance Criteria

- [ ] We control the proxy infrastructure used by Sitegeist
- [ ] The proxy supports the current `/?url=<target-url>` contract
- [ ] Anthropic OAuth works through our proxy
- [ ] GitHub Copilot OAuth works through our proxy
- [ ] Required proxied model calls work through our proxy
- [ ] The proxy rejects non-allowlisted destinations
- [ ] Telemetry exists for success/failure/latency without leaking credentials
- [ ] Documentation explains how the proxy works and how to operate it

## Recommended Execution Order

1. audit exact upstream hosts currently needed
2. build minimal authenticated allowlisted proxy
3. deploy it in a test environment
4. point Sitegeist settings at it
5. validate OAuth + proxied runtime flows
6. update docs and default configuration
7. roll out broadly
