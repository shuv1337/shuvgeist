# Human handoff

`handoff_start` pauses automation so a person can complete a CAPTCHA, passkey, payment prompt, or ordinary manual page step. It is available as:

- `shuvgeist handoff <task-id> <session-id>`
- the `shuvgeist_handoff` MCP tool
- the extension agent's `human_handoff` tool

Each handoff gets an opaque ID and is bound to one task ID, session ID, browser window, Chrome tab, frame, and `PageDriver` navigation generation. The in-page overlay first emits `acknowledged`; an optional semantic-ref trigger runs only after that acknowledgement. The overlay then emits either `completed` or `cancelled`. The coordinator accepts a completion only once and only when every bound identity field and the Chrome message sender match.

The lifecycle is `started -> acknowledged -> completed`, with `cancelled` and `timed_out` terminal alternatives. A completion before acknowledgement, a duplicate transition, a stale ID, a different sender, or a changed navigation generation fails closed.

Cancellation and lifecycle behavior:

- Request abort, bridge disconnect, target-window teardown, timeout, or navigation-generation change removes the active binding before resolving the operation.
- Overlay cleanup is best effort after revocation. Any late message sees an unknown/stale ID and cannot resume or trigger automation.
- A service-worker restart loses the in-memory binding deterministically. A surviving overlay removes itself when the restarted worker rejects its event.
- The optional trigger uses the existing semantic-ref and trusted-input authorization path. It does not introduce selector or raw-evaluate bypasses.

`handoff_lifecycle` bridge telemetry contains only the opaque IDs, handoff kind, exact target, navigation generation, state, and timestamp. The user-facing overlay message and any entered page credentials are excluded.
