# Shuvgeist Program Sequencing Plan — grounding artifact

> Derived from the frontier research report + a 7-agent code-seam mapping of all 13 roadmap targets.
> Governing rule: **every abstraction touched by >1 target is designed once, up front, with explicit
> extension seams, so later targets fill reserved slots rather than rewrite.** 5 load-bearing seams; 11
> of 13 targets converge on them.

## The 13 targets

- **Quick wins:** (1) wire PageSnapshotTool into the sidepanel agent · (2) stable ref→backendNodeId + invalidate-on-nav · (3) top-N keyword filter (hierarchy-preserving) · (4) snapshot-to-disk + on-demand read · (5) zero-friction default model path
- **Medium bets:** (6) MCP front-end over the bridge · (7) Planner→Actor→Validator + drift monitor · (8) per-session locks + session router · (9) cross-session memory keyed to skills · (10) dedicated profile + selective cookie import
- **Architectural bets:** (11) headless/embedded agent runtime · (12) CDP-direct stealth control plane · (13) selective vision (set-of-marks)

## 1. Shared Foundations (Phase 0 — design once, no user-visible features)

- **F1 — `CdpSession`** (`src/tools/helpers/cdp-session.ts`): one interface over `chrome.debugger` (`DebuggerManager`) and the Electron-WS `ElectronCdpClient`. Impls `ChromeDebuggerSession` + `ElectronWsCdpSession`. Exposes `ensureDomain(domain,{suppressRuntimeEnable})` (T12), `navigationGeneration` (T2), `acquire/release`. Depends-on targets: 8, 11, 12, 13.
- **F2 — `SessionRegistry` + `TargetSessionHandle`** (`src/bridge/session-registry.ts`, `per-handle-write-lock.ts`): replaces single `activeExtension` (server.ts:146) + global writer lock. Handle is target-kind-neutral, carries `cdp?`, `writeLock`, reserved `agentContext?` slot. Day-one `resolve()` returns the single handle (behavior identical). `isCatalogTargetDispatchedMethod(method, targetKind)` gets its 2nd arg now. Depends-on: 8, 6, 10, 11, 7.
- **F3 — Snapshot + Ref contract** (`page-snapshot.ts`, `ref-registry.ts`, `snapshot-filter.ts`): ONE canonical `SNAPSHOT_PAGE_SCRIPT` for both Chrome + Electron; `SnapshotProvider.captureSnapshot({query?})`; per-entry `stableElementId?` **added alongside** positional `snapshotId` (never rename); `RefRegistry` (DOM-free, per-session, `onNavigated` hook); pure `filterSnapshotByKeywords`. Depends-on: 1, 2, 3, 4, 6, 7, 11, 13.
- **F4 — `AgentRuntimeFactory` + `AgentSessionContext`** (`src/agent/runtime.ts`): extract the 340-line `createAgent()` (sidepanel.ts:756); surface all 5 unused `pi-agent-core` hooks (`prepareNextTurn`/`transformContext`/`before|afterToolCall`/`shouldStopAfterTurn`); parameterize `model` + `thinkingLevel` (kill hardcoded "medium"); `sessionId` first-class; UI-free context that slots into `TargetSessionHandle.agentContext`. Depends-on: 7, 9, 11, 5.
- **F5 — `ProviderCatalog` + `ProviderCredential`** (`src/providers/catalog.ts`, `oauth/types.ts`): collapse 3 duplicated provider tables into one `PROVIDER_CATALOG`; replace `startsWith("{")` heuristic with a discriminated union `{kind: "api-key"|"oauth"|"free-tier"}`; `resolveDefaultModel(...)` replaces the broken `getModel("anthropic",...)` fallback. Depends-on: 5, 10, (7/9 benefit).

**Micro-foundations (also Phase 0):** `TaskHandle`/`TaskRegistry` (T6+T7), `BridgeRequestHandler` seam (WS + MCP-SSE share routing), `PageSnapshotStore` raw-pre-filter disk store (T4), and a `Map<windowId,{client,executor}>` in `background.ts` so focus-change stops tearing down sibling sessions (prereq for T8).

## 2. Dependency graph

`F0(F1..F5) ; 1→2→{4,13}; 1,3→6; 8→{6,10,11,12}; 2→12; F4→{7,9,11}; 1,2→7→{9,13}; 11→{12,13 headless}; F5→5`

## 3. The sequence (phased, with stop-tiers)

- **Phase 0 — Foundations.** F1–F5 + micro-foundations. Day-one behavior identical to today. Ships no target; makes 11 of 13 additive.
- **Tier A — Observation & Zero-Friction (shippable):** T1 → T2 → T3 (∥ T2) ; T5 (∥, separate subsystem). *Stop here:* an agent that observes real page structure, targets stably across navigations, filters to relevant elements, onboards keyless.
- **Tier B — Multiplexing & External Interface:** T8 (makes F2 real) → T4 → T6 → T10 (∥ T6 after T8). *Stop here:* a multi-session bridge addressable over MCP, persistent snapshots, isolated profiles, authenticated sessions.
- **Tier C — Autonomy:** T7 (makes F4 real) → T9.
- **Tier D — Architectural big swings (gated):** T12, T11, T13 — each behind a spike + go/no-go.

**Critical path:** Phase 0 → T1 → T2 → T8 → T6 → T7 → T12/T11 → T13.
**Parallel tracks:** Provider/onboarding (T5), Profile/cookies (T10, after T8), filter/disk/memory (T3/T4/T9).

## 4. Design-once decisions

1. Keep `snapshotId="e${n}"` positional forever; add `stableElementId?: string` as a separate field. 2. `NavigationMessage.snapshot?: PageSnapshotResult` (typed object, serialized at message-build). 3. One `SNAPSHOT_PAGE_SCRIPT` for Chrome+Electron, landed before T3/T4. 4. `SessionRegistry: Map<key,Handle>` single-entry initially; `PerHandleWriteLock` its own class; `agentContext?` reserved nullable. 5. `CdpSession.ensureDomain(domain,{suppressRuntimeEnable})`; `TrustedInputProvider` takes a `CdpSession`, never calls `ensureDomain("Runtime")`, coordinates pre-resolved from `boundingBox`. 6. All 5 `AgentOptions` hooks as optional config; `systemPrompt: string|(ctx)=>string`; `thinkingLevel` parameterized. 7. `ProviderCredential` discriminated union with explicit serialized discriminant; single `resolveDefaultModel`. 8. `BridgeRequestHandler` shared by WS + SSE; `MCP_TOOL_MAP` in `mcp-tool-adapter.ts`; `TaskHandle` shape agreed Phase 0. 9. `PageSnapshotStore` stores raw pre-filter records; filter at read time.

## 5. Spikes & gates (big swings)

- **T8 — N concurrent CDP writers.** Spike: drive two tabs/two windows with interleaved `Input.*`+`Runtime.evaluate`; confirm per-`tabId` serial chains don't cross-contend. Reshape: if multi-window debugger attach storms infobars, T8 → per-window-one-active + logical MCP multiplexing.
- **T11 — Headless runtime.** Spike: `--headless=new`, attach `ElectronWsCdpSession`, run a full snapshot→locate→click→snapshot loop with no extension. Reshape: if tool code has hidden `chrome.*` deps, T11 → "Electron-app automation only".
- **T12 — Stealth.** Spike: on a CDP-detection page, measure whether `Input.*`-only without `Runtime.enable` avoids context-creation signals + whether the infobar is avoidable. Reshape: if `chrome.debugger` infobar is mandatory, T12 → "stealth only on the T11 direct-CDP/headless path; extension path explicitly non-stealth".
- **T13 — Set-of-marks.** Spike: numbered badges over candidate bboxes vs. plain "screenshot + candidate JSON" baseline. Reshape: if models pick correctly from structured candidates alone, drop the overlay; gate to vision-capable providers.

## 6. What parallelizes

Critical spine is serial. Independent tracks: T5 (provider/onboarding, gated only on F5), T10 (after T8), T3 (∥ T2), T4 (after T2 id-contract), T9 schema (∥ T7; write path waits on T7). Net: with the Phase-0 seams in place, every target extends a seam rather than reopening one.
