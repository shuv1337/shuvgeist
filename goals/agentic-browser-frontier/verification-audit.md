# Agentic Browser Frontier Verification Audit

Date: 2026-06-01

## Summary

The goal is not complete. The implemented foundations through Tier C have source and automated-test evidence, but the Tier D gate state is still open:

- T11 and T12 have spike reports that recommend proceeding, but both explicitly stop for human go/no-go before implementation.
- T13 has only local payload evidence. The required live default/free-tier model comparison did not run because no provider credentials were present and the bundled free-tier endpoint was unreachable.
- T8 appears implemented and covered by integration tests, but the repo artifact does not record the required human go/no-go between SPIKE-T8 and the implementation commit.

This audit is a current-state checkpoint, not a completion claim.

## Evidence Map

### Proven By Automated Checks

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
- Guardrails g1/g2/g3/g4: \`tests/unit/guardrails/frontier-guardrails.test.ts\`, \`tests/e2e/extension\`, and the manual no-claims grep target in the guardrail test.

### Gated Or Incomplete

- gate-spikes: \`goals/agentic-browser-frontier/spikes/t8-concurrent-cdp.md\`, \`t11-headless.md\`, \`t12-stealth.md\`, and \`t13-som.md\` exist. T11, T12, and T13 explicitly stop for human decision. T8's spike recommends proceeding and T8 is implemented, but the repo does not contain an explicit go/no-go record.
- T11 headless runtime: \`spikes/t11-headless.md\` proves a no-extension direct-CDP snapshot to locate to click to snapshot loop on a local page, but it also says the full AgentRuntimeFactory implementation is not done and requires approval first.
- T12 stealth control plane: \`spikes/t12-stealth.md\` proves the direct-CDP action hot path can avoid \`Runtime.enable\` on a local page, but it also says the TrustedInputProvider implementation is not done and requires approval first.
- T13 selective vision: \`spikes/t13-som.md\` does not satisfy the planned model comparison. It recommends reshaping to screenshot plus structured candidate JSON and waiting for a decision.

## Commands Run For This Audit

- \`git status --short --branch\`
- \`rg -n "cdpsession|CdpSession|SessionRegistry|stableElementId|snapshot_store|snapshot_read|mcp|cookie_import|planner|validator|MemoryStore|headless|Runtime.enable|vision|undetectable|bypass.*detection" src tests benchmarks goals/agentic-browser-frontier README.md site -g '*.ts' -g '*.md' -g '*.json' -g '*.tsx' -g '*.js'\`
- \`sed\` review of \`goal.md\`, \`facts.md\`, \`facts.meta.json\`, \`plan.md\`, the Tier-D spike reports, guardrail tests, and eval-harness tests.

## Next Decisions Needed

1. Record whether SPIKE-T8 had human approval after the spike and before implementation, or add a retroactive exception note if that process gap is accepted.
2. Decide T11 go/no-go for headless runtime implementation.
3. Decide T12 go/no-go for direct-CDP TrustedInputProvider implementation.
4. Decide T13 path: rerun with reachable model credentials, approve the reshaped structured-candidate vision baseline, or defer T13 explicitly.

Until those decisions are recorded and the selected implementations or deferrals are complete, the active goal should remain open.
