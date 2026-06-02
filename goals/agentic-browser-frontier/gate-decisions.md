# Frontier Gate Decisions

Date: 2026-06-01

This records the human gate choices made after reviewing
`verification-audit.md` and `decisions-frontier-gates.html`.

## Recorded Decisions

- T8 Process Record: `require-original-proof` - do not count the T8
  gate until prior human approval evidence is found.
- T11 Headless Runtime: `go-direct-cdp-headless` - implement the
  direct-CDP headless adapter and full agent loop.
- T12 Stealth Control Plane: `go-direct-cdp-only` - implement
  `TrustedInputProvider` over `CdpSession`; do not call
  `Runtime.enable` on the action path.
- T13 Vision Path: `approve-structured-candidate-baseline` - implement
  screenshot plus candidate JSON fallback first; do not add numbered badges
  initially; model proof remains separate.
- Implementation Sequencing: `t8-t11-t12-t13` - record the T8 process
  first, implement headless before stealth, and resolve vision last.

## T8 Approval Search

The selected T8 decision requires original approval proof. A process
exception is not sufficient and must not be counted as original gate proof.

Searches performed:

- Reviewed `goals/agentic-browser-frontier/spikes/t8-concurrent-cdp.md`
  and the current verification audit.
- Reviewed `git log` and `git show` for the T8 implementation commit
  `c2cc2aa feat: add free tier setup and multi-window bridge routing`.
- Searched the repo for T8 approval phrases and gate records.
- Ran `sess search "approve T8" --workspace /home/shuv/repos/shuvgeist
  --agent codex --since 2026-05-31 --ranking relevance --limit 20 --json
  --no-refresh`; it returned zero hits.
- Searched Codex and Claude session logs for exact T8 approval phrases,
  including `approve T8`, `approved T8`, `proceed with T8`,
  `SPIKE-T8`, and `Stop here until the user approves T8`.

Result:

- No original human approval evidence was found before commit `c2cc2aa`.
- T8 implementation and automated-test evidence remain present in the repo.
- Under the selected decision, T8 gate credit is withheld and T8 must not
  count toward goal completion until original proof is recovered or the human
  decision is changed.

## Current Gate State

| Gate | Decision | Current state |
| --- | --- | --- |
| T8 | `require-original-proof` | Implemented, but gate credit withheld because original approval proof was not found. |
| T11 | `go-direct-cdp-headless` | Implemented in `src/bridge/headless/direct-cdp-runtime.ts` with integration proof in `tests/integration/bridge/headless-direct-cdp-runtime.test.ts`. |
| T12 | `go-direct-cdp-only` | Implemented in `src/bridge/headless/trusted-input-provider.ts` and wired into the direct-CDP headless ref-click path. |
| T13 | `approve-structured-candidate-baseline` | Implemented in `src/bridge/headless/direct-cdp-runtime.ts` as screenshot plus structured candidate JSON for vision-capable models; live model proof remains separate. |

The active goal remains incomplete while T8 proof is missing. T13 live model
comparison proof remains explicitly separate from the implemented baseline.
