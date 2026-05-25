# Bridge Target Execution Deepening Plan

## Context

Shuvgeist bridge requests can target Chrome/Edge through the extension or Electron through bridge-local CDP sessions.

Current target execution knowledge spans:

- `src/bridge/target.ts` for target parsing.
- `src/bridge/server.ts` for extension routing, server-local routing, Electron target routing, and lifecycle events.
- `src/bridge/browser-command-executor.ts` for Chrome-side command dispatch.
- `src/bridge/electron/session-manager.ts` for Electron session and window execution.
- `src/tools/helpers/browser-target.ts` for Chrome tab/frame resolution.
- `src/tools/page-snapshot.ts`, `src/tools/page-assert.ts`, `src/tools/workflow-engine.ts`, and related tools for behavior shared conceptually across targets.

The current seam leaks. Callers must know whether a method is extension-relayed, server-local, Electron-targeted, Chrome-only, or target-neutral.

## Goal

Deepen a bridge target execution module so target routing and target capability rules are concentrated behind one interface.

The module should provide leverage by answering:

- which adapter should execute a request
- whether a method supports the requested target
- how target-specific errors are normalized
- how target-specific telemetry attributes are attached
- how target-local result shapes remain protocol-compatible

This plan preserves the existing Chrome and Electron adapters. It does not require replacing `BrowserCommandExecutor` or `ElectronSessionManager` in one step.

## Proposed Module Shape

Likely new files:

- `src/bridge/target-execution.ts`
- `src/bridge/target-capabilities.ts`

The external seam should be small:

- resolve target execution adapter
- execute bridge request against that adapter
- expose adapter capability metadata
- normalize unsupported-target and missing-target failures

Adapters:

- Chrome extension adapter backed by `BridgeClient` and `BrowserCommandExecutor`.
- Electron adapter backed by `ElectronSessionManager`.
- Server-local adapter backed by `BridgeServer` local methods.

One adapter would be a hypothetical seam; three adapters make this a real seam.

## Milestone 1: Characterize Current Routing

- [ ] Add tests for `BridgeServer` routing decisions without changing behavior.
- [ ] Cover extension-relayed methods.
- [ ] Cover server-local Electron management methods.
- [ ] Cover Electron target methods:
  - [ ] eval
  - [ ] screenshot
  - [ ] snapshot
  - [ ] locate
  - [ ] ref
  - [ ] record
- [ ] Cover unsupported target/method combinations.
- [ ] Cover no-extension-target behavior for Chrome requests.

## Milestone 2: Extract Target Capability Metadata

- [ ] Define target support metadata per bridge method.
- [ ] Keep metadata near the command catalog if that plan lands first.
- [ ] Represent at least:
  - [ ] Chrome extension target support
  - [ ] Electron window target support
  - [ ] server-local support
  - [ ] session write-lock needs
  - [ ] extension connection requirement
- [ ] Add tests that routing metadata matches current behavior.

## Milestone 3: Introduce Execution Adapters

- [ ] Create a target execution adapter interface.
- [ ] Wrap extension forwarding as an adapter.
- [ ] Wrap Electron session execution as an adapter.
- [ ] Wrap server-local operations as an adapter.
- [ ] Keep existing method implementations where they are during the first pass.

## Milestone 4: Move Server Routing Behind the Target Execution Interface

- [ ] Refactor `BridgeServer.handleCliRequest()` to ask the target execution module where the request should go.
- [ ] Refactor `BridgeServer.handleServerLocalRequest()` and `BridgeServer.handleElectronTargetRequest()` into adapter calls.
- [ ] Preserve telemetry spans and event broadcasts.
- [ ] Preserve active recording lease behavior.
- [ ] Preserve auth and registration behavior.

## Milestone 5: Normalize Target Errors

- [ ] Centralize missing extension target errors.
- [ ] Centralize missing Electron session/window errors.
- [ ] Centralize unsupported target/method errors.
- [ ] Add tests for user-facing error codes and messages.

## Milestone 6: Prove Chrome/Electron Parity for Shared Commands

- [ ] Add shared contract tests for commands that should work on both targets.
- [ ] Cover result shape compatibility for:
  - [ ] eval
  - [ ] screenshot
  - [ ] snapshot
  - [ ] locate
  - [ ] ref click/fill
  - [ ] record status/start/stop where possible with fakes

## Validation

```bash
./check.sh
npm run build
npm run build:cli
```

Focused tests:

```bash
npm run test:unit -- tests/unit/bridge/server.test.ts tests/unit/bridge/browser-command-executor.test.ts tests/unit/bridge/electron-session-manager.test.ts tests/unit/bridge/target.test.ts
npm run test:integration -- tests/integration/bridge/server.test.ts
```

Bridge smoke after implementation:

```bash
node dist-cli/shuvgeist.mjs status --json
node dist-cli/shuvgeist.mjs tabs --json
node dist-cli/shuvgeist.mjs electron list --json
```

## Risk

Risk is medium-high because `BridgeServer` owns request lifecycle, telemetry, recording leases, and client registration. Keep the first implementation as an adapter extraction with identical call paths before changing behavior.
