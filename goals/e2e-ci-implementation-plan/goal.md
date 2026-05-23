# E2E CI Implementation Plan

Implement deterministic Shuvgeist e2e CI support by adding first-class page assertions, workflow assertions, stable workflow target pinning, CI-oriented CLI exit codes, and native trusted ref interactions including iframe/subframe refs while preserving existing REPL `browserjs()` semantics.

Use `facts.md` as the accepted shared understanding of the required behavior. Use `plan.md` as the chunked execution plan for implementation, validation, and risk handling.

Done means every accepted fact in `facts.md` is implemented or explicitly marked blocked with evidence, each chunk in `plan.md` has passed its listed validation, final validation has run with `./check.sh`, `npm run build`, `npm run build:cli`, and Playwright extension e2e has run when the live fixture smoke is stable.
