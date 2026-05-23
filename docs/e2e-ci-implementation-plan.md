# Shuvgeist deterministic e2e CI implementation plan

## Goal

Make Shuvgeist suitable for real deterministic e2e CI workflows by keeping its current real-browser strengths while adding first-class page-context assertions, workflow assertions, stable target pinning, and native semantic ref interactions.

The core feedback to address:

> The extension can capture the page, but DOM/REPL target behavior makes agents fall back to Playwright for interactive assertions.

The desired end state is that agents can use Shuvgeist alone for flows like:

```bash
shuvgeist launch --url http://localhost:3000 --headless
shuvgeist assert text "Welcome" --timeout 10s
shuvgeist assert role button --name "Continue" --visible
shuvgeist screenshot --out artifacts/home.png
```

and structured workflows like:

```json
{
  "name": "app smoke",
  "target": { "mode": "new-tab" },
  "steps": [
    {
      "method": "navigate",
      "params": { "url": "http://localhost:3000", "newTab": true }
    },
    {
      "assert": {
        "kind": "text",
        "text": "Welcome",
        "timeoutMs": 10000
      }
    },
    {
      "assert": {
        "kind": "role",
        "role": "button",
        "name": "Continue",
        "visible": true
      }
    },
    {
      "method": "screenshot",
      "params": {},
      "as": "evidence"
    }
  ]
}
```

## Current state

### Screenshot path is already real-browser backed

The background screenshot router resolves the target tab and uses Chrome debugger/CDP:

- `Runtime.evaluate` for viewport metadata
- `Page.captureScreenshot` for the actual image

This gives real-browser smoke evidence and should remain the screenshot implementation.

### REPL is sandbox-first by design

The existing REPL executes outer code inside a hidden extension/offscreen sandbox iframe. Page DOM access only happens inside `browserjs()`:

```bash
shuvgeist repl 'return await browserjs(() => document.title)'
```

This behavior is documented and should not be broken. The gap is that CI/e2e assertions should not require agents to know or remember the `browserjs()` wrapper.

### Snapshot and locate are page-targeted

`page_snapshot`, `locate_by_role`, `locate_by_text`, and `locate_by_label` already execute against the target tab via `chrome.userScripts.execute()`. They are useful building blocks for deterministic assertions.

## Design principles

1. **Do not change REPL semantics.** Add page-context assertion commands instead.
2. **Assertions must run in page context by default.** Direct `document` in assertion expressions should mean the app page, not the sandbox.
3. **Failed assertions must be CI-friendly.** Nonzero CLI exit code, structured JSON, clear human-readable output.
4. **Assertions should auto-wait.** Match Playwright-style retry until timeout.
5. **Workflows should pin targets.** Avoid active-tab/focus drift in CI.
6. **Use existing Shuvgeist primitives.** Reuse user scripts, snapshots, refs, and native input providers.
7. **Avoid hidden fallback behavior.** If native input fails, fail loudly rather than silently degrading to synthetic DOM events.
8. **Keep tests hermetic by default.** Unit and integration tests should use local fixtures, local HTTP servers, mocked bridge dispatch, or launched local browser sessions. Public sites are acceptable only for optional manual smoke checks, not for required validation.

## `/goal` execution contract

Implementation should run as a sequence of small, independently valid chunks. A `/goal` agent should start at the first incomplete chunk in the "Suggested implementation chunks" section, complete that chunk, run its listed validation, and stop with a concise evidence summary if the validation passes.

Do not roll multiple chunks together unless the earlier chunk's validation has passed and the next chunk is a direct dependency that cannot be validated in isolation. If validation fails, fix the failure inside the same chunk before moving on. If the failure is unrelated pre-existing repo state, record exact evidence and stop.

### Human-blocker escalation

If implementation becomes 100% blocked until human action, send Kyle a Signal message and then stop. Use the `signal-cli` skill. On this host, the known durable send surface is:

```bash
/home/shuv/repos/shuvbot-skills/signal-cli/signal-cli.sh me "<short blocker message>"
```

The message should include:

- repo and chunk name
- exact blocker
- exact command or UI action needed from Kyle
- last validation command and failure summary

Do not send Signal for normal implementation uncertainty, test failures the agent can debug, missing local context that can be inspected, or decisions already answered by this plan.

## Phase 1: shared page-context execution primitive

### Objective

Land a shared background/service-worker-safe page execution helper **first**, then build the assertion executor (Phase 3) on top of it. Every page-script execution path added by this plan — `assert expr`, `assert text`, `assert selector`, internal scripts inside the retry loop — goes through this helper. No ad-hoc `chrome.userScripts.execute()` calls in the new code.

Building this primitive up front avoids three classes of drift:

- inconsistent console capture between REPL, assertions, and snapshot
- divergent world-id / messaging configuration
- multiple, slightly different wrapper templates for try/catch and serialization

### Candidate files

- new helper: `src/tools/helpers/page-execution.ts`
- `src/bridge/background-runtime-handler.ts` (migrate `handleBgBrowserJs` onto the helper as part of this phase)
- `src/tools/page-snapshot.ts` (no migration in this phase, but the helper must be designed so a later migration is mechanical)
- `src/tools/repl/runtime-providers.ts` (no migration in this phase; just verify the helper supports the REPL's needs)

### Proposed API

```ts
export interface PageExecutionTarget {
	tabId: number;
	frameId?: number;
}

export interface PageExecutionOptions {
	worldId: string;
	csp?: string;
	args?: unknown[];
	timeoutMs?: number;
	signal?: AbortSignal;
	includeConsole?: boolean;
	terminateOnAbort?: boolean;
}

export interface PageExecutionConsoleEntry {
	type: "log" | "warn" | "error" | "info";
	text: string;
}

export interface PageExecutionResult<T = unknown> {
	success: boolean;
	value?: T;
	error?: string;
	stack?: string;
	console: PageExecutionConsoleEntry[];
	tabId: number;
	frameId: number;
	durationMs: number;
}

export async function executePageFunction<T>(
	target: PageExecutionTarget,
	fnSource: string,
	options: PageExecutionOptions,
): Promise<PageExecutionResult<T>>;
```

### Responsibilities

The helper must:

1. configure a user-script world via `chrome.userScripts.configureWorld()` (idempotent; ignore "already configured" errors as `capturePageSnapshot()` does today)
2. build a wrapper around the supplied function source that returns `{ success, value?, error?, stack?, console }`
3. inject serialized args via JSON
4. optionally capture `console.log/warn/error/info` output inline (off by default; assertions don't need it, REPL/`handleBgBrowserJs` do)
5. support explicit `frameId` targeting (frame 0 → omit `frameIds`; non-zero → set `frameIds: [frameId]`)
6. resolve `tabId` once before injection (callers pass an already-resolved tab; the helper does not call `resolveTabTarget`)
7. return structured success/error details — never throw for script-level errors
8. respect `AbortSignal` as a distinct transport/runtime abort, not as `success: false`
9. when `chrome.userScripts.terminate` is available and `terminateOnAbort !== false`, generate an `executionId`, pass it to `chrome.userScripts.execute()`, and call `chrome.userScripts.terminate(tabId, executionId)` from the abort handler
10. when `terminate` is unavailable, check `signal.aborted` before configure/inject and after `execute()` settles, remove abort listeners reliably, and document that already-running page scripts cannot be preempted on older Chrome versions
11. return or throw an abort-shaped error consistently enough for `WorkflowEngine` / bridge request abort handling to classify it as aborted
12. avoid `any` types unless unavoidable

Non-goals for this phase:

- skill-library injection (specific to `handleBgBrowserJs`; that wrapper composes the helper output with its own skill prelude)
- `RuntimeMessageBridge` / `NativeInputEventsRuntimeProvider` injection (also `handleBgBrowserJs`-specific composition)
- MAIN-world execution — the helper is user-script-world only. `assert expr --world main` routes through the existing `eval` path, not this helper.

Cancellation compatibility note:

- The existing sidepanel REPL path in `BrowserJsRuntimeProvider` already uses Chrome's `userScripts.terminate` + `executionId` path for cancellation. Chunk A must preserve that behavior for background `browserjs()` and should avoid introducing a helper contract that makes future REPL migration lose preemptive cancellation.

### Implementation notes

The helper subsumes the common wrapper template currently duplicated across:

- `buildDirectBrowserJsCode()` in `src/bridge/background-runtime-handler.ts` (lines ~96–175)
- `buildWrapperCode()` in `src/tools/repl/userscripts-helpers.ts` (line ~241)
- ad-hoc `chrome.userScripts.execute` calls in `capturePageSnapshot()` (`src/tools/page-snapshot.ts` line ~437) and `executeRefDomAction()` (`src/bridge/browser-command-executor.ts` line ~934)

Migration scope for this phase:

- Reimplement `handleBgBrowserJs` so its wrapper is `executePageFunction({ includeConsole: true })` composed with the skill-library and native-input prelude. Behavior must not change — add a regression test before refactoring.
- Leave `capturePageSnapshot()`, `buildWrapperCode()` (REPL), and `executeRefDomAction()` as-is for this phase. The helper's design must clearly support migrating each of them later (Chunk H tracks that follow-up).

### GitNexus impact analysis

Before editing existing symbols, run impact analysis:

```text
gitnexus_impact({ target: "handleBgBrowserJs", direction: "upstream" })
gitnexus_impact({ target: "buildDirectBrowserJsCode", direction: "upstream" })
gitnexus_impact({ target: "BrowserJsRuntimeProvider", direction: "upstream" })
gitnexus_impact({ target: "capturePageSnapshot", direction: "upstream" })
```

The migration of `handleBgBrowserJs` is the highest-risk part of this phase because it sits behind every `browserjs()` call from REPL/skills. Land it with a regression test that pins the current console/error/value envelope shape, then refactor underneath it.

## Phase 2: assertion protocol types

### Objective

Define first-class assertion request/response types in the bridge protocol.

### Candidate files

- `src/bridge/protocol.ts`
- new file such as `src/tools/page-assert.ts` or `src/bridge/assertions.ts`

### Bridge method

Add a single generic bridge method:

```ts
"page_assert"
```

Add it to:

- `BridgeCapabilities`
- `BridgeMethods`

A single protocol method keeps the bridge surface compact while allowing CLI sugar commands and workflow assertion steps.

### Request types

```ts
export type PageAssertKind = "expression" | "text" | "selector" | "role" | "label" | "url";
export type PageAssertWorld = "user" | "main";

export interface PageAssertParams extends TargetedBridgeParams {
	kind: PageAssertKind;
	timeoutMs?: number;
	intervalMs?: number;
	includeHidden?: boolean;

	// expression
	expression?: string;
	// World for `expression` assertions. Defaults to "user" (user-script world,
	// matches snapshot/locate semantics). Use "main" to read MAIN-world globals
	// such as framework state; this routes through the existing sensitive `eval`
	// path and requires the same gating.
	world?: PageAssertWorld;

	// text
	text?: string;
	exact?: boolean;

	// selector
	selector?: string;
	visible?: boolean;
	enabled?: boolean;
	count?: number;
	minCount?: number;
	maxCount?: number;

	// role
	role?: string;
	name?: string;

	// label
	label?: string;

	// url
	url?: string;
	urlPattern?: string;
}
```

### Capabilities and sensitive gating

- Add `page_assert` to `BridgeCapabilities` and `BridgeMethods` in `src/bridge/protocol.ts`.
- `page_assert` is **non-sensitive** by default and must not be added to the sensitive capability set in `getBridgeCapabilities()` (so it is available without `--allow-sensitive`).
- The one exception is `kind: "expression"` with `world: "main"`: that path must reuse the existing `eval` sensitive gating. The executor enforces this, not the protocol layer.

### Target support boundary

`page_assert` is initially a Chrome-extension/browser-tab bridge method. The CLI may accept `--target`, but Electron targets are routed in `BridgeServer.handleElectronTargetRequest()` before they reach `BrowserCommandExecutor`, and that server path only implements a finite method set today.

Initial implementation must choose one of these explicit behaviors:

1. **Preferred for this plan:** add an explicit `page_assert` branch in the Electron-target dispatcher that returns a clear unsupported/capability error such as `page_assert is not implemented for Electron targets yet; use eval/snapshot or omit --target`. Add a regression test so Electron-targeted assertions do not fail with a generic "not implemented" message.
2. **Larger follow-up:** implement Electron assertion support in `ElectronSessionManager` using the existing Electron CDP snapshot/evaluate helpers.

Do not leave Electron-targeted `shuvgeist assert ... --target electron:...` to fall through to an accidental generic execution error.

### Response types

```ts
export interface PageAssertResult {
	ok: boolean;
	kind: PageAssertKind;
	tabId: number;
	frameId: number;
	durationMs: number;
	attempts: number;
	timeoutMs: number;
	message: string;
	actual?: unknown;
	expected?: unknown;
	matches?: unknown[];
	console?: PageExecutionConsoleEntry[];
}
```

### Failure model

Use structured assertion results:

- bridge request succeeds with `{ ok: false, ... }` for an assertion failure
- CLI translates `ok: false` into exit code `1`
- workflows can record failed assertion details in the workflow result

Bridge transport errors should still use normal bridge errors.

## Phase 3: page assertion executor/tool

Builds on the Phase 1 helper. All page-script execution inside the assertion executor must go through `executePageFunction()` — no direct `chrome.userScripts.execute` calls in this module.

### Objective

Add executor support for `page_assert`.

### Candidate files

- `src/bridge/browser-command-executor.ts`
- new file `src/tools/page-assert.ts`

### New tool shape

```ts
export class PageAssertTool {
	windowId?: number;

	async assert(params: PageAssertParams, signal?: AbortSignal): Promise<PageAssertResult>;
}
```

### Executor dispatch

In `BrowserCommandExecutor.dispatch()` add:

```ts
case "page_assert":
	result = await this.pageAssert((params ?? {}) as PageAssertParams, signal);
	break;
```

Add a lazy getter:

```ts
private pageAssertTool?: PageAssertTool;

private getPageAssertTool(): PageAssertTool {
	if (!this.pageAssertTool) {
		this.pageAssertTool = new PageAssertTool();
		this.pageAssertTool.windowId = this.windowId;
	}
	return this.pageAssertTool;
}
```

### Common retry loop

Implement polling once and reuse it for every assertion kind:

```ts
async function retryAssertion(
	timeoutMs: number,
	intervalMs: number,
	signal: AbortSignal | undefined,
	check: () => Promise<AttemptResult>,
): Promise<PageAssertResult>;
```

Defaults:

```ts
timeoutMs = 5000;
intervalMs = 100;
```

Every result should include:

- `attempts`
- `durationMs`
- `timeoutMs`
- target `tabId` and `frameId`

### Assertion kinds

#### `expression`

CLI example:

```bash
shuvgeist assert expr 'document.title.includes("Dashboard")'
shuvgeist assert expr 'window.__APP_STATE__.user.id === 42' --world main
```

Default world is `user` (user-script world). The expression should become truthy before timeout.

World semantics:

- `user` (default): can read DOM, computed styles, bounding rects. **Cannot** read page MAIN-world globals (e.g. `window.__APP_STATE__`, framework devtools hooks, or anything set by the page's own scripts that isn't on a DOM element).
- `main`: routes through the same path as `shuvgeist eval` and can see MAIN-world globals. Requires sensitive access to be enabled.

If an `expression` assertion evaluates to `undefined` for the entire timeout and `world` is `user`, the failure message must include a hint:

```text
Expression did not become truthy before timeout (5000ms, 43 attempts)
Hint: `assert expr` runs in user-script world by default; for MAIN-world state use --world main (requires sensitive access).
```

#### `text`

CLI example:

```bash
shuvgeist assert text "Saved successfully"
shuvgeist assert text "Sign in" --exact
```

Evaluate against page visible/body text. Start with:

```js
document.body?.innerText ?? document.body?.textContent ?? ""
```

`innerText` is layout-blocking and slow on large SPAs; falling back to `textContent` keeps the retry loop responsive when `innerText` is not available (e.g. detached body during navigation).

Options:

- `--exact` (boolean flag, no value): switches from contains-match to strict equality after trimming.
- default: case-sensitive contains match.

Include a truncated text sample (max ~512 chars) in `actual` on failure.

#### `selector`

CLI example:

```bash
shuvgeist assert selector "button[type=submit]" --visible --enabled
```

Checks:

- selector exists
- optional exact/min/max count
- optional visibility
- optional enabled state

Visibility should match snapshot semantics:

```js
const style = window.getComputedStyle(element);
const rect = element.getBoundingClientRect();
const visible =
	style.display !== "none" &&
	style.visibility !== "hidden" &&
	style.visibility !== "collapse" &&
	rect.width > 0 &&
	rect.height > 0;
```

Enabled check should understand common form elements.

#### `role`

CLI example:

```bash
shuvgeist assert role button --name "Submit" --visible
```

Implementation should reuse snapshot/locator logic:

1. `capturePageSnapshot()`
2. `locateByRole()`
3. require an acceptable score/match
4. optionally check visible bounding box

This keeps assertion behavior aligned with `locate role`.

**Snapshot reuse inside the retry loop.** `capturePageSnapshot()` is expensive (hundreds of ms on big pages). The retry loop should:

- snapshot once per attempt (cannot reuse across attempts because the page is changing — that's the whole point of waiting)
- use a longer default `intervalMs` for `role` / `label` assertions, e.g. `250` ms instead of the global `100` ms default
- abort the in-flight snapshot when the abort signal fires

#### `label`

CLI example:

```bash
shuvgeist assert label "Email" --visible
```

Reuse `capturePageSnapshot()` and `locateByLabel()`. Same retry/interval guidance as `role`.

#### `url`

CLI examples:

```bash
shuvgeist assert url "https://example.com/dashboard"
shuvgeist assert url --pattern "/dashboard"
```

This can use `chrome.tabs.get(tabId)` rather than page script execution.

## Phase 4: CLI assertion commands

### Objective

Expose page-context assertion commands that agents can discover and use directly.

### Candidate files

- `src/bridge/cli-core.ts`
- `src/bridge/cli.ts`
- `skills/shuvgeist/SKILL.md`
- `README.md`

### Command shape

Use an `assert` top-level command with subcommands:

```bash
shuvgeist assert expr 'document.title.includes("Dashboard")'
shuvgeist assert expr 'window.__APP_STATE__.ready === true' --world main
shuvgeist assert text "Saved successfully"
shuvgeist assert selector "button[type=submit]" --visible --enabled
shuvgeist assert role button --name "Submit" --visible
shuvgeist assert label "Email" --visible
shuvgeist assert url "/dashboard"
```

### Flags

Add or reuse flags in `CliFlags`:

```ts
interval?: string;
exact?: boolean;
visible?: boolean;
enabled?: boolean;
count?: string;
minCount?: string;
maxCount?: string;
world?: string; // "user" | "main", for `assert expr`
urlPattern?: string;
```

Existing flags such as `timeout`, `tabId`, `frameId`, `target`, and `name` should be reused.

### CLI planning

In `createCommandPlan()`:

```ts
case "assert":
	return createAssertCommandPlan(positionals, flags, target);
```

Add helper:

```ts
function createAssertCommandPlan(
	positionals: string[],
	flags: CliFlags,
	target?: BridgeTarget,
): CliCommandPlan;
```

The plan should map to:

```ts
{
	kind: "assert";
	params: PageAssertParams;
	defaultTimeoutMs: BridgeDefaults.SLOW_REQUEST_TIMEOUT_MS;
	target?: BridgeTarget;
}
```

### CLI execution

Do not use generic `runOneShot()` for assertions, and do not pass assertion responses through `exitCodeForResponse()` (`src/bridge/cli-core.ts:269`). `exitCodeForResponse` only inspects `response.error`, so an assertion failure (a successful bridge response carrying `{ ok: false, ... }`) would incorrectly map to exit code `0`.

Add assertion-specific handling:

```ts
async function cmdAssert(
	params: Record<string, unknown>,
	flags: AssertCliFlags,
): Promise<void>;
```

Three-way exit code contract (must match the rest of the CLI):

| Exit code | Condition |
|-----------|------------------------------------------------------------------|
| `0`       | Bridge OK, assertion result `ok: true` |
| `1`       | Bridge OK, assertion result `ok: false` (true assertion failure) |
| `2`       | Bridge error `NO_EXTENSION_TARGET` (browser/extension not reachable) |
| `3`       | Bridge error `AUTH_FAILED` / `INVALID_METHOD` / `REGISTRATION_REQUIRED` / network/config error |

CI must be able to distinguish "the test failed" (`1`) from "we never reached the browser" (`2` / `3`). Codes `2` and `3` should reuse `exitCodeForResponse` / `isNetworkOrConfigError` for the bridge-error branch; only the success branch needs custom logic to look at `result.ok`.

### Human output

Success:

```text
Assertion passed: text "Saved successfully" found after 312ms
```

Failure:

```text
Assertion failed after 5000ms: text "Saved successfully" was not found
Attempts: 42
Tab: 123 frame: 0
```

### JSON output

```json
{
  "ok": false,
  "kind": "text",
  "message": "Text \"Saved successfully\" was not found before timeout",
  "tabId": 123,
  "frameId": 0,
  "durationMs": 5002,
  "attempts": 43,
  "timeoutMs": 5000,
  "expected": "Saved successfully",
  "actual": "Welcome\nSettings\nProfile..."
}
```

## Phase 5: workflow assertion steps

### Objective

Allow deterministic multi-step browser tests without embedding assertions in REPL snippets.

### Candidate files

- `src/bridge/workflow-schema.ts`
- `src/tools/workflow-engine.ts`
- `src/bridge/protocol.ts`
- docs and skill file

### Allowlist note

`WorkflowEngine` currently restricts command steps to a small `DEFAULT_ALLOWED_METHODS` set (`src/tools/workflow-engine.ts:18-29`). Assertion steps are a **distinct step kind**, so the dispatch from `executeAssertStep` calls `page_assert` directly and bypasses the command-step allowlist. No allowlist change is required just for assertions.

However, Phase 6 (target propagation) will want to widen the allowlist for some other CI-useful methods (frame, network, device). Track that as a separate decision in Phase 6 rather than smuggling it in here.

### Schema extension

Add a workflow assertion step shape:

```ts
const workflowAssertStepSchema = Type.Object(
	{
		id: Type.Optional(Type.String({ minLength: 1 })),
		assert: Type.Object({
			kind: Type.Union([
				Type.Literal("expression"),
				Type.Literal("text"),
				Type.Literal("selector"),
				Type.Literal("role"),
				Type.Literal("label"),
				Type.Literal("url"),
			]),
			expression: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			role: Type.Optional(Type.String()),
			label: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
			url: Type.Optional(Type.String()),
			urlPattern: Type.Optional(Type.String()),
			exact: Type.Optional(Type.Boolean()),
			visible: Type.Optional(Type.Boolean()),
			enabled: Type.Optional(Type.Boolean()),
			timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
			intervalMs: Type.Optional(Type.Number({ minimum: 1 })),
			tabId: Type.Optional(Type.Number()),
			frameId: Type.Optional(Type.Number()),
		}),
		as: Type.Optional(Type.String({ minLength: 1 })),
		onError: Type.Optional(workflowOnErrorSchema),
	},
	{ additionalProperties: false },
);
```

Add it to the recursive workflow step union.

### Type extension

```ts
export type WorkflowAssertStep = {
	id?: string;
	assert: PageAssertParams;
	as?: string;
	onError?: WorkflowOnErrorPolicy;
};

export type WorkflowStep = WorkflowCommandStep | WorkflowAssertStep | WorkflowRepeatStep | WorkflowEachStep;
```

### Engine behavior

In `WorkflowEngine.executeStep()`:

```ts
if (isAssertStep(step)) {
	return this.executeAssertStep(step, context, state, signal, path);
}
```

`executeAssertStep()` should:

1. substitute tokens in assertion params
2. call dispatch with method `page_assert`
3. record result
4. if `result.ok === false` and `onError !== "continue"`, halt workflow
5. capture result under `as` if provided

**`as` capture semantics.** When `as` is set, the engine stores the **`PageAssertResult`** object (`{ ok, kind, message, attempts, ... }`) in `context.variables[step.as]` and in `state.captured`. It is **not** the original assertion params. This mirrors how command steps capture their `result`, and it lets later steps branch on `%{login_check.ok}` regardless of pass/fail. On a failed assertion the capture still happens (so `onError: "continue"` workflows can inspect `%{login_check.ok}` downstream); only step recording / halting changes.

### Workflow result type

Extend `WorkflowStepResult.type`:

```ts
type: "command" | "assert" | "repeat" | "each";
```

For assertion steps:

```ts
{
	path,
	type: "assert",
	status: result.ok ? "ok" : "error",
	method: "page_assert",
	durationMs,
	as,
	result,
	error: result.ok ? undefined : result.message,
}
```

### Downstream consumer impact

Adding `"assert"` to the `WorkflowStepResult.type` union is a typed change. Before editing, run:

```text
gitnexus_impact({ target: "WorkflowStepResult", direction: "upstream" })
```

Update every exhaustive switch on `WorkflowStepResult.type` — at minimum any workflow renderer, telemetry exporter, log formatter, and the sidepanel workflow result UI. Missing one will produce silent `undefined`-branch fallthroughs.

## Phase 6: target pinning and tab propagation

### Objective

Prevent active-tab or focus drift from breaking CI workflows.

### Current issue

Many commands accept `tabId`, but workflows do not provide a top-level target contract. Agents must manually thread `tabId` through every step.

### Candidate files

- `src/bridge/workflow-schema.ts`
- `src/tools/workflow-engine.ts`
- `src/bridge/browser-command-executor.ts`
- `src/tools/navigate.ts`
- `src/bridge/protocol.ts`

### Workflow-level target config

Extend workflow schema:

```ts
target: Type.Optional(
	Type.Object({
		mode: Type.Optional(
			Type.Union([
				Type.Literal("active"),
				Type.Literal("new-tab"),
				Type.Literal("pinned-tab"),
			]),
		),
		tabId: Type.Optional(Type.Number()),
		frameId: Type.Optional(Type.Number()),
	}),
)
```

Modes (defined precisely so two implementations cannot diverge):

- **`active`** (default, preserves current behavior): no pinned target. Each step resolves the target it cares about at execution time, falling back to the currently active tab in the workflow's `windowId`.
- **`new-tab`**: no tab is opened up-front. The **first** step that produces a `tabId` in its result (in practice, the first `navigate` step) sets the workflow's pinned `tabId`. From that point on, every targetable step (see method list below) inherits `tabId` from the workflow context unless the step itself sets an explicit `tabId`. If no such step appears before another targetable step runs, that step falls back to `active`-mode behavior and a warning is recorded.
- **`pinned-tab`**: requires an explicit `tabId` in `target.tabId`. Validation fails (workflow rejected at schema validation time) if `mode: "pinned-tab"` is set without `tabId`. All targetable steps inherit `tabId` (and `frameId` if set) unless they override it explicitly.

Note: `mode: "new-tab"` does **not** eagerly open a blank tab. The contract is "the first navigate result is authoritative", which keeps the workflow declarative and avoids dangling blank tabs if the workflow is aborted before step 0 dispatches.

### Ensure navigate returns `tabId`

`NavigateTool.execute` already returns `tabId` in `details` (see `src/tools/navigate.ts:127-131`). The work here is therefore:

1. Add a regression unit test pinning that `tabId` is present in the bridge response for both `navigate` (current-tab) and `navigate { newTab: true }` flows.
2. Verify the bridge serialization (`browser-command-executor.ts` → `navigate` case) does not strip `tabId` before responding.

Before editing, sanity check upstream consumers:

```text
gitnexus_impact({ target: "NavigateTool", direction: "upstream" })
```

### Workflow target context

Add to workflow execution context:

```ts
target?: {
	tabId?: number;
	frameId?: number;
	mode?: "active" | "new-tab" | "pinned-tab";
};
```

Before dispatching each targetable command/assertion, apply defaults:

```ts
resolvedParams = applyWorkflowTargetDefaults(resolvedParams, context.target);
```

Only apply to methods that support tab/frame targeting.

The **currently workflow-allowed** targetable methods (already in `DEFAULT_ALLOWED_METHODS`) are:

- `repl`
- `screenshot`
- `eval`
- `page_snapshot`
- `locate_by_role`
- `locate_by_text`
- `locate_by_label`
- `ref_click`
- `ref_fill`

Plus the new method added in Phase 5:

- `page_assert`

The plan also wants target propagation for these methods, but they are **not currently in the workflow allowlist**:

- `frame_list`, `frame_tree`
- `network_start`, `network_stop`, `network_list`, `network_clear`, `network_stats`
- `device_emulate`, `device_reset`
- `perf_metrics`, `perf_trace_start`, `perf_trace_stop`
- `record_start`, `record_stop`, `record_status`

Decision: expand `DEFAULT_ALLOWED_METHODS` in `src/tools/workflow-engine.ts` to include the methods above as part of this phase, because deterministic CI workflows need network/device/record steps to be first-class. Keep `select_element`, `workflow_run`, `workflow_validate`, and any `session_*` methods explicitly disallowed.

Document the expanded allowlist in the workflow docs and in `skills/shuvgeist/SKILL.md`.

### Workflow warnings

`new-tab` mode can encounter a targetable step before any prior step has produced a `tabId`. This is not a hard workflow error, but it is important diagnostic information for CI.

Add a first-class warning channel instead of appending to `errors`:

```ts
interface WorkflowExecutionState {
	warnings: string[];
	// existing fields...
}

export interface WorkflowRunResult {
	warnings: string[];
	// existing fields...
}
```

Rules:

- warnings do **not** make `ok` false
- warnings are included in JSON workflow output
- warning strings should include the step path and the method/assertion kind
- tests must verify that a pre-pin target warning is emitted without flipping `ok` to `false`

### Update target after navigation

If a `navigate` step returns `tabId`, update workflow context:

```ts
if (step.method === "navigate" && isRecord(result) && typeof result.tabId === "number") {
	context.target.tabId = result.tabId;
}
```

### Documentation guidance

All CI examples should use:

```json
"target": { "mode": "new-tab" }
```

or explicit `tabId` for workflows that operate on an already-open authenticated tab.

## Phase 7: native semantic ref actions

### Objective

Allow semantic refs to be operated with debugger-backed trusted input, not only synthetic DOM events.

### Current behavior

`BrowserCommandExecutor.executeRefDomAction()` performs synthetic DOM actions:

- `el.click()`
- direct `el.value = ...`
- `input` and `change` events

This is not enough for sites that require trusted input events.

### Candidate files

- `src/bridge/protocol.ts`
- `src/bridge/cli-core.ts`
- `src/bridge/browser-command-executor.ts`
- `src/tools/NativeInputEventsRuntimeProvider.ts`
- `src/bridge/background-runtime-handler.ts` (uses the provider via `handleBgNativeInput`)
- `skills/shuvgeist/SKILL.md`

### Required provider refactor (prerequisite)

`NativeInputEventsRuntimeProvider` today exposes `nativeClick` / `nativeType` / `nativePress` as **page-side globals** created by the function returned from `getRuntime()` (around lines 149‑201). The actual CDP work lives inside `handleMessage()`, which receives `{ type: "native-input", action, ... }` messages routed via `chrome.runtime.sendMessage`.

There is no class method the bridge executor can call directly. Before Phase 7's executor changes, refactor the provider:

1. Extract the per-action CDP blocks from `handleMessage` into typed methods on the provider, e.g.:

   ```ts
class NativeInputEventsRuntimeProvider {
	async nativeClickSelector(tabId: number, frameId: number, selector: string): Promise<void>;
	async nativeTypeIntoSelector(tabId: number, frameId: number, selector: string, text: string): Promise<void>;
	async nativePressKey(tabId: number, key: string): Promise<void>;
	async nativeKeyDown(tabId: number, key: string): Promise<void>;
	async nativeKeyUp(tabId: number, key: string): Promise<void>;
}
   ```

2. Reimplement `handleMessage` as a thin dispatcher that resolves `tabId` once and calls these methods. Keep its existing logging and telemetry behavior.
3. The executor (`executeRefNativeClick` / `executeRefNativeFill`) calls these methods directly — no fake `native-input` message synthesis.
4. Keep `getRuntime()` unchanged: page-side globals continue to send `native-input` messages, which `handleMessage` (and `handleBgNativeInput` in the background) still routes.

Before editing:

```text
gitnexus_impact({ target: "NativeInputEventsRuntimeProvider", direction: "upstream" })
gitnexus_impact({ target: "handleBgNativeInput", direction: "upstream" })
```

### Extend params

```ts
export interface RefClickParams extends TargetedBridgeParams {
	refId: string;
	native?: boolean;
}

export interface RefFillParams extends TargetedBridgeParams {
	refId: string;
	value: string;
	native?: boolean;
}
```

### CLI flags

```bash
shuvgeist ref click <refId> --native
shuvgeist ref fill <refId> --value "user@example.com" --native
```

Add `native?: boolean` to `CliFlags`.

### Executor behavior

In `refClick()`:

```ts
if (params.native) {
	await this.executeRefNativeClick(resolution);
} else {
	await this.executeRefDomAction(...);
}
```

In `refFill()`:

```ts
if (params.native) {
	await this.executeRefNativeFill(resolution, params.value);
} else {
	await this.executeRefDomAction(...);
}
```

### Native implementation

Reuse `NativeInputEventsRuntimeProvider`'s extracted typed methods (see prerequisite refactor above) rather than duplicating CDP input logic.

Implementation approach:

1. resolve the ref to a selector via `resolveReference()` (already used by `refClick` / `refFill`)
2. instantiate `NativeInputEventsRuntimeProvider` with `windowId`, `tabId`, `frameId`, the shared debugger manager (`getSharedDebuggerManager()`), telemetry, and trace context
3. call `nativeClickSelector(tabId, frameId, selector)` or `nativeTypeIntoSelector(tabId, frameId, selector, value)`

Frame boundary:

- Initial native ref actions are **main-frame only** unless the chunk also implements a verified frame-aware CDP coordinate resolution path.
- If `resolveReference()` returns `frameId !== 0` and frame-aware CDP targeting has not been implemented, fail loudly with a message that includes `refId`, `selector`, `tabId`, and `frameId`, e.g. `Native ref actions currently support main-frame refs only`.
- Do not silently run `document.querySelector()` in the main frame for a subframe ref. That would click/fill the wrong page context in CI.
- A later enhancement can support subframes by mapping the extension `frameId` to a CDP execution context and calculating viewport-relative coordinates inside that frame before dispatching trusted input events.

Failure behavior:

- Do not silently fall back from native to synthetic. Native failures must fail the command.
- Error messages must include both the underlying CDP exception text and the original ref selector. Today `refClick` throws a bare `"Ref action did not confirm success"`, which is useless for CI debugging — replace it with structured detail (`refId`, `selector`, `tabId`, `frameId`, root cause).

## Phase 8: documentation and agent skill updates

### Objective

Make agents choose Shuvgeist for deterministic browser assertions instead of defaulting to Playwright.

### Files

- `skills/shuvgeist/SKILL.md`
- `README.md`
- new runtime docs page, likely `docs/e2e-ci.md`
- `CHANGELOG.md`

### Skill updates

Add a dedicated section:

```md
## Deterministic e2e assertions

Use `shuvgeist assert ...` for CI-style checks. These run in page context by default; do not use `repl 'document...'` for page assertions.
```

Include examples:

```bash
shuvgeist assert text "Welcome" --timeout 10s
shuvgeist assert role button --name "Continue" --visible
shuvgeist assert selector "form [type=submit]" --enabled
```

Update decision rules:

- use `assert` for pass/fail browser checks
- use workflow assertion steps for multi-step CI tests
- use `screenshot` or `record` as failure evidence
- use Playwright only when Shuvgeist lacks a required browser feature

### README updates

Add a concise e2e CI example:

```bash
shuvgeist launch --url http://localhost:3000 --headless
shuvgeist assert text "Welcome" --timeout 10s
shuvgeist screenshot --out artifacts/home.png
```

### New `docs/e2e-ci.md`

Cover:

- setup in CI
- launching browser/headless
- extension loading
- target pinning
- assertions
- screenshots on failure
- exit codes
- sensitive access caveats
- limitations vs Playwright

### Changelog

Add entries under `## [Unreleased]`:

```md
### Added
- Added page-context `shuvgeist assert ...` commands for deterministic browser assertions.
- Added workflow assertion steps with auto-waiting and structured pass/fail results.
- Added workflow target pinning for stable CI tab targeting.
- Added native ref actions via `shuvgeist ref ... --native`.

### Changed
- Documented Shuvgeist e2e CI patterns and clarified REPL sandbox versus page-context assertions.
```

## Phase 9: tests

### Objective

Cover parser behavior, protocol additions, assertion evaluation, workflow execution, and CLI exit semantics.

### Existing test setup

The project already has `vitest` configured. `./check.sh` runs `npm run check`, which runs biome, both tsconfigs, **and** `npm run test:unit` + `npm run test:integration` (see `package.json` scripts). So new unit and integration tests under `tests/unit/**` and `tests/integration/**` are picked up automatically — there is no separate "add to CI" step.

Relevant existing test directories:

- `tests/unit/bridge/` — CLI parser, protocol, workflow schema, executor
- `tests/unit/tools/` — workflow engine, page snapshot, ref map, native input helpers
- `tests/integration/bridge/` — live bridge integration tests

Validation commands after implementation:

```bash
./check.sh          # biome + tsc x2 + unit + integration tests + site check
npm run build       # extension bundle (dist-chrome/)
npm run build:cli   # CLI bundle (dist-cli/)
```

This work affects both extension runtime and CLI bridge, so both builds are required in addition to `./check.sh`.

### Unit tests

#### CLI parser tests

For `src/bridge/cli-core.ts`:

- `assert expr`
- `assert text`
- `assert selector`
- `assert role`
- `assert label`
- `assert url`
- `--tab-id`
- `--frame-id`
- `--target`
- timeout and interval parsing
- invalid usage messages

#### Workflow schema tests

For `src/bridge/workflow-schema.ts`:

- valid assertion steps
- invalid assertion kind
- missing required assertion fields
- additional properties rejected
- workflow-level target config accepted

#### Workflow engine tests

Mock dispatch and verify:

- assertion success continues
- assertion failure halts by default
- `onError: "continue"` continues
- `as` captures assertion result
- workflow target defaults are applied
- `navigate` result updates pinned `tabId`

#### Assertion evaluator tests

If assertion logic is factored into pure helpers, test:

- text matching
- exact/inexact behavior
- selector count rules
- visibility semantics
- role matching through snapshot candidates
- URL pattern matching

### Integration tests

Where feasible, add live browser coverage with a simple local page and Shuvgeist-launched browser. Required live coverage must not depend on public internet availability.

Add a deterministic fixture page, for example:

- `tests/fixtures/e2e-ci/index.html`
- `tests/fixtures/e2e-ci/server.ts` or an existing local static-server helper

The fixture should include stable elements for every assertion class:

- visible text: `Welcome to Shuvgeist CI`
- role/name target: `<button>Continue</button>`
- selector target: `button[type=submit]`
- label target: `<label>Email <input ...></label>`
- delayed element insertion for auto-wait tests
- hidden and disabled controls for negative visibility/enabled tests
- a counter button for native ref smoke coverage

The fixture should avoid animation, external assets, third-party fonts, remote scripts, service workers, and time-dependent copy.

Put live browser/extension scenarios under `tests/e2e/extension/**` (Playwright), not Vitest `tests/integration/**`, unless the browser and bridge are fully mocked. `./check.sh` runs Vitest unit/integration tests; GitHub's browser smoke job runs Playwright extension tests separately.

Required default-suite coverage should stay mocked or pure:

- assertion evaluator helpers under `tests/unit/**`
- workflow schema/engine behavior under `tests/unit/**`
- bridge protocol/server behavior under `tests/integration/**` only when it uses the existing fake bridge/CDP patterns

Suggested live e2e scenarios:

1. launch browser with extension
2. start the local fixture server and navigate to it
3. `assert text` passes
4. `assert text` fails with exit code `1`
5. `assert selector --visible` passes
6. `assert role button --name ...` passes
7. native ref click increments a counter
8. workflow with assertions passes
9. workflow with failed assertion returns `ok: false`

If live extension tests are too heavy or flaky for CI, document them as manual smoke tests and keep unit/integration tests in the normal `./check.sh` gate.

## Phase 10: validation and release hygiene

### Required validation

After code changes:

```bash
./check.sh
npm run build
npm run build:cli
```

### Headless launch sanity check (blocker)

The whole CI story rests on `shuvgeist launch --headless` actually producing a registered extension that responds to bridge requests. Verify this end-to-end before relying on it in docs:

```bash
shuvgeist launch --url about:blank --headless --json
shuvgeist status --json   # must report a connected extension target
```

If `status` does not show a connected extension after `launch`, treat it as a blocker: agents will hit `NO_EXTENSION_TARGET` (exit code `2`) on every assertion and conclude Shuvgeist is broken.

Likely failure modes to instrument and document if encountered:

- extension load completes but service worker hasn't registered with the bridge yet (need a wait/poll loop in launch)
- headless Chrome flags strip user-script permissions
- session lock from a previous run blocks new registration

### Manual smoke commands

Run against the local deterministic fixture first. Replace `$FIXTURE_URL` in shell examples and `http://127.0.0.1:PORT/` in JSON examples with the URL printed by the fixture server.

```bash
shuvgeist launch --url "$FIXTURE_URL" --headless
shuvgeist status --json
shuvgeist assert text "Welcome to Shuvgeist CI" --json
shuvgeist assert role button --name "Continue" --visible --json
shuvgeist assert expr 'document.title.includes("Shuvgeist CI")' --json
shuvgeist screenshot --out /tmp/shuvgeist-e2e.png
```

Expected:

- assertion commands exit `0`
- JSON shows `ok: true`
- screenshot writes file and viewport metadata

Failure smoke:

```bash
shuvgeist assert text "Definitely missing" --timeout 1s --json
```

Expected:

- exits `1`
- JSON shows `ok: false`
- message includes timeout and attempts

Workflow smoke file:

```json
{
  "name": "fixture smoke",
  "target": { "mode": "new-tab" },
  "steps": [
    {
      "method": "navigate",
      "params": {
        "url": "http://127.0.0.1:PORT/",
        "newTab": true
      },
      "as": "nav"
    },
    {
      "assert": {
        "kind": "text",
        "text": "Welcome to Shuvgeist CI",
        "timeoutMs": 5000
      }
    },
    {
      "method": "screenshot",
      "params": {},
      "as": "shot"
    }
  ]
}
```

Run:

```bash
shuvgeist workflow run --file example-smoke.json --json
```

Expected:

- exits `0`
- workflow result `ok: true`
- assertion step recorded

## Suggested implementation chunks

The chunks are ordered so the shared Phase 1 helper lands first and every later chunk builds on it. Within that constraint, smaller / lower-risk chunks come earlier.

Each chunk is a deterministic `/goal` stopping point. For every chunk:

1. start with `git status --short` and confirm which files are already dirty
2. run the chunk's listed GitNexus impact checks before symbol edits
3. make only the chunk-scoped changes
4. run the chunk's validation commands
5. stop after a passing validation summary unless the user explicitly asks to continue

If a chunk requires documentation updates, update `skills/shuvgeist/SKILL.md` in the same chunk as the command surface it documents, then keep the broader README / `docs/e2e-ci.md` / changelog cleanup for Chunk G.

### Chunk A: shared page execution helper

Scope (Phase 1):

- add `src/tools/helpers/page-execution.ts` with `executePageFunction()` and the result/option/console types
- add unit tests covering: success path, script-level error, abort signal, console capture on/off, frame targeting (frame 0 vs non-zero)
- migrate `handleBgBrowserJs` to use the helper (with a regression test pinning its existing envelope shape)
- do not migrate `capturePageSnapshot`, REPL `buildWrapperCode`, or `executeRefDomAction` in this chunk — those follow in Chunk H

Validation:

```bash
./check.sh
npm run build
npm run build:cli
```

Stop point: helper exists, `handleBgBrowserJs` behavior is regression-tested, and all three validation commands pass.

### Chunk B: workflow target pinning + navigate regression test

Scope (Phase 6):

- add workflow `target` schema (modes: `active` / `new-tab` / `pinned-tab`)
- add target context propagation in `WorkflowEngine`
- add `WorkflowRunResult.warnings` / execution-state warnings for non-fatal pre-pin target diagnostics
- expand `DEFAULT_ALLOWED_METHODS` to include the targetable methods listed in Phase 6
- add `navigate` regression test confirming `tabId` is returned in bridge details
- update docs to use `"target": { "mode": "new-tab" }` in CI examples

Validation:

```bash
./check.sh
npm run build
npm run build:cli
```

Stop point: workflow target schema and propagation are covered by tests, pre-pin warnings are represented without making the workflow fail, navigate `tabId` regression is pinned, and all three validation commands pass.

### Chunk C: assertion protocol + executor + `page_assert` tool

Scope (Phase 2 + Phase 3, built on the Chunk A helper):

- add `page_assert` to `BridgeCapabilities` and `BridgeMethods` (non-sensitive)
- add `PageAssertParams` / `PageAssertResult` types in `protocol.ts`
- add `PageAssertTool` using `executePageFunction()` for every page-script execution
- add executor dispatch case in `browser-command-executor.ts`
- gate `assert expr --world main` through the existing sensitive `eval` path
- add explicit Electron-target behavior in `BridgeServer.handleElectronTargetRequest()` (clear unsupported error unless Electron assertion support is implemented in this chunk)
- add unit tests for assertion evaluator behavior

Validation:

```bash
./check.sh
npm run build
npm run build:cli
```

Stop point: `page_assert` bridge method works through executor-level tests, Electron-targeted `page_assert` has an intentional tested outcome, assertion evaluator behavior is covered, and all three validation commands pass.

### Chunk D: CLI `assert` subcommands with three-way exit codes

Scope (Phase 4, depends on Chunk C):

- parse `shuvgeist assert ...` in `cli-core.ts` (`createAssertCommandPlan`)
- new `cmdAssert` function in `cli.ts` that **does not** route through `runOneShot` or `exitCodeForResponse` for the success branch
- exit codes: `0` pass / `1` assertion failed / `2` no extension target / `3` config/network/registration
- CLI parser tests including `--world` and exit-code paths
- skill documentation update

Validation:

```bash
./check.sh
npm run build:cli
```

Stop point: CLI parser and exit-code tests prove pass/fail/unreachable-browser behavior, and both validation commands pass.

### Chunk E: workflow assertion steps

Scope (Phase 5, depends on Chunk B + Chunk C):

- extend workflow schema with assertion step
- add `WorkflowStepResult.type === "assert"` and update every downstream consumer (renderers, telemetry, log formatters)
- implement `executeAssertStep` with `as` capturing `PageAssertResult`
- add tests: pass, fail, `onError: "continue"`, `as` capture on both branches, target inheritance from Chunk B
- update docs

Validation:

```bash
./check.sh
npm run build
npm run build:cli
```

Stop point: workflow assertions pass/fail deterministically in tests, downstream `WorkflowStepResult.type` consumers are updated, and all three validation commands pass.

### Chunk F: native ref actions (independent of B–E)

Scope (Phase 7):

- refactor `NativeInputEventsRuntimeProvider` to expose typed methods (`nativeClickSelector`, `nativeTypeIntoSelector`, ...)
- update `handleMessage` and `handleBgNativeInput` to use the new methods (no behavior change)
- extend `RefClickParams` / `RefFillParams` with `native?: boolean` and CLI `--native` flag
- implement `executeRefNativeClick` / `executeRefNativeFill` in the executor
- enforce the main-frame-only boundary for native ref actions unless frame-aware CDP coordinate resolution is implemented and tested in the same chunk
- improve `ref_click` / `ref_fill` error messages to include `refId`, `selector`, `tabId`, `frameId`, and root cause
- add tests or manual smoke coverage
- update docs

Validation:

```bash
./check.sh
npm run build
npm run build:cli
```

Stop point: native and synthetic ref paths are both covered by tests or documented manual smoke evidence, subframe native refs fail clearly unless real frame support was implemented, native failures do not fall back silently, and all three validation commands pass.

### Chunk G: docs + skill + changelog

Scope (Phase 8):

- update `skills/shuvgeist/SKILL.md` with the deterministic e2e assertions section
- update `README.md` with the CI example
- add `docs/e2e-ci.md`
- add `CHANGELOG.md` entries under `## [Unreleased]`

Validation:

```bash
./check.sh
```

Stop point: README, `docs/e2e-ci.md`, skill docs, and changelog are aligned with the implemented command surface, and `./check.sh` passes.

### Chunk H (follow-up): migrate remaining call sites onto the helper

Scope (out of the critical CI path; can land any time after Chunk A):

- migrate `capturePageSnapshot()` in `src/tools/page-snapshot.ts`
- migrate `executeRefDomAction()` in `src/bridge/browser-command-executor.ts`
- migrate the REPL `buildWrapperCode()` path in `src/tools/repl/userscripts-helpers.ts` (will need a console-capture-on variant matching the existing REPL contract)

Validation:

```bash
./check.sh
npm run build
npm run build:cli
```

Stop point: remaining page execution call sites use the shared helper without changing their public behavior, and all three validation commands pass.

## Risks and mitigations

### Protocol compatibility

Adding bridge methods is additive, but older extensions will not advertise `page_assert`.

Mitigation:

- CLI should surface the existing capability-disabled error clearly.
- Only bump bridge protocol version if wire compatibility actually becomes breaking.

### Target focus drift

If workflows keep using active-tab defaults, CI can still be flaky.

Mitigation:

- document `"target": { "mode": "new-tab" }` as the CI default
- make examples always pin a target
- consider warning when workflows use assertion steps without explicit target mode

### Expression assertion security

Expression assertions execute user-provided JavaScript in the page script world. This is equivalent in trust to existing local REPL/eval commands.

Mitigation:

- document that assertion expressions are trusted local CLI input
- `assert expr --world main` routes through the existing sensitive `eval` path and inherits its gating

### User-script world cannot see app JS internals

Page assertions in user-script world can inspect DOM but cannot see page MAIN-world JavaScript state (`window.__APP_STATE__`, framework devtools hooks, anything not on a DOM element).

Mitigation:

- default `assert expr` to `world: "user"` and emit a helpful hint in the failure message pointing at `--world main`
- ship `--world main` from day one rather than as a follow-up, to avoid a protocol change later
- gate `--world main` behind the same sensitive-access toggle as `shuvgeist eval`

### Native input depends on debugger behavior

Native ref actions may require debugger attachment and settings.

Mitigation:

- follow existing native input/provider gating
- return explicit capability or execution errors
- do not silently fallback to synthetic DOM events

## Definition of done

The work is complete when:

1. `shuvgeist assert ...` runs assertions in the app page context by default.
2. Assertion failures return structured details and exit nonzero in CLI.
3. Workflow assertion steps support auto-waiting and structured results.
4. Workflows can pin and propagate target tabs across steps.
5. Semantic ref actions support `--native` trusted input.
6. Documentation and the external skill guide teach agents to use Shuvgeist assertions for CI.
7. `./check.sh`, `npm run build`, and `npm run build:cli` pass after implementation.
