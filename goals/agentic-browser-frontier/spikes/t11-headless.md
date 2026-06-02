# SPIKE-T11 - Headless Direct-CDP Runtime

Date: 2026-06-01

## Question

Can Shuvgeist run a no-extension, headless Chromium target through the shared CDP session and snapshot foundations, completing a snapshot to locate to click to snapshot loop while preserving target/session identity across a fresh CDP reconnect?

## Method

Used the current repo code with a disposable Chromium profile:

1. Launch /usr/bin/chromium with --headless=new, --remote-debugging-port=0, --user-data-dir=<tmp>, and no --load-extension.
2. Open a data: test page containing a heading, status text, and a button labeled Run headless action.
3. Discover the page target through /json/list.
4. Connect to the page websocket with the existing ElectronWsCdpSession.
5. Enable Page and Runtime.
6. Evaluate the canonical SNAPSHOT_PAGE_SCRIPT from src/tools/page-snapshot.ts.
7. Locate the button from the semantic snapshot entries.
8. Click the button through Input.dispatchMouseEvent using the entry bounding box center.
9. Close the CDP session, rediscover the same page target, create a fresh ElectronWsCdpSession, and snapshot again.

The fresh reconnect stands in for the bridge/runtime restart property this spike needs: the browser target stays alive, the page websocket remains discoverable, and the same target id plus generated stable element id are visible after the client-side CDP session is recreated.

## Result

The spike passed:

    {
      "ok": true,
      "chromiumPid": 3647874,
      "remoteDebuggingPort": 43757,
      "targetIdBefore": "E8CCA006B9A516C14D7C6370641DA0D1",
      "targetIdAfterReconnect": "E8CCA006B9A516C14D7C6370641DA0D1",
      "extensionLoaded": false,
      "before": {
        "title": "T11 Headless Spike",
        "urlScheme": "data:",
        "entries": 3,
        "buttonSnapshotId": "e3",
        "buttonStableElementId": "sg-button-target-run-headless-action-3",
        "buttonBoundingBox": {
          "x": 8,
          "y": 113.875,
          "width": 79.71875,
          "height": 21
        }
      },
      "click": {
        "x": 48,
        "y": 124,
        "state": {
          "clicked": 1,
          "status": "clicked 1"
        }
      },
      "afterReconnect": {
        "entries": 3,
        "buttonSnapshotId": "e3",
        "buttonStableElementId": "sg-button-target-run-headless-action-3",
        "state": {
          "clicked": 1,
          "status": "clicked 1"
        }
      }
    }

## Findings

- Headless Chromium can be launched without the extension and controlled through a page-level DevTools websocket.
- The existing ElectronWsCdpSession works for this page websocket path.
- The canonical snapshot script produces semantic entries in the no-extension runtime.
- A snapshot-derived bounding box can drive a trusted CDP input click.
- Recreating the CDP session after the click preserves page target id, page state, and generated stableElementId.
- No hidden chrome.* dependency was encountered in the snapshot to locate to click to snapshot loop used by this spike.

## Caveats

- This spike used a simple local data: page. It proves the runtime shape, not broad site compatibility.
- It used direct CDP commands and the shared snapshot script, not a full AgentRuntimeFactory loop with model calls.
- The page-side snapshot script needed a local __name shim because the TS runtime string includes a transpiler helper when evaluated outside the bundled extension build. T11 implementation should expose a self-contained snapshot script artifact for direct-CDP runtimes instead of depending on function toString() in the Node runtime.
- The reconnect check recreated the CDP session against the same browser target; it did not restart a production bridge process.

## Recommendation

Proceed with T11 implementation, with one implementation note:

- Add a direct-CDP/headless adapter that owns target discovery and page websocket sessions.
- Reuse ElectronWsCdpSession, AgentRuntimeFactory, and the canonical snapshot contract.
- Make the snapshot script consumable as a self-contained browser expression for direct-CDP execution.
- Keep the extension path separate; this spike supports headless/direct-CDP as its own runtime, not an extension replacement.

No reshape to Electron-app-only automation is needed based on this spike.

## Gate Status

SPIKE-T11 evidence supports proceeding, but the plan requires a human go/no-go before T11 implementation. Stop here until the user approves T11.
