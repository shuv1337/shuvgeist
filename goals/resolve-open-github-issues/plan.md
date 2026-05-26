# Resolve Open GitHub Issues Plan

## Solution approach

Work the open issue queue in dependency order. First make Electron session discovery stable enough that live testing is reliable, then fill the renderer command gaps, then handle human-decision issues with researched recommendations instead of speculative implementation.

The execution source of truth is the live GitHub queue captured in `goals/resolve-open-github-issues/open-issues.json`. At execution start, refresh it with `gh issue list --state open --limit 100 --json number,title,labels,url,body` and treat any newly-opened issue as part of the goal unless the user narrows scope.

## Ordered steps

1. Refresh and triage the live issue queue.
   - Touches: GitHub issue tracker, `goals/resolve-open-github-issues/open-issues.json`.
   - Confirm current labels and bodies for #15 and #36-#42.
   - Reorder only if new blockers or duplicates appeared.

2. Resolve #36: keep Electron launch sessions alive for wrapper apps.
   - Touches: `src/bridge/electron/session-manager.ts`, `src/bridge/electron/types.ts` if process metadata needs refinement, `tests/unit/bridge/electron-session-manager.test.ts`, possibly integration server tests.
   - Before editing, run GitNexus impact analysis for `ElectronSessionManager.launch` and any helper symbols changed.
   - Change launch tracking so a short-lived wrapper process does not delete a session while the CDP endpoint remains alive.
   - Preserve detach behavior for sessions that Shuvgeist actually launched.

3. Resolve #37: detect Node main-process inspector targets from `/json/list`.
   - Touches: `src/bridge/electron/session-manager.ts`, `src/bridge/electron/cdp-client.ts` if target connection helpers need cleanup, `tests/unit/bridge/electron-session-manager.test.ts`, `tests/integration/bridge/server.test.ts`.
   - Before editing, run GitNexus impact analysis for `resolveMainInspector` and `connectToMainInspector`.
   - Accept Chromium-style `/json/version` and Node-style `/json/list` response shapes.
   - Verify `electron main`, `electron ipc tap`, and `electron network-main start` no longer fail when a Node inspector WebSocket exists.

4. Resolve #38: infer Electron source roots behind launcher wrappers.
   - Touches: `src/bridge/electron/source-inspector.ts`, `src/bridge/electron/app-registry.ts` if registry metadata is needed, `tests/unit/bridge/electron-source-inspector.test.ts`, `tests/unit/bridge/electron-app-registry.test.ts`.
   - Before editing, run GitNexus impact analysis for `resolveSourceRoot` and `inspectElectronSourceLayout`.
   - Add wrapper/symlink-aware candidate discovery without hard-coding only shuvscode.
   - Ensure shuvscode resolves `/opt/shuvscode/resources` from alias-only commands.

5. Resolve #39: support Electron renderer assertions.
   - Touches: `src/bridge/server.ts`, `src/bridge/electron/session-manager.ts`, `src/bridge/electron/window-executor.ts`, `src/tools/page-assert.ts`, tests for server and Electron window/session execution.
   - Before editing, run GitNexus impact analysis for `handleElectronTargetRequest` and assertion helper symbols reused.
   - Implement text and expression assertion paths first, then either support or explicitly reject unsupported Chrome-only options.
   - Keep JSON result shape and nonzero failure behavior compatible with Chrome assertions.

6. Resolve #40: support Electron renderer network capture.
   - Touches: `src/bridge/server.ts`, `src/bridge/electron/session-manager.ts`, possibly a new Electron network capture helper, `src/tools/network-capture.ts` for reusable types/formatting, tests.
   - Before editing, run GitNexus impact analysis for `handleElectronTargetRequest` and any reused network capture symbols.
   - Use renderer CDP Network domain for start/list/get/body/curl/stats/clear/stop where practical.
   - Keep main-process network inspection separate from renderer network capture.

7. Resolve #41: support Electron renderer perf metrics.
   - Touches: `src/bridge/server.ts`, `src/bridge/electron/session-manager.ts`, possibly `src/tools/performance-tools.ts`, tests.
   - Before editing, run GitNexus impact analysis for `handleElectronTargetRequest` and any perf helper symbols reused.
   - Implement `perf metrics` through renderer CDP Performance APIs.
   - For trace operations, either implement CDP-compatible support or return specific unsupported-operation errors.

8. Resolve #42: decide trusted input strategy for Electron ref actions.
   - Touches: GitHub issue #42, docs or README if the decision changes user-facing behavior, possibly follow-up issue creation.
   - Research current Electron/Chrome CDP input options and existing Chrome native-input implementation in `src/bridge/browser-command-executor.ts`.
   - Recommend one of: CDP-only event synthesis, OS-level desktop input, or explicit limited support.
   - Update #42 with the decision and implementation criteria before coding. If the decision is implementation-ready, either implement it in the same goal or create/follow a narrower follow-up issue.

9. Revisit #15: Electron chat runner with encrypted provider token export.
   - Touches: GitHub issue #15, relevant plans such as `PLAN-electron-targets.md` and `PLAN-agent-browser-recon.md` if present.
   - Evaluate against the clarified product direction: primary use is external coding harness + shuvgeist CLI/skill driving Electron apps, not Shuvgeist hosting native chat.
   - Recommend close, split, or keep blocked with exact remaining decisions. Do not implement a bridge-native chat runner unless the current issue still matches the agreed product direction.

10. Validate, document, and close or update issues.
    - Touches: `CHANGELOG.md`, `README.md`, `skills/shuvgeist/SKILL.md` if command behavior changes, GitHub issue comments/closures.
    - Run focused tests after each issue-sized change.
    - Run `npm run build:cli` for CLI bridge changes.
    - Run `./check.sh` before any commit/push.
    - Run `npx gitnexus detect-changes --repo shuvgeist` before commit if committing.
    - Close fixed issues with validation notes. Leave unresolved human-decision issues open only with explicit blocker and next human action.

## Verification

- Refresh issue queue: `gh issue list --state open --limit 100 --json number,title,labels,url,body`.
- Focused unit tests:
  - `npx vitest run tests/unit/bridge/electron-session-manager.test.ts`
  - `npx vitest run tests/unit/bridge/electron-source-inspector.test.ts`
  - `npx vitest run tests/unit/bridge/electron-window-executor.test.ts`
  - `npx vitest run tests/unit/tools/page-assert.test.ts`
  - `npx vitest run tests/unit/tools/network-capture.test.ts`
  - `npx vitest run tests/unit/tools/performance-tools.test.ts`
- Integration tests:
  - `npx vitest run tests/integration/bridge/server.test.ts`
  - `npx vitest run tests/integration/bridge/network-capture.integration.test.ts`
  - `npx vitest run tests/integration/bridge/perf-tools.integration.test.ts`
- Full required gate after code changes: `./check.sh`.
- CLI rebuild after bridge/CLI changes: `npm run build:cli`.
- Live Electron smoke after Electron target changes:
  - `shuvgeist electron allow shuvscode --json`
  - `shuvgeist electron launch shuvscode --inspect-main --json`
  - `shuvgeist electron windows --json`
  - `shuvgeist electron attach shuvscode --port 9330 --inspect-port 9331 --json`
  - `shuvgeist electron main <session> --json`
  - `shuvgeist snapshot --target electron:<session>:main --json`
  - `shuvgeist assert expr 'document.title === "shuvscode"' --target electron:<session>:main --json`
  - `shuvgeist network start --target electron:<session>:main --json`
  - `shuvgeist perf metrics --target electron:<session>:main --json`
  - `shuvgeist electron source layout shuvscode --json`

## Risks and open questions

- Wrapper process handling can accidentally change detach/cleanup semantics. Keep tests explicit about wrapper-exit vs real-app-exit behavior.
- Main inspector support should not assume Node and Chromium expose identical discovery JSON.
- Renderer network/perf support may expose only renderer-visible data; do not conflate it with main-process Electron traffic.
- Trusted input may require a security-sensitive OS-level integration. Treat #42 as a decision gate, not just a missing method.
- #15 may be obsolete or too broad if Shuvgeist does not need to host its own Electron chat session. Update the issue before building anything from it.

