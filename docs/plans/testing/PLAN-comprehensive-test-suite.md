# Plan: Comprehensive Test Suite for Shuvgeist

Status: revised against the current repo on `main` (`abaf2f8`) as of 2026-03-22.

This is a planning document only. It does not implement the test suite.

## Goal

Add automated test coverage for the parts of Shuvgeist that carry the most regression risk while keeping local development fast:

1. bridge protocol and server behavior
2. CLI bridge client behavior
3. session projection and storage logic
4. multi-window background/session lock behavior
5. a small extension smoke suite in Chromium
6. targeted coverage for the proxy and static site, but only after core extension/bridge coverage exists

The project should move from effectively **no repo-owned automated tests** to a layered test suite that is maintainable and worth running on every change.

---

# Review findings that changed this plan

This revision corrects several issues in the original draft.

## 1. The highest-risk surface is the extension + bridge, not the proxy or site

The current product value is concentrated in:

- `src/bridge/**`
- `src/background.ts`
- `src/sidepanel.ts`
- `src/storage/**`
- `src/tools/**`

The proxy still exists, but the README and changelog history make clear that local declarativeNetRequest-based CORS handling reduced the proxy from a core runtime dependency to a secondary subproject. The site is also lower risk than the extension/CLI bridge.

Implication: the initial milestones should focus on bridge, CLI, storage, and background locking first.

## 2. The repo has no wired test runner, but the lockfile is not completely test-tool-free

There are currently no test scripts or test config files in the repo, and no project-owned tests under `tests/`, `proxy/tests/`, or `site/tests/`.

However, `package-lock.json` already contains transitive `vitest` references from sibling/file dependencies. The plan should therefore say:

- **no repo-owned automated tests exist today**
- **test tooling is not yet wired into this repo's scripts/config**

not that Vitest is totally absent from the install graph.

## 3. Some bridge command semantics were described too loosely

The CLI exposes commands such as `tabs` and `switch`, but the bridge protocol does not define separate `tabs` or `switch` methods. Those behaviors currently ride through the `navigate` method with `NavigateParams` such as:

- `listTabs: true`
- `switchToTab: number`

Implication: tests should be written against the actual protocol boundary, not against a cleaner-but-nonexistent abstraction.

## 4. `proxy/src/server.ts` is already more structured than the draft assumed

`proxy/src/server.ts` is still a large file, but it already has meaningful internal seams:

- `loadConfig()`
- `addCorsHeaders()`
- `filterRequestHeaders()`
- `filterResponseHeaders()`
- `isRateLimited()`
- `clientIp()`
- `parseTargetUrl()`

It also already includes structured logging and telemetry-safe behavior.

Implication: do not force a large proxy rewrite up front. Extract only the seams needed to make testing practical.

## 5. `./check.sh` is a thin wrapper around `npm run check`

Current behavior:

```bash
./check.sh
# -> npm run check
```

And root `package.json` currently defines:

```json
"check": "biome check --write . && tsc --noEmit && tsc --noEmit -p tsconfig.node.json && cd site && npm run check"
```

Implication: fast-test rollout needs to be designed around changes to root `package.json` scripts first. The plan should not talk about `./check.sh` as if it contains independent logic.

## 6. `src/background.ts` is small enough that the first refactor should be surgical

`src/background.ts` is about 167 lines, not a sprawling subsystem. It is side-effectful, but the first move should be to extract a small testable state/decision layer rather than redesign the whole file.

## 7. `src/sidepanel.ts` is large, but broad decomposition is not required before the first useful tests

`src/sidepanel.ts` is large enough to justify future extraction, but the plan should not block the entire suite on a broad sidepanel rewrite. There is immediate value available in bridge/storage/background tests without first splitting `sidepanel.ts` into many modules.

---

# Current repo state

## Existing validation

Current automated validation is limited to format/lint/typecheck:

- `./check.sh`
- root `package.json`
- `site/package.json`
- `tsconfig.build.json`
- `tsconfig.node.json`

Current checks are:

```bash
./check.sh
# -> npm run check
# -> biome check --write .
# -> tsc --noEmit
# -> tsc --noEmit -p tsconfig.node.json
# -> cd site && npm run check
```

## What does not exist today

There is currently no repo-owned automated coverage for:

- unit tests
- integration tests
- extension Playwright tests
- proxy HTTP tests
- site smoke tests
- coverage reporting
- CI test jobs beyond the current check flow

## Project shape relevant to testing

### Core extension + CLI bridge
- `src/sidepanel.ts`
- `src/background.ts`
- `src/bridge/browser-command-executor.ts`
- `src/bridge/cli.ts`
- `src/bridge/extension-client.ts`
- `src/bridge/logging.ts`
- `src/bridge/protocol.ts`
- `src/bridge/server.ts`
- `src/bridge/session-bridge.ts`
- `src/storage/**`
- `src/tools/**`
- `src/dialogs/**`
- `src/components/**`

### Proxy
- `proxy/src/server.ts`

### Static site
- `site/src/frontend/**`
- `site/infra/**`

## Architecture constraints that matter for tests

- MV3 extension with sidepanel page + background service worker
- many modules talk directly to `chrome.*`
- browser code and Node bridge code are separated by `tsconfig.build.json` vs `tsconfig.node.json`
- root build scripts already exist:
  - `npm run build:chrome`
  - `npm run build:cli`
- the user runs `./dev.sh` separately; this plan should not depend on `npm run dev`
- minimum Chrome version is 141 (`static/manifest.chrome.json`)
- Node target for CLI/proxy is effectively modern Node (`target`/runtime around Node 22)

---

# Planning principles

## 1. Optimize for early value, not theoretical completeness

The first tranche should cover modules that are already testable or require only small extractions.

## 2. Keep fast tests fast

Root checks should eventually include only:

- format/lint
- typecheck
- fast unit tests
- fast integration tests

Longer browser E2E should remain separate from `./check.sh`.

## 3. Prefer seam extraction over architectural rewrites

Refactor only when a test needs a seam. Do not redesign large files just to make the plan look clean.

## 4. Test the real protocol and current behavior

Do not invent abstractions that the code does not use today.

Examples:
- `tabs`/`switch` CLI coverage should validate current `navigate`-method behavior
- multi-window locking tests should match `docs/multi-window.md` and current `src/background.ts`

## 5. Preserve existing telemetry and logging behavior

Especially in `proxy/src/server.ts`, test work must not accidentally remove structured logs, request IDs, or safe logging behavior.

---

# Recommended test stack

## 1. Vitest at the repo root for unit and integration tests

Use Vitest as the main runner for root code.

Why:
- TypeScript-first
- good Node support for bridge/CLI/proxy logic
- supports browser-like environments for component tests
- coverage support
- fast local runs

Recommended usage:
- unit tests for protocol, storage, projection logic
- integration tests for bridge server, CLI helpers, background lock logic
- selected DOM/component tests

## 2. Prefer `happy-dom` for custom-element/component tests

The project uses Lit and `@mariozechner/mini-lit`. A lightweight DOM runner is sufficient for focused component tests.

Recommendation:
- start with `happy-dom`
- add `jsdom` only if a specific compatibility issue requires it

## 3. Playwright for extension smoke tests and later site smoke tests

Use Playwright only for the thin top-of-pyramid layer.

Recommended usage:
- extension smoke tests using the unpacked MV3 build
- later, static site smoke tests

## 4. Do not add Supertest on day one unless it clearly reduces friction

The proxy can be tested with either:

- an extracted `createProxyApp()` seam and `fetch`, or
- an ephemeral local server plus `fetch`

Add `supertest` only if the ergonomics justify the extra dependency.

---

# Test architecture by priority

## Priority 1 — Fast unit tests for stable logic

These are the first tests to add.

### Best initial targets

#### Bridge protocol and session projection
- `src/bridge/protocol.ts`
- `src/bridge/session-bridge.ts`

Test ideas:
- `getBridgeCapabilities(debuggerEnabled)`
- `isWriteMethod()`
- `buildSessionHistoryResult()` with `last` and `afterMessageIndex`
- `projectSessionMessage()` for user / assistant / toolResult / navigation
- attachment summarization
- tool call summarization
- truncation and omission behavior in `summarizeForBridge()`

#### Storage logic
- `src/storage/stores/cost-store.ts`
- `src/storage/stores/skills-store.ts`

Test ideas:
- atomic daily aggregation in `recordCost()` with a fake backend
- total/provider/model aggregations
- date range filtering
- domain and path pattern matching via `matchesAnyPattern()`
- invalid URL handling in skill matching

#### Utility/message transformation logic
- `src/messages/message-transformer.ts`
- `src/messages/custom-messages.ts`
- `src/messages/NavigationMessage.ts`
- `src/utils/favicon.ts`
- `src/utils/format-skills.ts`

These are good only if the file contents are sufficiently pure after inspection.

### Small refactors allowed in Priority 1
- export internal pure helpers if they represent important behavior
- add tiny adapters for time/random values if needed for determinism
- create a fake storage backend for store tests

Avoid at this stage:
- broad sidepanel decomposition
- broad tool refactors
- extension bootstrapping changes unrelated to tests

---

## Priority 2 — Bridge server and CLI integration tests

This is the highest-value integration layer.

### A. Bridge server integration

Relevant files:
- `src/bridge/server.ts`
- `src/bridge/protocol.ts`
- `src/bridge/logging.ts`

Use a real `BridgeServer` on an ephemeral port with fake CLI and extension WebSocket clients.

Test ideas:
- registration success for CLI and extension
- registration failure on bad token
- single active extension behavior
- same-window extension reconnect replacement
- different-window extension rejection
- invalid method rejection
- request relay and response forwarding
- event fan-out to all CLI clients
- pending request cleanup on CLI disconnect
- abort message emission when CLI disconnects mid-request
- write lock behavior for session write methods
- write lock release on disconnect
- write lock reset on session change, if current implementation does that

### B. CLI helper and command-core tests

Relevant file:
- `src/bridge/cli.ts`

`src/bridge/cli.ts` is large and currently calls `process.exit()` directly in many branches. The first goal is not a full rewrite. The goal is to extract only enough seams to test the command logic safely.

Recommended staged refactor:
1. test existing pure helpers directly where possible:
   - `resolveBridgeUrl()`
   - `bridgeStatusUrl()`
   - `parseTimeout()`
   - `isNetworkOrConfigError()`
2. extract command execution functions that return structured results
3. leave a thin outer wrapper responsible for stdout/stderr and `process.exit()`

Test ideas:
- config precedence: flags over env over file
- `status` command request formation
- `navigate` command request formation
- `tabs` and `switch` command mapping to `navigate` params
- session command request formation:
  - `session`
  - `inject`
  - `new-session`
  - `set-model`
  - `artifacts`
- exit code mapping
- JSON vs text output formatting

Important correction:
- test `tabs` and `switch` as CLI commands over the current bridge protocol, not as standalone bridge methods

---

## Priority 3 — Background/session lock integration tests

Relevant files:
- `src/background.ts`
- `src/utils/port.ts`
- `docs/multi-window.md`

This behavior is central and documented. It deserves coverage early.

### Recommended approach

Do not start with a large rewrite of `background.ts`.

Instead:
1. extract a tiny decision/state layer if needed, for example:
   - lock acquisition decision
   - sidepanel-open state transition helpers
   - cleanup logic for closed windows
2. keep `background.ts` as the runtime wire-up file

### Test ideas
- acquiring an unlocked session
- denying a lock when another live window owns it
- reclaiming a lock when the owning sidepanel is no longer open
- listing locked sessions
- releasing locks on disconnect
- releasing locks on window close
- sidepanel-open cache update behavior
- keyboard toggle behavior based on `openSidepanels`

### `src/utils/port.ts` tests

Test ideas:
- request/response type mapping correctness
- reconnect-on-send-failure behavior
- timeout cleanup of response handlers
- `initialize()` requirement before connect/send

---

## Priority 4 — Extension-side bridge adapter and browser command integration

Relevant files:
- `src/bridge/browser-command-executor.ts`
- `src/bridge/extension-client.ts`
- `src/bridge/session-bridge.ts`

This layer is high value because it connects the bridge to the extension runtime.

### Test ideas
- status result shape with mocked active tab
- capability disabling for `eval`
- session history bridging through `SessionBridgeAdapter`
- session inject/new/set-model/artifacts dispatch when a fake session bridge is present
- error behavior when session bridge is unavailable

For browser-command tests, prefer fakes over real browser startup.

Mock as needed:
- `chrome.tabs.query`
- tool execution methods on `NavigateTool`, `DebuggerTool`, `ExtractImageTool`
- fake `SessionBridgeAdapter`

---

## Priority 5 — Thin Playwright smoke suite for the extension

Use Playwright only after the fast layers above exist.

### Important constraint

Opening `chrome-extension://<id>/sidepanel.html` is useful, but it is not identical to proving that the real sidepanel surface behaves perfectly in Chromium. The initial smoke suite should therefore validate:

- extension build loads
- service worker is present
- extension page boots without runtime errors
- bridge-related UI is reachable

and should defer deeper sidepanel-surface fidelity checks if they become flaky.

### Recommended Playwright structure

```text
tests/
  e2e/
    fixtures/
      extension.ts
    extension/
      smoke.spec.ts
      bridge.spec.ts
```

### Fixture responsibilities
- use `npm run build:chrome` output at `dist-chrome/`
- launch persistent Chromium context with unpacked extension loaded
- derive extension ID from service worker URL
- open extension pages directly

### Initial extension smoke scenarios
- service worker appears
- `sidepanel.html` loads without console errors that fail the test
- settings UI opens
- `BridgeTab` content renders

### Bridge smoke scenarios after that
- connect extension to an in-process `BridgeServer`
- verify status path end to end
- verify one read command and one write-ish command path at smoke level

Keep this small. Do not start with full website automation.

### Defer initially
- live OAuth flows
- screenshot pixel diffs
- arbitrary website automation journeys
- debugger/cookies tests that depend on fragile browser state

---

## Priority 6 — Component tests for selected dialogs/components

This is useful, but it is not higher priority than bridge/background coverage.

### Best initial component targets
- `src/dialogs/BridgeTab.ts`
- `src/dialogs/WelcomeSetupDialog.ts`
- `src/dialogs/SessionListDialog.ts`
- `src/components/Toast.ts`
- `src/components/TabPill.ts`
- `src/components/SkillPill.ts`

### Test ideas
- render for supplied state
- button visibility/disabled state
- callback behavior
- BridgeTab settings persistence and commit behavior
- SessionListDialog lock badge rendering once lock state is injectable/mockable

### Refactor guidance

If a dialog reads global state directly, wrap that access in a small adapter instead of pulling the whole app shell into the test.

---

## Priority 7 — Proxy tests

The proxy should be covered, but it should not block the first useful suite.

Relevant file:
- `proxy/src/server.ts`

### Recommended approach

Start with minimal extraction only if required:
- export `loadConfig()` and `parseTargetUrl()` if needed
- optionally extract `createProxyApp(config)` once tests need direct app instantiation

Do not do a broad module split before proving it helps.

### Test ideas
- `parseTargetUrl()` query mode and path mode
- invalid target handling
- host allowlist enforcement
- auth enforcement via `X-Proxy-Secret`
- request header filtering
- response header stripping
- CORS preflight response
- rate limiting behavior
- upstream timeout/error handling
- streaming passthrough behavior

### Additional requirement

Because the proxy already includes structured logging, tests/refactors must preserve:
- request ID generation
- safe logging without credential/body leakage
- status/error event behavior

---

## Priority 8 — Static site smoke tests

This is the lowest priority of the suite described here.

Relevant files:
- `site/src/frontend/index.html`
- `site/src/frontend/install.html`
- `site/run.sh`
- `site/infra/**`

### Recommended coverage
- homepage loads
- install page loads
- key CTA/download/install content exists
- major external links are present

Avoid initially:
- full-page snapshots
- visual diffing
- deep animation assertions

---

# Test infrastructure plan

## Root dependencies to add

Recommended:
- `vitest`
- `@vitest/coverage-v8`
- `happy-dom`
- `playwright`

Optional:
- `@testing-library/dom`
- `supertest`

## Config files to add

Recommended:
- `vitest.config.ts`
- `playwright.config.ts`
- `tsconfig.test.json` only if needed

## Suggested test layout

```text
tests/
  unit/
    bridge/
    storage/
    utils/
    messages/
  integration/
    bridge/
    background/
    extension/
  component/
    dialogs/
    components/
  e2e/
    fixtures/
    extension/
    site/
proxy/tests/
```

## Shared test helpers

Recommended helpers:
- `tests/helpers/fake-storage-backend.ts`
- `tests/helpers/chrome-mock.ts`
- `tests/helpers/ws-client.ts`
- `tests/helpers/time.ts`

The helper layer should centralize:
- fake `chrome.*` APIs
- fake storage backends
- deterministic timers/dates
- WebSocket client/test server helpers

---

# Refactor plan required for testability

Only perform the smallest refactors needed.

## Refactor 1 — CLI command-core extraction

Needed early.

Plan:
- extract request-building and command execution helpers out of `src/bridge/cli.ts`
- keep a thin wrapper responsible for I/O and `process.exit()`

## Refactor 2 — Background decision/state seam

Needed early.

Plan:
- extract lock/open-window decision logic from `src/background.ts`
- keep Chrome event wiring in `background.ts`

## Refactor 3 — Optional proxy app seam

Needed later.

Plan:
- only if required, expose `createProxyApp(config)` or equivalent
- keep startup/listen behavior thin

## Refactor 4 — Selective sidepanel extraction only when justified

Not needed before the first useful suite.

Potential future extraction targets if tests demand them:
- bridge sync wiring
- model resolution
- auth label resolution
- session snapshot construction

---

# CI and local workflow plan

## Local scripts to add at the root

Recommended eventual scripts:

```json
{
  "test": "npm run test:unit && npm run test:integration",
  "test:unit": "vitest run tests/unit",
  "test:integration": "vitest run tests/integration",
  "test:component": "vitest run tests/component",
  "test:coverage": "vitest run --coverage",
  "test:e2e": "playwright test",
  "test:e2e:extension": "playwright test tests/e2e/extension",
  "test:e2e:site": "playwright test tests/e2e/site"
}
```

Do not require the final script names to match this exactly. The important part is the split between fast and slow layers.

## `./check.sh` rollout

Do not add Playwright to `./check.sh`.

Recommended steady state:
- `./check.sh` runs existing checks plus fast Vitest layers
- Playwright remains separate

Because `./check.sh` delegates to `npm run check`, the rollout should be:
1. update root scripts
2. validate locally
3. then change `check` to include fast tests

## CI jobs

Recommended jobs:

### Job 1 — Fast root checks
- install deps
- run `./check.sh`
- includes unit + integration tests once stabilized

### Job 2 — Extension smoke
- build extension
- run Playwright extension smoke tests
- upload traces on failure

### Job 3 — Proxy tests
- install proxy deps if separate step needed
- run proxy tests

### Job 4 — Site smoke
- build/serve site
- run Playwright site smoke tests

The order of Jobs 3 and 4 can vary. Both are lower priority than Jobs 1 and 2.

---

# Coverage strategy

Coverage should be phased in.

## Stage 1
Collect coverage only. No thresholds.

## Stage 2
Gate a small set of core modules:
- `src/bridge/protocol.ts`
- `src/bridge/session-bridge.ts`
- `src/storage/stores/cost-store.ts`
- `src/storage/stores/skills-store.ts`
- extracted background lock/state helper
- extracted CLI command-core helper

## Stage 3
Add global thresholds after the suite is stable.

Reasonable eventual thresholds:
- statements: 75%
- lines: 75%
- functions: 80%
- branches: 65%

---

# Implementation order

## Milestone 0 — Add test infrastructure
- [x] add Vitest to root devDependencies
- [x] add Playwright to root devDependencies
- [x] add `happy-dom`
- [x] add test scripts to root `package.json`
- [x] add `vitest.config.ts`
- [x] add `playwright.config.ts`
- [x] add shared helpers under `tests/helpers/`

## Milestone 1 — First useful unit tests
- [x] `src/bridge/protocol.ts`
- [x] `src/bridge/session-bridge.ts`
- [x] `src/storage/stores/cost-store.ts`
- [x] `src/storage/stores/skills-store.ts`
- [x] selected pure utility/message tests where inspection shows strong ROI

## Milestone 2 — Bridge/CLI integration
- [x] bridge server registration/relay tests
- [x] bridge server disconnect/cleanup tests
- [x] CLI helper tests for config parsing and timeout/error helpers
- [x] extract and test CLI command-core seams

## Milestone 3 — Background/session lock coverage
- [x] extract minimal background state/decision seam
- [x] add session lock tests
- [x] add `src/utils/port.ts` reconnection/timeout tests
- [x] validate behavior against `docs/multi-window.md`

## Milestone 4 — Extension bridge adapter coverage
- [x] `src/bridge/browser-command-executor.ts` tests
- [x] fake session bridge adapter tests
- [x] mocked Chrome tab/status tests

## Milestone 5 — Extension E2E smoke
- [x] unpacked-extension Playwright fixture
- [x] service worker / extension boot smoke
- [x] settings + BridgeTab smoke
- [x] minimal bridge happy-path smoke

## Milestone 6 — Component coverage
- [x] BridgeTab tests
- [x] selected dialog/component tests with small adapters where needed

## Milestone 7 — Proxy and site
- [x] proxy tests for URL parsing, auth, allowlist, CORS, streaming
- [x] site smoke tests for homepage/install page

## Milestone 8 — CI and coverage enforcement
- [x] wire fast tests into root `check`
- [x] add CI jobs
- [x] publish coverage
- [x] add thresholds for core modules

---

# Recommended first tranche

If implementation starts now, the highest-ROI sequence is:

1. add Vitest infrastructure
2. test `src/bridge/protocol.ts`
3. test `src/bridge/session-bridge.ts`
4. test `src/storage/stores/cost-store.ts`
5. test `src/storage/stores/skills-store.ts`
6. extract a minimal CLI command-core seam and test it
7. extract a minimal background lock/state seam and test it
8. add bridge server integration tests
9. only then add Playwright extension smoke

This order creates value quickly without forcing an E2E-first rollout or a large architectural rewrite.

---

# Acceptance criteria

The test-suite project is complete when all of the following are true:

- the repo has automated unit and integration coverage for bridge, storage, CLI, and background lock behavior
- fast tests run locally in a few minutes and are part of normal root checks
- the extension has at least a thin Chromium smoke suite against the unpacked build
- proxy coverage exists if the proxy remains a supported subproject
- site smoke coverage exists if the site remains an actively maintained shipped surface
- failures produce actionable output and traces/logs rather than silent regressions

---

# Explicit deferrals

These should not block the initial suite:

- live OAuth end-to-end flows
- broad `src/sidepanel.ts` decomposition before the first tests land
- screenshot pixel-based visual diffs
- arbitrary website automation workflows in CI
- exhaustive proxy/site coverage before bridge/core extension coverage exists
