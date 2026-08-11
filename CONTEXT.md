# Domain Glossary

## Automation run

A resumable unit of browser automation that owns at most one claimed tab group. Its identity is independent of any chat session, client connection, or Chrome window.

## Claimed tab group

A Chrome tab group exclusively assigned to one automation run. Implicit browser actions by that run are confined to tabs in this group, and other runs cannot use the group while the claim is active.

## Unowned browser state

Any tab or tab group without an active Shuvgeist claim. Automation runs do not observe or mutate unowned browser state implicitly.
