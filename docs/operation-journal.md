# Operation aftermath and journal

Every CLI- or MCP-originated bridge operation except `journal_list` returns a top-level `aftermath` object. It records:

- method, hashed session key, start/end time, duration, and outcome;
- exact resolved target and navigation generation when the command returns them;
- origin-only URL movement;
- controlled console/page error counters and warning codes;
- handoff count and allowlisted artifact IDs.

Outcomes are `succeeded`, `failed`, `timed_out`, or `cancelled`. Extension disconnects produce failures. A CLI disconnect revokes the extension request and records cancellation before teardown.

## Privacy boundary

Aftermath construction never copies request parameters, headers, bodies, raw console entries, page error text, prompts, credentials, or arbitrary error/warning messages. HTTP(S) URLs are reduced to their origin; usernames, passwords, paths, queries, and fragments are discarded. Session identities are stored only as stable 20-character SHA-256-derived keys. Known recording, handoff, and snapshot IDs must match a bounded safe-character allowlist.

MCP tool responses return aftermath beside their task and result/error. Generic CLI JSON output uses:

```json
{
  "result": {},
  "aftermath": {}
}
```

## Storage and retention

The bridge stores one JSONL file per hashed session key in `~/.shuvgeist/journals/`. Directories use mode `0700`; files use mode `0600`. Each update uses an exclusive temporary file and atomic rename.

Each session retains at most 500 records, 1 MiB, and 30 days. Writes are serialized within the bridge process. Rotation occurs on append. Reads skip malformed, partial, expired-on-next-write, and structurally invalid lines without hiding later valid records.

Use:

```bash
shuvgeist journal
shuvgeist journal --last 100 --json
```

Journal write failure is logged without the path or record contents and never changes the browser operation's response.
