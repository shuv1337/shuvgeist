# Resolve Open Shuvgeist GitHub Issues Plan

## Solution Approach

Resolve the open GitHub issue queue as a dependency-ordered program, not as a flat list. Each batch should close one independently verifiable vertical slice or a tightly coupled cluster, with blockers updated as prerequisites land.

The current queue naturally separates into four tracks:

- Deterministic e2e / Web Agent benchmark work: #21-#29 and #35.
- Architecture deepening: #30-#34.
- Electron target stack: #6-#20.
- Human decision points: currently #15 and #18 need explicit decision or blocker clarification before implementation.

The execution priority is:

1. Deterministic e2e and Web Agent benchmark work.
2. Architecture deepening that reduces implementation friction.
3. Electron stack in dependency order.
4. HITL/question issues only after decisions are resolved.

## Shared Operating Rules

- [ ] Before starting any batch, refresh the live issue queue with:
  ```bash
  gh issue list --state open --limit 100 --json number,title,labels,url,body
  ```
- [ ] Confirm branch/worktree state before edits:
  ```bash
  git status --short --branch
  ```
- [ ] If GitNexus reports a stale index, refresh before impact analysis:
  ```bash
  npx gitnexus status
  npx gitnexus analyze
  ```
- [ ] Before editing any function, class, or method, run `npx gitnexus impact --repo shuvgeist <symbol>` using the exact symbol name or UID.
- [ ] If impact is HIGH or CRITICAL, stop and report the blast radius before editing.
- [ ] Use targeted tests during development, then the required full validation before commit.
- [ ] Use explicit file staging only; never `git add .` or `git add -A`.
- [ ] Before commit, run:
  ```bash
  npx gitnexus detect-changes --repo shuvgeist
  git diff --cached --check
  ```
- [ ] Close issues only after validation passes, the change is committed and pushed, and dependent issue labels/blockers are updated.

## Queue Snapshot

### Deterministic e2e / Web Agent Benchmark Track

- #21 Add shared page-context execution helper
- #22 Add workflow target pinning and tab propagation
- #23 Add native semantic ref actions
- #24 Add page_assert bridge protocol and executor
- #25 Add CLI shuvgeist assert commands
- #26 Add workflow assertion steps
- #27 Migrate remaining page execution call sites onto shared helper
- #28 Add headless fixture smoke validation for e2e CI readiness
- #29 Document deterministic Shuvgeist e2e CI workflows
- #35 Implement Web Agent benchmark follow-up fixes

Primary code and docs:

- `src/tools/helpers/page-execution.ts`
- `src/tools/page-assert.ts`
- `src/tools/page-snapshot.ts`
- `src/tools/workflow-engine.ts`
- `src/bridge/browser-command-executor.ts`
- `src/bridge/cli-core.ts`
- `src/bridge/cli.ts`
- `src/bridge/protocol.ts`
- `src/bridge/server.ts`
- `tests/e2e/extension/deterministic-ci.spec.ts`
- `tests/e2e/fixtures/extension.ts`
- `tests/unit/bridge/cli-core.test.ts`
- `tests/unit/bridge/browser-command-executor.test.ts`
- `tests/unit/tools/page-assert.test.ts`
- `tests/unit/tools/page-execution.test.ts`
- `tests/unit/tools/workflow-engine.test.ts`
- `docs/e2e-ci.md`
- `README.md`
- `skills/shuvgeist/SKILL.md`
- `site/src/frontend/index.html`
- `CHANGELOG.md`

### Architecture Deepening Track

- #30 Deepen the bridge command catalog module
- #31 Deepen bridge target execution routing
- #32 Deepen the sidepanel session runtime
- #33 Deepen TTS playback coordination
- #34 Deepen Electron session automation internals

Primary plans and code:

- `docs/plans/architecture/PLAN-architecture-bridge-command-catalog.md`
- `docs/plans/architecture/PLAN-architecture-bridge-target-execution.md`
- `docs/plans/architecture/PLAN-architecture-sidepanel-session-runtime.md`
- `docs/plans/architecture/PLAN-architecture-tts-playback-coordination.md`
- `docs/plans/architecture/PLAN-architecture-electron-session-automation.md`
- `src/bridge/cli-core.ts`
- `src/bridge/protocol.ts`
- `src/bridge/cli.ts`
- `src/bridge/server.ts`
- `src/bridge/browser-command-executor.ts`
- `src/sidepanel.ts`
- `src/background.ts`
- `src/offscreen.ts`
- `src/tts/`
- `src/bridge/electron/`

### Electron Target Track

- #6 Bridge target routing supports Chrome default and extensionless Electron requests
- #7 Electron app allowlist, registry, and session attach/launch for VSCode fixture path
- #8 Electron CDP screenshot and eval work end-to-end
- #9 Electron window registry with stable refs and target resolution
- #10 Target-scoped refs and Electron snapshot/locate/click path
- #11 Electron recording path using shared ffmpeg encoder
- #12 Electron docs, help, architecture, and Shuvgeist skill docs
- #13 Minimum Electron target telemetry through bridge-local paths
- #14 Bridge-readable skill sync and appPatterns matching
- #15 Electron chat runner with encrypted provider token export
- #16 Sidepanel Electron Targets tab and event stream
- #17 Main-process inspector attach and safe read-only commands
- #18 IPC tap and main-process network tap with capability gating
- #19 Electron source inspection for ASAR and unpacked apps
- #20 Doctor Electron probes and auto-attach shims

Primary code and tests:

- `src/bridge/target.ts`
- `src/bridge/server.ts`
- `src/bridge/browser-command-executor.ts`
- `src/bridge/electron/app-registry.ts`
- `src/bridge/electron/config.ts`
- `src/bridge/electron/cdp-client.ts`
- `src/bridge/electron/session-manager.ts`
- `src/bridge/electron/doctor.ts`
- `src/bridge/electron/auto-attach.ts`
- `src/bridge/electron/skill-snapshot-store.ts`
- `src/bridge/electron/source-inspector.ts`
- `src/bridge/recording/ffmpeg-encoder.ts`
- `src/dialogs/ElectronTargetsTab.ts`
- `tests/unit/bridge/electron-*.test.ts`
- `tests/integration/bridge/server.test.ts`

## Ordered Execution Steps

### Step 1: Reconcile Already-Landed Issues

Several older issues appear to overlap with code and docs that now exist in the checkout. Before implementing new work, audit whether #21-#29 are already satisfied by commits `5eb64bb`, `4da0945`, and `a887544`.

- [ ] For each of #21-#29, compare issue acceptance criteria against current code and docs.
- [ ] Use direct source review plus targeted tests, not issue labels alone.
- [ ] For satisfied issues, add a concise GitHub comment with validation evidence and close the issue.
- [ ] For partially satisfied issues, update the issue with remaining concrete work and keep it open.
- [ ] For blocked labels whose blockers are already resolved, remove or update the blocker label/comment.

Verification:

```bash
gh issue view 21 --json number,title,body,labels,comments
npm run test:unit -- tests/unit/tools/page-execution.test.ts tests/unit/tools/page-assert.test.ts tests/unit/tools/workflow-engine.test.ts
npm run test:unit -- tests/unit/bridge/cli-core.test.ts tests/unit/bridge/protocol.test.ts tests/unit/bridge/browser-command-executor.test.ts
npm run test:integration -- tests/integration/bridge/server.test.ts tests/integration/bridge/workflow-engine.test.ts
./check.sh
```

Expected outcome:

- #21-#29 are either closed with evidence or reduced to exact remaining tasks.
- The queue no longer has stale blocked labels for already-landed prerequisites.

### Step 2: Execute Web Agent Benchmark Follow-Up (#35)

Use `PLAN-web-agent-benchmark-followup.md` as the authoritative implementation plan.

Batch 2A: fixture and regression coverage.

- [ ] Port or recreate the TechMart fixture under `tests/fixtures/techmart/` or the closest existing e2e fixture location.
- [ ] Add e2e coverage under `tests/e2e/extension/web-agent-benchmark.spec.ts` or extend `tests/e2e/extension/deterministic-ci.spec.ts`.
- [ ] Encode the expected final order number `TM-57F23A8F`.
- [ ] Add failing or pending coverage for select fill, async click navigation, and tab continuity gaps.

Batch 2B: element-aware `ref fill`.

- [ ] Run impact analysis for `BrowserCommandExecutor.refFill`, `executeRefDomAction`, and related Electron `refFill` if touched.
- [ ] Preserve text input behavior.
- [ ] Add native select behavior by value or visible label.
- [ ] Fail clearly for unsupported input types rather than reporting false success.

Batch 2C: reliable `ref click` waits.

- [ ] Add bounded wait behavior or explicit wait flags using existing timeout patterns.
- [ ] Preserve fast click behavior where no wait condition is requested.
- [ ] Return final URL/tab identity when navigation occurs.

Batch 2D: target continuity and benchmark runner.

- [ ] Ensure `navigate --json` and `ref click --json` expose usable tab/frame/final URL values.
- [ ] Add a Shuvgeist-only benchmark script or documented e2e runner that emits JSON and screenshot evidence.

Batch 2E: docs and changelog.

- [ ] Update `README.md`, `docs/e2e-ci.md`, `skills/shuvgeist/SKILL.md`, `src/bridge/cli.ts` help, `site/src/frontend/index.html` if user-facing claims change, and `CHANGELOG.md`.

Verification:

```bash
npm run test:unit -- tests/unit/bridge/browser-command-executor.test.ts tests/unit/bridge/cli-core.test.ts tests/unit/tools/ref-map.test.ts tests/unit/tools/page-snapshot.test.ts
npm run test:e2e:extension -- tests/e2e/extension/web-agent-benchmark.spec.ts
npm run build:cli
npm run build
./check.sh
```

Expected outcome:

- #35 closes only when the TechMart flow completes without direct DOM eval workarounds and records `TM-57F23A8F`.

### Step 3: Deepen Bridge Command and Target Modules (#30, #31)

These two issues are tightly coupled and should be handled as sequential small batches.

Batch 3A: bridge command catalog (#30).

- [ ] Follow `docs/plans/architecture/PLAN-architecture-bridge-command-catalog.md`.
- [ ] Characterize current CLI/protocol/help behavior before moving metadata.
- [ ] Introduce catalog metadata without behavior changes.
- [ ] Move CLI planning, protocol capability classification, sensitivity gates, write-method classification, and help alignment behind catalog-backed interfaces.
- [ ] Keep execution implementation outside the catalog.

Batch 3B: bridge target execution (#31).

- [ ] Follow `docs/plans/architecture/PLAN-architecture-bridge-target-execution.md`.
- [ ] Characterize `BridgeServer` routing decisions.
- [ ] Extract target capability metadata.
- [ ] Introduce Chrome extension, Electron, and server-local execution adapters.
- [ ] Normalize missing-target and unsupported-target errors.

Verification:

```bash
npm run test:unit -- tests/unit/bridge/cli-core.test.ts tests/unit/bridge/protocol.test.ts tests/unit/bridge/browser-command-executor.test.ts tests/unit/bridge/target.test.ts
npm run test:integration -- tests/integration/bridge/server.test.ts
npm run build:cli
npm run build
./check.sh
```

Expected outcome:

- #30 and #31 close with command/target metadata concentrated behind deeper interfaces.
- Later Electron work consumes these seams instead of adding another command or target matrix.

### Step 4: Deepen Sidepanel and TTS Runtime Modules (#32, #33)

These can proceed independently after Step 3 unless they touch bridge session command behavior.

Batch 4A: sidepanel session runtime (#32).

- [ ] Follow `docs/plans/architecture/PLAN-architecture-sidepanel-session-runtime.md`.
- [ ] Extract session metadata helpers first.
- [ ] Extract model resolution helpers.
- [ ] Introduce a session runtime with storage/model/agent/bridge adapters.
- [ ] Keep `src/sidepanel.ts` as the composition root.

Batch 4B: TTS playback coordination (#33).

- [ ] Follow `docs/plans/architecture/PLAN-architecture-tts-playback-coordination.md`.
- [ ] Characterize current TTS runtime behavior.
- [ ] Extract provider fallback policy.
- [ ] Introduce coordinator state and fakeable offscreen/overlay adapters.
- [ ] Preserve message payloads until tests prove the coordinator.

Verification:

```bash
npm run test:unit -- tests/unit/storage tests/unit/bridge/session-bridge.test.ts
npm run test:component -- tests/component/dialogs
npm run test:unit -- tests/unit/tts tests/unit/background/tts-runtime.test.ts tests/unit/background/offscreen-tts-ownership.test.ts tests/unit/background/offscreen-tts-playhead.test.ts
npm run build
./check.sh
```

Expected outcome:

- #32 and #33 close with reduced entry-point width and better testable runtime seams.

### Step 5: Deepen Electron Session Automation Internals (#34)

Do this before reopening the full Electron feature stack so subsequent Electron issues land on better internals.

- [ ] Follow `docs/plans/architecture/PLAN-architecture-electron-session-automation.md`.
- [ ] Add fake process and fake CDP characterization tests.
- [ ] Extract session storage behind an internal module.
- [ ] Extract Electron window execution.
- [ ] Extract main-process tools.
- [ ] Extract recording controller.
- [ ] Keep `ElectronSessionManager` as the external seam during the first pass.

Verification:

```bash
npm run test:unit -- tests/unit/bridge/electron-session-manager.test.ts tests/unit/bridge/electron-app-registry.test.ts tests/unit/bridge/electron-config.test.ts tests/unit/bridge/electron-doctor.test.ts tests/unit/bridge/electron-auto-attach.test.ts tests/unit/bridge/electron-source-inspector.test.ts
npm run build:cli
./check.sh
```

Expected outcome:

- #34 closes and later Electron feature issues use the extracted internals.

### Step 6: Execute Electron Stack in Dependency Order (#6-#20)

After Steps 3 and 5, re-audit #6-#20. Some work may already be partially implemented; close stale/completed issues with evidence before writing new code.

Recommended order:

1. #6 target routing foundation.
2. #7 allowlist, registry, launch/attach.
3. #8 CDP screenshot/eval.
4. #9 stable window refs.
5. #10 Electron snapshot/locate/ref actions.
6. #13 telemetry once attach/eval/ref flows exist.
7. #11 recording path after #8 and #9.
8. #12 docs after #7-#10.
9. #14 app-scoped skills after #10.
10. #16 sidepanel Electron targets after #7, #9, #13.
11. #17 main-process inspector after #7, #9, #13.
12. #19 source inspection after #7.
13. #20 doctor and auto-attach after #7, #12, #13.
14. #18 IPC/main-network tap after #17 and after the explicit invasive-diagnostics decisions below are captured.
15. #15 Electron chat after the provider-token export decisions below are captured.

For each Electron issue:

- [ ] Re-check the issue body and comments.
- [ ] Re-check whether current code already satisfies part of it.
- [ ] Implement the smallest vertical slice that satisfies acceptance criteria.
- [ ] Use fake CDP/process tests where real Electron is not stable enough for default validation.
- [ ] Mark live Electron/VScode smoke as manual evidence when hardware/app state is required.

Verification baseline:

```bash
npm run test:unit -- tests/unit/bridge/electron-*.test.ts tests/unit/bridge/target.test.ts tests/unit/bridge/telemetry.test.ts
npm run test:integration -- tests/integration/bridge/server.test.ts
npm run build:cli
./check.sh
```

Manual smoke when relevant:

```bash
shuvgeist electron list --json
shuvgeist electron allow <app>
shuvgeist electron attach <app-or-port> --json
shuvgeist --target electron:<app>:w1 screenshot --out /tmp/electron.png
shuvgeist --target electron:<app>:w1 snapshot --json
```

Expected outcome:

- #6-#20 close in dependency order, with #15 and #18 unblocked by explicit recorded decisions before implementation starts.

### Step 7: Unblock HITL and Question Issues (#15, #18)

Do not leave #15 and #18 as vague human blockers. Before implementing either issue, convert the uncertainty into concrete decision records on the issues. If the user confirms the recommended choices, remove or update `ready-for-human` / `question` labels and continue with implementation.

Decision set for #15, Electron chat runner with encrypted provider token export:

- [ ] Decide whether Electron chat is in scope for this issue or should be split into a separate post-Electron-target milestone.
- [ ] Decide the provider-token export trust model. Recommended: explicit one-time user action from the extension, encrypted local token file, restrictive file permissions, and clear documentation that anyone with both bridge config and token file access can decrypt credentials.
- [ ] Decide token lifetime and rotation behavior. Recommended: no automatic export; user can regenerate/revoke by replacing the file, and expired/missing/tampered tokens fail with teaching errors.
- [ ] Decide whether bridge-process chat may run without Chrome connected after token export. Recommended: yes, but only for explicitly attached Electron targets and synced app-scoped skills.
- [ ] Decide cancellation behavior. Recommended: Ctrl-C cancels model streaming and in-flight Electron commands.
- [ ] Record the chosen answers as a comment on #15 and remove `ready-for-human` only after the comment is present.

Decision set for #18, IPC tap and main-process network tap with capability gating:

- [ ] Decide whether invasive main-process diagnostics are allowed in v1. Recommended: yes, but only for explicitly allowed apps and never by default.
- [ ] Decide warning and consent UX. Recommended: each IPC/main-network tap command prints a clear warning that it monkey-patches the running app until cleanup or restart, and requires an explicit command invocation rather than passive attach.
- [ ] Decide capability model. Recommended: per-app capability flags independently gate eval, cookies, main inspect, IPC tap, and main network tap.
- [ ] Decide cleanup guarantees. Recommended: best-effort stop commands and tests for cleanup, with docs that app restart may be required after failures.
- [ ] Decide network-source labeling. Recommended: main-process network captures must be labeled separately from renderer network captures.
- [ ] Record the chosen answers as a comment on #18 and remove `question` only after the comment is present.

Verification for unblocking:

```bash
gh issue view 15 --json number,title,labels,comments
gh issue view 18 --json number,title,labels,comments
gh issue edit 15 --remove-label ready-for-human
gh issue edit 18 --remove-label question
```

Expected outcome:

- #15 and #18 have explicit decision comments.
- Their labels represent current state accurately.
- If the recommended decisions are accepted, both issues become normal dependency-ordered implementation work once their prerequisite issues are closed.

## Issue Closure and Label Maintenance

After each batch:

- [ ] Add a GitHub comment to each affected issue with:
  - commit hash
  - files changed summary
  - validation commands and pass/fail evidence
  - manual smoke evidence when applicable
- [ ] Close issues whose acceptance criteria are fully satisfied:
  ```bash
  gh issue close <number> --comment "Resolved in <commit>. Validation: ..."
  ```
- [ ] For issues no longer blocked, remove `blocked` and add or keep `ready-for-agent`.
- [ ] For issues needing decisions, keep or add `ready-for-human` or `question` and write the smallest decision question.
- [ ] Do not close parent or related issues automatically unless their own acceptance criteria are satisfied.

## Final Verification

The goal is complete when:

- [ ] `gh issue list --state open` shows no agent-completable open issues.
- [ ] Any remaining open issues are explicitly labeled and documented as `ready-for-human`, `question`, `wontfix`, or genuinely externally blocked.
- [ ] The final repo state is clean and pushed.
- [ ] The latest relevant validation suite has passed:
  ```bash
  ./check.sh
  npm run build
  npm run build:cli
  ```
- [ ] The final report lists all closed issue numbers, remaining non-agent issues, validation evidence, and commit range.

## Risks and Open Questions

- The issue queue may already contain stale blocked labels because several deterministic e2e changes appear to have landed. Step 1 handles this before new implementation.
- #15 is ready-for-human because provider token export has trust-model, token-lifetime, extensionless-chat, and cancellation decisions. Step 7 defines the recommended choices and the issue-comment record needed to unblock it.
- #18 is labeled question because invasive IPC/main-network taps need explicit decisions about v1 allowance, warnings, per-app capability gates, cleanup guarantees, and network-source labeling. Step 7 defines the recommended choices and the issue-comment record needed to unblock it.
- Electron live smoke may require installed apps, CDP-compatible launch flags, and local machine state. Prefer fake tests for default validation and record live smoke separately.
- GitNexus `detect-changes` can be a weak signal for non-code docs or newly ignored files. Always pair it with `git diff --stat`, direct review, and validation output.
