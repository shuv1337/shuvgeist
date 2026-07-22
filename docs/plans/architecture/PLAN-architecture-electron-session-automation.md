# Electron Session Automation Deepening Plan

## Context

Electron support lets the Shuvgeist bridge launch, attach to, inspect, and automate Electron apps through CDP and main-process hooks.

Current behavior is concentrated in:

- `src/bridge/electron/session-manager.ts`
- `src/bridge/electron/cdp-client.ts`
- `src/bridge/electron/app-registry.ts`
- `src/bridge/electron/config.ts`
- `src/bridge/electron/source-inspector.ts`
- `src/bridge/electron/doctor.ts`
- `src/bridge/electron/auto-attach.ts`

`ElectronSessionManager` currently owns launch/attach/detach, window discovery, main-process inspection, IPC tap, main network tap, CDP evaluate/screenshot, snapshots, locators, refs, and recording. Tests mostly cover small helpers, so the implementation is hard to change safely.

## Goal

Deepen Electron session automation so session lifecycle and window execution have clear locality and fakeable internal adapters.

The public interface should remain the bridge's Electron command surface. Internally, process discovery, CDP, source inspection, main-process hooks, refs, and recording should be adapters or internal modules.

## Proposed Module Shape

Likely new files:

- `src/bridge/electron/session-store.ts`
- `src/bridge/electron/window-executor.ts`
- `src/bridge/electron/main-process-tools.ts`
- `src/bridge/electron/recording-controller.ts`

Keep `ElectronSessionManager` as the external seam at first, but reduce its implementation to orchestration.

Internal adapters:

- process discovery adapter
- CDP page adapter
- main-process adapter
- source inspector adapter
- ref store adapter
- recording adapter

## Milestone 1: Characterize Electron Session Behavior

- [ ] Add fake CDP client tests for evaluate and screenshot behavior.
- [ ] Add tests for attach resolution by app ref, pid, port, and inspect port.
- [ ] Add tests for window labeling and target resolution.
- [ ] Add tests for no-session and no-window errors.
- [ ] Add tests for locator/ref behavior using fake snapshots.
- [ ] Add tests for recording state without starting ffmpeg.

## Milestone 2: Extract Session Store

- [ ] Move session map, refs map, recordings map, and session numbering behind a session store module.
- [ ] Preserve session IDs and window refs.
- [ ] Preserve summary shape returned by `list()` and `windows()`.
- [ ] Add tests for session creation, lookup, detach, and summary projection.

## Milestone 3: Extract Window Executor

- [ ] Move Electron window evaluate, screenshot, snapshot, locate, ref click, and ref fill behavior behind a window executor.
- [ ] Keep the CDP client as an adapter.
- [ ] Reuse snapshot/ref logic where possible without coupling to Chrome-only helpers.
- [ ] Add contract tests for result shapes shared with Chrome bridge commands.

## Milestone 4: Extract Main Process Tools

- [ ] Move main info, IPC tap, and main network tap logic behind a main-process tools module.
- [ ] Keep injected script strings local to the module.
- [ ] Add tests for generated injected behavior where feasible.
- [ ] Preserve capability allowlist checks.

## Milestone 5: Extract Recording Controller

- [ ] Move Electron recording start/stop/status state behind a recording controller.
- [ ] Keep ffmpeg encoding behavior compatible with `src/bridge/recording/ffmpeg-encoder.ts`.
- [ ] Add tests for lease cleanup and tab/window close behavior with fakes.

## Milestone 6: Keep Bridge Server Integration Stable

- [ ] Keep `BridgeServer` calling `ElectronSessionManager` through the existing public methods during the first pass.
- [ ] If the bridge target execution plan has landed, register Electron adapters with that seam.
- [ ] Preserve Electron command help and docs.
- [ ] Update `ARCHITECTURE.md` and `docs/e2e-ci.md` only if public usage or architecture narrative changes.

## Validation

```bash
./check.sh
npm run build:cli
```

Focused tests:

```bash
npm run test:unit -- tests/unit/bridge/electron-session-manager.test.ts tests/unit/bridge/electron-app-registry.test.ts tests/unit/bridge/electron-config.test.ts tests/unit/bridge/electron-doctor.test.ts tests/unit/bridge/electron-auto-attach.test.ts tests/unit/bridge/electron-source-inspector.test.ts
```

Manual validation after implementation:

- [ ] `shuvgeist electron list --json`
- [ ] `shuvgeist electron allow <app>`
- [ ] `shuvgeist electron attach <app-or-port> --json`
- [ ] `shuvgeist --target electron:<app>:w1 screenshot --out /tmp/electron.png`
- [ ] `shuvgeist --target electron:<app>:w1 snapshot --json`
- [ ] `shuvgeist --target electron:<app>:w1 locate text "..." --json`

## Risk

Risk is medium. The Electron surface is broad but isolated under `src/bridge/electron/`. The safest route is fake-adapter tests first, then internal extractions that preserve `ElectronSessionManager` as the external interface.
