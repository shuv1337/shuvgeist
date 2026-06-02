# SPIKE-T12 - Direct-CDP Input-Only Control Plane

Date: 2026-06-01

## Question

Can the headless/direct-CDP path perform trusted input with pre-stored coordinates while keeping Runtime.enable off the action hot path, and what does that imply for the extension path?

## Method

Used the current repo code with a disposable no-extension headless Chromium target:

1. Launch /usr/bin/chromium with --headless=new, --remote-debugging-port=0, --user-data-dir=<tmp>, and no --load-extension.
2. Open a data: test page with a fixed-position button at known coordinates.
3. Connect to the page websocket through a recording CDP transport wrapped by ElectronWsCdpSession.
4. Enable Page only before action.
5. Use pre-stored coordinates x=120, y=72 for the button center.
6. Call ensureDomain("Runtime", { suppressRuntimeEnable: true }) immediately before action to verify the session honors the suppression flag.
7. Dispatch mouseMoved, mousePressed, and mouseReleased through Input.dispatchMouseEvent.
8. Only after the action, enable Runtime and evaluate page state for verification.

## Result

The spike passed:

    {
      "ok": true,
      "extensionLoaded": false,
      "headless": true,
      "targetId": "94DFFBA3A97082A021E8B71F8BE41878",
      "preStoredCoords": {
        "x": 120,
        "y": 72
      },
      "methodsBeforeAction": [
        "Page.enable"
      ],
      "actionMethods": [
        "Input.dispatchMouseEvent",
        "Input.dispatchMouseEvent",
        "Input.dispatchMouseEvent"
      ],
      "runtimeEnableOnActionPath": false,
      "suppressRuntimeEnableHonored": true,
      "postActionVerificationMethods": [
        "Runtime.enable",
        "Runtime.evaluate"
      ],
      "pageState": {
        "clicked": 1,
        "events": [
          {
            "type": "click",
            "isTrusted": true,
            "x": 120,
            "y": 72
          }
        ],
        "status": "clicked 1 trusted=true"
      },
      "infobarVisible": false,
      "infobarEvidence": "headless Chromium has no browser UI surface; extension chrome.debugger infobar remains unmeasured on headed extension path"
    }

## Findings

- ElectronWsCdpSession honors suppressRuntimeEnable for Runtime.
- The measured action hot path sent only Input.dispatchMouseEvent commands.
- The page received a trusted click event at the pre-stored coordinates.
- Runtime.enable was only used after the action for verification.
- No extension was loaded, so there was no chrome.debugger extension infobar in this path.
- The extension path remains explicitly non-stealth; this spike does not prove headed chrome.debugger infobar avoidability.

## Caveats

- The test page is local and simple; it measures protocol shape and trusted-input semantics, not broad anti-automation behavior.
- Coordinate discovery was simulated by fixed pre-stored coordinates. T12 implementation should consume bounding boxes from the snapshot/ref contract and avoid getBoundingClientRect during the action itself.
- Post-action verification used Runtime.enable. That was outside the measured hot path and should not be part of a stealth action path.
- Headless no-UI behavior is not evidence that the headed extension path can avoid debugger UI disclosure.

## Recommendation

Proceed with T12 on the headless/direct-CDP path only:

- Implement a TrustedInputProvider over CdpSession.
- Keep Runtime.enable suppressed on the action path.
- Feed it pre-resolved coordinates from PageSnapshotEntry.boundingBox / RefRegistry metadata.
- Document the extension/chrome.debugger path as non-stealth and avoid any undetectable or bypass-all-detection claims.

No reshape is needed beyond the already accepted direction that stealth belongs to headless/direct-CDP, not the extension path.

## Gate Status

SPIKE-T12 evidence supports proceeding on the headless/direct-CDP path, but the plan requires a human go/no-go before T12 implementation. Stop here until the user approves T12.
