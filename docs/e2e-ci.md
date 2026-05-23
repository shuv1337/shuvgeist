# Deterministic E2E CI

Shuvgeist can run local browser checks from the CLI using the installed extension and a real Chrome/Edge target. Use this guide for hermetic app fixtures and authenticated browser flows where plain HTTP checks are not enough.

## Readiness Checklist

Before relying on a machine for CI, verify the extension can launch and register:

```bash
npm run build
npm run build:cli
shuvgeist launch --url about:blank --headless --json
shuvgeist status --json
```

`status --json` must show a connected extension target. If it does not, assertion commands will return the no-extension-target exit code `2`.

## Assertions

Use `shuvgeist assert ...` for pass/fail page checks:

```bash
shuvgeist assert text "Welcome" --timeout 10s --json
shuvgeist assert selector "button[type=submit]" --visible --enabled --json
shuvgeist assert role button --name "Continue" --visible --json
shuvgeist assert label "Email" --visible --json
shuvgeist assert url --url-pattern "/dashboard" --json
shuvgeist assert expr 'document.title.includes("Dashboard")' --json
```

Assertions auto-wait until they pass or time out. Assertion failures return structured JSON with `ok: false` and CLI exit code `1`; bridge/auth/config failures remain bridge errors.

Expression assertions run in user-script world by default. Use MAIN-world only for app state that is not visible to the DOM/user-script context:

```bash
shuvgeist assert expr 'window.__APP_STATE__.ready === true' --world main --json
```

MAIN-world assertions use the sensitive `eval` path and require sensitive browser access in Bridge settings.

## Workflow Target Pinning

Use workflow target modes to avoid active-tab drift:

```json
{
  "name": "local smoke",
  "target": { "mode": "new-tab" },
  "steps": [
    { "method": "navigate", "params": { "url": "http://localhost:3000" } },
    { "assert": { "kind": "text", "text": "Welcome" }, "as": "welcome" },
    { "assert": { "kind": "role", "role": "button", "name": "Continue", "visible": true } }
  ]
}
```

`new-tab` pins the tab after the first `navigate` response returns `tabId`. `pinned-tab` requires an explicit `tabId` and optional `frameId`. Assertion failures halt workflows by default; add `onError: "continue"` to record a failed assertion and keep going.

## Native Semantic Refs

Use semantic refs when selectors are unstable:

```bash
shuvgeist locate label "Email" --json
shuvgeist ref fill <refId> --value "user@example.com"
```

Add `--native` when the page requires trusted debugger-backed input:

```bash
shuvgeist ref click <refId> --native
shuvgeist ref fill <refId> --value "user@example.com" --native
```

Native ref actions never silently fall back to synthetic DOM events. If debugger attach, stale refs, or frame coordinate resolution fails, the command fails.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Assertion or command passed |
| 1 | Assertion failed, or a command/runtime error occurred |
| 2 | No extension target is connected |
| 3 | Auth, registration, invalid method, network, or config error |

## CI Pattern

Keep required fixtures local and deterministic:

```bash
npm run build
npm run build:cli
shuvgeist launch --url http://127.0.0.1:3000 --headless --json
shuvgeist assert text "Welcome" --timeout 10s --json
shuvgeist assert role button --name "Continue" --visible --json
shuvgeist workflow run --file smoke.workflow.json --json
```

Public-site smoke tests are useful manually, but required CI should use local app fixtures so failures are attributable to the app or Shuvgeist rather than the network.
