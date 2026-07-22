# Plan: Public Cloudflare Worker CORS Proxy for Shuvgeist

## Objective

Stand up an operator-controlled public CORS proxy for Shuvgeist using a Cloudflare Worker while preserving the current client contract:

```text
<proxy-base-url>/?url=<encoded-target-url>
```

This plan is specifically for a Cloudflare Worker deployment. It does not replace the broader self-hosted Node proxy plan in [`PLAN-own-cors-proxy.md`](./PLAN-own-cors-proxy.md); it narrows the design to a Worker-first implementation that can be deployed on a public hostname such as `proxy.shuvgeist.ai`.

## Current State

### Existing proxy contract

The current extension and local proxy already assume:

- `GET|POST|OPTIONS /?url=<encoded-upstream-url>`
- `GET /<encoded-upstream-url>` as a document-extraction fallback path
- permissive CORS response headers

Relevant files:

- `proxy/src/server.ts`
- `proxy/README.md`
- `src/sidepanel.ts`
- `src/oauth/browser-oauth.ts`
- `src/oauth/anthropic.ts`
- `src/oauth/github-copilot.ts`
- `../pi-mono/packages/web-ui/src/utils/proxy-utils.ts`
- `../pi-mono/packages/web-ui/src/tools/extract-document.ts`

### Current defaults and behavior

- `src/sidepanel.ts` defaults `proxy.url` to `http://localhost:3001`
- `proxy/README.md` documents the allowlist-based local Node proxy
- the current repo already has a working reference implementation in `proxy/src/server.ts`

### Proxy use cases that must keep working

- Anthropic OAuth token exchange and refresh
- GitHub Copilot device-code and token exchange
- proxied runtime model calls that already depend on the proxy path
- optional document extraction fallback, if we keep that behavior in the public Worker

## Cloudflare Worker Fit

### Why a Worker is viable

- Worker `fetch()` can forward requests to approved upstream hosts
- manual CORS handling is straightforward
- Cloudflare provides public hostname, TLS, logs, WAF, and rate limiting in one place
- the current proxy contract is simple enough to port directly

### Why a public Worker is risky

- this proxy may forward OAuth token exchanges and upstream Authorization headers
- a truly open public proxy will be abused quickly
- a static shared secret embedded in the extension is not durable protection
- Cloudflare Access service tokens are also not sufficient if the client is a public browser extension and the token is embedded client-side

### Practical recommendation

- make the endpoint public and internet-reachable
- do not make it a general-purpose open relay
- tightly constrain allowed upstream hosts and paths
- add hard request limits and observability from day one
- treat unauthenticated public access as acceptable only if the Worker can expose a very narrow, low-abuse surface

## Required Architecture

### Worker surface

- `GET /health`
- `OPTIONS /?url=<encoded-upstream-url>`
- `GET /?url=<encoded-upstream-url>`
- `POST /?url=<encoded-upstream-url>`
- optional `GET /<encoded-upstream-url>` document fallback path

### Worker responsibilities

- decode and validate the upstream URL
- reject malformed URLs
- enforce allowlist rules
- enforce exact-path rules for sensitive providers
- filter request headers before forwarding
- forward request body for supported methods
- preserve upstream status code and relevant response headers
- add browser CORS headers on every response
- emit structured logs without secrets

### Cloudflare components

- Worker for request handling
- DNS route such as `proxy.shuvgeist.ai`
- WAF or zone rate-limiting rules in front of the Worker
- Worker environment variables for host/path allowlists and feature flags
- optional Analytics Engine or log push target for telemetry aggregation

## Security Model

### Minimum controls

- [ ] Exact allowlist of approved upstream hostnames
- [ ] Exact allowlist of approved upstream paths for OAuth/token routes
- [ ] Header filtering and redaction
- [ ] Request timeout handling
- [ ] Request body size limit
- [ ] Worker-level rate limiting
- [ ] Zone-level WAF/rate-limit rules
- [ ] Secret-safe structured logs

### Host allowlist

Initial candidate hosts, subject to code audit:

- `platform.claude.com`
- `api.anthropic.com`
- `github.com`
- `api.github.com`
- `api.z.ai`
- `chatgpt.com`

### Path restrictions

Do not stop at hostname allowlisting alone. Add exact or prefix path rules for sensitive routes, for example:

- Anthropic OAuth token routes
- GitHub OAuth device-code and access-token routes
- only the specific provider API prefixes already required by current runtime behavior

This is the single biggest improvement over a generic public CORS proxy.

### Authentication decision

Initial Worker version:

- no extension-bundled static secret
- no Cloudflare Access service token embedded in the extension
- rely on narrow allowlists, rate limits, and WAF controls

Future hardening option:

- add short-lived signed client tokens from an operator-controlled backend if Shuvgeist later gains a server-side trust anchor

## Request and Response Rules

### Allowed request methods

- `OPTIONS`
- `GET`
- `POST`

Add other methods only if the audited Shuvgeist flows require them.

### Request validation

- [ ] Require `url` query parameter for the main proxy route
- [ ] Parse as absolute HTTPS URL
- [ ] Reject non-HTTPS targets unless explicitly justified
- [ ] Reject userinfo in URLs
- [ ] Reject hosts not in allowlist
- [ ] Reject paths not in per-host allowlist

### Forwarded request headers

Forward only required headers such as:

- `authorization`
- `content-type`
- `accept`
- provider-specific headers already required by current flows

Strip headers such as:

- `origin`
- `referer`
- `cookie`
- `host`
- `content-length` when recomputed
- browser-only fetch metadata unless explicitly needed

### Response handling

- [ ] Return upstream status code
- [ ] Return upstream body
- [ ] Return safe upstream content-type
- [ ] Add `Access-Control-Allow-Origin`
- [ ] Add `Access-Control-Allow-Methods`
- [ ] Add `Access-Control-Allow-Headers`
- [ ] Respond correctly to preflight requests

## Implementation Plan

## Phase 1: Audit and lock scope

- [ ] Confirm every upstream host currently used by Shuvgeist proxy flows
- [ ] Confirm every sensitive path that must remain reachable
- [ ] Decide whether document extraction stays on the same public Worker
- [ ] Decide whether the Worker becomes the default production proxy or remains optional

Validation:

- [ ] A reviewed allowlist table exists with host and path entries
- [ ] Every entry maps back to a real Shuvgeist code path

## Phase 2: Port the proxy to a Worker

- [ ] Create a Worker package or repo
- [ ] Implement `/?url=` parsing and validation
- [ ] Implement `/health`
- [ ] Implement CORS preflight handling
- [ ] Implement request forwarding via Worker `fetch()`
- [ ] Implement header filtering
- [ ] Implement structured error responses
- [ ] Implement optional path-based extraction fallback if retained

Suggested files:

- [ ] `worker-proxy/src/index.ts`
- [ ] `worker-proxy/src/config.ts`
- [ ] `worker-proxy/src/allowlist.ts`
- [ ] `worker-proxy/src/headers.ts`
- [ ] `worker-proxy/src/logging.ts`
- [ ] `worker-proxy/wrangler.jsonc`
- [ ] `worker-proxy/README.md`

Validation:

- [ ] Local `wrangler dev` requests behave the same as the Node proxy for happy-path requests
- [ ] Preflight requests succeed
- [ ] allowlist rejection works

## Phase 3: Add abuse controls

- [ ] Add per-IP Worker rate limiting
- [ ] Add Cloudflare WAF or zone-level rate limiting
- [ ] Add timeouts and body-size checks
- [ ] Ensure logs never contain auth headers, bodies, or full sensitive URLs
- [ ] Add request IDs for traceability

Validation:

- [ ] Repeated requests hit rate limits as expected
- [ ] Logs remain useful without leaking secrets
- [ ] oversized or timed-out requests fail cleanly

## Phase 4: Deploy to production

- [ ] Provision Worker route on `proxy.shuvgeist.ai` or equivalent
- [ ] Configure production allowlists and limits as Worker env vars
- [ ] Enable HTTPS-only access
- [ ] Add basic uptime monitoring and error alerts

Validation:

- [ ] `/health` responds on the public hostname
- [ ] only approved routes are reachable
- [ ] rejected routes return deterministic 4xx responses

## Phase 5: Integrate with Shuvgeist

- [ ] Decide whether to change `src/sidepanel.ts` default `proxy.url` from localhost to the Worker URL
- [ ] Update UI copy in proxy-related dialogs if the public Worker becomes the default
- [ ] Document operator and user trust expectations in `README.md` or `docs/proxy.md`

Relevant files:

- `src/sidepanel.ts`
- `src/dialogs/ApiKeysOAuthTab.ts`
- `src/dialogs/ApiKeyOrOAuthDialog.ts`
- `src/tutorials.ts`
- `README.md`
- `docs/proxy.md` if added

Validation:

- [ ] Anthropic OAuth succeeds through the Worker
- [ ] GitHub Copilot OAuth succeeds through the Worker
- [ ] proxied model requests succeed
- [ ] document extraction fallback succeeds if still enabled

## Phase 6: Rollout

- [ ] Start with internal-only testing
- [ ] Observe traffic and abuse patterns before switching defaults
- [ ] Only make the Worker the default proxy after real-flow validation
- [ ] Document incident response for blocked hosts, rate-limit spikes, and provider-side failures

## External References

- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Workers fetch API: https://developers.cloudflare.com/workers/runtime-apis/fetch/
- Cloudflare Worker rate limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Cloudflare Access service tokens: https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/

## Open Decisions

### 1. Should the public Worker support document extraction fallback?

Recommendation:

- only keep it if the host/path surface can be narrowly bounded
- otherwise split document fetches into a separate operator path

### 2. Should the Worker be the default proxy for all users?

Recommendation:

- not initially
- first ship it as an operator-controlled option
- promote it to default only after live OAuth and runtime validation

### 3. Is a pure Worker-only public deployment enough?

Recommendation:

- yes for an initial narrow-scope proxy
- no if you later need stronger client authentication or per-user entitlements

## Acceptance Criteria

- [ ] The Worker preserves the current `/?url=` contract
- [ ] Only approved hosts and approved paths are reachable
- [ ] CORS preflight works for all supported flows
- [ ] Anthropic OAuth works through the Worker
- [ ] GitHub Copilot OAuth works through the Worker
- [ ] proxied runtime calls work through the Worker
- [ ] rate limiting and WAF controls are active
- [ ] logs and telemetry do not leak secrets
- [ ] Shuvgeist docs explain when and why the proxy is used
