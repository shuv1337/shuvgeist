# Facts — Agentic Browser Frontier

Shared understanding for the goal. Grouped by phase; order is the build order from `sequence.md`.

## Foundations (Phase 0 — no user-visible features; behavior-unchanged)

- A unified CdpSession interface exists with two implementations (chrome.debugger and Electron-WebSocket), and every existing debugger-backed and Electron operation works through it unchanged.
- A SessionRegistry replaces the single activeExtension slot; with exactly one connected target, all existing bridge commands behave identically to today.
- One canonical snapshot script serves both Chrome and Electron targets, and each entry carries the existing positional snapshotId plus an optional stableElementId, with snapshotId values unchanged in format.
- Agent construction is extracted into a UI-free AgentRuntimeFactory exposing the pi-agent-core loop hooks, and the sidepanel agent built through it behaves identically to before (same tools, same defaults).
- A single provider catalog is the source of truth and credentials use a typed discriminated union (no startsWith-brace heuristic); previously stored API-key and OAuth credentials still load and resolve.
- Changing the focused browser window no longer tears down other windows' bridge sessions.

## Tier A — Observation & Zero-Friction

- On navigation, the sidepanel agent receives a compact semantic page snapshot as its observation instead of only the page title and URL.
- Element refs resolve to a stable identifier and are invalidated on navigation, so a ref used after the page changes fails cleanly rather than resolving to the wrong element.
- A snapshot can be filtered to the top-N query-relevant elements while preserving ancestor hierarchy, and the filter applies on both Chrome and Electron targets.
- With no provider connected, the user can start using the assistant via a guided OAuth-subscription flow or a bundled free-tier key, with BYO still available, and local Ollama is not the default agent loop.

## Tier B — Multiplexing & External Interface

- Multiple independent browser sessions run concurrently without blocking each other, a write to one session does not lock another, and exactly one writer per target is enforced.
- Page snapshots can be persisted to a server-side store as raw pre-filter records and read back on demand by tab/frame/snapshot id, without dumping full snapshots into every bridge response.
- An MCP server fronts the bridge over Streamable HTTP, exposing observe/act/extract/agent mapped onto snapshot/locate/ref/workflow with task lifecycle states, and an external MCP client can drive a browser session through it.
- With explicit per-site consent, selected cookies from the user's real Chrome profile can be imported into a dedicated non-primary profile, while the default launch profile stays isolated.

## Tier C — Autonomy

- A lightweight internal eval harness runs a fixed set of task scenarios at least 8 times each and reports pass-rate and token usage.
- The agent runs a Planner-Actor-Validator loop with a mid-trajectory drift monitor that can halt or correct off-task trajectories, and reliability measured on the eval harness improves versus the baseline single loop.
- Successful trajectories (especially validator notes) are stored as cross-session memory keyed to skills and surfaced on matching domains, living in their own IndexedDB store rather than as fields on Skill.

## Tier D — Architectural big swings (gated)

- Each architectural big swing (session router, headless runtime, stealth control plane, set-of-marks vision) is preceded by a spike whose result is reported, and execution halts for explicit go/no-go before the implementation is committed.
- A separate headless/embedded agent runtime can run a full snapshot to locate to click to snapshot loop with no extension present, reusing the CdpSession, AgentRuntime, and snapshot foundations.
- On the headless/direct-CDP path the control plane keeps Runtime.enable off the action hot path (pre-stored coordinates / isolated-world execution), and the extension path is explicitly documented as non-stealth.
- When ref resolution is ambiguous or low-confidence, the agent can fall back to a vision step gated to vision-capable providers, and vision is not used by default.

## Guardrails (must hold across the whole program)

- The existing single-session sidepanel chat experience continues to work unchanged.
- All pre-existing bridge CLI commands keep their current behavior and signatures; every change to the bridge surface is additive.
- The project stays AGPL-licensed and all user data stays in local IndexedDB and the local bridge by default, with no new mandatory cloud dependency.
- No 'undetectable' or bypass-all-bot-detection claims are introduced in product copy or documentation.
