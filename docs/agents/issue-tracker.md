# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues. Use the `gh` CLI for all operations.

## Conventions

- Create an issue with `gh issue create --title "..." --body "..."`.
- Read an issue and its discussion with `gh issue view <number> --comments`.
- List issues with `gh issue list --state open --json number,title,body,labels,comments` and appropriate label filters.
- Comment with `gh issue comment <number> --body "..."`.
- Apply or remove labels with `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close with `gh issue close <number> --comment "..."`.

Infer the repository from the current clone. Pull requests are not a triage request surface.

## Skill operations

When a skill says to publish to the issue tracker, create a GitHub issue. When it says to fetch a ticket, read the issue and its comments.

## Wayfinding operations

The Wayfinder map is one issue labelled `wayfinder:map`; its tickets are native GitHub sub-issues.

- Create each child issue before attaching it through `POST repos/<owner>/<repo>/issues/<map>/sub_issues` with the child's numeric database ID as `sub_issue_id`.
- Label tickets `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- Represent blocking with native issue dependencies through `POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by`, passing the blocker's numeric database ID as `issue_id`.
- The frontier is the map's open, unassigned children whose `issue_dependencies_summary.blocked_by` count is zero, in map order.
- Claim a frontier ticket before work with `gh issue edit <number> --add-assignee @me`.
- Resolve a ticket by posting its answer as a comment, closing it, and appending a concise link and gist to the map's Decisions-so-far section.

Refer to maps and tickets by linked title in human-facing prose, not by bare issue number.
