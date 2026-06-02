# SPIKE-T8 - Concurrent Chrome Debugger Sessions

Date: 2026-06-01

## Question

Can Shuvgeist attach `chrome.debugger` to two tabs in two browser windows and drive interleaved `Input.*` plus `Runtime.evaluate` commands without target cross-contention or focus-change teardown?

## Method

Used the existing Playwright extension harness shape against the current `dist-chrome` build in a disposable Chromium profile:

1. Launch Chromium with the unpacked Shuvgeist extension.
2. Evaluate a spike script inside the extension service worker.
3. Create two browser windows, each with one `data:` page containing an independent button and click counter.
4. Attach `chrome.debugger` to both tab IDs using protocol version `1.3`.
5. Interleave commands across both targets:
   - `Runtime.enable`
   - `Runtime.evaluate` to confirm each page identity
   - `Input.dispatchMouseEvent` `mouseMoved` / `mousePressed` / `mouseReleased` on both tabs
6. Flip focus between window 1, window 2, and window 1.
7. Run `Runtime.evaluate` on both targets after focus changes to confirm state and attachment health.

## Result

The spike passed in headless Chromium:

```json
{
  "ok": true,
  "elapsedMs": 554,
  "tabs": [1748302, 1748304],
  "after": [
    { "clicked": "1", "name": "one", "visibility": "visible" },
    { "clicked": "1", "name": "two", "visibility": "visible" }
  ],
  "cleanup": [null, null]
}
```

Observed command ordering showed actual interleaving:

```text
start 1748302 Runtime.enable
start 1748304 Runtime.enable
done 1748302 Runtime.enable
done 1748304 Runtime.enable
start 1748302 Runtime.evaluate
start 1748304 Runtime.evaluate
done 1748302 Runtime.evaluate -> one
done 1748304 Runtime.evaluate -> two
start 1748302 Input.dispatchMouseEvent
start 1748304 Input.dispatchMouseEvent
...
start windows.update
done windows.update { window 1 }
start windows.update
done windows.update { window 2 }
start windows.update
done windows.update { window 1 }
start 1748302 Runtime.evaluate
start 1748304 Runtime.evaluate
done both with independent clicked/name state
```

## Findings

- Chrome allows simultaneous `chrome.debugger.attach` on two extension-owned tab targets in separate windows.
- Interleaved `Runtime.evaluate` calls returned the correct per-tab page identity.
- Interleaved `Input.dispatchMouseEvent` calls clicked the intended button in each tab exactly once.
- Focus changes across the two windows did not detach either debugger session; both targets remained responsive afterward.
- No command returned a protocol or `chrome.runtime.lastError` failure in the spike.

## Caveats

- This was run in headless Chromium through Playwright. It proves target-level concurrency and focus-change survival, but it cannot visually assess debugger infobar behavior.
- The spike used direct service-worker `chrome.debugger` calls, not the current bridge request path. The result validates the browser capability needed by T8; the implementation still needs per-target routing and per-target write locks in the bridge.
- The test pages were simple `data:` documents. More complex pages may introduce timing issues, but no fundamental one-debugger-session-only limitation appeared.

## Recommendation

Go for T8 implementation with the planned shape:

- `SessionRegistry` should become a real map of target handles.
- `PerHandleWriteLock` should stay per target, not global.
- Requests should route by explicit target/session identity.
- Keep one writer per target.

No reshape is needed based on this spike. The infobar concern should remain a T12/headless-path question because this spike was headless and cannot prove user-visible debugger UI behavior.

## Gate Status

SPIKE-T8 evidence supports proceeding, but the plan requires a human go/no-go before T8 implementation. Stop here until the user approves T8.

## Gate Decision - 2026-06-01

Human decision: `require-original-proof` - do not count the T8 gate until prior human approval evidence is found.

Search result: no original human approval evidence was found in the repo,
the T8 implementation commit context, or local Codex/Claude session logs. The
implementation and automated-test evidence remain valid technical evidence,
but they are not process proof under this decision.

Current status: T8 gate credit is withheld. T8 must not count toward the
frontier goal completion audit until original approval proof is recovered or
the human decision is changed.
