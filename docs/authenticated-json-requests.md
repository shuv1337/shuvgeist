# Authenticated origin JSON requests

`authenticated_json_request` performs one bounded `window.fetch` inside the
selected live page. It uses that page's existing same-origin browser session
without exposing cookies or authorization material to the CLI, bridge, MCP
task store, operation journal, screenshots, or recording artifacts.

```bash
shuvgeist request-json /api/me
shuvgeist request-json /api/items \
  --method POST \
  --body '{"name":"example"}' \
  --review-mutation
```

The command accepts relative paths only. Absolute URLs, protocol-relative
paths, embedded credentials, non-HTTP(S) pages, cross-origin resolution,
redirects, non-JSON responses, invalid UTF-8 JSON, and responses above the
declared byte limit fail closed. Fetch uses `credentials: "same-origin"`,
`cache: "no-store"`, and `redirect: "manual"`.

GET is the only non-mutating method. POST, PUT, PATCH, and DELETE require
`reviewMutation: true` or `--review-mutation`; Shuvgeist performs the request
once and never retries it. The default timeout is 15 seconds and the default
response limit is 256,000 bytes. Bounds are 100-60,000 milliseconds and
1-1,048,576 bytes. Request bodies are capped at 256,000 UTF-8 bytes.

An optional JSON schema subset supports `type`, `enum`, object `required` and
`properties`, and array `items`. Validation stops after 10 issues, 100 schema
nodes, or eight levels. Issues identify paths and expected types without
including response values.

Successful and fail-closed results are marked `sensitive: true` and
`noStore: true`. The direct caller receives the JSON value, while MCP task
history stores only the no-store marker. The operation journal records method,
target, timing, and outcome but never the path, body, schema, or response.

## Capability gates

Chrome advertises the dedicated `authenticated_json_request` capability only
when sensitive browser data access is enabled for the extension bridge.

Electron requires both an allowlisted application and an explicit per-app
capability:

```json
{
  "electron": {
    "capabilities": {
      "com.microsoft.VSCode": {
        "authenticated_json_request": true
      }
    }
  }
}
```

Electron top-level renderer pages use the same injected runtime, origin checks,
timeout, byte limit, schema validator, and no-store result contract as Chrome.
Closing the requesting bridge connection aborts an in-flight Electron request.
