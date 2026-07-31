# Network secret references

Shuvgeist network capture is safe-export by default. Captured headers and supported
text bodies are transformed before they enter the in-memory request buffer. Raw
credentials are never returned by `network list`, `network get`, `network body`,
or `network curl`.

## Threat model and data flow

- Capture: known credential headers and all cookie values become stable
  `{{shuvgeist-secret:<slot>}}` references. JSON, GraphQL JSON variables, and
  URL-encoded forms use structural field rules, explicit `sensitiveFields`
  annotations, and opaque-token entropy checks.
- Storage: Chrome keeps lossless values only in the extension process memory for
  the active page-driver lifetime. Electron stores them separately in
  `~/.shuvgeist/profiles/network-secrets.json` (or beside a custom bridge config)
  using an atomic replacement, a mode-0700 directory, and a mode-0600 file.
- Rotation: slots derive from origin, direction, structural location, and field
  name rather than the secret value. A rotated credential updates the same slot.
- Display and export: list/get/body/curl output contains references only.
  `--include-sensitive` is retained as a deprecated compatibility flag and never
  restores plaintext.
- Logs and errors: neither lossless values nor bodies are passed to routine
  bridge logs, telemetry, operation journals, error text, or generated commands.
- Subprocesses: generated curl commands contain placeholders, so child
  stdout/stderr cannot reveal a value that Shuvgeist supplied.
- Deletion: `network clear`, page-driver disposal, and extension restart remove
  captured safe projections. Operators may delete the separate Electron profile
  when its local replay value is no longer needed.

Unknown media types, malformed JSON, scalar JSON, binary bodies, and other
ambiguous bodies are omitted. This is intentional: a body must be demonstrably
safe to export, not merely absent from a short denylist.

## Mutation review gate

`network curl` refuses POST, PUT, PATCH, DELETE, and other non-safe methods unless
`--review-mutation` is supplied. The flag confirms that a human or higher-level
policy reviewed the method, URL, redacted body, and side effects. It does not
substitute secret values or execute the command. Shuvgeist never automatically
retries a mutation.

## Target behavior

Chrome and Electron share the same driver-level redaction implementation and
wire schemas. Chrome deliberately uses an ephemeral lossless store because a
browser extension cannot provide POSIX mode-0600 guarantees. Electron uses the
local file profile described above. Both targets expose identical safe
projections and mutation-review behavior.
