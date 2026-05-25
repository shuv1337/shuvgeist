# Sidepanel Session Runtime Deepening Plan

## Context

`src/sidepanel.ts` is the main extension UI entry point and currently owns several concepts:

- model/provider discovery
- API key and OAuth resolution
- agent creation and event subscriptions
- session persistence and metadata
- bridge session commands
- bridge REPL/screenshot delegation
- UI rendering
- settings dialogs
- TTS overlay actions
- update checks
- tab steering and element inspection

The module is deep in behavior but too wide at its interface. Internal concepts have poor locality because session runtime behavior is mixed with rendering and dialog wiring.

## Goal

Deepen a sidepanel session runtime module that owns the agent/session lifecycle behind a small interface.

Rendering, dialogs, and bridge message handlers should become adapters around that runtime. The runtime should be testable without rendering the full sidepanel.

## Proposed Module Shape

Likely new files:

- `src/sidepanel/session-runtime.ts`
- `src/sidepanel/model-resolution.ts`
- `src/sidepanel/session-metadata.ts`

Only add folders if the repo accepts a new `src/sidepanel/` slice. Otherwise use `src/session-runtime.ts` or another local convention.

Runtime interface responsibilities:

- create/load/new sessions
- create and replace the `Agent`
- save session metadata
- emit bridge session events
- inject bridge messages
- set model
- summarize current session
- wait for idle where required

UI responsibilities should remain in `src/sidepanel.ts` initially:

- render app
- open dialogs
- wire buttons
- display toasts
- register custom renderers

## Milestone 1: Characterize Current Session Behavior

- [ ] Add or extend tests around pure session metadata behavior:
  - [ ] title generation
  - [ ] should-save rules
  - [ ] preview generation
  - [ ] cumulative usage aggregation
- [ ] Add tests for bridge session adapter behavior with fake agent/storage:
  - [ ] session snapshot
  - [ ] session injection
  - [ ] new session
  - [ ] set model
  - [ ] session artifacts
- [ ] Preserve current no-active-session, session-mismatch, and busy-session errors.

## Milestone 2: Extract Session Metadata Helpers

- [ ] Move title generation, should-save rules, preview generation, and usage aggregation out of `src/sidepanel.ts`.
- [ ] Keep exported helper names small and domain-focused.
- [ ] Update tests to target the new module interface.
- [ ] Do not change IndexedDB schema or stored metadata shape.

## Milestone 3: Extract Model Resolution Helpers

- [ ] Move custom provider lookup helpers out of `src/sidepanel.ts`.
- [ ] Move default model selection logic out of `src/sidepanel.ts`.
- [ ] Move runtime model normalization if it remains sidepanel-specific.
- [ ] Keep provider registration setup stable.
- [ ] Add tests for custom-provider and provider/model-id resolution.

## Milestone 4: Introduce Session Runtime

- [ ] Create a runtime object or class with injected adapters:
  - [ ] storage
  - [ ] model registry access
  - [ ] API key resolver
  - [ ] agent factory
  - [ ] session bridge event sink
- [ ] Move `saveSession()`, `currentSessionSnapshot()`, `appendInjectedMessage()`, `bridgeNewSession()`, and `bridgeSetModel()` behind the runtime.
- [ ] Keep `src/sidepanel.ts` as the composition root.
- [ ] Keep bridge message types unchanged.

## Milestone 5: Move Agent Creation Behind the Runtime

- [ ] Move `createAgent()` into the runtime or an internal collaborator.
- [ ] Keep tool factory construction injectable so browser-specific tools remain available.
- [ ] Preserve cost recording behavior.
- [ ] Preserve tab steering and navigation-message behavior.
- [ ] Preserve agent unsubscribe cleanup on session changes.

## Milestone 6: Slim the Sidepanel Entry Point

- [ ] Replace global session state in `src/sidepanel.ts` with runtime calls.
- [ ] Keep UI render state explicit.
- [ ] Keep dialog creation in `src/sidepanel.ts` or a separate UI module, not inside the runtime.
- [ ] Update `ARCHITECTURE.md` if the entry point responsibilities materially change.

## Validation

```bash
./check.sh
npm run build
```

Focused tests:

```bash
npm run test:unit -- tests/unit/storage tests/unit/bridge/session-bridge.test.ts
npm run test:component -- tests/component/dialogs
```

Manual/browser validation after implementation:

- [ ] Open the sidepanel.
- [ ] Start a new session.
- [ ] Send a message.
- [ ] Rename and reload the session.
- [ ] Use bridge `session`, `new-session`, `inject`, `set-model`, and `artifacts` commands.

## Risk

Risk is medium. The module is large, but the refactor can be staged by moving pure helpers first, then introducing the runtime as a facade before changing sidepanel call sites.
