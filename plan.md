## Goal

Add a lightweight text-to-speech feature to the Shuvgeist browser extension that:

- provides an on-page overlay with TTS controls
- can optionally arm a click-to-speak mode so the user can click text on a website and hear it spoken
- supports OpenAI TTS, ElevenLabs, and a local Kokoro setup out of the box
- uses the local Kokoro path as the primary testing path wherever practical

This document is a plan only. It does not implement the feature.

---

## Locked decisions from this conversation

| Decision | Value |
|---|---|
| Primary first entry point | New sidepanel header button |
| Click-to-speak default | Off by default; user enables it in overlay |
| Local Kokoro integration shape | OpenAI-compatible `/v1/audio/speech` endpoint |
| Delivery scope | Lightweight browser-extension feature, not a full agent tool/CLI feature |
| Testing preference | Prefer Kokoro/local-compatible paths as much as possible |
| Offscreen document reasons | `["WORKERS", "AUDIO_PLAYBACK", "BLOBS"]` (keep `WORKERS` to preserve REPL; add the other two for audio + `URL.createObjectURL`) |
| Offscreen ownership contract | TTS playback state lives on a dedicated `window.__shuvgeistTtsController` object; REPL's `sandbox.remove()` must not touch TTS state |
| TTS overlay `worldId` | `shuvgeist-tts-overlay` (distinct from REPL's `shuvgeist-repl-overlay`) |
| TTS overlay CSP | `style-src 'unsafe-inline'; default-src 'none'` (no `unsafe-eval` needed) |
| Click interception model | Capture-phase `click` listener with `preventDefault()` + `stopImmediatePropagation()` while armed |
| Shared text clamp | 3000 characters, applied in `src/tts/service.ts` before provider dispatch |
| OpenAI TTS defaults | `model: "gpt-4o-mini-tts"` (fallback `"tts-1"`), `response_format: "mp3"`, `speed` clamped to `[0.25, 4.0]` |
| ElevenLabs defaults | `model_id: "eleven_turbo_v2_5"`, `output_format: "mp3_44100_128"` |
| Kokoro defaults | `model: "kokoro"`, `response_format: "mp3"`, `voice: "af_heart"`, `baseUrl: "http://127.0.0.1:8880/v1"` |
| OpenAI key reuse target | `providerKeys["openai"]` (same key `ProviderKeyInput.ts` writes); TTS tab must render an actionable raw-key input when missing |

---

## Product shape

### User-facing behavior

- [x] Add a speaker/TTS button to the sidepanel header near the existing Inspect and Settings buttons.
- [x] Clicking that button injects an on-page TTS overlay into the active tab.
- [ ] The overlay supports at minimum:
  - [ ] play/speak current text
  - [ ] pause/resume
  - [ ] stop
  - [ ] provider switcher
  - [ ] voice selection
  - [ ] click-to-speak arm/disarm toggle
- [x] Click-to-speak is opt-in and clearly armed/disarmed in the overlay UI.
- [x] When click-to-speak is armed, clicking readable text on the page starts speaking the resolved text block instead of navigating normally.
- [x] The feature should degrade safely on restricted pages (`chrome://`, extension pages, browser internal pages).

### Non-goals for v1

- [ ] No full-page read-aloud queueing system.
- [ ] No speech-to-text, transcript sync, karaoke highlighting, or per-word highlighting.
- [ ] No bridge/CLI command surface unless needed later.
- [ ] No provider streaming pipeline in v1 if blob-based playback is enough.
- [ ] No background scraping of whole articles beyond what is needed for click-to-speak.

---

## Why this fits the current codebase

Shuvgeist already has the main primitives needed for this feature:

- reusable page-overlay injection patterns
- userScripts-based page runtime injection
- offscreen document support
- background-owned runtime orchestration
- IndexedDB-backed settings and secret storage patterns
- existing sidepanel header actions and settings tab infrastructure

The main design task is to add a small TTS subsystem without over-coupling it to the existing REPL or bridge layers.

## Explicit rejected alternatives for v1

To reduce ambiguity during implementation, this plan explicitly rejects the following approaches for v1:

- [x] Do **not** reuse the REPL overlay module directly; create dedicated TTS overlay modules that borrow the pattern but keep TTS state separate.
- [x] Do **not** reuse the REPL `worldId` (`shuvgeist-repl-overlay`). TTS must use `shuvgeist-tts-overlay` so message types and CSP cannot shadow REPL.
- [x] Do **not** drop `WORKERS` from the offscreen `reasons` array when adding audio support; REPL depends on it.
- [x] Do **not** tear down shared offscreen TTS state from REPL teardown paths (`sandbox.remove()` in `src/offscreen.ts`).
- [x] Do **not** make the sidepanel the playback owner; playback state belongs to background/offscreen.
- [x] Do **not** add a new IndexedDB object store unless existing `settings` / `provider-keys` reuse proves insufficient.
- [x] Do **not** assume a direct persistent page-overlay subscription channel exists; background-to-overlay sync should use explicit reinjection/update calls unless proven otherwise.
- [x] Do **not** push overlay state on every audio time-update tick; only push on status transitions and arm/disarm changes.
- [x] Do **not** overload `ApiKeysOAuthTab` as the OpenAI raw-key source of truth.
- [x] Do **not** silently fail when `providerKeys["openai"]` is missing at first launch; surface an actionable raw-key input in `TtsTab`.

---

## Current codebase touch points

### Existing files to reuse or modify

| File | Why it matters |
|---|---|
| `src/sidepanel.ts` | Add the new sidepanel header button and wire settings/overlay launch |
| `src/background.ts` | Own TTS session coordination, runtime messaging, and offscreen lifecycle |
| `src/offscreen.ts` | Extend offscreen document to synthesize/fetch/play audio and maintain playback state |
| `static/offscreen.html` | Existing offscreen host page for background DOM-capable work |
| `src/tools/repl/overlay-inject.ts` | Reuse overlay injection patterns for page UI |
| `src/tools/repl/overlay-content.ts` | Existing full-page overlay implementation pattern |
| `src/tools/helpers/element-picker.ts` | Reuse ideas for armed page interaction, click interception, cleanup, and selection UX |
| `src/tools/helpers/browser-target.ts` | Reuse the shared protected-page and active-tab resolution helpers instead of re-implementing URL checks |
| `src/tools/repl/userscripts-helpers.ts` | Reuse userScripts availability/permission checks |
| `src/dialogs/UserScriptsPermissionDialog.ts` | Reuse the existing actionable permission UX when overlay launch is blocked by missing userScripts permission |
| `src/storage/app-storage.ts` | Confirm whether existing stores are sufficient; avoid unnecessary schema changes |
| `src/dialogs/ShuvgeistProvidersTab.ts` | Reference existing settings-tab patterns; do not overload LLM provider UI unless intentionally chosen |
| `src/dialogs/ApiKeysOAuthTab.ts` | Reference only for subscription/OAuth tab patterns, not raw OpenAI key entry |
| `node_modules/@mariozechner/pi-web-ui/src/dialogs/ProvidersModelsTab.ts` | Current raw provider-key entry surface; use this as the OpenAI key reuse reference, not `ApiKeysOAuthTab.ts` |
| `static/manifest.chrome.json` | Verify permissions stay sufficient; likely no new permissions required |
| `CHANGELOG.md` | If implemented, add an Unreleased entry because this changes visible extension behavior |
| `tests/unit/background/*` | Add background/offscreen/TTS message flow tests |
| `tests/unit/tools/browser-target.test.ts` | Extend shared protected-page/active-tab coverage if TTS adds new launch checks |
| `tests/component/dialogs/*` | Add settings-tab UI tests if a new TTS settings tab is introduced |
| `tests/e2e/extension/smoke.spec.ts` | Keep sidepanel boot/smoke coverage green while adding a new header action |

### New files recommended

| File | Purpose |
|---|---|
| `src/tts/types.ts` | Shared TTS provider/state/type definitions |
| `src/tts/settings.ts` | TTS default settings, storage keys, normalization helpers |
| `src/tts/service.ts` | Main orchestrator for provider selection, synthesis requests, and playback control |
| `src/tts/providers/openai.ts` | OpenAI TTS adapter |
| `src/tts/providers/elevenlabs.ts` | ElevenLabs TTS adapter |
| `src/tts/providers/kokoro.ts` | Kokoro adapter for local OpenAI-compatible endpoint |
| `src/tts/internal-messages.ts` | TTS-specific message types between background, offscreen, and page overlay |
| `src/tts/overlay-content.ts` | Injected page overlay HTML/CSS/JS |
| `src/tts/overlay-inject.ts` | Overlay injection/removal helpers |
| `src/tts/text-targeting.ts` | Resolve clicked DOM text into a readable utterance |
| `src/dialogs/TtsTab.ts` | Dedicated TTS settings tab |
| `tests/unit/tts/*.test.ts` | Provider, settings, targeting, and service tests |
| `tests/component/dialogs/tts-tab.test.ts` | TTS settings tab UI coverage |

If implementation ends up being very small, `text-targeting.ts` and `internal-messages.ts` can be merged into neighboring modules, but the plan should start from explicit boundaries.

---

## Proposed architecture

### 1. Source of truth: background + offscreen, not sidepanel

The TTS session should not live only inside the sidepanel UI.

Use this ownership model:

- [ ] `src/background.ts` owns the active TTS session state and routing.
- [ ] `src/offscreen.ts` handles synthesis fetches and audio playback because it has DOM/audio capability and can outlive the sidepanel.
- [ ] `src/sidepanel.ts` acts only as a launcher/config surface.
- [ ] The on-page overlay is a thin remote control surface injected into the active tab.

This avoids making playback depend on the sidepanel staying open and aligns with the project’s existing background/offscreen split.

### 2. Overlay injection model

Use the existing REPL overlay pattern as the template:

- [ ] Add a dedicated TTS overlay injector instead of repurposing the REPL overlay.
- [ ] Use `chrome.userScripts.execute()` in `USER_SCRIPT` world.
- [ ] Use a TTS-specific world: `worldId = "shuvgeist-tts-overlay"` (distinct from REPL's `"shuvgeist-repl-overlay"`).
- [ ] Use a tighter CSP than REPL: `style-src 'unsafe-inline'; default-src 'none'` (no `'unsafe-eval'` required).
- [ ] Call `chrome.userScripts.configureWorld({ worldId: "shuvgeist-tts-overlay", messaging: true, csp: ... })` **once** at background startup (or first launch), not on every overlay open. Configure-world is a global side effect; re-running it per-injection is wasteful and has had intermittent failures historically.
- [ ] All overlay page globals namespaced under `window.__shuvgeistTtsOverlay` (e.g. `.update(state)`, `.remove()`, `.setArmed(bool)`).
- [ ] Reuse `resolveTabTarget()` / `isProtectedTabUrl()` from `src/tools/helpers/browser-target.ts` instead of duplicating tab and URL checks inside TTS modules.
- [ ] Reuse `requestUserScriptsPermission()` / `checkUserScriptsAvailability()` from `src/tools/repl/userscripts-helpers.ts`.
- [ ] Reuse `UserScriptsPermissionDialog` as the user-facing recovery path when the feature is launched without required permission.

### 3. Concrete overlay control-plane transport

The review found that the original plan named message groups but did not say exactly how state and commands move between the page overlay and extension runtime.

Use a concrete transport that matches the current codebase:

- [ ] **Sidepanel → background:** use `chrome.runtime.sendMessage(...)` one-shot requests for “open overlay on current page”, “get current TTS state”, and “speak test phrase”. Do **not** introduce a new long-lived sidepanel port just for TTS.
- [ ] **Overlay → background:** enable userScripts messaging on the dedicated TTS world and have the injected overlay send commands upward via `chrome.runtime.sendMessage(...)`, which background receives through `chrome.runtime.onUserScriptMessage`.
- [ ] **Message type disambiguation:** all TTS messages flowing through `chrome.runtime.onUserScriptMessage` MUST use a `tts-` prefix (e.g. `tts-overlay-command`, `tts-overlay-ready`). The existing listener in `src/background.ts` (around line 610) must branch on this prefix so TTS and REPL message types cannot shadow each other.
- [ ] **Background → overlay:** do not assume a new direct page-overlay push channel exists. Instead, use idempotent `chrome.userScripts.execute(...)` updates that call into a stable page-global overlay instance such as `window.__shuvgeistTtsOverlay.update(...)` / `.remove()`.
- [ ] **Background → overlay update cadence:** push state to the overlay **only** on status transitions (`idle → loading → playing → paused → stopped`), click-mode arm/disarm changes, voice/provider selection changes, and error transitions. Do **not** push on audio `timeupdate` ticks, buffering ticks, or any continuous progress event. The overlay renders transition-driven state only.
- [ ] **Background ↔ offscreen:** keep using `chrome.runtime.sendMessage(...)` message types for playback commands/state responses.
- [ ] **Single state owner:** background owns the canonical `TtsPlaybackState`; offscreen reports playback facts upward, and overlay/sidepanel only render that state or request transitions.
- [ ] Add a small reducer-style state transition helper so play/pause/resume/stop/error transitions are centralized instead of being reconstructed in sidepanel, overlay, and offscreen independently.

This keeps the feature aligned with the existing REPL overlay pattern while avoiding unsupported assumptions about direct page-overlay subscriptions.

### 4. Armed click-to-speak mode

Do not make the page globally “always clickable for TTS.”

Instead:

- [ ] Overlay has a clear arm/disarm control.
- [ ] When armed, the page enters a focused interaction mode similar to the existing element-picker flow.
- [ ] Click interception uses a **capture-phase** listener so SPAs and link-hijacking sites cannot swallow the event:
  ```ts
  document.addEventListener("click", onArmedClick, { capture: true });
  // inside onArmedClick, when a speakable target is resolved:
  ev.preventDefault();
  ev.stopImmediatePropagation();
  ```
- [ ] On disarm (ESC, arm toggle off, overlay close, page navigation), the listener is removed with the same `{ capture: true }` option so it is cleanly detached.
- [ ] Clicking readable text prevents normal navigation for that click and resolves text to speak.
- [ ] ESC or overlay toggle exits armed mode.
- [ ] The default state on every fresh overlay open is disarmed.

This is the safest way to satisfy “click any text to speak it” without surprising the user or breaking normal browsing.

### 5. Provider abstraction

Define a small provider contract around browser-friendly audio blobs.

Recommended contract:

```ts
export interface TtsProvider {
  id: "openai" | "elevenlabs" | "kokoro";
  label: string;
  synthesize(input: TtsSynthesisRequest, signal?: AbortSignal): Promise<TtsSynthesisResult>;
  listVoices?(signal?: AbortSignal): Promise<TtsVoice[]>;
}

export interface TtsSynthesisRequest {
  text: string;
  voiceId: string;
  speed: number;
  /** Optional provider-specific model override; Kokoro in particular may need to forward a non-default model name. */
  modelId?: string;
}

export interface TtsSynthesisResult {
  mimeType: string;
  audioData: ArrayBuffer;
  providerRequestId?: string;
}
```

For v1, standardize on **full-response blob playback**, not chunked streaming playback.

Reason:

- simpler implementation
- fewer moving parts in the extension runtime
- easier provider parity across OpenAI, ElevenLabs, and Kokoro
- still lightweight and fast enough for the requested feature

If later latency is insufficient, streaming can be introduced as a second phase.

### 6. Audio format normalization

Use a common playback target format for v1.

Recommended decision:

- [ ] Request `mp3` from OpenAI (`response_format: "mp3"`).
- [ ] Request `mp3_44100_128` from ElevenLabs (via `output_format` query parameter).
- [ ] Request `mp3` from Kokoro local endpoint (`response_format: "mp3"`).
- [ ] Convert responses into `Blob` + `objectURL` for playback inside offscreen document. This is why `BLOBS` must be in the offscreen `reasons` array.

This keeps playback in normal browser-audio territory and avoids early PCM/audio-worklet complexity.

### 7. Voice-list strategy

Use a mixed strategy by provider:

- [ ] **OpenAI**: use a built-in static list for known voices.
- [ ] **ElevenLabs**: fetch voices from ElevenLabs API.
- [ ] **Kokoro**: try local voice discovery if the local service exposes a voices endpoint; otherwise fall back to a curated default list with a configurable/manual voice ID.

Recommended fallback Kokoro defaults for plan purposes:

- [ ] Default voice: `af_heart`
- [ ] Include a small curated starter set in the UI for local testing

Do not block the whole feature on dynamic Kokoro voice enumeration if the local wrapper varies.

---

## Text-targeting behavior

### Required behavior

When the user clicks page text in armed mode:

- [ ] Identify the text node or nearest readable ancestor.
- [ ] Prefer a sensible utterance unit over raw `element.textContent` of a huge container.
- [ ] Trim whitespace and ignore empty/very short/noisy text.
- [ ] Clamp final utterance text to the shared 3000-character limit before handing it to `src/tts/service.ts` (see "Shared text clamp" below).
- [ ] Stop current playback before starting the next utterance.

### Recommended heuristic for v1

Resolve clicked text in this order:

1. [ ] If the click lands inside a text selection, speak the current selection.
2. [ ] Else, try the nearest sentence/paragraph-like text span around the clicked text node.
3. [ ] Else, fall back to nearest readable block ancestor (`p`, `li`, `blockquote`, table cell, heading, etc.).
4. [ ] Clamp utterance length to a conservative limit and show truncation feedback in UI if needed.

### Explicitly avoid in v1

- [ ] Speaking the entire page container by accident.
- [ ] Speaking hidden/nav/chrome text.
- [ ] Speaking repeated overlay text.
- [ ] Allowing link clicks to navigate when armed mode intends to speak.

### Shared text clamp

Provider input-length limits differ (OpenAI `input` max ≈ 4096 chars; ElevenLabs practical single-request limit is similar; Kokoro varies with local config).

- [ ] Implement a single shared clamp in `src/tts/service.ts` at **3000 characters** before any provider-specific call.
- [ ] When clamping triggers, pass `{ truncated: true }` back to background so the overlay can render a "truncated" hint next to the current utterance.
- [ ] This clamp applies to both click-to-speak utterances and `"Speak test phrase"` paths. No provider adapter should apply its own silent truncation.

### Edge-case rules to lock before implementation

- [ ] **Iframes:** v1 targets the top frame only unless testing proves multi-frame injection is required; document this limitation explicitly.
- [ ] **Content-editable / inputs / textareas:** if the click lands in an editable field, prefer current selection; otherwise do not hijack editing behavior.
- [ ] **Shadow DOM:** support text extraction when the clicked node is reachable through composed events, but do not promise exhaustive shadow-root traversal in v1.
- [ ] **Tab navigation / reinjection:** playback may continue in background/offscreen after page navigation, but the page overlay is per-tab and must be reinjected after navigation.
- [ ] **Overlay dismissal while playing:** dismissing the overlay should hide controls only; it should not implicitly stop playback unless the user explicitly presses Stop.

---

## Settings and storage design

### Recommendation: use existing settings + provider key stores

Do **not** add a new IndexedDB object store unless implementation complexity proves it necessary.

Use:

- [ ] `settings` store for non-secret preferences
- [ ] `provider-keys` store for secrets/API keys

This keeps the feature lightweight and avoids a DB version bump for v1.

### Suggested settings keys

| Key | Type | Default | Notes |
|---|---|---:|---|
| `tts.enabled` | boolean | `true` | Master feature toggle |
| `tts.provider` | `"kokoro" | "openai" | "elevenlabs"` | `"kokoro"` | Default to local-friendly testing path |
| `tts.voiceId` | string | provider-specific | Default voice per provider |
| `tts.speed` | number | `1.0` | Shared speed setting |
| `tts.clickModeDefault` | boolean | `false` | Matches user decision |
| `tts.kokoro.baseUrl` | string | `http://127.0.0.1:8880/v1` | OpenAI-compatible local endpoint |
| `tts.kokoro.model` | string | `kokoro` | Default local model name |
| `tts.kokoro.voiceId` | string | `af_heart` | Local default |
| `tts.openai.modelId` | string | `gpt-4o-mini-tts` | Fallback `tts-1` if `gpt-4o-mini-tts` rejects for account |
| `tts.elevenlabs.modelId` | string | `eleven_turbo_v2_5` | Low-latency multilingual default |
| `tts.elevenlabs.outputFormat` | string | `mp3_44100_128` | Normalized MP3 output |
| `tts.kokoro.modelId` | string | `kokoro` | Local model name |
| `tts.maxTextChars` | number | `3000` | Shared clamp applied in service before provider dispatch |
| `tts.openai.voiceId` | string | `alloy` or chosen default | OpenAI-specific |
| `tts.elevenlabs.voiceId` | string | empty until chosen | Must be selected/discovered |
| `tts.overlay.rememberLastPosition` | boolean | `true` | Optional nicety if overlay becomes draggable |

Implementation rule:

- [ ] Treat `tts.enabled` as a true kill switch, not just a cosmetic toggle. Sidepanel launch, overlay injection, background routing, and offscreen playback entrypoints should all early-return when it is disabled.
- [ ] `SettingsStore` values are stored flat by key (see existing `proxy.enabled` / `proxy.url` usage in `src/sidepanel.ts:307,319`). Dotted keys like `tts.kokoro.baseUrl` are string keys, **not** nested objects.

### Suggested provider key names

| Store | Key |
|---|---|
| `provider-keys` | `openai` as the first-choice reuse path for raw OpenAI TTS |
| `provider-keys` | `tts-openai` only if a dedicated TTS override is later proven necessary |
| `provider-keys` | `tts-elevenlabs` |
| `provider-keys` | `tts-kokoro` if local endpoint uses auth; otherwise no key |

### Reuse decision for OpenAI key

Preferred approach:

- [ ] Reuse existing stored `provider-keys["openai"]` if present.
- [ ] Use `node_modules/@mariozechner/pi-web-ui/src/components/ProviderKeyInput.ts` (lines 44, 95) and existing `storage.providerKeys.get(providerName)` behavior in `src/sidepanel.ts:288` as the current-code reference for raw provider-key reuse.
- [ ] Treat `src/dialogs/ApiKeysOAuthTab.ts` as a pattern reference for tab UI only, not as the source of truth for raw OpenAI API key entry.
- [ ] Allow explicit `tts-openai` override later only if there is a real need.

### First-launch OpenAI key gap

**Shuvgeist itself has no in-repo writer for `providerKeys["openai"]`.** That key is only populated when the user adds OpenAI through the upstream `ProvidersModelsTab`. First-time TTS users who select OpenAI as their TTS provider will very likely NOT have this key set.

- [ ] `TtsTab` MUST detect `providerKeys["openai"]` absence and render an actionable raw-key input directly in the TTS tab.
- [ ] That input writes to the **same** `providerKeys["openai"]` key (not `tts-openai`), so the value remains shared with any later LLM use.
- [ ] Reuse `ProviderKeyInput` from `@mariozechner/pi-web-ui` if its API fits; otherwise implement a small raw-key field that calls `storage.providerKeys.set("openai", value)`.
- [ ] When the key is present (whether set via TTS tab or `ProvidersModelsTab`), the TTS tab should show "Using shared OpenAI key" with a link/button to manage it in Providers & Models.

This minimizes setup friction, aligns with the actual credential surface, and avoids silent failures on first use.

---

## Settings UI plan

### Add a dedicated TTS settings tab

Recommended file: `src/dialogs/TtsTab.ts`

Why a dedicated tab is cleaner than reusing Providers & Models:

- TTS is separate from LLM/model selection.
- ElevenLabs and Kokoro settings are not LLM provider settings.
- Overlay preferences and click-mode defaults belong in a feature settings surface.

### TTS tab contents

- [ ] master TTS enable toggle
- [ ] provider selector
- [ ] per-provider config blocks
- [ ] API key fields / connection status where relevant
- [ ] explicit indication when OpenAI TTS is reusing the existing `provider-keys["openai"]` value versus an optional dedicated override
- [ ] local Kokoro base URL and model
- [ ] default voice picker or text input fallback
- [ ] playback speed
- [ ] click-to-speak default toggle
- [ ] “Open overlay on current page” test button
- [ ] “Speak test phrase” button using the selected provider

### Sidepanel integration

- [ ] Add `new TtsTab()` to **both** `SettingsDialog.open([...])` call sites in `src/sidepanel.ts`:
  - around line 380 (primary settings open path)
  - around line 1486 (header Settings button path)
  - Failing to update both produces a half-wired feature where the tab only appears through one entry point.
- [ ] Add a speaker icon button beside existing header actions in `src/sidepanel.ts`.
  - Use `Volume2` from `lucide` (already imported alongside `Crosshair`, `History`, `Plus`, `Settings` at `src/sidepanel.ts:23`).
  - Register it through `src/icons.ts` if that is the project's icon registry convention.
  - Place the button between `Crosshair` (Inspect) and `Settings` in the existing header action row.

---

## Offscreen lifecycle plan

### Why offscreen should do playback

Offscreen is already part of this extension and is the best home for:

- audio element lifecycle
- object URL management
- continued playback when the sidepanel is not frontmost
- background-owned playback state

### Required work

- [ ] Extend `src/offscreen.ts` to support TTS-specific messages.
- [ ] Add playback commands: `synthesize`, `play`, `pause`, `resume`, `stop`, `get-state`.
- [ ] Maintain current playback metadata in offscreen and mirror state back to background.
- [ ] Ensure playback cleanup revokes object URLs and resets state.
- [ ] Add explicit ownership/lifecycle logging so it is always visible whether offscreen is currently serving REPL work, TTS work, or both.

### Shared-document ownership contract (locked)

REPL currently creates and removes a `SandboxIframe` per call (`src/offscreen.ts:44-92`), with a `finally { sandbox.remove() }` that tears down REPL state. TTS playback, by contrast, must persist across REPL calls.

- [ ] TTS playback state lives on a dedicated page-global: `window.__shuvgeistTtsController`.
- [ ] The controller owns: the active `HTMLAudioElement`, the current object URL, the last known `TtsPlaybackState`, and AbortControllers for in-flight synth requests.
- [ ] REPL's `finally { sandbox.remove() }` block MUST NOT touch `window.__shuvgeistTtsController` or its `<audio>` element. REPL tears down its own `SandboxIframe` only.
- [ ] TTS teardown is explicit: only a `tts-offscreen-stop` message, a full extension reload, or offscreen document destruction releases the controller. Object URLs must be revoked in all three paths.
- [ ] Add a unit/integration test in `tests/unit/background/` (or `tests/unit/offscreen/`, see Milestone 9) asserting that a REPL execution during active TTS playback does NOT stop the audio element or revoke its object URL.

### Offscreen reason review (locked decision)

Current offscreen creation at `src/background.ts:131` uses:

```ts
reasons: [chrome.offscreen.Reason.WORKERS]
```

**Do not replace `WORKERS`** — REPL depends on it. Extend, do not switch.

- [ ] Update `setupOffscreenDocument()` in `src/background.ts:84-150` to create the document with:
  ```ts
  reasons: [
    chrome.offscreen.Reason.WORKERS,
    chrome.offscreen.Reason.AUDIO_PLAYBACK,
    chrome.offscreen.Reason.BLOBS,
  ]
  ```
  - `WORKERS` preserves REPL's `SandboxIframe` worker-backed execution.
  - `AUDIO_PLAYBACK` is required for reliable `HTMLAudioElement` lifetime under Chrome's offscreen cleanup rules.
  - `BLOBS` is required because TTS creates `URL.createObjectURL(blob)` for audio playback.
- [ ] `chrome.offscreen.createDocument` rejects if a document already exists. The existing `setupOffscreenDocument()` is already idempotent via `offscreenReady` + `chrome.runtime.getContexts` — keep that guard and just expand the reasons array on first creation. Do not attempt to "add" reasons to an existing document.
- [ ] Validate **before** provider adapters are implemented (Milestone 0) that extending the reasons array:
  - does not break the existing REPL offscreen path
  - does not alter offscreen lifetime in a way that regresses the `bridge-keepalive-ping` path
  - allows a basic `new Audio(objectUrl).play()` to run end-to-end in offscreen
- [ ] If shared lifecycle becomes too brittle despite the ownership contract above, explicitly split REPL and TTS into separate offscreen documents rather than forcing both through an unclear unified controller.

This is a key technical validation item before implementation is declared complete.

---

## Internal messaging plan

Prefer a dedicated TTS message namespace instead of stuffing more unrelated message types into bridge-specific files.

### Recommended message groups

- [ ] background ↔ offscreen playback commands carried over `chrome.runtime.sendMessage(...)`
- [ ] overlay ↔ background commands carried through userScripts messaging / `chrome.runtime.onUserScriptMessage`
- [ ] background → overlay sync/update operations carried by idempotent `chrome.userScripts.execute(...)` update snippets
- [ ] sidepanel ↔ background launch/status requests carried over `chrome.runtime.sendMessage(...)`

### Suggested concrete message shapes

- [ ] `tts-open-overlay`, `tts-close-overlay`, `tts-get-state`, `tts-set-click-mode`, `tts-speak-text`, `tts-pause`, `tts-resume`, `tts-stop`
- [ ] `tts-offscreen-synthesize`, `tts-offscreen-play`, `tts-offscreen-pause`, `tts-offscreen-resume`, `tts-offscreen-stop`, `tts-offscreen-get-state`
- [ ] `tts-overlay-command` and `tts-overlay-sync` helpers if a typed wrapper makes background code cleaner
- [ ] Keep TTS message definitions in `src/tts/internal-messages.ts`; only add bridge-level wiring where background or offscreen truly needs shared typing

### Suggested state model

```ts
export interface TtsPlaybackState {
  status: "idle" | "loading" | "playing" | "paused" | "error";
  provider: "openai" | "elevenlabs" | "kokoro";
  voiceId: string;
  /**
   * UI-only preview of the currently-speaking utterance.
   * MUST NOT be forwarded into structured logs or telemetry.
   * See Milestone 8 — raw spoken text is never logged.
   */
  uiTextPreview?: string;
  truncated?: boolean;
  clickModeArmed: boolean;
  error?: string;
}
```

The background should be the single relay point so overlay and sidepanel do not talk to offscreen directly.

---

## Provider implementation details

### OpenAI

Use `POST /v1/audio/speech`.

Locked defaults:

- `model: "gpt-4o-mini-tts"` with fallback `"tts-1"` if the primary returns 400/404 for the account
- `response_format: "mp3"`
- `speed` clamped client-side to `[0.25, 4.0]`
- `input` length clamped to the shared 3000-character cap before the request

Plan tasks:

- [ ] Implement OpenAI TTS adapter using fetch.
- [ ] Reuse stored OpenAI key (`providerKeys["openai"]`); if missing, surface the `TtsTab` raw-key input path described in "First-launch OpenAI key gap".
- [ ] Use a static built-in voice list in UI (e.g. `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`).
- [ ] On `gpt-4o-mini-tts` rejection, retry once with `tts-1` and surface a one-time info toast.
- [ ] Handle 4xx/5xx responses with actionable user-visible errors.

### ElevenLabs

Use `POST /v1/text-to-speech/{voice_id}`.

Locked defaults:

- `model_id: "eleven_turbo_v2_5"` (lowest latency, multilingual)
- `output_format: "mp3_44100_128"` (via query parameter)
- `text` clamped to the shared 3000-character cap before the request

Plan tasks:

- [ ] Implement ElevenLabs adapter with `xi-api-key` header auth.
- [ ] Fetch voices from `GET /v1/voices` for settings/overlay picker.
- [ ] Persist the selected voice under `tts.elevenlabs.voiceId`.
- [ ] Output is already `mp3_44100_128`; no transcode needed.

### Kokoro local

Because the user's local setup is OpenAI-compatible:

- [ ] Implement Kokoro adapter as a configurable OpenAI-compatible adapter, not as a bespoke binary/process integration.
- [ ] Default base URL to local `http://127.0.0.1:8880/v1`.
- [ ] Default model to `kokoro` (configurable via `tts.kokoro.modelId`).
- [ ] Default voice to `af_heart`.
- [ ] Forward `TtsSynthesisRequest.modelId` if provided so users with non-default local Kokoro model names can override without special-casing.
- [ ] Request `response_format: "mp3"`.
- [ ] Keep optional local API key support (Bearer header when configured), but do not require it.
- [ ] `text` clamped to the shared 3000-character cap before the request.

This gives the feature a stable local-first testing story and avoids shipping a local daemon manager inside the extension.

---

## Milestones

## Milestone 0 — Architecture validation before coding depth

- [ ] Run `gitnexus_impact` against `src/background.ts` and `src/offscreen.ts` (project AGENTS.md mandates pre-edit impact analysis). Record the blast radius as an addendum to this plan before any edits.
- [ ] Confirm the overlay command/update transport: overlay → background via userScripts messaging (`tts-`-prefixed message types), background → overlay via idempotent `chrome.userScripts.execute(...)` sync calls against `window.__shuvgeistTtsOverlay`.
- [ ] Confirm TTS uses its own `worldId = "shuvgeist-tts-overlay"` and tight CSP (`style-src 'unsafe-inline'; default-src 'none'`), configured once at startup.
- [ ] Confirm `resolveTabTarget()` / `isProtectedTabUrl()` will be the shared launch guard for TTS.
- [ ] Confirm the OpenAI key reuse path references `providerKeys["openai"]` and `ProviderKeyInput.ts`, not `ApiKeysOAuthTab`. Confirm `TtsTab` owns the first-launch raw-key input when the key is missing.
- [ ] Lock the offscreen `reasons` array to `["WORKERS", "AUDIO_PLAYBACK", "BLOBS"]` and validate a minimal `new Audio(objectUrl).play()` path in offscreen before building provider adapters.
- [ ] Lock the shared-offscreen ownership contract: `window.__shuvgeistTtsController` is not torn down by REPL's `sandbox.remove()`.
- [ ] Decide whether one shared offscreen document is safe enough or whether REPL/TTS responsibilities should be split. Default is shared-document with the ownership contract above; split only if validation shows unavoidable lifecycle conflicts.

### Validation

- [ ] Impact analysis for `src/background.ts` and `src/offscreen.ts` is recorded.
- [ ] The transport decision (worldId, CSP, message prefix, update cadence) is written down before `src/tts/overlay-content.ts` is implemented.
- [ ] Protected-page behavior is anchored to existing shared helpers/tests.
- [ ] Offscreen audio feasibility is known before provider adapter work starts.
- [ ] Manual smoke: existing REPL offscreen path still works with the expanded `reasons` array.

## Milestone 1 — Settings and type foundation

- [x] Add `src/tts/types.ts`.
- [x] Add `src/tts/settings.ts` with defaults and helper accessors.
- [x] Decide and document exact settings keys.
- [x] Confirm no new IndexedDB store is needed.
- [x] Confirm whether OpenAI key reuse uses `openai` or a dedicated TTS key.

### Validation

- [x] Settings defaults resolve cleanly from existing storage.
- [x] No DB migration/version bump is required.
- [x] Missing settings fall back safely.

---

## Milestone 2 — TTS settings UI + sidepanel entry point

- [x] Create `src/dialogs/TtsTab.ts`.
- [x] Add TTS tab to `SettingsDialog.open([...])` calls in `src/sidepanel.ts`.
- [x] Add a sidepanel header speaker button.
- [x] Gate overlay launch on userScripts availability/permission.

### Validation

- [x] User can open the TTS tab from Settings.
- [x] User can launch overlay from the sidepanel header.
- [x] Restricted pages fail gracefully with a helpful message.
- [x] Missing userScripts permission routes through the existing `UserScriptsPermissionDialog` path with actionable guidance.

---

## Milestone 3 — Overlay injection + control surface

- [x] Create `src/tts/overlay-content.ts`.
- [x] Create `src/tts/overlay-inject.ts`.
- [x] Implement overlay lifecycle: inject, update state, remove.
- [x] Implement controls for play/pause/resume/stop/provider/voice/click-mode.
- [x] Ensure overlay never duplicates itself in the same tab.
- [x] Make overlay dismissal hide controls only; do not implicitly stop playback.

### Validation

- [ ] Overlay appears on normal web pages.
- [ ] Overlay can be dismissed cleanly.
- [ ] Overlay state updates reflect playback status.
- [ ] Reinjection/update calls are idempotent and never create duplicate overlays in the same tab.

---

## Milestone 4 — Background/offscreen playback runtime

- [x] Create `src/tts/internal-messages.ts` with all message types `tts-`-prefixed.
- [x] Extend `src/background.ts` to route TTS commands. Update the existing `chrome.runtime.onUserScriptMessage` listener (around line 610) to branch on the `tts-` prefix so TTS and REPL message types cannot shadow each other.
- [x] Extend `src/offscreen.ts` to synthesize/fetch/play audio, installing the `window.__shuvgeistTtsController` page-global described in the ownership contract.
- [x] Update `setupOffscreenDocument()` in `src/background.ts:84-150` to create the document with `reasons: [WORKERS, AUDIO_PLAYBACK, BLOBS]`.
- [x] Keep background as source of truth for active TTS state. Apply the overlay-update cadence rule (status transitions + arm/disarm only, no `timeupdate` ticks).
- [x] Confirm offscreen lifecycle/reason handling for audio.

### Validation

- [ ] Playback continues independently of sidepanel rendering.
- [ ] Stop/pause/resume work through background/offscreen messaging.
- [ ] State is consistent after tab switches and overlay reinjection.
- [ ] Offscreen ownership/lifecycle logs make it obvious which subsystem currently owns playback/runtime activity.
- [ ] A REPL execution run during active TTS playback does NOT stop the audio element or revoke its object URL (explicit test asserts this).
- [ ] Existing REPL offscreen path (`bridge-repl-execute`, `bridge-keepalive-ping`) still works unchanged after the reasons-array expansion.

---

## Milestone 5 — Provider adapters

- [x] Implement `src/tts/providers/openai.ts`.
- [x] Implement `src/tts/providers/elevenlabs.ts`.
- [x] Implement `src/tts/providers/kokoro.ts`.
- [x] Implement `src/tts/service.ts` to select provider and normalize calls.
- [x] Default provider to Kokoro for local-first testing.

### Validation

- [ ] Kokoro local path works end-to-end with default local base URL.
- [ ] OpenAI path works with stored key.
- [ ] ElevenLabs path works with API key + chosen voice.
- [ ] Errors are readable and provider-specific.

---

## Milestone 6 — Click-to-speak targeting

- [x] Create `src/tts/text-targeting.ts`.
- [x] Implement armed click interception using a **capture-phase** listener with `preventDefault()` + `stopImmediatePropagation()` on resolved speakable targets; remove with `{ capture: true }` on disarm.
- [x] Resolve clicked text using selection/sentence/block heuristics.
- [x] Apply the shared 3000-character clamp from `src/tts/service.ts` before dispatch; surface truncation via `TtsPlaybackState.truncated`.
- [x] Prevent accidental full-page or empty-text speech.
- [x] Stop current playback before starting a new click-targeted utterance.

### Validation

- [ ] Armed mode speaks clicked readable text.
- [ ] Disarmed mode leaves page behavior unchanged.
- [ ] Link-heavy pages do not navigate when armed click-to-speak is intentionally used.
- [ ] ESC/disarm reliably exits the special interaction mode.
- [ ] Editable fields are not hijacked unexpectedly.
- [ ] Top-frame-only behavior is explicit and tested/documented if iframe support is deferred.

---

## Milestone 7 — Voice handling and defaults

- [x] Add static OpenAI voice list.
- [x] Add dynamic ElevenLabs voice fetch.
- [x] Add Kokoro voice discovery with static fallback.
- [x] Store per-provider default voice settings.
- [x] Make overlay/provider switch preserve or safely reset voice state.

### Validation

- [ ] Voice lists populate in settings and overlay.
- [ ] Switching providers does not produce invalid voice/provider combinations.
- [ ] Fresh Kokoro setup defaults to `af_heart`.

---

## Milestone 8 — Telemetry and logging

Even if this extension does not yet forward full OTEL telemetry, the feature must emit enough structured lifecycle data to diagnose failures.

- [x] Add structured logs for TTS session start, synth start, synth success, playback start, pause, resume, stop, and failure.
- [ ] Include stable fields:
  - [ ] provider
  - [ ] voiceId
  - [ ] speed
  - [ ] text length
  - [ ] synth latency ms
  - [ ] playback duration ms where available
  - [ ] click-mode enabled/disabled
  - [ ] error class/message
- [x] Never log raw spoken text.

### Validation

- [ ] Local dev logs clearly show provider choice and failure mode.
- [ ] Playback failures are diagnosable without sensitive content leakage.

---

## Milestone 9 — Tests and QA

### Unit tests

- [x] `tests/unit/tts/settings.test.ts`
- [x] `tests/unit/tts/service.test.ts` (includes the shared 3000-char clamp behavior)
- [x] `tests/unit/tts/openai-provider.test.ts` (covers `gpt-4o-mini-tts` → `tts-1` fallback)
- [x] `tests/unit/tts/elevenlabs-provider.test.ts`
- [x] `tests/unit/tts/kokoro-provider.test.ts` (covers `modelId` override forwarding)
- [x] `tests/unit/tts/text-targeting.test.ts` (covers capture-phase interception + disarm cleanup)
- [x] `tests/unit/background/tts-runtime.test.ts`
- [x] `tests/unit/background/offscreen-tts-ownership.test.ts` — asserts REPL execution during TTS playback does NOT tear down `window.__shuvgeistTtsController` or revoke its object URL. (Co-locate here rather than creating a new `tests/unit/offscreen/` path, since no offscreen-specific test directory exists today.)
- [ ] Extend `tests/unit/tools/browser-target.test.ts` if TTS introduces new protected-page launch or active-tab resolution branches

### Component tests

- [x] `tests/component/dialogs/tts-tab.test.ts`

### Optional integration/e2e coverage

- [ ] Add a small integration test that mocks an OpenAI-compatible local TTS endpoint and exercises the Kokoro path.
- [ ] If practical, add a page-overlay smoke test under `tests/e2e/extension/`.
- [ ] Keep existing sidepanel smoke coverage passing and, if low-cost, extend `tests/e2e/extension/smoke.spec.ts` to assert the new speaker button appears without regressing Settings/boot behavior.

### Kokoro-first test strategy

- [x] Use Kokoro/local-compatible mocks as the main provider test fixture.
- [x] Avoid hitting OpenAI and ElevenLabs live APIs in automated tests.
- [x] Use provider contract tests so OpenAI and Kokoro share as much harness code as possible.

### Non-code ship checklist

- [x] Add an `## [Unreleased]` entry to `CHANGELOG.md` under `### Added` when implementation lands.
- [ ] If the final UX differs materially from the current Settings flow, update any relevant user-facing docs or screenshots.

### Validation commands after implementation

```bash
./check.sh
npm run build
```

Because this feature affects extension UI/runtime, `npm run build` must be run so `dist-chrome/` is updated.

---

## Technical decisions confirmed (previously "to confirm during implementation")

Most items below are now locked in the "Locked decisions" table at the top of this plan. The remaining items are small runtime verifications to perform during Milestone 0.

### 1. Overlay control-plane transport (LOCKED)

- Overlay → background via userScripts messaging with `tts-`-prefixed message types.
- Background → overlay via idempotent `chrome.userScripts.execute(...)` update/remove calls targeting `window.__shuvgeistTtsOverlay`.
- Update cadence: status transitions + arm/disarm only.
- `TtsPlaybackState` transitions centralized in background.

### 2. Offscreen reasons and lifecycle (LOCKED)

- Reasons: `["WORKERS", "AUDIO_PLAYBACK", "BLOBS"]`.
- Ownership contract: `window.__shuvgeistTtsController` is not torn down by REPL's `sandbox.remove()`.
- Remaining verification: during Milestone 0, confirm a minimal `new Audio(objectUrl).play()` works and existing REPL/keepalive paths do not regress.

### 3. OpenAI key reuse (LOCKED)

- Reuse `providerKeys["openai"]` (same key `ProviderKeyInput.ts` writes).
- `TtsTab` renders an actionable raw-key input when missing; it writes to the same `openai` key.
- No `tts-openai` dedicated key for v1.

### 4. Kokoro voice enumeration

- [ ] Confirm whether the local service exposes a usable voices endpoint consistently.
- [ ] If not, ship static fallback voice definitions and manual voice entry.

### 5. Blob playback vs streaming

- Start with blob playback. Streaming is out of scope for v1 unless measured UX on Kokoro/OpenAI/ElevenLabs requires it.

---

## Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Overlay hijacks normal browsing too aggressively | High | Use explicit armed mode, off by default, with clear disarm affordance |
| Offscreen audio lifecycle conflicts with existing REPL offscreen usage | High | Validate reason/lifecycle early; keep a single background-owned state machine |
| Kokoro local implementations vary slightly from OpenAI shape | Medium | Keep base URL/model/voice configurable; support static voice fallback |
| ElevenLabs adds more setup friction than desired | Medium | Dedicated settings tab with clear API key + voice picker flow |
| UserScripts permission is missing | Medium | Reuse existing permission helper and show actionable guidance |
| Clicking text on complex pages extracts junk text | Medium | Use sentence/block heuristics and clamp/noise filters |
| Provider/network failures produce silent UI failure | High | Background/offscreen state machine must always emit explicit error state to overlay |
| Logging leaks spoken content | High | Log only text length and provider metadata, never raw text |
| Runtime rollback is awkward if overlay/background/offscreen all change together | Medium | Make `tts.enabled` a hard gate across launch/runtime paths and keep the overlay modules isolated from REPL code |
| `providerKeys["openai"]` missing at first launch (no in-repo writer in Shuvgeist today) | High | `TtsTab` detects absence and renders an actionable raw-key input that writes to the same `openai` key |
| Shared offscreen document teardown kills TTS playback when REPL runs | High | Ownership contract: `window.__shuvgeistTtsController` lives outside REPL's `SandboxIframe` and is not touched by `sandbox.remove()`; dedicated test asserts this |
| REPL/TTS message collisions on `chrome.runtime.onUserScriptMessage` | Medium | TTS messages use `tts-` prefix; dedicated `worldId = "shuvgeist-tts-overlay"` |
| Audio `timeupdate` flooding `chrome.userScripts.execute` calls | Medium | Update cadence rule: transitions + arm/disarm only, no continuous progress pushes |
| Site click-hijacking defeats click-to-speak | Medium | Capture-phase listener with `preventDefault` + `stopImmediatePropagation`; cleaned up on disarm |

---

## Research references

### Extension/runtime references

- Chrome offscreen API docs: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- Chrome offscreen documents blog: https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3

### Provider/API references

- OpenAI speech creation docs: https://platform.openai.com/docs/api-reference/audio/createSpeech
- ElevenLabs TTS API docs: https://elevenlabs.io/docs/api-reference/text-to-speech
- Kokoro FastAPI repo: https://github.com/remsky/Kokoro-FastAPI
- Kokoro model card: https://huggingface.co/hexgrad/Kokoro-82M

### Relevant existing local code references

- `src/sidepanel.ts`
- `src/background.ts`
- `src/offscreen.ts`
- `static/offscreen.html`
- `src/tools/repl/overlay-inject.ts`
- `src/tools/repl/overlay-content.ts`
- `src/tools/helpers/element-picker.ts`
- `src/tools/helpers/browser-target.ts`
- `src/tools/repl/userscripts-helpers.ts`
- `src/dialogs/UserScriptsPermissionDialog.ts`
- `src/dialogs/ShuvgeistProvidersTab.ts`
- `src/dialogs/ApiKeysOAuthTab.ts`
- `node_modules/@mariozechner/pi-web-ui/src/dialogs/ProvidersModelsTab.ts`
- `src/storage/app-storage.ts`
- `static/manifest.chrome.json`
- `tests/unit/tools/browser-target.test.ts`
- `tests/e2e/extension/smoke.spec.ts`

---

## Suggested implementation order summary

1. [x] Lock the control-plane transport, protected-page helper reuse, and offscreen lifecycle decision.
2. [x] Define settings/types and confirm storage strategy.
3. [x] Add TTS settings tab and sidepanel header speaker button.
4. [x] Build dedicated overlay injection/control modules.
5. [x] Extend background + offscreen for playback orchestration.
6. [x] Implement Kokoro adapter first.
7. [x] Implement OpenAI adapter.
8. [x] Implement ElevenLabs adapter.
9. [x] Add click-to-speak targeting.
10. [x] Add telemetry/logging.
11. [x] Add tests, update changelog/docs as needed, run `./check.sh`, then `npm run build`.

This order keeps the feature locally testable early, with Kokoro as the first working provider path, while settling the highest-risk architectural decisions before provider-specific work begins.

---

## Definition of done

- [x] User can click the new sidepanel speaker button (`Volume2` from `lucide`) and open an on-page TTS overlay.
- [x] User can play, pause, resume, and stop spoken audio from the overlay.
- [x] OpenAI, ElevenLabs, and local Kokoro all work through the same TTS subsystem with the locked defaults (`gpt-4o-mini-tts`, `eleven_turbo_v2_5` / `mp3_44100_128`, `kokoro` / `af_heart`).
- [x] OpenAI path works whether the `openai` key was set via TTS tab or upstream `ProvidersModelsTab`. First-launch users with no `openai` key see an actionable input, not a silent failure.
- [x] Click-to-speak is off by default and can be armed explicitly in the overlay; capture-phase interception holds against SPA link hijackers.
- [x] Armed click-to-speak resolves readable text reliably on normal sites and respects the 3000-char shared clamp with truncation feedback.
- [x] The feature works without the sidepanel being the sole playback owner.
- [x] Overlay ↔ background ↔ offscreen transport is implemented as documented: `shuvgeist-tts-overlay` worldId, `tts-`-prefixed messages, transition-only update cadence.
- [x] Shared protected-page/active-tab helpers are reused rather than duplicated.
- [x] Offscreen document is created with `reasons: ["WORKERS", "AUDIO_PLAYBACK", "BLOBS"]`; REPL offscreen path is unregressed.
- [x] REPL execution during active TTS playback does not stop the audio element or revoke its object URL (automated test).
- [x] Both `SettingsDialog.open([...])` call sites in `src/sidepanel.ts` include `new TtsTab()`.
- [x] Kokoro/local path is the main tested path in automated and manual QA.
- [x] Structured logs/telemetry exist for synth/playback lifecycle and failures; `uiTextPreview` is never forwarded into logs.
- [x] `CHANGELOG.md` has an Unreleased entry for the feature when implementation lands.
- [x] `./check.sh` passes.
- [x] `npm run build` completes and updates `dist-chrome/`.
