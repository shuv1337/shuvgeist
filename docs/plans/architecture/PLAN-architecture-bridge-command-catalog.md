# Bridge Command Catalog Deepening Plan

## Context

The bridge command surface has grown across Chrome, Electron, deterministic workflows, assertions, snapshots, refs, network capture, device emulation, perf tracing, recording, session control, and skills snapshot status.

Current command knowledge is distributed across several shallow modules:

- `src/bridge/cli-core.ts` parses command line arguments and builds command plans.
- `src/bridge/cli.ts` prints help text and executes command plans.
- `src/bridge/protocol.ts` declares capabilities, methods, sensitivity rules, protocol types, and write-method rules.
- `src/bridge/browser-command-executor.ts` dispatches methods to Chrome-side execution.
- `src/bridge/server.ts` routes extension-relayed, server-local, and Electron-targeted commands.
- `tests/unit/bridge/cli-core.test.ts`, `tests/unit/bridge/protocol.test.ts`, and `tests/unit/bridge/browser-command-executor.test.ts` re-encode parts of the command matrix.

The deletion test says the current scattered command knowledge is earning its keep, but the modules are shallow: removing any one copy of the command matrix moves complexity into the other copies instead of concentrating it.

## Goal

Deepen the bridge command catalog module so adding or changing a command has one primary interface for metadata:

- command name and CLI shape
- bridge method
- default timeout
- target support
- sensitivity gate
- write-lock classification
- capability advertisement
- help text data
- command-plan parameter builder

Do not redesign the wire protocol in this plan. This is a locality and leverage refactor around existing behavior.

## Proposed Module Shape

Create a new bridge command catalog module, likely under:

- `src/bridge/command-catalog.ts`

The module should expose a small interface for callers:

- enumerate bridge capabilities
- enumerate bridge methods
- look up command metadata by CLI command or bridge method
- build a `CliCommandPlan` from command input
- render command help sections from catalog data
- answer sensitivity and write-method questions

The existing `src/bridge/command-dispatcher.ts` is too shallow today. Either deepen it into the catalog or keep it as a tiny adapter if it already has a narrow role.

## Milestone 1: Characterize Current Behavior

- [ ] Add characterization tests for current command metadata consistency.
- [ ] Assert every `BridgeMethod` has a matching capability when applicable.
- [ ] Assert every CLI command maps to the expected method, timeout, target support, and params.
- [ ] Assert sensitive capabilities are filtered exactly as today.
- [ ] Assert write methods remain only the current session-mutating methods.
- [ ] Include representative command families:
  - [ ] navigation and tabs
  - [ ] repl, eval, screenshot, cookies
  - [ ] assert
  - [ ] workflow
  - [ ] snapshot, locate, ref, frame
  - [ ] network, device, perf, record
  - [ ] session commands
  - [ ] Electron commands

## Milestone 2: Introduce Catalog Data Without Behavior Changes

- [ ] Create `src/bridge/command-catalog.ts`.
- [ ] Move static command metadata into catalog records.
- [ ] Keep parameter-building behavior equivalent to `createCommandPlan`.
- [ ] Keep protocol arrays in place initially, generated from catalog where safe.
- [ ] Keep help text in `src/bridge/cli.ts` initially, but add tests proving catalog and help remain aligned.

## Milestone 3: Move CLI Planning Behind the Catalog Interface

- [ ] Refactor `createCommandPlan` in `src/bridge/cli-core.ts` to delegate each command family to catalog entries.
- [ ] Preserve exported helper functions that tests or other modules already import.
- [ ] Keep usage-error strings byte-for-byte where existing tests assert them.
- [ ] Add focused tests for catalog-driven command planning instead of expanding the large switch.

## Milestone 4: Move Protocol Classification Behind the Catalog Interface

- [ ] Derive `BridgeCapabilities` from catalog metadata.
- [ ] Derive `BridgeMethods` from catalog metadata.
- [ ] Derive `getBridgeCapabilities()` from sensitivity metadata.
- [ ] Derive `isWriteMethod()` from write-lock metadata.
- [ ] Keep exported types stable so callers do not change.

## Milestone 5: Move Help Text Toward Catalog Data

- [ ] Convert command summaries and usage strings in `src/bridge/cli.ts` into catalog-backed sections.
- [ ] Preserve current visible help output unless there is an intentional copy edit.
- [ ] Add a snapshot or targeted test for high-risk help sections.

## Milestone 6: Verify Executor Dispatch Coverage

- [ ] Add a test that every executable bridge method is handled by Chrome dispatch, server-local dispatch, or Electron-target dispatch.
- [ ] Keep `BrowserCommandExecutor.dispatch()` behavior stable.
- [ ] Do not move execution implementation into the catalog; the catalog is a seam for command metadata, not the command implementation.

## Validation

Run the repo-required checks after implementation:

```bash
./check.sh
npm run build
npm run build:cli
```

Run focused tests during development:

```bash
npm run test:unit -- tests/unit/bridge/cli-core.test.ts tests/unit/bridge/protocol.test.ts tests/unit/bridge/browser-command-executor.test.ts
```

Because this changes the CLI bridge surface, also smoke:

```bash
node dist-cli/shuvgeist.mjs --help
node dist-cli/shuvgeist.mjs assert --help
node dist-cli/shuvgeist.mjs electron --help
```

## Risk

Risk is medium. The behavior is broad but mostly deterministic. The safest implementation path is catalog-first with characterization tests before deleting any switch branches or duplicated arrays.
