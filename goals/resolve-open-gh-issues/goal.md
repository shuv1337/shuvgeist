# Resolve Open Shuvgeist GitHub Issues

Systematically resolve the open GitHub issue queue for shuvgeist by working in small dependency-ordered vertical batches, starting with deterministic e2e and Web Agent benchmark work, then architecture-deepening work, then the Electron stack. Blocked and human-decision issues should be actively unblocked by resolving prerequisites or recording explicit decision comments instead of being silently skipped.

Use `goals/resolve-open-gh-issues/facts.md` as the shared understanding of scope, sequencing, blocker policy, and validation expectations.

Use `goals/resolve-open-gh-issues/plan.md` as the execution plan.

Done when every agent-completable open issue is closed with validation evidence, any remaining open issue is explicitly labeled and documented as human-decision/question/wontfix/external-blocked, the final repo state is clean and pushed, and the final report lists closed issues, remaining non-agent issues, validation evidence, and commit range.
