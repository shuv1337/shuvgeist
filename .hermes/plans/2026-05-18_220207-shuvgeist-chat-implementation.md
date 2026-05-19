# Plan: Implement `shuvgeist chat`

## Goal

Ship `shuvgeist chat` as a terminal interface to the existing Shuvgeist agent loop, then extend the same command to Electron targets once the Chrome/sidepanel loop is stable.

The key product behavior:

- `shuvgeist chat "task"` runs a one-shot browser agent task and exits with the final answer.
- `shuvgeist chat` opens an interactive terminal REPL.
- `shuvgeist chat --json "task"` emits newline-delimited structured stream events suitable for other agents.
- Chrome/browser targets reuse the existing sidepanel/pi-agent-core loop and provider credentials.
- Electron targets later run through a bridge-process loop with explicit encrypted provider token export.

## Current Context

The planning docs already define the intended shape:

- `PLAN-agent-browser-recon.md` section 2.1 defines the Chrome/CLI `shuvgeist chat` feature.
- `PLAN-electron-targets.md` Tier 2 defines Electron chat and explicitly blocks it on the base `shuvgeist chat` surface.

The current repo has useful primitives already:

- `src/sidepanel.ts` already owns the real pi-agent-core `Agent`.
- `src/sidepanel.ts` already supports bridge session commands:
  - `session_history`
  - `session_inject`
  - `session_new`
  - `session_set_model`
  - `session_artifacts`
  - `waitForIdle`
- `src/bridge/session-bridge.ts` already projects session messages and tool events for CLI consumers.
- `src/bridge/cli.ts` already has `cmdSession --follow`, `cmdInject`, WebSocket registration, JSON printing, signal handling patterns, and bridge config resolution.
- `src/bridge/server.ts` already relays extension events to CLI clients and enforces a single writer lease.
- Electron target support now exists locally for target routing, CDP actions, skill snapshots, main inspector, source inspection, doctor, and IPC/network taps.

Important constraint:

- Do not re-implement the sidepanel agent loop for Chrome. The first implementation should drive the existing loop through bridge session commands.
- Do not start Electron chat until Chrome `shuvgeist chat` exists and the CLI/session protocol is stable.

## Proposed Approach

Implement in two phases.

Phase 1: Chrome/sidepanel-backed `shuvgeist chat`

Use existing session bridge methods to create or reuse a sidepanel session, inject user prompts, follow streaming session events, and render terminal output. This avoids building the offscreen chat runner immediately and proves the CLI UX with real OAuth/provider state.

Phase 2: Electron/bridge-process `shuvgeist chat --target electron:...`

After Phase 1 is green, add the bridge-process runner and encrypted provider token export needed for extensionless Electron targets.

This plan intentionally separates the two phases because #15 depends on both, but the base command is useful and testable without Electron token export.

## Phase 1: Chrome/Sidepanel Chat

### 1. Define CLI UX and Command Planning

Modify:

- `src/bridge/cli-core.ts`
- `src/bridge/cli.ts`

Add a top-level `chat` command:

```bash
shuvgeist chat "task"
shuvgeist chat
shuvgeist chat --json "task"
shuvgeist chat --quiet "task"
shuvgeist chat --verbose "task"
shuvgeist chat --model anthropic/claude-sonnet-4-6 "task"
shuvgeist chat --new "task"
shuvgeist chat --session <session-id> "task"
shuvgeist chat --open-sidepanel
```

Recommended first-cut flags:

- `--json`: emit newline-delimited JSON events.
- `--quiet`: final assistant answer only.
- `--verbose`: include full tool start/update/end payloads.
- `--model <provider/model>`: call `session_set_model` before injection.
- `--new`: call `session_new` before injection.
- `--session <id>`: require active session id to match before injection. If arbitrary session restore is not available yet, return a teaching error and document the limitation.
- `--timeout <duration>`: reuse existing timeout parsing.
- `--target <spec>`: accept but only allow Chrome/default targets in Phase 1. Electron target should return a clear "Electron chat requires token export/bridge runner" error until Phase 2.

Implementation detail:

- Add `kind: "chat"` to `CliCommandPlan`.
- Keep command planning pure in `cli-core.ts`.
- Put terminal streaming/orchestration in a new module rather than growing `cli.ts` further.

Create:

- `src/bridge/chat/cli.ts`
- `src/bridge/chat/types.ts`

### 2. Build Session-Orchestration Flow

Create a `runChatCommand()` helper in `src/bridge/chat/cli.ts`.

One-shot flow:

1. Resolve bridge URL/token with existing `resolveConfig`.
2. Open WebSocket and register as CLI.
3. Optionally call `session_new` if `--new` or no active persisted session.
4. Optionally call `session_set_model`.
5. Call `session_history` to capture:
   - active session id
   - last message index
   - streaming state
6. Call `session_inject` with:
   - `role: "user"`
   - `content: <task>`
   - `expectedSessionId: <active session id>`
   - `waitForIdle: true`
7. Listen for:
   - `session_message`
   - `session_tool`
   - `session_run_state`
   - `session_changed`
8. Stop once the injected turn reaches idle and a new assistant message has arrived after the injected user message.
9. Print final assistant text or stream events depending on output mode.

Interactive flow:

1. Start or reuse a persisted session.
2. Enter a readline loop.
3. Supported slash commands:
   - `/help`
   - `/model <provider/model>`
   - `/new`
   - `/clear` as alias for `/new`
   - `/history`
   - `/exit`
4. Each normal line injects a user message and streams the turn until idle.
5. Ctrl-C behavior:
   - First Ctrl-C cancels the in-flight turn if possible.
   - Second Ctrl-C exits.

Initial cancellation can be implemented by closing the CLI WebSocket only if no explicit cancel method exists. Preferred follow-up is a dedicated `session_cancel` method.

### 3. Add Explicit Cancellation

Recommended before declaring the feature complete.

Modify:

- `src/bridge/protocol.ts`
- `src/sidepanel.ts`
- `src/background.ts`
- `src/bridge/browser-command-executor.ts`
- `src/bridge/cli.ts`

Add:

- `session_cancel`

Sidepanel behavior:

- If `agent.state.isStreaming`, call `agent.abort()`.
- Return `{ ok: true, cancelled: true }`.
- Emit `session_run_state` with `state: "idle"` after abort settles.

CLI behavior:

- In one-shot, SIGINT sends `session_cancel`, waits briefly for idle, then exits 130.
- In interactive, SIGINT cancels the current turn without exiting unless no turn is active.

Tests:

- Cancel while the extension has a pending session request.
- Cancel when idle returns `{ ok: true, cancelled: false }`.
- CLI SIGINT path does not leave the session write lock held.

### 4. Terminal Output Renderer

Create:

- `src/bridge/chat/output.ts`

Render modes:

- Normal:
  - tool start as compact lines like `[navigate] https://...`
  - tool end as compact summaries
  - assistant final answer as text
- Quiet:
  - suppress tool lines
  - print final assistant answer only
- Verbose:
  - print full tool input/result summaries
  - include session id/model at turn start
- JSON:
  - one JSON object per line
  - no human text on stdout
  - errors also structured

Define event shape in `src/bridge/chat/types.ts`:

```ts
export type ChatCliEvent =
  | { type: "session"; sessionId?: string; model?: { provider: string; id: string } }
  | { type: "turn-start"; sessionId?: string; messageIndex: number }
  | { type: "tool-call"; toolCallId: string; name?: string; phase: "start" | "update" | "end"; summary?: string; isError?: boolean }
  | { type: "message"; role: "user" | "assistant"; messageIndex: number; text: string }
  | { type: "turn-end"; sessionId?: string }
  | { type: "error"; message: string; code?: string };
```

Do not expose raw binary attachments or full data URLs in verbose output. Reuse the existing `summarizeForBridge()` behavior where possible.

### 5. Bridge/Protocol Adjustments

Modify:

- `src/bridge/protocol.ts`
- `src/bridge/session-bridge.ts`
- `src/bridge/server.ts`
- `src/sidepanel.ts`

Likely additions:

- `session_cancel`
- optional `waitForAssistantMessageAfter?: number` on `session_history`, or keep that logic in the CLI by following events
- `SessionRunStateEventData.state` should support at least `"started" | "idle" | "cancelled" | "error"` if not already broad enough

Keep existing `session_inject` semantics unless the CLI cannot reliably detect turn completion. If needed, add:

```ts
interface SessionInjectResult {
  ok: true;
  sessionId: string;
  messageIndex: number;
  turnId?: string;
}
```

### 6. Sidepanel Passive Indicator

Modify:

- `src/sidepanel.ts`

Add a small passive indicator when a CLI chat turn is active, but do not hijack the UI.

First cut can be state-only:

- bridge-injected user messages already appear in the active sidepanel session
- agent streaming already updates the existing UI

Only add custom UI if the current sidepanel does not make CLI-originated messages clear enough.

### 7. Documentation

Modify:

- `README.md`
- `ARCHITECTURE.md`
- `skills/shuvgeist/SKILL.md`
- `CHANGELOG.md`

Document:

- one-shot examples
- interactive REPL
- JSON mode
- extension/bridge prerequisites
- Ctrl-C cancellation behavior
- sidepanel credential reuse
- limitation: Electron targets require Phase 2

Also mirror the skill doc to the shared skill repository if this repo expects that workflow:

- `/home/shuv/repos/shuvbot-skills/shuvgeist/SKILL.md`

Ask before touching sibling repos if the user wants a strict single-repo change.

## Phase 1 Tests

Unit tests:

- `tests/unit/bridge/cli-core.test.ts`
  - `chat` command planning
  - `--json`, `--quiet`, `--verbose`, `--model`, `--new`, `--target`
- `tests/unit/bridge/chat/output.test.ts`
  - normal/quiet/verbose/JSON rendering
  - secret/binary redaction
- `tests/unit/bridge/chat/session.test.ts`
  - event-to-turn completion state machine
  - duplicate/out-of-order session events
  - error events

Integration tests:

- `tests/integration/bridge/chat.test.ts`
  - one-shot against a fake extension that emits `session_message`, `session_tool`, and `session_run_state`
  - JSON output is newline-delimited and parseable
  - no active extension returns a doctor-style hint
  - SIGINT/cancel releases write lock
- Extend `tests/integration/bridge/server.test.ts`
  - `session_cancel` relay and write-lock behavior
  - chat does not bypass capability gating

E2E tests:

- `tests/e2e/extension/chat.e2e.ts`
  - extension installed, bridge running, mock model/provider if available
  - `shuvgeist chat "ping"` returns a response
  - browser-driving task against a fixture page performs at least one tool call

Validation commands:

```bash
npm run build:cli
npm run build
./check.sh
```

If e2e fixtures are available:

```bash
npm run test:e2e -- tests/e2e/extension/chat.e2e.ts
```

## Phase 2: Electron Chat

Phase 2 implements GitHub issue #15 and should begin only after Phase 1 is merged or otherwise stable.

### 1. Token Export and Store

Create:

- `src/bridge/agent/token-store.ts`
- `src/bridge/agent/token-export.ts`

Modify:

- `src/bridge/protocol.ts`
- `src/bridge/server.ts`
- `src/sidepanel.ts`
- `src/bridge/cli.ts`

Add protocol methods:

- `cli_write_tokens`
- `electron_token_status`

Add CLI/UI:

```bash
shuvgeist electron export-tokens
shuvgeist electron token-status --json
```

Flow:

1. User explicitly clicks export in sidepanel or runs a CLI command that opens/prompts sidepanel.
2. Extension reads provider keys from `storage.providerKeys`.
3. Extension derives AES-256-GCM key from bridge token.
4. Bridge writes encrypted payload to `~/.shuvgeist/tokens.enc`.
5. File mode must be `0600`.
6. Bridge process decrypts only on demand.

Security note to document:

- v1 bridge-token-derived encryption means anyone who can read both `bridge.json` and `tokens.enc` can decrypt provider credentials.
- Optional passphrase can be a v2 hardening path.

Tests:

- token write creates `0600` file
- decrypt succeeds with matching bridge token
- decrypt fails after tamper
- decrypt fails with wrong bridge token
- missing/expired token returns teaching error

### 2. Bridge-Process Electron Agent Runner

Create:

- `src/bridge/agent/runner.ts`
- `src/bridge/agent/tools-electron.ts`
- `src/bridge/chat/electron-session.ts` or extend `src/bridge/chat/session.ts`

Tool strategy:

- Map agent tools to existing Electron bridge/session-manager methods:
  - navigate: limited or unsupported for app targets unless a renderer URL can be changed safely
  - eval: `ElectronSessionManager.evaluate`
  - screenshot: `ElectronSessionManager.screenshot`
  - snapshot: `ElectronSessionManager.snapshot`
  - locate role/text/label
  - ref click/fill
  - record start/stop/status if needed later
  - source/doctor/main info as explicit tools only if safe
- Inject app-scoped skills from the synced snapshot.
- Keep Electron tools target-scoped; never fall back to Chrome.

Model strategy:

- Extract model resolution/stream creation from `src/sidepanel.ts` into a shared runtime helper if feasible.
- If extraction is too risky, start with configured provider token file and a narrow model resolver in the bridge process, but keep API behavior aligned with sidepanel defaults.

### 3. Route `shuvgeist chat --target electron:...`

Modify:

- `src/bridge/chat/cli.ts`
- `src/bridge/cli-core.ts`
- `src/bridge/protocol.ts`
- `src/bridge/server.ts`

Behavior:

- Chrome/default target: sidepanel loop.
- Electron target: bridge-process runner.
- Missing token export: teaching error with exact command/UI action.
- Missing Electron session: reuse existing teaching error.
- Ctrl-C: cancel model stream and in-flight Electron tool operations.

Tests:

- `tests/integration/bridge/agent/electron-chat.test.ts`
  - fixture app click/fill flow
  - app-scoped skill injection
  - cancellation
  - missing token file
  - tampered token file

## Implementation Order

1. Add Phase 1 command planning and skeleton `src/bridge/chat/*`.
2. Implement one-shot orchestration using existing `session_history` + `session_inject` + event follow.
3. Add normal/quiet/verbose/JSON renderers.
4. Add `session_cancel` and SIGINT handling.
5. Add interactive REPL.
6. Add docs and changelog.
7. Run Phase 1 validations.
8. Only then start Phase 2 token export.
9. Implement Electron bridge runner and tools.
10. Route `--target electron:*`.
11. Add Electron chat docs/tests.
12. Run full validation and real smoke.

## Risks and Tradeoffs

- Existing `session_inject` returns before the agent turn finishes. The CLI must follow events and reliably detect the matching assistant response.
- If the sidepanel is not open or the extension is not registered, Chrome chat cannot run. The error should point to `shuvgeist launch` / `shuvgeist status` / doctor.
- MV3 offscreen lifecycle is finicky. Avoid offscreen runner in Phase 1 if the active sidepanel session is enough.
- Closing the CLI WebSocket is not the same as cancelling the agent. Implement `session_cancel`.
- Terminal JSON mode must never mix human text on stdout.
- Electron token export is security-sensitive and should be opt-in only.
- Electron runner may duplicate some sidepanel model setup. Prefer extracting shared helpers, but keep the extraction narrow.

## Definition of Done

Phase 1 done:

- `shuvgeist chat "ping"` works against the existing sidepanel agent.
- `shuvgeist chat "..." --json` emits valid NDJSON.
- Interactive REPL supports `/help`, `/model`, `/new`, `/clear`, `/exit`.
- Ctrl-C cancels the active turn.
- Same sidepanel provider credentials are used.
- Full validation passes:

```bash
npm run build:cli
npm run build
./check.sh
```

Phase 2 done:

- `shuvgeist chat --target electron:vscode "..."` drives an attached Electron app without Chrome as execution target.
- Token export is explicit, encrypted, file-mode restricted, and documented.
- Missing/tampered/expired token cases produce teaching errors.
- App-scoped synced skills are used.
- Cancellation stops model streaming and Electron operations.
- Full validation plus Electron fixture integration tests pass.
