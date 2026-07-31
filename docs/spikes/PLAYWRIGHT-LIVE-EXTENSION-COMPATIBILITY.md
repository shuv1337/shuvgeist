# Stock Playwright over the live extension: compatibility spike

- Date: 2026-07-31
- Issue: #69
- Reference baseline: Browser Control commit `0110939f584362df2cba1f4f167dc5867c7f6e27`
- Decision: NO-GO for production integration now

## Scope and time-box

This spike evaluates whether Shuvgeist should expose a Playwright-compatible
CDP browser view backed by `chrome.debugger`. It does not add Playwright as a
dependency, change extension behavior, replace `PageDriver`, or add commands to
the catalog.

The executable Node prototype is:

```text
packages/server/src/prototypes/playwright-cdp-adapter.ts
```

It models the hard relay semantics independently of the production server:
client-local session/target aliases, root and child announcements, OOPIF event
replay, worker filtering, duplicate reconciliation, navigation generations,
method authorization, timeouts, multi-client isolation, and teardown.

## Workflow selection gate

These workflows were selected before implementing the prototype. Routine
navigation, snapshots, refs, assertions, screenshots, network capture,
recording, and authenticated JSON requests were excluded because Shuvgeist
already has safer first-class commands.

### 1. Run a supplied Playwright reproduction against an authenticated live tab

Example: a customer or developer supplies a short Playwright script that
reproduces an OOPIF form or popup failure, and rewriting it would change the
reproduction.

Success:

- script connects without launching or owning the user's browser
- root page and OOPIF appear once
- locator/evaluate/input calls reach the exact adopted tab
- no command reaches another tab or compatibility client
- navigation does not silently change root identity
- teardown leaves the live tab open and usable

### 2. Reuse a Playwright-only diagnostic library

Example: a package accepts a Playwright `Page` and has no transport-neutral
entry point. Accessibility libraries that only need an evaluate-capable page
are the most plausible case.

Success:

- the library completes on a normal page and an OOPIF fixture
- unsupported browser-context, download, cookie, and service-worker behavior
  fails with explicit errors
- read-only mode cannot evaluate or synthesize input
- evaluate and input require separate sensitive capabilities

### 3. Reproduce target-lifecycle bugs with stock Playwright events

Example: an existing Playwright test depends on page/frame/worker attachment
events and duplicate-free navigation behavior.

Success:

- duplicate root/child announcements produce one client-visible target
- OOPIF frame events replay in attachment order
- dedicated workers are visible; service/shared workers are filtered
- two clients receive isolated aliases and cannot detach or address each
  other's sessions
- timeout/disconnect abort pending commands and discard late results

## What Browser Control demonstrates

Browser Control proves this can work, but its relay has to emulate a browser
endpoint rather than simply forward CDP:

- synthesize `Browser.getVersion`, discovery, target creation, and attachment
- assign isolated client session views
- reconcile duplicate targets and replacement sessions
- store/replay OOPIF frame events around attachment races
- suppress targets that confuse Playwright
- reset Runtime state only after the last client leaves
- recover root targets across extension generations
- guard unsupported downloads and browser-context operations
- maintain behavior around Playwright's private connection assumptions

The implementation is substantial because `chrome.debugger` attaches to tabs,
while Playwright connects as if it owns a browser-level CDP endpoint.

## Prototype result

The prototype passes deterministic tests for:

- OOPIF attachment and ordered frame replay
- dedicated-worker exposure and service/shared-worker filtering
- exact duplicate suppression and target-ID replacement
- root/navigation generation tracking
- client-local target and session aliases
- backend sharing without cross-client teardown
- timeout abort and late-result discard
- immediate disconnect cancellation even when the backend ignores abort
- bearer-authentication admission
- separate compatibility, evaluate, and input capability gates
- explicit denial of browser contexts, target creation/closure, downloads, and
  cookie mutation

Run:

```bash
npx vitest run tests/unit/bridge/playwright-cdp-adapter-prototype.test.ts
```

The prototype is not a claim of stock Playwright compatibility. It deliberately
stops before adding `playwright-core` and before exposing an HTTP/WebSocket CDP
endpoint. Its purpose is to measure the irreducible adapter state and security
surface before accepting that dependency.

## Authentication and authorization

The adapter must be a separate loopback Node endpoint owned by the bridge:

1. HTTP and WebSocket upgrade require the existing bearer token.
2. Origin and Host checks remain fail-closed.
3. A client needs `playwright_compat`.
4. `Runtime.evaluate` and `Runtime.callFunctionOn` additionally need
   `playwright_evaluate`.
5. `Input.*` additionally needs `playwright_input`.
6. Every routed method is matched against an allowlist; unknown methods fail.
7. Target selection occurs before a client view is created and is bound to an
   exact root generation.
8. Client-generated session and target IDs are aliases. Raw Chrome debugger
   session IDs never cross client boundaries.

Bearer authentication alone must never enable Playwright. Electron app
allowlists and per-app capabilities still apply when the selected target is
Electron.

## CDP surface

Handled locally rather than forwarded:

- `Browser.getVersion`
- `Target.getTargets`
- `Target.setDiscoverTargets`
- `Target.setAutoAttach`

Candidate routed read/bootstrap families:

- `Accessibility.*`
- `CSS.*`
- `DOM.*`
- `DOMSnapshot.*`
- `Log.*`
- bounded `Network.*`
- bounded `Page.*`
- selected Runtime enable/release calls

Separately gated:

- `Runtime.evaluate`
- `Runtime.callFunctionOn`
- `Input.*`

Denied in the prototype:

- browser-context creation
- target creation and closure
- browser/page download behavior
- cookie read/write methods
- unknown Browser, Target, Security, Storage, or SystemInfo methods

A production implementation would need a method-by-method parameter and result
review. Prefix allowlists in the prototype are evidence of scope, not an
acceptable final policy.

## Raw evaluate and late mutation

Stock Playwright fundamentally expects Runtime evaluation. Even a nominally
read-only library can send arbitrary expressions, inject scripts, retain remote
objects, install bindings, or trigger application behavior. This is a broader
trust surface than schema-first Shuvgeist commands.

Timeout cannot prove cancellation. Chrome may execute an evaluate or input
command after the Node adapter times out or the client disconnects. Therefore:

- never retry timed-out mutation-capable CDP commands automatically
- report timeout as `outcome_unknown`, not a clean cancellation
- journal only bounded method/target metadata
- revoke client aliases immediately so late results cannot mutate adapter
  state
- require fresh page observation before subsequent writes
- keep evaluate/input behind explicit sensitive capabilities

The prototype aborts the backend signal and discards late results. It cannot
undo a renderer mutation that already occurred. That limitation is a primary
reason for the no-go decision.

## Target semantics

### Aliases and multiple clients

Every compatibility client gets unique target and session aliases. Commands
resolve aliases server-side to one backend session. Disconnecting one client
does not disable shared Runtime state; backend teardown occurs only after the
last viewer leaves.

### Duplicates

An exact duplicate `(targetId, backendSessionId, generation)` is ignored. The
same target ID with a new backend session detaches the old client alias before
announcing the replacement. Process-level suppression of “Duplicate target”
exceptions, as used defensively by Browser Control, should not be the primary
correctness mechanism.

### OOPIFs and workers

Child frame attachment can race stored `Page.frameAttached` and
`Page.frameNavigated` events. The adapter must retain a bounded replay buffer
per child session and replay after `Target.attachedToTarget`.

Dedicated workers may be exposed. Service workers and shared workers are
filtered in the prototype because their lifecycle and browser-context
assumptions extend the privilege and emulation surface. Supporting them would
require a separate decision.

### Generations

Root generation changes replace the target view. Same-root navigation advances
navigation generation without creating a duplicate page. The generation is
adapter metadata, not a nonstandard field injected into Playwright's CDP
events.

## Comparison

| Dimension | Stock Playwright adapter | Existing PageDriver/catalog | Simpler targeted addition |
| --- | --- | --- | --- |
| Main benefit | Runs some existing Playwright code with fewer rewrites | Stable schema-first automation across Chrome/Electron/direct CDP | Adds only the missing workflow primitive |
| Compatibility | Fragile browser-endpoint emulation over tab-scoped debugger | Controlled by Shuvgeist contracts | Controlled and narrow |
| Added routing latency | One Node relay hop plus alias/policy lookup per CDP message | Existing bridge/driver path | Existing path |
| Dominant latency | Browser round trips, Playwright retries, attachment reconciliation | Browser round trips | Browser round trips |
| Multi-client cost | Per-client target/session state and shared-domain teardown | Existing target handle and write locks | Usually none |
| Security | Broad Runtime/Input/raw-CDP surface | Method schemas and per-command capabilities | Narrow new schema/capability |
| Release maintenance | Track Chrome CDP plus Playwright private expectations | Track Chrome CDP and owned contracts | Track one API |
| Failure diagnosis | Three layers: Playwright, emulation relay, chrome.debugger | Shuvgeist command and driver layers | Shuvgeist layers |
| Electron parity | Separate emulation and policy work | Existing PageDriver parity | Can be target-neutral |

The prototype's in-process bookkeeping is trivial compared with browser round
trips; it does not justify a latency concern by itself. The material costs are
event ordering, compatibility churn, security review, and diagnosis.

## Maintenance burden

Production ownership would require:

- a pinned `playwright-core` compatibility matrix
- canary tests for every supported Chrome and Playwright release
- captured bootstrap transcripts to detect new Browser/Target/Runtime methods
- OOPIF, popup, crash, worker, navigation, duplicate, and disconnect fixtures
- re-review whenever Playwright changes CDP connection internals
- separate Chrome extension and Electron behavior
- explicit unsupported behavior for downloads, contexts, service workers, and
  browser-owned features

Browser Control contains several defensive reconciliation paths and even
process-fault handling for duplicate-target failures. That is credible
engineering evidence and also evidence that this is a product-sized subsystem,
not a thin adapter.

## Simpler alternatives

1. Add a first-class PageDriver command for a demonstrated missing workflow.
2. Use `repl`/`browserjs` for bounded page logic with existing target and
   artifact controls.
3. Add a small library-specific adapter that accepts Shuvgeist snapshots or an
   authenticated JSON result instead of a Playwright `Page`.
4. For scripts that truly require stock Playwright, run them against a
   dedicated browser Playwright owns, accepting that it is not the user's live
   authenticated extension tab.
5. Export a deterministic repro fixture/workflow from Shuvgeist rather than
   exposing raw CDP.

## Decision

NO-GO for a production Playwright-over-live-extension endpoint now.

The two plausible benefits—running supplied Playwright repros and reusing
Playwright-only libraries—do not currently outweigh:

- the separate browser-endpoint emulation subsystem
- Runtime evaluate and late-mutation risk
- Chrome/Playwright compatibility maintenance
- weaker schema and target-neutral guarantees
- unclear demand beyond workflows existing commands already cover

Reconsider only when at least three real, recurring scripts cannot reasonably
be expressed through `PageDriver`, `repl`, or a targeted command. At that point,
run a second spike with `playwright-core` as a development-only dependency,
captured bootstrap transcripts, a real Chrome extension fixture, and explicit
success thresholds from the selected scripts. Do not redirect the extension
agent runtime or command catalog during that experiment.
