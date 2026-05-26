# Facts

- The goal covers every open shuvgeist GitHub issue that can be completed by an agent, including ready-for-agent implementation issues, documentation and validation issues, architecture-deepening issues, and the Web Agent benchmark follow-up issue.
- The goal treats ready-for-human or question-labeled issues as explicit decision points that must be escalated with the smallest needed question instead of being silently implemented or skipped.
- Blocked issues are not skipped by default; the plan should first try to unblock them by resolving their prerequisite issues or clarifying their blocker state.
- Work is batched as small dependency-ordered vertical PR batches, with one coherent issue slice or tightly coupled issue cluster per batch.
- The priority order starts with deterministic e2e and Web Agent benchmark work, then architecture-deepening work that reduces future friction, then Electron stack work in dependency order.
- Each implementation batch must run GitNexus impact analysis before editing symbols, and HIGH or CRITICAL impact results must be reported before proceeding.
- Each implementation batch must run targeted tests during development and the required full checks and builds before commit.
- Behavior-changing batches must update the relevant documentation, CLI help, skill docs, site copy, and changelog entries in the same batch when those surfaces are affected.
- An issue is closed only after its acceptance criteria are satisfied, validation evidence is recorded, the change is committed and pushed, and any dependent issue labels or blockers are updated.
- The final goal output is a reusable /goal package under goals/resolve-open-gh-issues/ with facts.md, plan.md, and goal.md.
