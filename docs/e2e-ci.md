# Deterministic E2E CI

Shuvgeist can run local browser checks from the CLI using the installed extension and a real Chrome/Edge target. Use this guide for hermetic app fixtures and authenticated browser flows where plain HTTP checks are not enough.

## Readiness Checklist

Before relying on a machine for CI, verify the extension, CLI bundle, bridge, and browser target all agree:

```bash
npm run build
npm run build:cli
shuvgeist launch --url about:blank --headless --user-data-dir "${RUNNER_TEMP:-/tmp}/shuvgeist-profile" --json
shuvgeist status --json
```

`status --json` must show a connected extension target and the extension capabilities must include `page_assert`. If the target is disconnected, assertion commands return exit code `2`. If `assert` reports `Unknown method: page_assert`, the CLI, bridge server, or loaded extension build is stale or mismatched.

Use an explicit `--user-data-dir` in CI so the run owns an isolated browser profile. Local development can omit it; `launch` then uses Shuvgeist's managed persistent profile under `~/.shuvgeist/profile/<browser>`.

The live extension regression suite exercises the deterministic fixture path:

```bash
npm run test:e2e:extension
```

That suite covers CLI assertions, workflow assertion steps, workflow target pinning, and native iframe ref input against local fixtures.

## Assertions

Use `shuvgeist assert ...` for pass/fail page checks instead of embedding assertions in `repl` snippets:

```bash
shuvgeist assert text "Welcome" --timeout 10s --json
shuvgeist assert selector "button[type=submit]" --visible --enabled --json
shuvgeist assert role button --name "Continue" --visible --json
shuvgeist assert label "Email" --visible --json
shuvgeist assert url --url-pattern "/dashboard" --json
shuvgeist assert expr 'document.title.includes("Dashboard")' --json
```

Assertions auto-wait until they pass or time out. Assertion failures return structured JSON with `ok: false` and CLI exit code `1`; bridge/auth/config failures remain bridge errors.

Example result shape:

```json
{
  "ok": true,
  "kind": "text",
  "message": "Text assertion passed",
  "attempts": 1,
  "durationMs": 12,
  "timeoutMs": 10000,
  "tabId": 42,
  "frameId": 0
}
```

A failed assertion has the same shape with `ok: false`, a failure `message`, and optional `actual` or `expected` fields.

## Assertion Reference

| Assertion | Required input | Common flags |
|-----------|----------------|--------------|
| `assert expr <js>` | JavaScript expression returning truthy/falsy | `--world user|main`, `--timeout`, `--interval`, `--tab-id`, `--frame-id`, `--json` |
| `assert text <text>` | Visible or document text | `--exact`, `--count`, `--min-count`, `--max-count`, `--timeout`, `--json` |
| `assert selector <css>` | CSS selector | `--visible`, `--enabled`, `--count`, `--min-count`, `--max-count`, `--timeout`, `--json` |
| `assert role <role>` | ARIA role | `--name`, `--visible`, `--enabled`, `--count`, `--timeout`, `--json` |
| `assert label <label>` | Form label text | `--visible`, `--enabled`, `--count`, `--timeout`, `--json` |
| `assert url <url>` | Exact or partial URL | `--exact`, `--url-pattern`, `--timeout`, `--json` |

Expression assertions run in user-script world by default. Use MAIN-world only for app state that is not visible to the DOM/user-script context:

```bash
shuvgeist assert expr 'window.__APP_STATE__.ready === true' --world main --json
```

MAIN-world assertions use the sensitive `eval` path and require sensitive browser access in Bridge settings.

## Workflow Assertions

Use workflow assertion steps when one bounded bridge request should own a multi-step test:

```json
{
  "name": "local smoke",
  "target": { "mode": "new-tab" },
  "steps": [
    { "method": "navigate", "params": { "url": "http://127.0.0.1:3000" } },
    { "assert": { "kind": "text", "text": "Welcome" }, "as": "welcome" },
    {
      "assert": {
        "kind": "role",
        "role": "button",
        "name": "Continue",
        "visible": true
      }
    }
  ]
}
```

Run it with:

```bash
shuvgeist workflow validate --file smoke.workflow.json
shuvgeist workflow run --file smoke.workflow.json --json
```

Assertion steps delegate to the same `page_assert` bridge method as the CLI `assert` command. They halt the workflow by default on failure. Add `onError: "continue"` when the workflow should record the failed assertion and keep going:

```json
{ "assert": { "kind": "text", "text": "Optional banner" }, "onError": "continue" }
```

## Target Pinning

Use workflow target modes to avoid active-tab drift:

| Mode | Use case |
|------|----------|
| `active` | Manual runs against the currently active tab |
| `new-tab` | CI runs that should create and pin their own tab |
| `pinned-tab` | Authenticated/manual setup where the workflow should use a known `tabId` and optional `frameId` |

`new-tab` pins the tab after the first `navigate` response returns `tabId`. `pinned-tab` requires an explicit `tabId` and can include `frameId`. CI workflows should usually use `"target": { "mode": "new-tab" }`.

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

Frame-aware flows should discover frames first and pass `--frame-id` consistently:

```bash
shuvgeist frame tree --json
shuvgeist locate role button --name "Pay" --frame-id 7 --json
shuvgeist ref click <refId> --frame-id 7 --native --json
```

Native ref actions never silently fall back to synthetic DOM events. If debugger attach, stale refs, or frame coordinate resolution fails, the command fails.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Assertion or command passed |
| 1 | Assertion failed, or a command/runtime error occurred |
| 2 | No extension target is connected |
| 3 | Auth, registration, invalid method, network, or config error |

Shell pattern:

```bash
if ! shuvgeist assert text "Welcome" --timeout 10s --json; then
  shuvgeist screenshot --out artifacts/failure.png || true
  exit 1
fi
```

## CI Pattern

Keep required fixtures local and deterministic:

```bash
npm run build
npm run build:cli
npm run test:e2e:extension

shuvgeist launch --url http://127.0.0.1:3000 --headless --user-data-dir "${RUNNER_TEMP:-/tmp}/shuvgeist-profile" --json
shuvgeist status --json
shuvgeist assert text "Welcome" --timeout 10s --json
shuvgeist assert role button --name "Continue" --visible --json
shuvgeist workflow run --file smoke.workflow.json --json
```

Public-site smoke tests are useful manually, but required CI should use local app fixtures so failures are attributable to the app or Shuvgeist rather than the network.
