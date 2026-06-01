# Goal — Agentic Browser Frontier

## Goal

Make Shuvgeist the most capable agentic browser tool across four axes — autonomous task completion, controllability by external agents, multi-session scale, and daily-driver UX + stealth — by shipping all 13 roadmap targets from the frontier research report. Build it foundations-first so every target extends a shared seam instead of rewriting one (minimal backtracking), and gate each architectural big swing behind a spike and an explicit go/no-go.

## Shared understanding

See [`facts.md`](facts.md) — 25 accepted, testable outcomes grouped by phase (Foundations, Tier A–D, Guardrails), with automated-verification flags in [`facts.meta.json`](facts.meta.json). Grounding for the build order and shared abstractions is in [`sequence.md`](sequence.md).

## Execution plan

See [`plan.md`](plan.md) (gated/approved) — the foundations-first, phased, code-grounded steps with per-step verification, the `SPIKE → STOP` gates for the big swings, the GitNexus impact/detect-changes discipline, and the standing guardrail gates.

## Key decisions (from interview)

- Big swings (T8 router, T11 headless, T12 stealth, T13 vision) are **gated**: spike → report → human go/no-go before implementation.
- Reliability is **measured** on a lightweight internal eval harness (n≥8), not eyeballed.
- Zero-friction default model = **guided OAuth-subscription + bundled free-tier**; BYO stays; local Ollama is not the default loop.
- Multitask serves **both** interactive windows and a background fleet (one kind-neutral registry).
- Stealth lives on the **headless/direct-CDP path**; the extension path is explicitly non-stealth.
- Cookie import is **selective + per-site consent**; the default launch profile stays isolated.
- Guardrails hold throughout: sidepanel UX unchanged, bridge surface additive-only, AGPL + local-first preserved, no "undetectable" claims.

## Done condition

- Phase 0 foundations (F1–F5 + micro-foundations) merged with their characterization tests green — behavior provably unchanged.
- Every accepted fact with `automatedVerification: true` is backed by a passing automated check; the two manual facts (spike-gate process, no-stealth-claims) are confirmed by review.
- The four guardrail gates pass on every phase.
- Each Tier-D big swing is either shipped (after its spike + approval) or explicitly deferred/reshaped at its gate with the decision recorded in `spikes/<name>.md`.
- `npm run check` green and `gitnexus_detect_changes()` clean at each phase boundary.
