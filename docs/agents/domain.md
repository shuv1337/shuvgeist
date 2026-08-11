# Domain Docs

This repository uses a single domain context for vocabulary and architectural decisions that cross package boundaries.

## Before exploring

- Read `CONTEXT.md` at the repository root when it exists.
- Read relevant ADRs under `docs/adr/` when that directory exists.
- If either location is absent, proceed silently. Domain-modeling workflows create files lazily when terms or qualifying decisions settle.

## Vocabulary

Use terms as defined in `CONTEXT.md` in issue titles, specifications, tests, and implementation. If a required concept is missing, validate it through domain modeling rather than silently introducing a synonym.

## ADR conflicts

Surface any conflict with an existing ADR explicitly. Do not silently override a recorded architectural decision.
