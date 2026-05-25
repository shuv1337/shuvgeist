# TTS Playback Coordination Deepening Plan

## Context

The TTS read-along flow spans multiple execution contexts:

- `src/background.ts` owns TTS settings snapshots, overlay state, reading sessions, provider fallback, offscreen dispatch, and runtime message handling.
- `src/offscreen.ts` owns audio playback, synthesis calls, playhead tracking, and REPL offscreen execution.
- `src/tts/overlay-runtime.ts` owns the page overlay UI and user actions.
- `src/tts/service.ts` owns provider config, text prep, voice listing, and synthesis.
- `src/tts/types.ts` owns shared state and message types.
- `src/tts/page-runtime.ts`, `src/tts/highlight-renderer.ts`, and related modules own read-along page behavior.

The current helper modules are useful, but the TTS lifecycle itself has weak locality. A bug in fallback, overlay sync, or playhead routing requires reasoning across background, offscreen, page user scripts, and settings.

## Goal

Deepen a TTS playback coordination module that owns read-along session lifecycle behind a small interface.

The background service worker should compose the module and adapt Chrome messaging. Offscreen audio and page overlay should remain adapters.

## Proposed Module Shape

Likely new files:

- `src/tts/playback-coordinator.ts`
- `src/tts/playback-adapters.ts`

Coordinator interface responsibilities:

- refresh settings and voices
- start speech or read-along session
- choose provider and fallback provider
- dispatch offscreen synthesis/playback
- apply offscreen events
- track active reading sessions
- sync overlay state
- end sessions and forward playhead updates

Adapters:

- settings/storage adapter
- provider secrets adapter
- offscreen audio adapter
- overlay port adapter
- tab/page adapter
- Kokoro health adapter

## Milestone 1: Characterize Current TTS Lifecycle

- [ ] Expand unit tests around `handleTtsRuntimeMessage` and current reducer behavior.
- [ ] Cover speak command for:
  - [ ] plain text
  - [ ] page target read-along
  - [ ] Kokoro healthy path
  - [ ] Kokoro unavailable fallback path
  - [ ] explicit OpenAI fallback retry
  - [ ] explicit ElevenLabs fallback retry
- [ ] Cover playhead forwarding and session end behavior.
- [ ] Cover overlay close and tab navigation behavior.

## Milestone 2: Extract Coordinator State Transitions

- [ ] Move active reading session bookkeeping into a coordinator-owned state object.
- [ ] Keep `reduceTtsPlaybackState()` as the low-level playback-state implementation.
- [ ] Add tests for session bookkeeping without Chrome runtime.
- [ ] Keep message types and external behavior unchanged.

## Milestone 3: Extract Provider Selection and Fallback Policy

- [ ] Move provider choice and fallback override logic behind a small function or internal module.
- [ ] Preserve current Kokoro-first behavior.
- [ ] Preserve current fallback action behavior from the overlay.
- [ ] Add table-driven tests for provider/fallback decisions.

## Milestone 4: Extract Offscreen Audio Adapter

- [ ] Wrap `ensureOffscreenDocument()`, `dispatchTtsOffscreenMessage()`, and `applyOffscreenEvent()` behind an adapter.
- [ ] Keep offscreen message payloads stable.
- [ ] Keep `src/offscreen.ts` playback implementation unchanged in the first pass.
- [ ] Test coordinator behavior with a fake offscreen adapter.

## Milestone 5: Extract Overlay Adapter

- [ ] Wrap `sendToOverlay()`, overlay port registration, overlay sync, and overlay close operations.
- [ ] Keep `src/tts/overlay-runtime.ts` UI behavior unchanged.
- [ ] Test coordinator behavior with a fake overlay adapter.

## Milestone 6: Compose Coordinator in Background

- [ ] Replace TTS global state and functions in `src/background.ts` with coordinator calls.
- [ ] Keep Chrome event listeners in `src/background.ts`.
- [ ] Keep bridge connection and session-lock logic separate from TTS coordination.
- [ ] Update `docs/tts.md` and `ARCHITECTURE.md` if the lifecycle explanation changes.

## Validation

```bash
./check.sh
npm run build
```

Focused tests:

```bash
npm run test:unit -- tests/unit/tts tests/unit/background/tts-runtime.test.ts tests/unit/background/offscreen-tts-ownership.test.ts tests/unit/background/offscreen-tts-playhead.test.ts
npm run test:component -- tests/component/dialogs/tts-tab.test.ts
```

Manual validation after implementation:

- [ ] Open TTS settings and refresh voices.
- [ ] Speak selected text.
- [ ] Start page read-along with Kokoro.
- [ ] Force fallback to OpenAI or ElevenLabs.
- [ ] Navigate the tab during playback and verify cleanup/resync.

## Risk

Risk is medium-high because the flow crosses MV3 background, offscreen document, page user script, and provider network calls. Keep adapters fakeable and preserve message payloads until the coordinator is proven.
