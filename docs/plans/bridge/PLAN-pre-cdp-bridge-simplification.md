# Plan: Pre-CDP Bridge Simplification and Onboarding Cleanup

Status: drafted against the current repo on `main` (`9a6057e`) as of 2026-04-07. Revised 2026-04-08 after code review alignment.

This is a planning document only. It does not implement the changes.

## Goal

Complete the bridge and onboarding cleanup work that should land **before** any direct/raw CDP feature work.

The goal is to keep the always-on bridge architecture introduced in 1.1.2, while removing the now-redundant configuration friction that still assumes the bridge is sidepanel-driven.

Specifically, the pre-CDP work should:

1. remove manual token handoff for the common loopback case
2. stop requiring the sidepanel to be opened before the background bridge can work
3. collapse bridge configuration to a single source of truth
4. shrink the Bridge tab UI to status + safety controls + advanced remote override
5. preserve current LAN / remote-bridge capability and current security posture
6. update docs and tests so future CDP work builds on the simplified bridge instead of the legacy UX

This plan explicitly does **not** include:

- raw CDP passthrough methods
- CLI-side direct CDP sockets
- screenshot/perf rework through CDP
- benchmark optimization work beyond keeping the bridge valid and easy to use

---

# Why this should happen before CDP work

The current bridge architecture already moved the runtime-critical parts into the background service worker:

- `BridgeClient` now lives in `src/background.ts`
- `BrowserCommandExecutor` now lives in `src/background.ts`
- the bridge stays connected when the sidepanel is closed
- REPL and screenshot have background-owned router/fallback paths
- keepalive is handled by `chrome.alarms`

But the **configuration story** is still shaped like the pre-1.1.2 sidepanel-only world:

- the user must open the sidepanel at least once
- the user must manually enable the bridge
- the user must manually copy the token out of `~/.shuvgeist/bridge.json`
- the extension writes bridge config into IndexedDB
- `sidepanel.ts` mirrors that into `chrome.storage.local`
- the background service worker reads the mirrored value

That means the bridge is “always-on” at runtime, but **not actually zero-setup at onboarding**.

Shipping CDP work on top of this would compound complexity on the wrong base.

---

# Current code review findings

## 1. The bridge server is still required

File references:

- `src/bridge/server.ts`
- `src/bridge/cli.ts`
- `src/background.ts`

The separate Node bridge process is still justified because the extension cannot act as a listening server. The background service worker is a WebSocket **client**, not a listener.

The bridge server still provides real value:

- listening rendezvous point for CLI + extension
- token-gated registration
- request/response relay and abort propagation
- `/status` health endpoint used by CLI and launch flow
- process independence from Chrome lifecycle
- support for LAN bridge scenarios

Implication: **do not plan to remove the bridge server** as part of this cleanup.

## 2. Bridge configuration still flows through a legacy mirror path

File references:

- `src/dialogs/BridgeTab.ts`
- `src/sidepanel.ts`
- `src/background.ts`
- `src/bridge/internal-messages.ts`

Current flow:

1. `BridgeTab` reads/writes `bridge.enabled`, `bridge.url`, `bridge.token`, `bridge.sensitiveAccessEnabled` through `getAppStorage().settings` (IndexedDB-backed app storage)
2. `sidepanel.ts` runs `mirrorBridgeSettings()`
3. `mirrorBridgeSettings()` writes a `BridgeSettings` object into `chrome.storage.local[BRIDGE_SETTINGS_KEY]`
4. `background.ts` reads `chrome.storage.local[BRIDGE_SETTINGS_KEY]` inside `ensureBridgeConnection()` and reacts to `chrome.storage.onChanged`

Important nuance:

- the **read layer** in background is already correct
- `chrome.storage.onChanged` already calls `ensureBridgeConnection()`
- but current reconnect behavior is **not** sufficient for storage-only writes while already connected

Today, `ensureBridgeConnection()` reconnects only when the client is `disabled`, `disconnected`, or `error`, or when the focused `windowId` changes. It does **not** force reconnection when `url`, `token`, or `sensitiveAccessEnabled` change while already connected.

Implication:

- the mirror layer is technical debt and should be removed
- but before BridgeTab can rely on `chrome.storage.local` alone, background must gain explicit **settings-diff reconciliation** so live edits to URL/token/sensitive-access actually take effect

## 3. The Bridge tab still exposes the legacy manual handoff flow

File references:

- `src/dialogs/BridgeTab.ts`
- `README.md`

Current UI fields:

- Enable bridge
- Bridge server URL
- Token
- Sensitive browser data access
- explanatory same-host / LAN help text
- warning text about unencrypted traffic

This UI still assumes the user must manually obtain and paste the token.

Implication: the common local-host case should become self-configuring; URL and token should become advanced/remote-only overrides.

## 4. The CLI already has bridge auto-start semantics

File reference:

- `src/bridge/cli.ts`

`ensureBridgeServer()` already:

- checks `/status`
- auto-starts the bridge as a detached process if not running
- reuses config file token or generates one if missing
- writes `~/.shuvgeist/bridge.pid`

That means the local flow is already close to “just run a command and the bridge comes up.”

The missing piece is the extension discovering the token/config without the sidepanel copy/paste step.

Implication: the cleanup should reuse the existing auto-start path instead of inventing a new launcher model.

## 5. Existing documentation still describes the old UX

File references:

- `README.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`

The README currently tells users to:

- open the sidepanel
- enable the bridge
- paste the token

That documentation will become wrong once bootstrap is added.

Implication: doc updates are part of the same change, not follow-up polish.

## 6. Legacy IndexedDB migration is feasible in background

File references:

- `src/storage/app-storage.ts`
- `node_modules/@mariozechner/pi-web-ui/src/storage/stores/settings-store.ts`

The legacy bridge settings are simple out-of-line keys in IndexedDB:

- DB name: `shuvgeist-storage`
- store name: `settings`
- keys: `bridge.enabled`, `bridge.url`, `bridge.token`, `bridge.sensitiveAccessEnabled`

Implication: the migration plan should commit to a **one-time background-side migration** when `chrome.storage.local[BRIDGE_SETTINGS_KEY]` is absent. This is preferable to any sidepanel-open migration or hybrid migration.

## 7. Existing test targets need cleanup before implementation starts

File references:

- `tests/integration/bridge/server.test.ts`
- `tests/unit/background/background-state.test.ts`
- `tests/component/dialogs/bridge-tab.test.ts`
- `package.json`

Observations:

- `tests/integration/bridge/server.test.ts` already exists and should be extended, not created
- `tests/unit/background/background-state.test.ts` covers session-lock helpers, not bridge bootstrap/settings logic
- `tests/component/dialogs/bridge-tab.test.ts` is stale relative to the current `BridgeTab` module shape and should be rewritten rather than lightly updated
- `./check.sh` runs unit + integration + typecheck, but **not** component tests or extension e2e tests

Implication: this plan must add a **new focused bridge settings/bootstrap unit test file** and explicitly require component + e2e runs outside `./check.sh`.

---

# Desired end state

## User experience

### Default local-machine flow

A user should be able to:

1. install or link the CLI
2. run any `shuvgeist` CLI command
3. have the bridge auto-start if needed
4. have the extension background worker auto-discover the token on loopback
5. see the bridge become connected without having opened the sidepanel first

The only bridge-related sidepanel action should be **optional**:

- enabling sensitive browser data access when they want `eval`, `cookies`, or future raw CDP features
- blocking bridge connections if they do not want bridge access at all

### Advanced / LAN flow

Users who intentionally point the extension at a non-loopback bridge should still be able to:

- set a custom bridge URL
- provide a manual token
- keep the current token-based security model

This should remain possible, but it should be clearly labeled as advanced / remote bridge configuration.

## Storage model

Bridge settings should have **one runtime source of truth** for extension-side behavior:

- `chrome.storage.local[BRIDGE_SETTINGS_KEY]`

IndexedDB `bridge.*` keys should exist only as a **one-time migration source** and should never be written again after migration.

The background worker should be able to initialize bridge behavior entirely from `chrome.storage.local`, without depending on the sidepanel.

## Connection-state model

The bridge state shown in UI should distinguish:

- **disabled** → the user explicitly blocked bridge connections
- **disconnected** → the bridge is allowed, but unavailable / bootstrapping / awaiting the local server
- **connecting** → active connection attempt in progress
- **connected** → bridge registered and ready
- **error** → a real error occurred that should be surfaced to the user

Important UX rule:

- `enabled: true` with an empty token on loopback is **not** “disabled”; it is a bridge-allowed state that should degrade to `disconnected` while bootstrap/retry proceeds

## UI model

Bridge UI should shrink from a full setup form to a small management panel:

- bridge status
- "Block bridge connections" toggle (default: false)
- sensitive browser data access toggle
- advanced disclosure for URL/token manual override
- minimal contextual help when disconnected

---

# Recommended implementation strategy

Implement this in four phases, in order.

## Phase 1 — Add loopback bootstrap to the bridge server

### Objective

Allow the extension to fetch the local bridge token automatically when connecting to a bridge on `127.0.0.1` / `localhost`.

### Scope

#### Server endpoint

Add a new HTTP endpoint to `src/bridge/server.ts`:

- `GET /bootstrap`

Behavior:

- only responds to loopback callers (see hardening below)
- returns the active token in JSON
- rejects non-loopback callers with `403`
- returns a minimal versioned payload to leave room for future bootstrap metadata

Suggested response shape:

```json
{
  "version": 1,
  "token": "<shared-token>"
}
```

Suggested non-goals for phase 1:

- no new auth layer on `/bootstrap`
- no LAN support through bootstrap
- no bridge URL advertisement logic
- no token rotation changes

#### Loopback definition

Treat the following remote addresses as loopback:

- `127.0.0.1`
- `::1`
- `::ffff:127.0.0.1`

If the server is bound to `0.0.0.0`, `/bootstrap` must still remain loopback-only based on the request socket address.

#### Header-behavior validation spike (REQUIRED before freezing the allowlist)

Before finalizing `/bootstrap` hardening, capture the **actual headers** sent by a Manifest V3 background/service-worker `fetch()` from this extension to `http://127.0.0.1:19285/bootstrap`.

The implementation must confirm, in Chrome 141+ / current target:

- whether `Origin` is absent, `chrome-extension://<id>`, or something else
- that the custom bootstrap header is preserved
- that the extension can fetch localhost with the current host permissions / CSP

This is a short validation spike, not a separate feature. Its only purpose is to prevent over-tightening the `Origin` policy and accidentally blocking the extension itself.

#### DNS rebinding hardening (REQUIRED)

Socket-level loopback alone is **not sufficient**. A page on `evil.com` can resolve a subdomain to `127.0.0.1` and trigger the victim's browser to `GET http://127.0.0.1:19285/bootstrap`. The request arrives over a loopback socket, passes a naive remote-address check, and the attacker exfiltrates the token via the response.

`/bootstrap` MUST enforce all of the following, in addition to the loopback socket check:

1. **`Host` header allowlist.** Reject unless the `Host` header is one of:
   - `127.0.0.1:<port>`
   - `localhost:<port>`
   - `[::1]:<port>`
2. **`Origin` policy derived from the validation spike.** Final allowlist must be explicit. Minimum safe outcome:
   - allow absent `Origin`
   - allow the extension's own `chrome-extension://<id>` origin if Chrome sends one
   - optionally allow loopback origins only if manual validation shows they are needed
   - reject everything else
3. **Custom header requirement.** Require a fixed header like `X-Shuvgeist-Bootstrap: 1`. A normal web page cannot send this cross-origin without a CORS preflight; `/bootstrap` will not answer preflight permissively, so the actual request never fires.
4. **No CORS headers in the response.** Do not emit `Access-Control-Allow-Origin`. The extension fetch does not need permissive page CORS, and emitting it would only help attackers.
5. **Do not answer `OPTIONS /bootstrap` permissively.** Let cross-origin preflight fail closed.
6. **Rate-limit or warn-log repeated rejected `/bootstrap` calls.** Cheap defense in depth that also surfaces probing.

Add a code comment on the handler stating Decision 1's trust argument verbatim: a same-user local process can already read `~/.shuvgeist/bridge.json`, so `/bootstrap` adds no new attack surface **as long as** the above checks hold.

### File targets

- `src/bridge/server.ts`
- `tests/integration/bridge/server.test.ts`
- optionally `src/bridge/protocol.ts` if a shared bootstrap response type is worth introducing

### Tasks

- [x] Extend `BridgeServer.start()` with `GET /bootstrap` next to `/status`
- [x] Add a small helper for loopback request detection if it improves readability
- [x] Run the MV3 header-behavior validation spike and document the observed `Origin` behavior in code comments / implementation notes
- [x] Implement DNS rebinding hardening: `Host` allowlist, validated `Origin` allowlist, required `X-Shuvgeist-Bootstrap: 1` header
- [x] Ensure no `Access-Control-Allow-*` headers are emitted on `/bootstrap`
- [x] Do not respond permissively to `OPTIONS /bootstrap`
- [x] Add a code comment on the handler explaining the trust model (Decision 1)
- [x] Add lightweight rate-limit or `warn`-level logging for repeated rejected `/bootstrap` calls
- [x] Return JSON with `{ version, token }` on success
- [x] Return `403` JSON for non-loopback callers and for any rebinding-check failure
- [x] Keep logging minimal and do not print the token in logs
- [ ] Extend server integration tests to cover:
  - [ ] `/bootstrap` success from loopback with required header
  - [ ] `/bootstrap` rejection from non-loopback/mocked remote
  - [ ] `/bootstrap` rejection when socket is loopback but `Host` header is non-loopback (DNS rebinding)
  - [ ] `/bootstrap` rejection when `Origin` is a non-allowlisted origin
  - [ ] `/bootstrap` rejection when the `X-Shuvgeist-Bootstrap` header is missing
  - [ ] `OPTIONS /bootstrap` is not answered with permissive CORS
  - [ ] `/status` remains unchanged

### Validation criteria

- `GET /bootstrap` returns token on loopback in a local manual test with the required header
- a simulated DNS-rebinding request (loopback socket + attacker `Host`) is rejected with `403`
- the extension's actual background fetch is accepted by the final `Origin` policy
- existing `/status` behavior is unchanged
- existing CLI and extension registration still require the token on `/ws`
- no token appears in stdout or structured logs

---

## Phase 2 — Make the background service worker self-seeding and reconnect-correct

### Objective

Make the background service worker self-sufficient at first run by adding:

1. lazy default settings in `chrome.storage.local`
2. one-time legacy IndexedDB migration when local settings are absent
3. loopback token bootstrap via `/bootstrap`
4. explicit settings-diff reconciliation so storage-only writes take effect immediately

### Scope

#### Canonical settings object

Keep `BridgeSettings` in `src/bridge/internal-messages.ts` as the single shared shape:

```ts
export interface BridgeSettings {
  enabled: boolean;
  url: string;
  token: string;
  sensitiveAccessEnabled: boolean;
}
```

Ownership after this phase:

- canonical storage location: `chrome.storage.local[BRIDGE_SETTINGS_KEY]`
- IndexedDB legacy keys are read only once for migration and then ignored forever
- no more dependency on sidepanel mirroring

#### Helper/module split

Extract bridge settings/bootstrap logic out of the main connection routine if that materially improves testability.

Suggested helper module(s):

- `src/bridge/settings.ts`
- `src/bridge/bootstrap.ts`

Suggested functions:

- `getDefaultBridgeSettings()`
- `loadBridgeSettings()`
- `readLegacyBridgeSettingsFromIndexedDb()`
- `migrateLegacyBridgeSettingsIfNeeded()`
- `isLoopbackBridgeUrl(url: string)`
- `bootstrapTokenIfNeeded(settings: BridgeSettings)`
- `settingsRequireReconnect(previous: BridgeSettings | null, next: BridgeSettings)`

#### First-run defaults

Default settings for new installs should support auto-connect behavior:

- `enabled: true`
- `url: "ws://127.0.0.1:19285/ws"`
- `token: ""`
- `sensitiveAccessEnabled: false`

Apply these lazily inside `loadBridgeSettings()` and persist them when first resolved, so startup and upgrade behavior are consistent.

#### One-time legacy migration (final decision)

This plan chooses **background-side one-time migration**.

When `chrome.storage.local[BRIDGE_SETTINGS_KEY]` is absent:

1. open IndexedDB directly in the service worker
2. read legacy values from:
   - DB: `shuvgeist-storage`
   - store: `settings`
   - keys: `bridge.enabled`, `bridge.url`, `bridge.token`, `bridge.sensitiveAccessEnabled`
3. if any legacy bridge settings exist, seed `chrome.storage.local[BRIDGE_SETTINGS_KEY]` from them
4. otherwise seed from defaults
5. after seeding local storage, never read legacy bridge keys again in normal runtime

This avoids the sidepanel-open requirement and avoids silently flipping previously-disabled users to enabled.

If unexpected implementation friction makes direct service-worker IndexedDB access infeasible in practice, stop and revise the plan before implementation continues. Do **not** silently fall back to sidepanel migration or accept-and-document behavior drift mid-change.

#### Background bootstrap path

Update `ensureBridgeConnection()` in `src/background.ts` so it can:

1. load `BridgeSettings` from `chrome.storage.local`
2. migrate legacy IndexedDB settings once if local storage is empty
3. if `enabled` is true, `url` is loopback, and `token` is missing, try `/bootstrap`
4. persist the discovered token back to `chrome.storage.local`
5. reconcile settings changes against `currentSettings`
6. connect, reconnect, or rebuild the executor when needed

#### Settings-diff reconciliation (REQUIRED)

Before BridgeTab can write only to local storage, background must explicitly handle **live settings changes while already connected**.

Add reconciliation rules so that a change to any of the following forces the correct behavior immediately:

- `enabled`
- `url`
- `token`
- `sensitiveAccessEnabled`

Required behavior:

- `enabled: false` → disconnect immediately and surface `disabled`
- `enabled: true` with changed `url` or `token` → reconnect immediately
- changed `sensitiveAccessEnabled` → rebuild the executor / reconnect so capability reporting and sensitive command gating update immediately
- no effective settings change → do nothing

The current `chrome.storage.onChanged` listener is only a trigger; this phase makes `ensureBridgeConnection()` smart enough to react correctly to the new value.

#### State semantics

This phase must also define explicit state behavior for the bridge-allowed but not-yet-connected path:

- user-blocked → `disabled`
- allowed + loopback + empty token + bridge offline → `disconnected`
- allowed + bootstrap in progress → `connecting` or `disconnected` with useful detail, but never `disabled`
- bootstrap failure → non-fatal, retryable, user-visible detail without crashing startup

#### Retry and duplicate-write handling

Successful bootstrap will write the discovered token back to `chrome.storage.local`, which will re-trigger `chrome.storage.onChanged`.

Avoid duplicate connect/reconnect churn by adding a simple in-flight or handoff guard. One acceptable pattern:

- bootstrap persists the token
- current invocation returns without connecting
- the storage-change path performs the connect exactly once

Do not add a new aggressive retry loop. Reuse the existing `chrome.alarms` keepalive cadence.

### File targets

- `src/background.ts`
- `src/bridge/internal-messages.ts`
- new helper file(s) under `src/bridge/` if extracted
- new focused unit test file under `tests/unit/background/` or `tests/unit/bridge/`

### Tasks

- [x] Introduce helper(s) to read/default bridge settings from `chrome.storage.local`
- [x] Implement one-time legacy IndexedDB migration in background when local settings are absent
- [x] Unit-test the legacy migration path explicitly
- [x] Set new defaults (`enabled: true`, loopback URL, empty token, sensitive false)
- [x] Add loopback URL detection helper
- [x] Add `/bootstrap` fetch logic in background
- [x] Persist token back to `chrome.storage.local` after successful bootstrap
- [x] Add a guard so bootstrap persistence does not create duplicate reconnect churn
- [x] Ensure missing token on non-loopback URL does **not** attempt bootstrap
- [x] Ensure explicit manual token always wins over bootstrap
- [x] Ensure bootstrap failure does **not** hard-crash background startup; it should degrade to disconnected/retry behavior
- [x] Define explicit retry policy: bootstrap is re-attempted on the normal reconnect/keepalive path when token is empty and URL is loopback
- [x] Implement explicit settings-diff reconciliation so changes to URL/token/sensitive access take effect immediately even while already connected
- [x] Make `disabled` mean only “user blocked”, not “missing token”
- [ ] Add unit coverage for:
  - [ ] default settings creation
  - [ ] one-time legacy migration from IndexedDB
  - [ ] loopback bootstrap success
  - [ ] bootstrap skipped for non-loopback URLs
  - [ ] bootstrap skipped when token already present
  - [ ] bootstrap persistence does not cause duplicate reconnect churn
  - [ ] URL/token changes while connected force reconnect
  - [ ] `sensitiveAccessEnabled` changes while connected rebuild capabilities correctly
  - [ ] connection remains deferred/retryable when bootstrap or bridge fetch fails

### Validation criteria

- fresh install with no sidepanel open can still eventually connect once the bridge is reachable
- existing users with legacy bridge settings preserve their prior enabled/url/token/sensitive-access values without opening the sidepanel first
- existing local users no longer need to paste the token manually
- existing LAN/manual-token users can still connect by setting URL/token manually
- background startup no longer depends on `sidepanel.ts` mirroring bridge settings
- settings edits in the future BridgeTab take effect immediately without the legacy message path

---

## Phase 3 — Rewrite BridgeTab around management, not setup

### Objective

Turn the Bridge tab into a small operational panel instead of a multi-field onboarding wizard.

### Scope

#### Data source rewrite

Update `src/dialogs/BridgeTab.ts` to read/write directly from `chrome.storage.local[BRIDGE_SETTINGS_KEY]` instead of `getAppStorage().settings` bridge keys.

This change should also remove the need for:

- `BridgeSettingsChangeCallback`
- `settingsChangeCallback`
- `setBridgeSettingsChangeCallback()`
- `getBridgeSettingsChangeCallback()`
- sidepanel-initiated `bridge-settings-changed` as a primary reconnect path

Because Phase 2 adds settings-diff reconciliation in background, storage-only writes are now valid.

#### Bridge state updates

Replace the BridgeTab's polling loop with storage listeners where practical:

- use `chrome.storage.session[BRIDGE_STATE_KEY]` as the display source
- subscribe to storage changes instead of polling every 500ms
- keep the implementation simple and testable

This does not require reworking every other sidepanel polling path in the repo; the change is scoped to BridgeTab.

#### UI redesign

Replace the current layout with:

1. title + short description
2. connection status row
3. `Block bridge connections` toggle
   - backed by inverse of `enabled` **at the render layer only**
   - do **not** add a separate `blocked` field to storage
4. sensitive browser data access section (kept, largely unchanged)
5. `<details>` Advanced: Remote bridge settings
   - bridge URL input
   - token input
   - short note that these are only needed for remote/LAN bridges or manual override
6. conditional help text when disconnected, e.g.
   - if local loopback URL and bridge unreachable: “Run any `shuvgeist` command or `shuvgeist serve` to start the bridge.”
   - if remote URL with no token: “Enter the remote bridge token.”

#### Legacy migration in BridgeTab

Do **not** reintroduce migration logic here.

By the time this phase starts, background already owns the one-time migration path. BridgeTab should simply:

- read canonical settings from `chrome.storage.local`
- render them
- write updated values back to `chrome.storage.local`

Do not keep dual-write behavior and do not keep IndexedDB bridge writes alive “just in case.”

### File targets

- `src/dialogs/BridgeTab.ts`
- `tests/component/dialogs/bridge-tab.test.ts`
- optionally a small helper module if BridgeTab storage code is extracted

### Tasks

- [x] Rework `BridgeTab` to load/write `BridgeSettings` from `chrome.storage.local`
- [x] Remove legacy callback-based notify plumbing
- [x] Replace BridgeTab polling with storage-change subscription for `BRIDGE_STATE_KEY` if feasible in component scope
- [x] Replace “Enable bridge” with “Block bridge connections” semantics
- [x] Preserve and clearly label the sensitive-access control
- [x] Move URL/token into an advanced disclosure
- [x] Add conditional explanatory copy for local vs remote states
- [x] Ensure blocked state, disconnected state, and connected state copy all map cleanly to the new state model
- [ ] Rewrite BridgeTab component tests to cover:
  - [ ] default local mode render
  - [ ] status display from `BRIDGE_STATE_KEY`
  - [ ] blocking/unblocking bridge writes correct `enabled` state
  - [ ] advanced URL/token editing writes to local storage
  - [ ] sensitive-access toggle still writes correctly
  - [ ] disconnected help text for local loopback mode
  - [ ] remote/manual-token guidance when URL is non-loopback and token is empty

### Validation criteria

- BridgeTab remains functional without relying on `mirrorBridgeSettings()`
- existing state indicator still updates from `BRIDGE_STATE_KEY`
- local default users are not confronted with URL/token fields on first load
- remote/LAN users can still access URL/token fields without hidden functionality loss
- BridgeTab no longer depends on IndexedDB bridge keys or callback wiring

---

## Phase 4 — Remove the legacy mirror path and update docs/tests

### Objective

Delete the old config plumbing and make the new behavior the documented default.

### Scope

#### Sidepanel cleanup

In `src/sidepanel.ts`, remove:

- `mirrorBridgeSettings()`
- all bridge-setting reads from `storage.settings`
- all calls to `mirrorBridgeSettings()`
- BridgeTab callback setup that only existed to drive mirroring

Before removal, audit every call site identified by grep:

- startup initialization
- settings change handlers
- any model/session setup path that incidentally called the mirror

The goal is that `sidepanel.ts` should no longer be involved in bridge configuration propagation at all.

#### Background message cleanup

With Phase 2 and Phase 3 complete, remove the now-redundant `bridge-settings-changed` message handler path from `src/background.ts` and prune any now-unused types from `src/bridge/internal-messages.ts`.

#### Documentation updates

Update docs to describe the new local default behavior.

Files:

- `README.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`
- optionally `AGENTS.md` if a future agent should know the bridge no longer depends on sidepanel-open state

README changes should include:

- local bridge requires no token paste in normal same-host use
- Bridge tab is for monitoring, sensitive-access toggling, and advanced remote bridge configuration
- `shuvgeist serve` or any CLI command can bring up the bridge
- LAN note remains, with explicit mention that remote bridges still require manual token entry

ARCHITECTURE changes should include:

- bridge settings now live in `chrome.storage.local`
- background worker performs one-time legacy migration when needed
- background worker can bootstrap token on loopback via `/bootstrap`
- sidepanel no longer mirrors bridge config
- live settings changes are reconciled in background

CHANGELOG changes should be placed under `## [Unreleased]` in the correct subsections.

### File targets

- `src/sidepanel.ts`
- `src/background.ts`
- `src/bridge/internal-messages.ts`
- `README.md`
- `ARCHITECTURE.md`
- `CHANGELOG.md`

### Tasks

- [x] Delete `mirrorBridgeSettings()` and all call sites from `src/sidepanel.ts`
- [x] Remove any no-longer-used BridgeTab callback plumbing from `src/sidepanel.ts`
- [x] Remove the `bridge-settings-changed` message handler from `src/background.ts`
- [x] Prune only the `bridge-settings-changed` message variant from `src/bridge/internal-messages.ts`
- [x] Keep `BRIDGE_SETTINGS_KEY` and `BridgeSettings` — these remain the canonical storage key and shape
- [x] Update README same-host bridge instructions
- [x] Update architecture docs for the new ownership/bootstrap/reconnect model
- [x] Add changelog entries under `## [Unreleased]`

### Validation criteria

- `sidepanel.ts` no longer writes bridge settings into local storage indirectly
- background worker still reconnects on settings changes via `chrome.storage.onChanged`
- docs match actual behavior
- no dead types/functions remain after cleanup

---

# Cross-cutting design decisions

## Decision 1 — Loopback bootstrap is allowed because it does not weaken the local trust model

Rationale:

- any local process that can hit loopback can already read `~/.shuvgeist/bridge.json` if running as the same user
- token bootstrap is only exposed to loopback callers
- LAN users still rely on the current token model

This should be documented in code comments and implementation notes.

## Decision 2 — `chrome.storage.local` becomes the extension-side source of truth

Rationale:

- background worker already reads from it
- `chrome.storage.onChanged` already exists in background
- removing IndexedDB mirroring reduces moving parts and removes the need to open the sidepanel once

## Decision 3 — One-time legacy migration belongs in background, not in sidepanel

Rationale:

- the service worker can read the existing IndexedDB schema directly
- sidepanel migration would reintroduce the very first-open dependency this plan is trying to remove
- one-time migration preserves existing users without keeping legacy writes alive

## Decision 4 — Default local bridge behavior should be opt-out, not opt-in

Rationale:

- always-on bridge means the runtime is already safe to reconnect automatically
- the CLI already auto-starts the bridge
- users who do not want bridge access can still block it explicitly

This is the main behavior change most likely to need UX copy review.

## Decision 5 — Remote bridge support remains advanced, not removed

Rationale:

- bridge server still intentionally supports trusted LAN scenarios
- removing URL/token override would be a real feature cut
- the right move is to demote it in the UI, not delete it

## Decision 6 — `disabled` must mean user-blocked, not “missing config”

Rationale:

- the simplified onboarding flow needs a visible difference between “blocked by user” and “allowed but not connected yet”
- otherwise BridgeTab copy and status semantics remain confusing

---

# Proposed implementation order

## Milestone A — Runtime foundation

- [ ] Add `/bootstrap` endpoint to `src/bridge/server.ts`
- [ ] Run the MV3 header validation spike and finalize the `Origin` allowlist
- [ ] Add tests for `/bootstrap`
- [ ] Add background helper(s) for loading/defaulting/migrating settings
- [ ] Add loopback token bootstrap in the `ensureBridgeConnection()` path
- [ ] Add explicit settings-diff reconciliation in background
- [ ] Add focused unit tests for bootstrap/default/migration/reconnect behavior

**Why first:** this makes the runtime model correct before touching UI.

## Milestone B — UI/storage migration

- [ ] Rework `BridgeTab` to read/write local storage directly
- [ ] Replace polling with storage-change listening where practical
- [ ] Implement advanced disclosure for remote URL/token
- [ ] Rename enable semantics to block/allow semantics
- [ ] Rewrite BridgeTab tests

**Why second:** after runtime is ready, the UI can be safely simplified.

## Milestone C — Delete legacy plumbing

- [ ] Remove `mirrorBridgeSettings()` and call sites
- [ ] Remove obsolete bridge-setting message path
- [ ] Prune unused bridge internal-message types

**Why third:** avoids deleting old paths before the new ones are proven.

## Milestone D — Docs and final validation

- [ ] Update README
- [ ] Update ARCHITECTURE.md
- [ ] Update CHANGELOG.md
- [ ] Run checks plus targeted component/e2e coverage

---

# Testing plan

## Unit / component tests to add or update

### Bridge server integration tests

File:

- `tests/integration/bridge/server.test.ts`

Add coverage for:

- [ ] `/bootstrap` returns token for loopback request with required header
- [ ] `/bootstrap` rejects non-loopback request
- [ ] `/bootstrap` rejects rebinding-style `Host`
- [ ] `/bootstrap` rejects non-allowlisted `Origin`
- [ ] `/bootstrap` rejects missing custom header
- [ ] `/status` remains unchanged

### Focused bridge settings/bootstrap unit tests

Add a **new** test file. Suggested locations:

- `tests/unit/background/bridge-settings.test.ts`
- or `tests/unit/bridge/settings.test.ts`

Do **not** overload `tests/unit/background/background-state.test.ts`; that file covers unrelated sidepanel/session-lock helpers.

Add coverage for:

- [ ] default bridge settings creation
- [ ] one-time legacy migration from IndexedDB
- [ ] bootstrap attempted only for loopback URL with empty token
- [ ] bootstrap skipped when token exists
- [ ] bootstrap skipped for non-loopback URL
- [ ] bootstrap persistence does not cause duplicate reconnect churn
- [ ] URL/token changes while connected force reconnect
- [ ] `sensitiveAccessEnabled` changes while connected rebuild capabilities correctly
- [ ] bootstrap failure leaves reconnect path alive
- [ ] background can connect without sidepanel ever opening

### BridgeTab component tests

File:

- `tests/component/dialogs/bridge-tab.test.ts`

This file should be treated as a **rewrite**, not a light touch-up.

Add coverage for:

- [ ] render with local defaults
- [ ] status display from `BRIDGE_STATE_KEY`
- [ ] block-bridge toggle semantics
- [ ] sensitive-access toggle persistence
- [ ] advanced disclosure inputs for URL/token
- [ ] disconnected loopback guidance
- [ ] remote/manual-token guidance

## Existing end-to-end coverage to verify

Relevant existing tests:

- `tests/e2e/extension/bridge-happy-path.spec.ts`
- `tests/e2e/extension/bridge.spec.ts`

At minimum, re-run these after the change and confirm that the bridge no longer depends on explicit sidepanel configuration in the same-host case.

If needed, add one e2e scenario:

- [ ] fresh local setup where the bridge starts and the extension connects without manual token paste or sidepanel pre-open

This can be deferred if e2e fixture complexity is high, but should be considered before CDP work begins.

---

# Manual validation checklist

After implementation, run all of the following manually.

## Local same-host flow (fresh-state test)

- [ ] Clear extension local bridge settings
- [ ] Ensure no sidepanel interaction occurs
- [ ] Start bridge via `shuvgeist serve` or any CLI command
- [ ] Observe background eventually connect on its own
- [ ] Confirm `shuvgeist status` shows extension connected
- [ ] Open BridgeTab and confirm it shows connected without token paste

## Local disconnected flow

- [ ] Stop bridge server
- [ ] Confirm BridgeTab shows disconnected state and useful guidance
- [ ] Start any CLI command that auto-starts the bridge
- [ ] Confirm extension reconnects without manual intervention

## Remote/LAN flow

- [ ] Set custom non-loopback URL in advanced settings
- [ ] Confirm bootstrap is not attempted
- [ ] Confirm manual token entry still works
- [ ] Confirm connection succeeds with explicit token

## Sensitive-access flow

- [ ] Leave sensitive access off and confirm `eval` / `cookies` remain gated
- [ ] Enable sensitive access and confirm those commands work
- [ ] Verify this behavior is unchanged by the bootstrap rewrite

## Upgrade flow

- [ ] Test with an existing profile that has old bridge settings
- [ ] Confirm previous enabled/url/token/sensitive-access values are preserved by the one-time background migration
- [ ] Confirm legacy mirror code is no longer required after migration

---

# Commands to run after implementation

Per repo rules, after code changes:

```bash
./check.sh
```

Because `./check.sh` does **not** run component or extension e2e tests, also run:

```bash
npm run test:component -- tests/component/dialogs/bridge-tab.test.ts
npm run test:e2e:extension
```

Because this affects extension UI/runtime, also rebuild:

```bash
npm run build
```

Because this change touches the bridge server / CLI-facing local bootstrap flow, also rebuild CLI:

```bash
npm run build:cli
```

Recommended targeted test commands while iterating:

```bash
npm run test:unit -- tests/unit/background/bridge-settings.test.ts
npm run test:integration -- tests/integration/bridge/server.test.ts
npm run test:component -- tests/component/dialogs/bridge-tab.test.ts
npm run test:e2e:extension
```

If the final focused unit test file lands under `tests/unit/bridge/` instead, adjust the `npm run test:unit -- ...` path accordingly.

---

# Risks and mitigations

## Risk 1 — Existing remote users lose custom settings during migration

Mitigation:

- never overwrite existing `chrome.storage.local[BRIDGE_SETTINGS_KEY]`
- only apply defaults when local settings are absent and no legacy values exist
- run one-time background migration before falling back to defaults
- test remote URL/token preservation explicitly

## Risk 2 — `/bootstrap` hardening blocks the extension itself

Mitigation:

- run the MV3 header validation spike before freezing the `Origin` allowlist
- treat the custom header + host allowlist as the primary defense layer
- document the final header assumptions in tests

## Risk 3 — Background bootstrap creates noisy reconnect/error loops

Mitigation:

- bootstrap only when token is empty and URL is loopback
- swallow bootstrap errors and fall back to normal disconnected state
- add a guard so token persistence does not cause duplicate reconnect churn
- rely on the existing keepalive timer rather than adding aggressive retry loops

## Risk 4 — UI semantics around enabled/blocking remain confusing

Mitigation:

- make the label explicitly negative: “Block bridge connections”
- show current connection state nearby
- keep disabled vs disconnected semantics explicit in code and copy
- keep advanced remote options visually separate from the default path

## Risk 5 — Leaving the old `bridge-settings-changed` path around causes dual-write confusion

Mitigation:

- land settings-diff reconciliation first
- then remove the old message path in the same change series
- do not keep temporary dual support beyond the migration window

## Risk 6 — Docs drift from runtime again before CDP work begins

Mitigation:

- make README and ARCHITECTURE updates part of the same change series, not later cleanup
- include a changelog entry so the behavior change is visible during release prep

---

# Deliverables

At completion of this plan, the repo should contain:

- a loopback-only `/bootstrap` endpoint in the bridge server
- validated header hardening for `/bootstrap`
- background-owned defaults + one-time legacy migration + token bootstrap logic
- explicit background settings-diff reconciliation for live config edits
- bridge settings owned directly in `chrome.storage.local`
- a simplified BridgeTab with advanced remote config disclosure
- removal of `mirrorBridgeSettings()` and related dead plumbing
- updated tests covering bootstrap, migration, reconnect behavior, storage ownership, and BridgeTab behavior
- updated README / ARCHITECTURE / CHANGELOG describing the simplified bridge flow

---

# Definition of done

This pre-CDP plan is complete when all of the following are true:

- a fresh local same-host user does not need to paste a token or open the sidepanel first
- existing users retain their prior bridge settings through one-time background migration
- the bridge still supports manual remote/LAN configuration
- sensitive-access gating still works exactly as before
- `sidepanel.ts` is no longer required to mirror bridge settings for the background worker
- changing URL/token/sensitive-access in BridgeTab takes effect immediately without legacy callback plumbing
- the bridge server remains the only listener process; no architectural churn beyond config/bootstrap cleanup
- tests and docs reflect the new steady-state behavior

Only after that should the repo move into raw/direct CDP design and implementation work.
