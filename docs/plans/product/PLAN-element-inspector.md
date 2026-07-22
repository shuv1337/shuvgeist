# Plan: Element Inspector → Chat Attachment

Add an "inspect element"-style picker to the Shuvgeist sidepanel so the user can point at any element in the active page and stage it as an attachment in the chat composer. The user then types their question and sends — the element's structured context (selector, HTML, bounding box, etc.) rides along with the prompt as an attachment the agent can read.

Inspired by the Claude Desktop app's Preview inspector and by [react-grab](https://github.com/aidenybai/react-grab). The MVP is framework-agnostic; React component detection is explicitly deferred to a stretch PR.

## Relevant Codebase Alignment

- **Element picker overlay already exists**: [`src/tools/ask-user-which-element.ts`](src/tools/ask-user-which-element.ts) contains `createElementPickerOverlay()` (lines 56–500) plus the `chrome.userScripts.execute()` injection glue, and an `AbortSignal`-driven cleanup path that dispatches `shuvgeist-element-cancel` into the page. Today it is called only by the agent tool; we will refactor it into a shared helper that both the agent tool and the new user-initiated flow use.
- **`ElementInfo` type already defined** at [`ask-user-which-element.ts:21-36`](src/tools/ask-user-which-element.ts): `{ selector, xpath, html, tagName, attributes, text, boundingBox, computedStyles, parentChain }`. No changes needed.
- **Composer exposes reactive fields directly**: `AgentInterface._messageEditor` is queried via `@query("message-editor")` and `MessageEditor.attachments` / `MessageEditor.value` are both `@property`-reactive. We append to `attachments` directly; we do **not** call `AgentInterface.setInput(text, attachments)` because it also overwrites `value` and would clobber anything the user is typing between the read and the write (see §"Race avoidance" below).
- **`Attachment` shape is permissive**: `{ id, type: "image" | "document", fileName, mimeType, size, content, extractedText?, preview? }` (`node_modules/@mariozechner/pi-web-ui/dist/utils/attachment-utils.d.ts`). Our element becomes a `type: "document"` attachment with `mimeType: "application/json"` and the serialized context in `extractedText`. No fork of pi-web-ui required.
- **Attachments flow to the model via `convertAttachments()`** (`pi-web-ui/dist/components/Messages.js:291`): for `type: "document"` with `extractedText`, it emits a single `TextContent` block `\n\n[Document: <fileName>]\n<extractedText>`. `content` (base64) is **not** read on this path — it is only used by `AttachmentOverlay` for raw preview/download. We still populate it correctly for parity with PDF/DOCX attachments.
- **Tab resolution already exists**: `resolveTabTarget` in `src/tools/helpers/browser-target.ts` — reused as-is.
- **Toast + ChatPanel already available** in `src/sidepanel.ts` (`src/components/Toast.ts` exposes `Toast.show/success/error`).

## Goals

1. User clicks a button in the sidepanel → cursor becomes an element picker on the active tab.
2. User clicks an element → picker dismisses, element context is staged as an attachment chip in the composer.
3. User can add text, remove the chip, or pick additional elements before sending.
4. On send, the agent receives the element context inside a `user-with-attachments` message — the existing attachment pipeline carries it with no special handling.
5. Zero modifications to `pi-web-ui`, `pi-agent-core`, or the bridge protocol.
6. Agent-tool behavior (`AskUserWhichElementTool`) is unchanged after the refactor, including its `AbortSignal` cancellation path.

## Non-Goals for V1

- React fiber detection (component name, `_debugSource` file/line) — stretch PR.
- Element screenshot thumbnail in the attachment tile — stretch PR.
- Global keyboard shortcut via `chrome.commands` — stretch PR.
- Multi-element selection in a single pick session.
- Remote driving of the picker from the CLI bridge (the existing agent tool already covers that path).
- Cross-frame (iframe) element picking.

---

## Architecture

### Data flow

```
[Sidepanel Inspect button]
        │
        ▼
 resolveTabTarget() ──► element-picker.ts (shared)
        │                     │
        │                     ▼
        │            chrome.userScripts.execute(
        │              createElementPickerOverlay,
        │              world: "USER_SCRIPT",
        │              worldId: "shuvgeist-element-picker")
        │                     │
        │                     ▼  (user clicks element)
        │            ElementInfo { selector, xpath, html, ... }
        │                     │
        ▼                     ▼
 elementToAttachment(info) ──► Attachment
        │
        ▼
 editor.attachments = [...editor.attachments, att]   // direct mutation
        │
        ▼
 MessageEditor renders <attachment-tile>
        │
        ▼  (user types + hits Send)
 UserMessageWithAttachments { role, content, attachments } ──► agent.prompt()
```

### Why masquerade as a document attachment

The `Attachment` union is only `"image" | "document"`. Extending it means forking `pi-web-ui`, which we want to avoid. A `type: "document"` attachment with structured `extractedText` renders cleanly in `AttachmentTile` (falls through to the document-icon branch, lines 66–86), shows a truncated filename, and exposes the full content via the existing `AttachmentOverlay` click handler. The model sees `extractedText` via `convertAttachments()` — the same path used for PDFs, DOCX, text files. No new renderer, no new tool, no protocol changes.

Note on format inconsistency: existing document attachments (PDF/DOCX/PPTX/XLSX) serialize `extractedText` as ad-hoc XML (e.g. `<pdf filename="x"><page number="1">…</page></pdf>`). We use JSON instead to avoid hand-rolled escaping of user-controlled strings (`selector`, attribute values, page title, inner HTML). This is a deliberate, scoped divergence — the model consumes the raw text regardless of format.

### Attachment shape for an inspected element

```ts
{
  id: `element_${Date.now()}_${randomId}`,
  type: "document",
  fileName: `${sanitizedSelectorSlug}.json`,   // see §"fileName sanitization"
  mimeType: "application/json",
  size: extractedText.length,                  // bytes of the JSON, not the base64 blob
  content: utf8ToBase64(extractedText),        // UTF-8-safe base64; see §"Base64 encoding"
  extractedText: JSON.stringify({
    kind: "inspected-element",
    page: {
      url: "https://example.com/page",
      title: "Example page"
    },
    element: {
      selector: "h3.text-lg.font-semibold.text-foreground",
      xpath: "/html/body/div/main/h3[1]",
      tagName: "h3",
      text: "Team and graph relationships",
      boundingBox: { x: 240, y: 412, width: 1031, height: 28 },
      attributes: { class: "text-lg font-semibold text-foreground" },
      computedStyles: { fontSize: "18px", color: "rgb(17, 24, 39)" /* … */ },
      parentChain: ["section.card", "main"],
      html: "<h3 class=\"text-lg font-semibold text-foreground\">Team and graph relationships</h3>"
    }
  }, null, 2)
}
```

All user-controlled strings are serialized through `JSON.stringify()`, so `<`, `&`, quotes, and `]]>`-style edge cases cannot corrupt the payload format.

---

## Files

### New files

#### `src/tools/helpers/element-picker.ts`

Shared picker module. Extracted from `ask-user-which-element.ts` with no behavior change.

```ts
export class ElementPickCancelled extends Error {
  readonly code = "cancelled" as const;
}

export async function pickElement(
  tabId: number,
  opts?: { message?: string; signal?: AbortSignal }
): Promise<ElementInfo>;   // throws ElementPickCancelled on Escape / Cancel button / aborted signal
                             // throws Error on other failures (already-running guard, injection blocked)
```

Contents moved from `ask-user-which-element.ts`:
- `createElementPickerOverlay` (lines 56–500) — unchanged.
- The `chrome.userScripts.execute` wrapper with `world: "USER_SCRIPT"` and `worldId` kept as in the current tool.
- The `window.__shuvgeistElementPicker` guard.
- The `AbortSignal` plumbing: subscribe to `signal`, on abort dispatch a second `chrome.userScripts.execute({ js: [{ code: "window.dispatchEvent(new CustomEvent('shuvgeist-element-cancel'))" }] })` and reject with `ElementPickCancelled`.
- Convert the current `resolve(null)` cancel path into `throw new ElementPickCancelled("Element selection was cancelled")` at the helper boundary (the in-page overlay still resolves `null`; the helper translates).

`ElementInfo` is re-exported from this module so existing imports (`ask-user-which-element-renderer.ts`, etc.) keep working via either path. `ask-user-which-element.ts` will re-export from the helper to avoid widespread import rewrites.

##### Minor overlay tweak (inside `getElementInfo`)

Raise the in-page truncation limits so the sidepanel flow has useful context:

- `text`: 500 → **1000** chars.
- `html` (`outerHTML.substring`): 1000 → **4000** chars; if truncated, append the literal marker `"<!-- [truncated] -->"` to the returned string.

The agent-tool path also benefits. Defense-in-depth truncation in `element-attachment.ts` remains in case these ever drift.

#### `src/tools/helpers/element-attachment.ts`

Pure formatting module — no side effects, unit-testable.

```ts
import type { ElementInfo } from "./element-picker.js";
import type { Attachment } from "@mariozechner/pi-web-ui";

export function elementToAttachment(
  info: ElementInfo,
  context: { url: string; title?: string }
): Attachment;
```

Responsibilities:

- Build the JSON payload from `ElementInfo` and `context`.
- Defensive truncation: `html` capped at 4096 chars (with `<!-- [truncated] -->` marker); `text` capped at 1000 chars.
- Prune `computedStyles` to a curated 20-key allowlist defined as a module constant:
  `display, position, width, height, margin, padding, border, color, backgroundColor, fontFamily, fontSize, fontWeight, lineHeight, textAlign, opacity, zIndex, overflow, visibility, cursor, boxSizing`.
  Missing keys are dropped, not emitted as `undefined`.
- Cap `parentChain` to the 6 nearest ancestors.
- **fileName sanitization** (see §"fileName sanitization" below).
- **Base64 encoding** (see §"Base64 encoding" below).
- `JSON.stringify(payload, null, 2)` for `extractedText`. Never hand-roll string concatenation.

##### fileName sanitization

Selectors contain characters invalid in filenames (`/`, `:`, `[`, `]`, `#`, `"`, spaces). Sanitize:

```ts
const slug =
  (info.selector || info.tagName || "element")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "element";
const fileName = `${slug}.json`;
```

This keeps `AttachmentTile`'s 10-char truncation readable (`h3.text-lg…`).

##### Base64 encoding

`btoa()` throws on non-ASCII (emoji, CJK, em-dash in page text, etc.). Use a UTF-8-safe encoder:

```ts
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
```

`content` is populated for parity with PDF/DOCX attachments (so `AttachmentOverlay` can render the raw JSON), but is not on the hot path to the LLM.

### Modified files

#### `src/tools/ask-user-which-element.ts`

- Delete the inline overlay code (lines 40–500-ish) and the `chrome.userScripts.execute` wrapper block.
- Re-export `ElementInfo` from `./helpers/element-picker.js` to preserve external imports (e.g. `ask-user-which-element-renderer.ts`).
- `execute()` becomes a thin wrapper:
  1. Check `signal?.aborted`.
  2. `resolveTabTarget({ windowId })`.
  3. Replicate the existing protected-URL guard: `chrome://`, `chrome-extension://`, `moz-extension://`, `about:`.
  4. `const info = await pickElement(tabId, { message: args.message, signal })`.
  5. Build the same human-readable `output` string the current tool returns.
  6. On `ElementPickCancelled`, throw `new Error("Element selection was cancelled")` (matches existing behavior).

Verification: the tool must behave identically — same inputs, same outputs, same error messages, same abort semantics.

#### `src/sidepanel.ts`

- Import `Crosshair` from `lucide` (drop-in with existing `History`, `Plus`, `Settings` imports).
- Import `pickElement, ElementPickCancelled` from `./tools/helpers/element-picker.js`.
- Import `elementToAttachment` from `./tools/helpers/element-attachment.js`.
- Import `Toast` from `./components/Toast.js`.
- Import `resolveTabTarget` from `./tools/helpers/browser-target.js`.
- In the header render region (inside the existing right-side controls: `<div class="flex items-center gap-1 px-2">`, immediately **before** the existing `Settings` button), add:

```ts
${Button({
  variant: "ghost",
  size: "sm",
  children: icon(Crosshair, "sm"),
  onClick: onInspectElementClick,
  title: "Inspect element",
})}
```

- Click handler `onInspectElementClick()`:
  1. If `!chatPanel.agentInterface`, `Toast.show("Chat is not ready yet", "error")`; return.
  2. Resolve active tab via `resolveTabTarget({ windowId: currentWindowId })`; wrap in try/catch → error toast on failure.
  3. Reject protected URLs: `tab.url` starts with `chrome://`, `chrome-extension://`, `moz-extension://`, or `about:` → `Toast.show("Can't inspect this page", "error")`; return.
  4. Access the editor directly:
     ```ts
     const editor = chatPanel.agentInterface.querySelector("message-editor") as MessageEditor | null;
     if (!editor) { Toast.show("Composer not ready", "error"); return; }
     if (editor.attachments.length >= editor.maxFiles) {
       Toast.show(`Max ${editor.maxFiles} attachments reached`, "error");
       return;
     }
     ```
  5. `const toast = Toast.show("Click an element in the page to attach it", "info", 30000);` (long duration — dismissed explicitly below).
  6. `try { const info = await pickElement(tabId); const att = elementToAttachment(info, { url: tab.url!, title: tab.title }); editor.attachments = [...editor.attachments, att]; } catch (err) { if (!(err instanceof ElementPickCancelled)) Toast.show(err.message || "Inspect failed", "error"); } finally { toast.remove(); }`
- Keep the button enabled during streaming; staging mutates local composer state only, and `MessageEditor.handleSend` already blocks on `isStreaming`.
- Staging before the first user message is safe — the in-memory `agent`/editor exist from app bootstrap, and the first send follows the normal new-session persistence path.

No other files change. No manifest edit. No background/bridge changes.

### Race avoidance — why we mutate `editor.attachments` directly

`AgentInterface.setInput(text, attachments)` (pi-web-ui `AgentInterface.js:53`) sets both `_messageEditor.value = text` and `_messageEditor.attachments = attachments` inside a RAF callback. If we read `editor.value` before awaiting the picker and then call `setInput(currentText, [...currentAttachments, att])`, any keystrokes the user types during the pick (which can last many seconds) are silently discarded on the write.

Mutating only `editor.attachments`:

- avoids touching `value`, so typed text is never overwritten;
- is immediate (no RAF deferral);
- is reactive — `MessageEditor.attachments` is `@property` and Lit re-renders the tiles automatically.

This relies on pi-web-ui internals (the `message-editor` custom element name, the `attachments` property, the `maxFiles` property). These are all part of the exported API surface or stable in the shipped `.d.ts`. If pi-web-ui renames either, the sidepanel flow fails loudly (querySelector returns null → error toast). Documented as a known coupling.

---

## Build order

1. **Extract picker to helper** (non-functional refactor).
   - Create `src/tools/helpers/element-picker.ts`.
   - Move overlay code, injection wrapper, and abort-signal plumbing verbatim.
   - Introduce `ElementPickCancelled`.
   - Apply the `text` (500→1000) and `html` (1000→4000 + truncated marker) limit bumps inside `getElementInfo`.
   - Update `ask-user-which-element.ts` to import from the helper and re-export `ElementInfo`.
   - Verify: run the agent tool on a test page; confirm selector, html length, and cancel behavior match the pre-refactor baseline.

2. **Write `elementToAttachment()`**.
   - Implement with the allowlist, truncation rules, sanitized fileName, UTF-8-safe base64.
   - Dump 2–3 real `ElementInfo` samples captured during step 1; eyeball the JSON; verify `fileName` parses into a readable tile label and contains no filesystem-hostile chars.

3. **Add sidebar button + handler**.
   - Icon button placement in `sidepanel.ts` (inside the right-side controls, before `Settings`).
   - Wire `onInspectElementClick` exactly as specified.
   - Long-lived "Click an element in the page to attach it" toast on start, dismissed in `finally`.

4. **Manual test matrix**:
   - ✅ Pick a simple element on a content site → chip appears → send → agent sees `[Document: <name>.json]` followed by the JSON payload.
   - ✅ Pick an element containing non-ASCII text (emoji, CJK, em-dash) → no `btoa` throw; JSON round-trips cleanly.
   - ✅ Pick an element with `#`, `:`, spaces, `[`, `]` in the selector → `fileName` sanitized, tile readable.
   - ✅ Pick a deeply nested element → `parentChain` capped at 6, no malformed JSON.
   - ✅ Cancel with Escape → no chip, no error toast (cancellation is silent).
   - ✅ Cancel with the in-page "Cancel (ESC)" button → same behavior.
   - ✅ Try to pick on `chrome://extensions`, `about:blank`, a `moz-extension://` page → graceful toast, no crash, picker not injected.
   - ✅ Pick while another pick is in flight → `window.__shuvgeistElementPicker` guard fires; helper rejects; error toast shown.
   - ✅ Pick two elements in succession → both chips visible, both carried to agent.
   - ✅ Type in the composer, then pick an element mid-sentence → typed text is preserved (race fix).
   - ✅ Pick, click chip's × → chip removed, composer retains text.
   - ✅ Pick while streaming → chip stages; send remains blocked by `MessageEditor.isStreaming`.
   - ✅ Pick before any user message exists → chip stages; first send persists the session normally.
   - ✅ Attempt an 11th pick when `maxFiles=10` is already reached → error toast, picker not launched.
   - ✅ Regression: run the agent's `ask_user_which_element` tool — same output text, same cancel error message, same abort behavior (abort the agent mid-pick and confirm the overlay cleans up).

5. **Repo validation**:
   - `./check.sh` clean.
   - `npm run build` so `dist-chrome/` is updated.

---

## Edge cases

| Case | Behavior |
|---|---|
| Active tab is `chrome://`, `chrome-extension://`, `moz-extension://`, or `about:` | Button click shows toast "Can't inspect this page"; picker not injected. |
| Picker already active on target tab | `window.__shuvgeistElementPicker` guard rejects; surface as toast. |
| User switches tabs mid-pick | MVP: picker stays on original tab until dismissed; we do not follow. Known limitation. |
| `maxFiles` already reached | Error toast; picker not launched. |
| `html` > 4KB | Overlay truncates at 4KB and appends `<!-- [truncated] -->`; serializer re-checks as defense-in-depth. |
| `parentChain` > 6 deep | Serializer caps to 6 nearest ancestors. |
| `computedStyles` | Pruned by serializer to a 20-key allowlist. |
| Element text contains non-ASCII | `utf8ToBase64` handles it; `extractedText` (JSON string) is already Unicode-safe. |
| Session is streaming when user clicks | Button remains enabled; attachment is staged; send remains blocked by `MessageEditor.isStreaming`. |
| No persisted session yet | Allow staging; first send follows the normal new-session persistence flow. |
| Agent tool aborted via `AbortSignal` mid-pick | Helper dispatches `shuvgeist-element-cancel` to the page and rejects with `ElementPickCancelled`; the agent tool surface re-throws as before. |

---

## Stretch PR (separate branch)

Not included in this plan's scope, but designed-for:

- **React fiber detection**: inject a second userScript that walks `__reactFiber$*` keys on the selected element, extracts `type.name` and `_debugSource`. Add `reactComponent` and `sourceFile` fields to `ElementInfo`. Include them in the serialized JSON payload when present. Requires a React dev build to preserve source info; degrades gracefully when absent.
- **Element screenshot thumbnail**: after pick, use the existing CDP debugger (`src/tools/helpers/debugger-manager.ts`) to call `Page.captureScreenshot` with a clip matching `boundingBox`. Populate `Attachment.preview` so the tile shows the element image instead of the generic document icon.
- **Keyboard shortcut**: add `commands` entry in `manifest.chrome.json` (e.g. `Ctrl+Shift+E` / `Cmd+Shift+E`); handler in `background.ts` relays to sidepanel via port message; sidepanel triggers the same click handler.
- **Multi-element mode**: hold Shift while clicking to stay in picker mode and accumulate multiple elements before dismissing.

Each of these is additive — the MVP attachment format and the helper modules don't need to change to accept them.
