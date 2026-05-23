# E2E CI Implementation Execution Plan

## Solution Approach

Implement deterministic Shuvgeist e2e CI support in small validated chunks. The work should preserve current REPL semantics, add `page_assert` as a separate bridge capability, make workflows target-stable, add native trusted ref input including subframe refs, and finish with docs plus local e2e validation.

The current code already has the right primitives in pieces: bridge dispatch lives in `src/bridge/browser-command-executor.ts`, protocol types in `src/bridge/protocol.ts`, workflow parsing/execution in `src/bridge/workflow-schema.ts` and `src/tools/workflow-engine.ts`, CLI command planning in `src/bridge/cli-core.ts` and `src/bridge/cli.ts`, page snapshots and locators through `chrome.userScripts.execute`, and native input plumbing in `src/tools/NativeInputEventsRuntimeProvider.ts`. The implementation should reuse those paths rather than adding an independent test runner.

## Ordered Steps

### 1. Add A Shared Page Execution Helper

Touch:

- `src/tools/helpers/page-execution.ts` as a new helper
- `src/bridge/background-runtime-handler.ts`
- focused tests under `tests/unit/` or the closest existing bridge/tool test location

Work:

- Add a service-worker-safe helper for page-context user-script execution.
- Support `tabId`, optional `frameId`, user-script `worldId`, serialized args, console capture, duration, structured script success/errors, timeout/abort handling, and `chrome.userScripts.terminate` with `executionId` when available.
- Migrate `handleBgBrowserJs` onto the helper only after adding regression coverage for the current `browserjs()` result envelope.
- Keep direct REPL semantics unchanged: page DOM access still requires `browserjs()`, while assertions will be separate.
- Do not migrate `page_snapshot`, REPL `buildWrapperCode`, or ref DOM actions in this chunk; leave them for later mechanical cleanup.

Verification:

- Before editing existing symbols, run GitNexus impact checks for `handleBgBrowserJs`, `buildDirectBrowserJsCode`, `BrowserJsRuntimeProvider`, and `capturePageSnapshot`.
- Unit-test success, thrown script errors, console capture, frame targeting, abort-before-run, abort-during-run with terminate available, and terminate-unavailable fallback.
- Run `./check.sh`.
- Run `npm run build` because the extension runtime path changes.
- Run `npm run build:cli` if shared bridge types or CLI imports are touched.

### 2. Stabilize Workflow Targets And Warnings

Touch:

- `src/bridge/workflow-schema.ts`
- `src/tools/workflow-engine.ts`
- `src/tools/navigate.ts`
- `src/bridge/browser-command-executor.ts` if navigate response shaping is required there
- workflow schema and engine tests

Work:

- Add top-level workflow target modes: `active`, `new-tab`, and `pinned-tab`.
- Thread inherited `tabId` and `frameId` into targetable steps unless a step explicitly overrides them.
- Ensure `navigate` bridge responses preserve `tabId` for current-tab and new-tab navigations.
- Add non-fatal workflow warnings for new-tab mode when a targetable step runs before a pinned tab exists.
- Include warnings in workflow run results without turning them into failures.
- Keep recursive workflows, session methods, and `select_element` disallowed; allow CI-useful frame, network, device, performance, and record methods.

Verification:

- Run GitNexus impact checks for `WorkflowEngine`, `executeCommandStep`, and the navigate bridge path symbols that will be edited.
- Add tests for pinned target inheritance, explicit target override, warning emission, warning result shape, allowed/disallowed methods, and `tabId` preservation after navigate.
- Run `./check.sh`.
- Run `npm run build`.
- Run `npm run build:cli` if protocol or CLI-visible workflow result types change.

### 3. Add `page_assert` Protocol, Executor, And Electron Guardrail

Touch:

- `src/bridge/protocol.ts`
- `src/tools/page-assert.ts`
- `src/bridge/browser-command-executor.ts`
- `src/bridge/server.ts`
- protocol, executor, and server integration tests

Work:

- Add non-sensitive `page_assert` to bridge capabilities and bridge methods.
- Define `PageAssertParams`, `PageAssertResult`, assertion kinds `expression`, `text`, `selector`, `role`, `label`, and `url`, target fields, timeout/interval, attempts, duration, count constraints, visibility/enabled options, and result metadata including `tabId` and `frameId`.
- Implement user-world assertions on top of the shared page execution helper.
- Route main-world expression assertions through the existing sensitive `eval` gate rather than making `page_assert` itself sensitive.
- Return `PageAssertResult` with `ok: false` for assertion failures; keep transport, auth, invalid method, network, and config errors as bridge errors.
- In Electron-target request handling, fail `page_assert` with a clear unsupported message instead of the current generic dispatcher error.

Verification:

- Run GitNexus impact checks for `dispatch`, `getBridgeCapabilities`, `handleElectronTargetRequest`, and any helper symbols being edited.
- Test passing/failing assertions for each kind, auto-wait behavior, timeout metadata, structured failure result, frame targeting, main-world sensitive gating, and Electron unsupported behavior.
- Run `./check.sh`.
- Run `npm run build`.
- Run `npm run build:cli` because protocol types change.

### 4. Add CLI `assert` Commands And Exit Codes

Touch:

- `src/bridge/cli-core.ts`
- `src/bridge/cli.ts`
- CLI tests

Work:

- Add `shuvgeist assert expr|text|selector|role|label|url` command planning.
- Support target, timeout, interval, visibility, enabled, count, min/max count, world, URL pattern, and native-related flags where they apply.
- Map assertion results to CI exit codes: `0` pass, `1` assertion failure, `2` no reachable extension target, `3` auth/registration/invalid method/network/config errors.
- Preserve JSON output shape for automation and provide concise human output for non-JSON use.

Verification:

- Run GitNexus impact checks for `createCommandPlan`, `exitCodeForResponse`, `runOneShot`, and the CLI dispatch switch.
- Add parser tests, response-to-exit-code tests, and command dispatch tests for all assert subcommands.
- Run `./check.sh`.
- Run `npm run build:cli`.

### 5. Add Workflow Assertion Steps

Touch:

- `src/bridge/workflow-schema.ts`
- `src/tools/workflow-engine.ts`
- `src/bridge/protocol.ts` if result unions need to be exported
- workflow docs/tests

Work:

- Extend workflow steps with an `assert` step type that delegates to `page_assert`.
- Default assertion failures to halt the workflow.
- Support `onError: "continue"` so failed assertions can be recorded and execution can proceed.
- Capture `PageAssertResult` under `as` on both pass and fail paths.
- Preserve target inheritance and warnings from step 2 for assertion steps.

Verification:

- Run GitNexus impact checks for workflow schema parsing and `executeStep`.
- Add tests for pass, fail, halt, continue, capture-on-pass, capture-on-fail, target inheritance, and warning coexistence.
- Run `./check.sh`.
- Run `npm run build`.
- Run `npm run build:cli` if exported protocol or CLI workflow output changes.

### 6. Add Native Trusted Ref Click/Fill With Subframe Support

Touch:

- `src/bridge/protocol.ts`
- `src/bridge/browser-command-executor.ts`
- `src/tools/NativeInputEventsRuntimeProvider.ts`
- `src/bridge/background-runtime-handler.ts` if shared runtime plumbing is reused
- possibly a new helper under `src/tools/helpers/` for frame-aware element coordinate resolution
- unit/integration tests plus a live iframe fixture under `tests/e2e/extension`

Work:

- Add typed native options for `ref_click` and `ref_fill`.
- Implement trusted debugger-backed input paths and never silently fall back to synthetic DOM events when native mode is requested.
- Support iframe and subframe refs by resolving the referenced element in the correct extension frame context and dispatching trusted input to the root browser viewport coordinates.
- Prefer using `chrome.userScripts.execute` with `frameIds` to locate the element inside the target frame, then translate coordinates to viewport coordinates for CDP input dispatch. If CDP frame identifiers are needed, explicitly map extension `webNavigation` frame ids to CDP frame/frame tree data and test that mapping.
- Return clear errors for missing refs, stale refs, inaccessible frames, unsupported native mode, and debugger attach failures.

Verification:

- Run GitNexus impact checks for `refClick`, `refFill`, `executeRefDomAction`, `resolveReference`, and `NativeInputEventsRuntimeProvider`.
- Add tests proving native mode calls debugger-backed input, synthetic mode remains unchanged, no silent fallback happens, and subframe coordinates resolve correctly.
- Add a Playwright extension fixture with nested iframe refs once the lower-level implementation is stable.
- Run `./check.sh`.
- Run `npm run build`.
- Run `npm run build:cli` if protocol/CLI flags change.
- Run `npm run test:e2e:extension` when the iframe fixture is stable.

### 7. Document CI Usage And Update Guides

Touch:

- `README.md`
- `docs/e2e-ci.md` as a new deterministic CI guide
- `docs/e2e-ci-implementation-plan.md` if it remains the design reference
- `skills/shuvgeist/SKILL.md`
- `CHANGELOG.md`

Work:

- Document headless launch, extension target readiness, `assert` CLI examples, workflow target pinning, workflow assertions, exit codes, native refs, subframe caveats, and sensitive-access behavior for main-world expression assertions.
- Add `CHANGELOG.md` entries under `## [Unreleased]` in existing subsections only.
- Make the skill guide teach agents to use Shuvgeist assertions for deterministic CI flows instead of falling back to Playwright for basic DOM assertions.
- Do not claim CI readiness until the headless launch and local fixture smoke checks pass.

Verification:

- Run `./check.sh`.
- Run `npm run build` if the skill/docs are packaged into extension output or the change touches extension runtime docs.
- Manually inspect docs examples against actual CLI parser flags.

### 8. Migrate Remaining Page-Script Call Sites Onto The Helper

Touch:

- `src/tools/page-snapshot.ts`
- `src/tools/repl/userscripts-helpers.ts`
- `src/bridge/browser-command-executor.ts`
- tests for migrated paths

Work:

- Migrate `capturePageSnapshot`, REPL user-script wrapper code where compatible, and synthetic ref DOM action script execution onto the shared helper.
- Keep behavior equivalent and land migrations one call site at a time.
- Leave unrelated refactors out of this cleanup chunk.

Verification:

- Run GitNexus impact checks for each migrated symbol before editing it.
- Add or update regression tests for snapshot, REPL browserjs wrapper behavior, and synthetic ref actions.
- Run `./check.sh`.
- Run `npm run build`.
- Run `npm run build:cli` if shared types or CLI imports changed.

### 9. Final E2E And Release-Readiness Validation

Touch:

- `tests/e2e/extension/` fixtures/specs
- `.github/workflows/test.yml` only if CI wiring needs adjustment after local validation

Work:

- Add stable Playwright extension e2e coverage for local deterministic assertions, target pinning, workflow assertion execution, and native iframe refs.
- Verify `shuvgeist launch --headless --json` produces a connected extension target before documenting readiness.
- Keep required tests hermetic and local. Public-site smoke can be documented as optional, not required CI.
- If CI workflow changes are needed, keep them limited to existing `fast-checks` and `browser-smoke` structure unless a new job is justified by runtime cost.

Verification:

- Run `./check.sh`.
- Run `npm run build`.
- Run `npm run build:cli`.
- Run `npm run test:e2e:extension` when the live fixture smoke is stable.
- Capture exact failure output and mark the final validation partial if browser launch or extension registration is environment-blocked.

## Risks And Open Questions

- Native subframe support is the highest-risk area. Chrome extension frame ids and CDP frame ids are not the same surface, and coordinate translation must be proven with nested iframe tests before the feature is considered done.
- `page_assert` must stay non-sensitive while main-world expression assertions reuse the sensitive `eval` gate. Mixing these concerns would either over-prompt safe assertions or under-protect main-world script execution.
- Workflow target pinning depends on navigate responses reliably returning `tabId`; this should be fixed and tested before workflow assertions are added.
- Abort behavior depends on Chrome support for `chrome.userScripts.terminate`. The helper must test both terminate-available and terminate-unavailable behavior so older runtimes fail predictably.
- Live browser e2e should be added only after unit and integration coverage makes failures diagnosable. If headless extension launch is environment-blocked, document the exact blocker instead of weakening the implementation contract.
- Every implementation chunk must start with current `git status` and required GitNexus impact checks, because this repo has explicit AGENTS rules for symbol edits and the work spans bridge, CLI, workflow, and extension runtime surfaces.
