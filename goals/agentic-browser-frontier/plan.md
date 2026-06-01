# Plan — Agentic Browser Frontier

Execution plan for the full 13-target program. Companion docs: `facts.md` (what must be true), `sequence.md` (why this order). This plan adds the *how*, the *files*, and the *verification* per step.

## Solution approach

Build **5 shared foundations first (Phase 0)** so the remaining work is additive. Each foundation ships with its day-one behavior identical to today — proven by **characterization tests written before the refactor** — so Phase 0 is provably non-breaking. Then walk the dependency order: Tier A (observation + zero-friction) → Tier B (multiplexing + external interface) → Tier C (autonomy) → Tier D (gated big swings). The four architectural bets are each preceded by a spike that halts for a go/no-go.

GitNexus impact already confirms the two scariest Phase-0 refactors are low blast radius: `BridgeServer` is imported only by `cli.ts`; the `createAgent` closure (`src/sidepanel.ts:755`) has zero external callers. So foundation risk is *behavior-parity within a file*, not call-graph breakage.

## Working discipline (applies to every step — per CLAUDE.md)

1. **Before editing any symbol:** `gitnexus_impact({target, direction:"upstream", repo:"shuvgeist"})`. If risk is HIGH/CRITICAL, surface the blast radius to the user before proceeding.
2. **Refactor steps run under green characterization tests:** write tests that capture current behavior first, refactor until they still pass.
3. **Before every commit:** `gitnexus_detect_changes()` to confirm only expected symbols/flows changed, then `npm run check` (biome + tsc + tsc:node + unit + integration + site check).
4. **Branch per phase**; spikes go on throwaway branches with findings written to `goals/agentic-browser-frontier/spikes/<name>.md`.
5. **Guardrails are standing gates**, re-run each phase (see end).

---

## Phase 0 — Foundations (no user-visible features)

**Step 0.0 — Characterization safety net.** Before touching anything, add characterization tests capturing current behavior of: bridge command dispatch for the single-target path, `createAgent` agent wiring (tools list + defaults), snapshot output shape, and credential load/resolve. Files: `tests/integration/bridge/`, `tests/unit/`. *Verify:* `npm run test:unit && npm run test:integration` green on `main` before any refactor. (Safety net for f1–f5, g1, g2.)

**Step 0.1 — F1 `CdpSession`.** New `src/tools/helpers/cdp-session.ts` (interface + `ChromeDebuggerSession`); refactor `src/tools/helpers/debugger-manager.ts` into a factory/pool; add `ElectronWsCdpSession` in `src/bridge/electron/cdp-client.ts`. Expose `ensureDomain(domain,{suppressRuntimeEnable})`, `navigationGeneration`, `acquire/release`. *Touches:* `debugger.ts`, `NativeInputEventsRuntimeProvider.ts`, `electron/window-executor.ts`. *Verify:* `gitnexus_impact` on `DebuggerManager` first; new unit tests for both impls; existing debugger/Electron integration tests unchanged → **f1-cdpsession**.

**Step 0.2 — F2 `SessionRegistry` + `TargetSessionHandle`.** New `src/bridge/session-registry.ts`, `src/bridge/per-handle-write-lock.ts`; refactor `src/bridge/server.ts` to dispatch through the registry (replace `activeExtension`); `resolve()` returns the single handle on day one. Change `isCatalogTargetDispatchedMethod(method, targetKind)` signature in `command-catalog.ts`. Add the `Map<windowId,{client,executor}>` in `background.ts` (replaces focus-torn-down singletons). *Verify:* `gitnexus_impact` on `BridgeServer` (known LOW, only `cli.ts`) + `handleCliRequest`; characterization test proves single-target command behavior identical → **f2-registry**, **f-focus-isolation**.

**Step 0.3 — F3 Snapshot + Ref contract.** Extract one `SNAPSHOT_PAGE_SCRIPT` in `src/tools/page-snapshot.ts` used by both Chrome `capturePageSnapshot` and `ElectronSessionManager.captureSnapshot`. Add `stableElementId?` as a separate field (never rename `snapshotId`). New `src/tools/helpers/ref-registry.ts` wrapping `RefMap` with an injectable `NavigationEventSource`; new `src/tools/helpers/snapshot-filter.ts` (pure, reuses `rankLocatorCandidates`). Add `stableElementId`/`query` to `protocol.ts`. *Verify:* unit test that `snapshotId` format is unchanged and `stableElementId` is additive; Chrome and Electron snapshots produced by the same script → **f3-snapshot-contract**.

**Step 0.4 — F4 `AgentRuntimeFactory`.** Extract `createAgent` closure (`src/sidepanel.ts:755`, impact = LOW/0 callers) into `src/agent/runtime.ts`; surface all five `pi-agent-core` `AgentOptions` hooks as optional config; parameterize `model` + `thinkingLevel` (kill hardcoded `"medium"` at `sidepanel.ts:819`, `session-runtime.ts:153`); make `AgentSessionContext` UI-free so it slots into `TargetSessionHandle.agentContext`. Rewire `sidepanel.ts` + `SidepanelSessionRuntime` to call the factory. *Verify:* characterization test — agent built via factory has identical tools array + defaults; sidepanel chat e2e unchanged → **f4-agent-factory**, **g1-sidepanel-ux**.

**Step 0.5 — F5 `ProviderCatalog` + `ProviderCredential`.** New `src/providers/catalog.ts` (one `PROVIDER_CATALOG` collapsing `DEFAULT_MODELS`/`OAUTH_PROVIDERS`/`PROVIDER_KEY_MAP`); discriminated-union `ProviderCredential` in `oauth/types.ts` (replace `startsWith("{")`); `resolveProviderCredential` + `resolveDefaultModel` in `sidepanel/model-resolution.ts` (replace broken `getModel("anthropic",...)` fallback). *Verify:* migration test — existing stored API-key and OAuth strings still parse/resolve; unit test for the union → **f5-provider-catalog**.

**Step 0.6 — Micro-foundations.** `src/bridge/task-registry.ts` (`TaskHandle` lifecycle states), factor `BridgeRequestHandler` out of `handleCliRequest` (transport-agnostic), `src/bridge/page-snapshot-store.ts` (`SnapshotRecord` schema, raw pre-filter, modeled on `electron/skill-snapshot-store.ts`). *Verify:* unit tests for each; shapes frozen so T4/T6/T7 extend them.

**Phase 0 gate:** `npm run check` green; `gitnexus_detect_changes()` shows only foundation symbols touched; all characterization tests pass. No behavior change shippable to users.

---

## Tier A — Observation & Zero-Friction (shippable on its own)

**T1 — Snapshot into the sidepanel agent.** Add `PageSnapshotTool` to the sidepanel tools array (`sidepanel.ts:1056`) *and simultaneously* inject a `RefRegistry` + wire `chrome.webNavigation.onCommitted → refRegistry.onNavigated`. Add `snapshot?: PageSnapshotResult` to `NavigationMessage`; `browserMessageTransformer` serializes to text at build time. *Verify:* unit on message-transformer (snapshot present in nav context); manual agent run; e2e:extension → **t1-snapshot-in-agent**.

**T2 — Stable refs + invalidate-on-nav.** Populate `stableElementId` (attribute-injection selector now; CDP `backendNodeId` path reserved for T12); tag refs with F1 `navigationGeneration`; reject stale-generation refs without re-snapshot. *Verify:* integration — ref used after navigation fails cleanly, not mis-resolves → **t2-stable-refs**.

**T3 — Top-N keyword filter.** Wire `filterSnapshotByKeywords` (built in 0.3) into the common snapshot path + `query?` param; applies to Chrome and Electron. *Verify:* unit — hierarchy preserved, top-N selected, token count drops; runs on both target kinds → **t3-keyword-filter**. *(Parallel with T2.)*

**T5 — Zero-friction default model.** `WelcomeSetupDialog` becomes an additive step-sequence; add a guided OAuth-subscription path + a bundled free-tier key path via F5; `resolveDefaultModel` replaces the broken fallback. Local Ollama selectable but **not** default. *Verify:* unit on `resolveDefaultModel`; manual first-run with no creds reaches a working model → **t5-zero-friction-model**. *(Parallel track, gated only on F5.)*

**Tier A gate:** `npm run check` + e2e:extension; ships a coherent product (observes, targets stably, filters, onboards keyless).

---

## Tier B — Multiplexing & External Interface

**SPIKE-T8 (gate).** Attach `chrome.debugger` to two tabs in two windows; drive interleaved `Input.*` + `Runtime.evaluate`; confirm per-`tabId` serial chains don't cross-contend and focus-change doesn't tear down siblings (relies on 0.2 window map). Write `spikes/t8-concurrent-cdp.md`; **STOP for go/no-go** → **gate-spikes**. Reshape rule: if multi-window attach storms infobars, T8 → per-window-one-active + logical MCP multiplexing.

**T8 — Per-session locks + session router.** Swap `SessionRegistry.resolve` to a `Map`; make `PerHandleWriteLock` per-handle; route by request `target`. *Verify:* integration — two sessions run concurrently, a write to one doesn't lock the other, one-writer-per-target enforced → **t8-multisession**.

**T4 — Snapshot-to-disk.** Server-local `snapshot_store`/`snapshot_read` methods over the 0.6 `PageSnapshotStore` (raw pre-filter; filter at read). *Verify:* integration — store then read by tab/frame/snapshot id; responses don't inline full snapshots → **t4-snapshot-store**. *(After T2's id contract is final.)*

**T6 — MCP front-end.** New `src/bridge/mcp/` Streamable-HTTP server over `BridgeRequestHandler`; `mcp-tool-adapter.ts` maps observe→`page_snapshot`(+T3 filter), act→`ref_*`, extract→`repl`+snapshot, agent→`workflow_run`; task lifecycle via `TaskRegistry`. *Verify:* integration — MCP handshake + tool list; an external client drives a session end-to-end → **t6-mcp-frontend**. *(Needs T8, T3, T4.)*

**T10 — Dedicated profile + consented cookie import.** `CookieAccessPort` (Node SQLite read + `chrome.cookies.set` write) behind a per-site consent prompt; carries a `sessionId` target; default profile stays isolated. *Verify:* integration on import mechanics; manual consent UX → **t10-cookie-import**. *(Parallel with T6 after T8.)*

**Tier B gate:** `npm run check` + integration; a multi-session, MCP-addressable platform.

---

## Tier C — Autonomy

**Eval harness (first).** New `benchmarks/agent-eval/` — fixed task scenarios, n≥8 runs, pass-rate + token reporting. *Verify:* harness runs and emits a report → **eval-harness**. *(Baseline captured here for T7's comparison.)*

**T7 — Planner→Actor→Validator + drift monitor.** Plug into F4 hooks: planner persona via `systemPrompt`, validator via `prepareNextTurn` (diffs typed `PageSnapshotResult`), drift halt via `shouldStopAfterTurn`, actor capture via `before/afterToolCall`; subscribe to `TaskHandle`. *Verify:* harness shows reliability improvement vs baseline → **t7-planner-validator**. *(Needs T1/T2 typed snapshots; needs T12 before automated trusted-input trajectories on stealthed sites.)*

**T9 — Cross-session memory.** New `MemoryStore` IndexedDB store (version bump; compound key `(skillName, sessionId?, createdAt)`); write path via F4 `sessionPersistence.onAgentEnd` (validator notes); read via `formatSkills` `getMemoriesForSkill` callback. *Verify:* unit/integration — memory persists, keys to skills, surfaces on matching domains; not stored on `Skill` → **t9-memory**. *(After T7.)*

---

## Tier D — Architectural big swings (each gated)

**SPIKE-T11 → STOP.** `--headless=new` via `launcher.ts:154` + `ElectronWsCdpSession`; run one snapshot→locate→click→snapshot loop via `AgentRuntimeFactory`, no extension. Prove long-lived CDP connection + stable session IDs survive bridge restart. `spikes/t11-headless.md`. Reshape: if tool code has hidden `chrome.*` deps, T11 → Electron-app automation only.
**T11 — Headless runtime.** Fill `TargetSessionHandle.agentContext` with `ElectronAgentSessionAdapter`; headless agent with no-op UI persistence. *Verify:* integration — full loop with no extension present → **t11-headless-runtime**.

**SPIKE-T12 → STOP.** On a CDP-detection page, measure `Input.*`-only without `Runtime.enable` (context-creation signal) and trusted input via pre-stored coords (avoids `getBoundingClientRect` tell); confirm infobar avoidability. `spikes/t12-stealth.md`. Reshape: if `chrome.debugger` infobar is mandatory, T12 → headless/direct-CDP path only.
**T12 — CDP-direct stealth.** F1 `suppressRuntimeEnable`; `TrustedInputProvider` takes a `CdpSession`, never calls `ensureDomain("Runtime")`, uses F3 pre-stored `boundingBox`; extension path documented non-stealth. *Verify:* unit — no `ensureDomain("Runtime")` on the action path; spike measurement attached → **t12-stealth-controlplane**. *(Needs T8, T2.)*

**SPIKE-T13 → STOP.** Numbered badges over candidate bboxes + `Page.captureScreenshot` vs "screenshot + candidate JSON" baseline on the default and free-tier models. `spikes/t13-som.md`. Reshape: if structured candidates suffice, drop the overlay; gate to vision-capable providers.
**T13 — Selective vision.** Fallback triggered by T7's validator failure signal (not a duplicate detector); `captureAnnotatedScreenshot` helper kept out of `ExtractImageTool.execute`; gated to vision-capable providers; off by default. *Verify:* integration — ambiguous resolution triggers vision; never fires by default → **t13-selective-vision**. *(Needs T1, T2, T7; T11 decides headless vision surface.)*

---

## Standing guardrail gates (re-run each phase)

- **g1-sidepanel-ux:** `npm run test:e2e:extension` green every phase.
- **g2-bridge-additive:** a contract test enumerating existing `command-catalog` method names + param shapes; fails on any removal/signature change.
- **g3-agpl-local:** CI check that `LICENSE` stays AGPL and no new mandatory network egress is added to storage/session paths (review + `package.json` dependency diff).
- **g4-no-stealth-claims:** doc/string grep in CI for "undetectable"/"bypass.*detection" in `site/`, `README.md`, UI copy.

## Risks & open questions (carried from the report's spikes)

- **Concurrent multi-client CDP state mutation on one target** is underdocumented → T8 keeps one-writer-per-target until SPIKE-T8 proves otherwise.
- **chrome.debugger infobar** may be unhideable → T12 already scoped to fall back to headless-only (matches the interview decision).
- **SoM on current models** may be unnecessary → SPIKE-T13 must beat the cheaper baseline or T13 degrades to structured-candidate JSON.
- **Real-profile stealth benefit** is unproven → T10 stays consent-gated and isolated-by-default; no stealth claim attached to it.
- **Linked packages** (`pi-agent-core`, `pi-ai`, `mini-lit`) are `file:` siblings — F4's hook usage must match the installed `pi-agent-core` `AgentOptions` surface; confirm before relying on a hook.
