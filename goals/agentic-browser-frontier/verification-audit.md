# Agentic Browser Frontier Verification Audit

Date: 2026-06-01

## Summary

The goal is not complete. The implemented foundations through Tier C have source and automated-test anchors, but this audit is not a full completion proof. Tier D gate state is still open, and external/manual checks remain separate from repo-local test coverage:

- T11 now has an implementation and integration proof for the approved direct-CDP headless path. T12 now has a direct-CDP-only trusted input implementation and unit proof that Runtime is not enabled on the action path.
- T13 now has the human-approved reshaped baseline implementation: a direct-CDP screenshot plus structured candidate JSON path gated to vision-capable models and explicit fallback triggers. The required live default/free-tier model comparison remains separate and did not run because no provider credentials were present and the bundled free-tier endpoint was unreachable.
- T8 appears implemented and covered by integration tests, but no original human go/no-go evidence was found between SPIKE-T8 and the implementation commit. Under the recorded `require-original-proof` decision, T8 gate credit remains withheld.

This audit is a current-state checkpoint, not a completion claim.

## Evidence Map

### Automated Evidence Anchors

These anchors identify the current source and test coverage used to justify the audit. They are not a substitute for the goal's final completion audit, especially for extension e2e coverage, live external proof, and manual go/no-go decisions.

- F1 CdpSession: \`src/tools/helpers/cdp-session.ts\`, \`src/bridge/electron/cdp-client.ts\`, \`tests/unit/tools/cdp-session.test.ts\`, and \`tests/unit/bridge/electron-cdp-session.test.ts\`.
- F2 SessionRegistry and focus isolation: \`src/bridge/session-registry.ts\`, \`tests/unit/bridge/session-registry.test.ts\`, and bridge integration coverage in \`tests/integration/bridge/server.test.ts\`.
- F3 snapshot contract: \`src/tools/helpers/snapshot-page-script.ts\`, \`src/tools/page-snapshot.ts\`, \`src/tools/helpers/snapshot-filter.ts\`, \`tests/unit/tools/page-snapshot.test.ts\`, and \`tests/unit/messages/message-transformer.test.ts\`.
- F4 AgentRuntimeFactory: \`src/agent/runtime.ts\`, \`tests/unit/agent/runtime.test.ts\`, and \`tests/unit/sidepanel-agent-wiring.test.ts\`.
- F5 provider catalog and credential resolution: \`src/providers/catalog.ts\`, \`src/sidepanel/model-resolution.ts\`, and provider/model-resolution unit coverage.
- T1/T2/T3 observation, refs, and filtering: \`src/messages/message-transformer.ts\`, \`src/tools/helpers/ref-registry.ts\`, \`src/tools/helpers/snapshot-filter.ts\`, and their unit/integration tests.
- T5 zero-friction model path: \`src/dialogs/WelcomeSetupDialog.ts\`, \`src/providers/free-tier.ts\`, \`src/sidepanel/model-resolution.ts\`, and model-resolution tests.
- T8/T4/T6/T10 Tier B bridge surface: \`src/bridge/server.ts\`, \`src/bridge/command-catalog.ts\`, \`src/bridge/mcp/\`, \`src/bridge/cookie-import.ts\`, \`tests/integration/bridge/server.test.ts\`, and \`tests/unit/guardrails/frontier-guardrails.test.ts\`.
- Eval harness and T7 planner-validator: \`benchmarks/agent-eval/\`, \`tests/unit/benchmarks/agent-eval.test.ts\`, \`src/agent/planner-validator.ts\`, and \`tests/unit/agent/planner-validator.test.ts\`.
- T9 cross-session memory: \`src/storage/stores/memory-store.ts\`, \`src/agent/skill-memory.ts\`, \`tests/unit/storage/memory-store.test.ts\`, and \`tests/unit/agent/skill-memory.test.ts\`.
- T11 direct-CDP headless runtime: `src/bridge/headless/direct-cdp-runtime.ts` and `tests/integration/bridge/headless-direct-cdp-runtime.test.ts`.
- T12 direct-CDP trusted input: `src/bridge/headless/trusted-input-provider.ts`, the `DirectCdpAgentSessionAdapter` ref-click path, and `tests/unit/bridge/trusted-input-provider.test.ts`.
- T13 direct-CDP vision candidate baseline: `src/bridge/headless/direct-cdp-runtime.ts`, `tests/unit/bridge/direct-cdp-vision-baseline.test.ts`, and `tests/integration/bridge/headless-direct-cdp-runtime.test.ts`.
- Guardrails g1/g2/g3/g4: \`tests/unit/guardrails/frontier-guardrails.test.ts\`, \`tests/e2e/extension\`, and the manual no-claims grep target in the guardrail test. This audit records those anchors; it does not claim that extension e2e was rerun as part of this checkpoint unless a separate validation log says so.

### Gated Or Incomplete

- gate-spikes: `goals/agentic-browser-frontier/spikes/t8-concurrent-cdp.md`, `t11-headless.md`, `t12-stealth.md`, and `t13-som.md` exist. The recorded decisions are summarized in `goals/agentic-browser-frontier/gate-decisions.md`.
- T8 process record: user selected `require-original-proof`. A repo, commit-context, `sess`, and direct session-log search did not find original human approval evidence before commit `c2cc2aa`; T8 gate credit remains withheld.
- T11 headless runtime: `spikes/t11-headless.md` proves a no-extension direct-CDP snapshot to locate to click to snapshot loop on a local page. User selected `go-direct-cdp-headless`; implementation is now present in `src/bridge/headless/direct-cdp-runtime.ts` with no-extension integration proof.
- T12 stealth control plane: `spikes/t12-stealth.md` proves the direct-CDP action hot path can avoid `Runtime.enable` on a local page. User selected `go-direct-cdp-only`; implementation is now present in `src/bridge/headless/trusted-input-provider.ts` with unit proof.
- T13 selective vision: `spikes/t13-som.md` does not satisfy the planned model comparison. User selected `approve-structured-candidate-baseline`; reshaped screenshot plus structured candidate JSON implementation is now present, and model proof remains separate.

## Commands Run For This Audit

- \`git status --short --branch\`
- \`rg -n "cdpsession|CdpSession|SessionRegistry|stableElementId|snapshot_store|snapshot_read|mcp|cookie_import|planner|validator|MemoryStore|headless|Runtime.enable|vision|undetectable|bypass.*detection" src tests benchmarks goals/agentic-browser-frontier README.md site -g '*.ts' -g '*.md' -g '*.json' -g '*.tsx' -g '*.js'\`
- \`sed\` review of \`goal.md\`, \`facts.md\`, \`facts.meta.json\`, \`plan.md\`, the Tier-D spike reports, guardrail tests, and eval-harness tests.
- `npm run test:integration -- headless-direct-cdp-runtime`
- `npx vitest run tests/unit/bridge/trusted-input-provider.test.ts tests/integration/bridge/headless-direct-cdp-runtime.test.ts`
- `npx vitest run tests/unit/bridge/direct-cdp-vision-baseline.test.ts tests/unit/bridge/trusted-input-provider.test.ts tests/integration/bridge/headless-direct-cdp-runtime.test.ts`
- `npm run build:cli`
- `./check.sh`

## Remaining Work

1. Recover original T8 human approval evidence or change the T8 decision; until then, T8 must not count toward completion.
2. Keep T13 numbered badges and model-proof claims out until live model evidence exists.

Until T8 proof is recovered or re-decided, the active goal should remain open.
