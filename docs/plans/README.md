# Design plans

Tracked implementation plans live here instead of at the repository root. Moving a plan here does not assert that every checkbox is current or that the plan is still the authoritative implementation brief. Revalidate a plan against the live checkout and its linked issue before executing it.

Ignored root `PLAN-*.md` files and `HANDOFF.md` are local working material. They are deliberately outside this index and must not be moved or deleted as part of repository-wide documentation cleanup.

## Architecture

- [`PLAN-architecture-bridge-command-catalog.md`](./architecture/PLAN-architecture-bridge-command-catalog.md) — command-catalog deepening; referenced by the open-issues execution plan.
- [`PLAN-architecture-bridge-target-execution.md`](./architecture/PLAN-architecture-bridge-target-execution.md) — bridge target routing; referenced by the open-issues execution plan.
- [`PLAN-architecture-sidepanel-session-runtime.md`](./architecture/PLAN-architecture-sidepanel-session-runtime.md) — sidepanel runtime ownership; referenced by the open-issues execution plan.
- [`PLAN-architecture-tts-playback-coordination.md`](./architecture/PLAN-architecture-tts-playback-coordination.md) — TTS coordination; referenced by the open-issues execution plan.
- [`PLAN-architecture-electron-session-automation.md`](./architecture/PLAN-architecture-electron-session-automation.md) — Electron session internals; referenced by the open-issues execution plan.

## Bridge

- [`PLAN-cli-bridge.md`](./bridge/PLAN-cli-bridge.md) — original CLI-to-extension bridge plan; partially implemented and retained as design history.
- [`PLAN-closed-sidebar-full-repl.md`](./bridge/PLAN-closed-sidebar-full-repl.md) — closed-sidepanel REPL design; revalidate remaining checklist items before use.
- [`PLAN-pre-cdp-bridge-simplification.md`](./bridge/PLAN-pre-cdp-bridge-simplification.md) — bridge settings/bootstrap simplification; much of the canonical-settings work is implemented, while the plan remains useful historical context.

## Proxy

- [`PLAN-own-cors-proxy.md`](./proxy/PLAN-own-cors-proxy.md) — self-hosted Node proxy design.
- [`PLAN-cloudflare-worker-cors-proxy.md`](./proxy/PLAN-cloudflare-worker-cors-proxy.md) — Cloudflare Worker variant that references the broader Node plan.

The proxy already has its own package boundary under `proxy/`; these documents do not propose moving that package.

## Testing and local deployment

- [`PLAN-comprehensive-test-suite.md`](./testing/PLAN-comprehensive-test-suite.md) — implemented test-suite baseline retained for rationale and coverage history.
- [`PLAN-local-development-test-deployment.md`](./testing/PLAN-local-development-test-deployment.md) — local deployment workflow proposal; revalidate before implementation.

## Product

- [`PLAN-element-inspector.md`](./product/PLAN-element-inspector.md) — element-inspector implementation design retained with the shipped feature history.

## Research

- [`chrome-extension-research.md`](../research/chrome-extension-research.md) — Chromium TTS overlay research and source notes.
