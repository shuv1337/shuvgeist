# Plan: Element Inspector → Chat Attachment

Add an "inspect element"-style picker to the Shuvgeist sidepanel so the user can point at any element in the active page and stage it as an attachment in the chat composer. The user then types their question and sends — the element's structured context (selector, HTML, bounding box, etc.) rides along with the prompt as an attachment the agent can read.

Inspired by the Claude Desktop app's Preview inspector and by [react-grab](https://github.com/aidenybai/react-grab). The MVP is framework-agnostic; React component detection is explicitly deferred to a stretch PR.

## Relevant Codebase Alignment

- **Element picker overlay already exists**: [`src/tools/ask-user-which-element.ts`](src/tools/ask-user-which-element.ts) contains `createElementPickerOverlay()` (lines 56–500) plus the `chrome.userScripts.execute()` injection glue. Today it is called only by the agent tool; we will refactor it into a shared helper that both the agent tool and the new user-initiated flow use.
- **`ElementInfo` type already defined** at [`ask-user-which-element.ts:21-36`](src/tools/ask-user-which-element.ts): `{ selector, xpath, html, tagName, attributes, text, boundingBox, computedStyles, parentChain }`. No changes needed.
- **Composer exposes a staging API**: `AgentInterface.setInput(text, attachments?)` at `node_modules/@mariozechner/pi-web-ui/src/components/AgentInterface.ts:49-58` programmatically seeds the editor with text + attachments. Staged attachments render as `<attachment-tile>` via `MessageEditor` and flow into `prompt()` automatically as a `user-with-attachments` message.
- **`Attachment` shape is permissive**: `{ id, type: "image" | "document", fileName, mimeType, size, content, extractedText?, preview? }` (attachment-utils.ts:11-20). Our element becomes a `type: "document"` attachment with `mimeType: "application/json"` and the serialized context in `extractedText`. No fork of pi-web-ui required.
- **Tab resolution already exists**: `resolveTabTarget` in `src/tools/helpers/browser-target.ts` — reused as-is.
- **Toast + ChatPanel already available** in `src/sidepanel.ts` for user feedback and wiring the button.

## Goals

1. User clicks a button in the sidepanel → cursor becomes an element picker on the active tab.
2. User clicks an element → picker dismisses, element context is staged as an attachment chip in the composer.
3. User can add text, remove the chip, or pick additional elements before sending.
4. On send, the agent receives the element context inside a `user-with-attachments` message — the existing attachment pipeline carries it with no special handling.
5. Zero modifications to `pi-web-ui`, `pi-agent-core`, or the bridge protocol.
6. Agent-tool behavior (`AskUserWhichElementTool`) is unchanged after the refactor.

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
 resolveTabTarget() ──► picker.ts (shared)
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
 chatPanel.agentInterface.setInput(
   existingText,
   [...existingAttachments, elementAttachment])
        │
        ▼
 MessageEditor renders <attachment-tile>
        │
        ▼  (user types + hits Send)
 UserMessageWithAttachments { role, content, attachments } ──► agent.prompt()
```

### Why masquerade as a document attachment

The `Attachment` union is only `"image" | "document"`. Extending it means forking `pi-web-ui`, which we want to avoid. A `type: "document"` attachment with structured `extractedText` renders cleanly in `AttachmentTile` (falls through to the document-icon branch at lines 70–86), shows a truncated filename, and exposes the full content via the existing `AttachmentOverlay` click handler. The model sees `extractedText` — the same path used for PDFs, DOCX, text files. No new renderer, no new tool, no protocol changes.

### Attachment shape for an inspected element

```ts
{
  id: `element_${Date.now()}_${random}`,
  type: "document",
  fileName: truncatedSelector + ".json",  // e.g. "h3.text-lg.json"
  mimeType: "application/json",
  size: extractedText.length,
  content: base64(extractedText),         // required by Attachment contract
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
      computedStyles: { fontSize: "18px" },
      parentChain: ["section.card", "main"],
      html: "<h3 class=\"text-lg font-semibold text-foreground\">Team and graph relationships</h3>"
    }
  }, null, 2)
}
```

Using JSON instead of ad-hoc XML removes the need for manual entity escaping. All user-controlled strings (`selector`, `text`, attribute values, `html`, page title) are serialized through `JSON.stringify()`, so `<`, `&`, quotes, and `]]>`-style edge cases cannot corrupt the payload format.

---

## Files

### New files

#### `src/tools/helpers/element-picker.ts`

Shared picker module. Extracted from `ask-user-which-element.ts`.

```ts
export async function pickElement(
  tabId: number,
  opts?: { message?: string }
): Promise<ElementInfo>;
```

Contents moved from `ask-user-which-element.ts`:
- `createElementPickerOverlay` (lines 56–500)
- The `chrome.userScripts.execute` wrapper with `world: "USER_SCRIPT"` and `worldId: "shuvgeist-element-picker"`
- The `window.__shuvgeistElementPicker` guard
- Error surface for cancel / already-running / injection-blocked

No behavior change — just relocation. `ElementInfo` type re-exported from here.

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
- Build the JSON payload from `ElementInfo`
- Truncate `html` to ~4KB with `<!-- [truncated] -->` marker
- Truncate `computedStyles` to the 20 most-likely-useful properties (font-size, color, display, position, width, height, margin, padding, border — full list TBD during implementation; default pruning list in the module)
- Cap `parentChain` depth to 6
- Build `fileName` from the selector, truncated so the 10-char tile label still makes sense (e.g. `h3.text-lg` not `h3.text-lg.font-semibold.text-foreground`)
- Base64-encode `extractedText` into `content` (Attachment contract requires `content` to be base64 of the original bytes)
- Use `JSON.stringify(payload, null, 2)` for `extractedText`; do not hand-roll string concatenation or custom escaping

### Modified files

#### `src/tools/ask-user-which-element.ts`

- Delete the inline picker overlay code (lines 40–500-ish).
- Import `pickElement` from `./helpers/element-picker.ts`.
- The agent tool's `execute()` becomes a thin wrapper: `resolveTabTarget → pickElement → return ElementInfo` (unchanged return shape).

Verification: the agent tool must behave identically — same inputs, same outputs, same error messages.

#### `src/sidepanel.ts`

- Import `Crosshair` from `lucide` (or `MousePointerClick` — TBD during implementation; pick whichever reads clearer in the header).
- In the header render region (near the existing tab/settings controls around the `renderApp` return), add an icon button: `title="Inspect element"`.
- `ChatPanel.agentInterface` is already reachable as a public `@state` field; no `pi-web-ui` changes are needed.
- Click handler:
  1. Resolve active tab via `resolveTabTarget` (reuse existing helper).
  2. Early-return with toast if: `chatPanel.agentInterface` is unavailable / tab URL is `chrome://` or `chrome-extension://` / no tabs matched.
  3. Show a transient toast "Click an element in the page to attach it" (auto-dismiss when picker resolves or errors).
  4. `await pickElement(tabId)`.
  5. On success:
     - Query the live composer state from the existing `message-editor` element:
       `const editor = chatPanel.agentInterface.querySelector("message-editor") as MessageEditor | null`
     - Read:
       `const currentText = editor?.value ?? ""`
       `const currentAttachments = editor?.attachments ?? []`
     - Build the new attachment:
       `const att = elementToAttachment(info, { url, title })`
     - Stage without overwriting the draft:
       `chatPanel.agentInterface.setInput(currentText, [...currentAttachments, att])`
  6. On cancel/error: dismiss toast, show error toast if it was an error (not a cancel).
- Keep the button enabled while streaming. Staging is safe because it only mutates the local composer draft; the existing send path still blocks while `isStreaming` is true.
- Allow staging before the first user message. There is always an in-memory agent/editor even when the session is not yet persisted, so the attachment can be staged and sent normally later.

No other files change. No manifest edit. No background/bridge changes.

---

## Build order

1. **Extract picker to helper** (non-functional refactor).
   - Create `src/tools/helpers/element-picker.ts`.
   - Move overlay code and injection wrapper.
   - Update `ask-user-which-element.ts` to import from the helper.
   - Run: `npm run build` (or existing dev command) and manually fire the agent tool on a test page to confirm identical behavior.

2. **Write `elementToAttachment()`**.
  - Implement serializer with truncation rules.
  - Exercise with 2–3 real `ElementInfo` samples (dump from step 1 during testing) — eyeball the output and confirm the JSON payload reads well to a model.

3. **Add sidebar button + handler**.
   - Header button placement in `sidepanel.ts`.
   - Wire click handler as specified above.
   - Toast on start / error.

4. **Manual test matrix**:
   - ✅ Pick a simple element on a content site → chip appears → send → agent sees content.
   - ✅ Pick a deeply nested element → truncation works, no malformed JSON.
   - ✅ Cancel with Escape → no chip, no errors.
   - ✅ Try to pick on `chrome://extensions` → graceful toast, no crash.
   - ✅ Pick while another pick is in flight → guard fires, toast shown.
   - ✅ Pick, add a second pick → both chips visible, both carried to agent.
   - ✅ Pick, type text, edit, send → agent receives user text + both attachments.
   - ✅ Pick, click chip's × → chip removed, composer retains text.
   - ✅ Pick while streaming → attachment is staged, send remains blocked until streaming ends.
   - ✅ Pick before any user message exists → draft is staged, first send persists the session normally.

5. **Repo validation**:
   - Run `./check.sh`.
   - Run `npm run build` so `dist-chrome/` is updated.

---

## Edge cases

| Case | Behavior |
|---|---|
| Active tab is `chrome://` or extension URL | Button click shows toast "Can't inspect this page"; picker not injected. |
| Picker already active on target tab | Guard at `window.__shuvgeistElementPicker` rejects; surface as toast. |
| User switches tabs mid-pick | MVP: picker stays on original tab until dismissed; we don't attempt to follow. Document as known limitation. |
| HTML > 4KB | Truncate with `[truncated]` marker in the serialized JSON `html` field. |
| `parentChain` > 6 deep | Cap to 6 nearest ancestors. |
| `computedStyles` is huge | Prune to a curated 20-property subset (defined in `element-attachment.ts`). |
| Session is streaming when user clicks | Button remains enabled; attachment is staged; send remains blocked by the existing `isStreaming` guard in `MessageEditor`. |
| No persisted session yet | Allow staging; the draft lives in the existing in-memory editor/agent, and the first send follows the normal new-session persistence flow. |

---

## Stretch PR (separate branch)

Not included in this plan's scope, but designed-for:

- **React fiber detection**: inject a second userScript that walks `__reactFiber$*` keys on the selected element, extracts `type.name` and `_debugSource`. Add `reactComponent` and `sourceFile` fields to `ElementInfo`. Include them in the serialized JSON payload when present. Requires React dev build to preserve source info; degrades gracefully when absent.
- **Element screenshot thumbnail**: after pick, use the existing CDP debugger (`src/tools/helpers/debugger-manager.ts`) to call `Page.captureScreenshot` with a clip matching `boundingBox`. Populate `Attachment.preview` so the tile shows the element image instead of the generic document icon.
- **Keyboard shortcut**: add `commands` entry in `manifest.chrome.json` (e.g. `Ctrl+Shift+E` / `Cmd+Shift+E`); handler in `background.ts` relays to sidepanel via port message; sidepanel triggers the same click handler.
- **Multi-element mode**: hold Shift while clicking to stay in picker mode and accumulate multiple elements before dismissing.

Each of these is additive — the MVP attachment format and the helper modules don't need to change to accept them.
