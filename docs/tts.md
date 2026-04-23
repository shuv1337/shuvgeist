# TTS Read-Along

Shuvgeist's Text-to-Speech (TTS) feature provides a Kokoro-first read-aloud experience with real word-level highlighting and center-band auto-scroll.

## Overview

The TTS system is built on a three-context architecture:

```
┌─────────────────────────┐        ┌─────────────────────────┐
│ Service Worker          │        │ Offscreen Document      │
│ (background.ts)         │◀──────▶│ (offscreen.ts)          │
│ - Settings & health     │        │ - Audio playback        │
│ - Session management    │        │ - Synthesis & timing    │
│ - Fallback decisions    │        │ - Playhead generation   │
└─────────────────────────┘        └─────────────────────────┘
            ▲                                   │
            │ Port (persistent)                 │ Messages
            ▼                                   ▼
┌─────────────────────────────────────────────────────────────┐
│ USER_SCRIPT overlay / page runtime                          │
│ - Shadow DOM controls                                       │
│ - Token mapping & highlights                                │
│ - Scroll controller                                         │
└─────────────────────────────────────────────────────────────┘
```

## Features

### Providers

- **Kokoro (local, default)**: Local OpenAI-compatible endpoint. Supports read-along with `/dev/captioned_speech` endpoint.
- **OpenAI**: Cloud TTS with multiple voice options. Audio-only (no read-along).
- **ElevenLabs**: Cloud TTS with high-quality voices. Audio-only (no read-along).

### Read-Along

When using Kokoro with a compatible instance:

- **Word-level highlighting**: Current word is highlighted with an orange background
- **Auto-scroll**: Page scrolls to keep the current word in the center band (35%-65% of viewport)
- **Hysteresis**: Prevents jitter by requiring the word to exit the center band before scrolling

Read-along is triggered when:
1. Provider is Kokoro
2. `readAlongEnabled` setting is true (default)
3. Text source is page-target (click-to-speak or selection)
4. Kokoro instance supports `/dev/captioned_speech`

Raw typed text from the overlay textarea is always audio-only.

## Settings

Access TTS settings from the sidepanel Settings → TTS tab:

| Setting | Description |
|---------|-------------|
| **Enable TTS** | Master toggle for TTS functionality |
| **Provider** | Kokoro (local), OpenAI, or ElevenLabs |
| **Voice** | Provider-specific voice selection |
| **Speed** | Playback speed (0.25x - 4x) |
| **Arm click-to-speak by default** | Enable click-to-speak mode when overlay opens |
| **Enable word-level read-along** | Enable read-along highlighting for page-bound text |
| **Kokoro base URL** | Endpoint for Kokoro (default: `http://127.0.0.1:8880/v1`) |
| **Kokoro model** | Model ID for Kokoro synthesis |

### Kokoro Health

Click "Test connection" to check:
- **Online with caption support**: Full read-along available
- **Online - captions unavailable**: Audio works, but read-along disabled
- **Unreachable**: Kokoro not responding
- **Authentication required**: Kokoro requires an API key

## Usage

### Opening the Overlay

1. Click the speaker icon in the sidepanel header, or
2. Go to Settings → TTS → "Open overlay on current page"

### Speaking Text

**Typed text (audio-only):**
1. Type text in the overlay textarea
2. Click "Speak"

**Page text (read-along capable):**
1. Click "Arm click-to-speak"
2. Click on any paragraph on the page
3. Or select text and click "Speak"

### Controls

- **Speak**: Start speaking current text
- **Pause**: Pause playback
- **Resume**: Resume playback
- **Stop**: Stop and reset
- **Arm/Disarm click-to-speech**: Toggle click-to-speak mode

Press `Escape` to disarm click-to-speak mode.

## Architecture Details

### Text Normalization

The `text-normalization.ts` module ensures consistency between:
- Text sent to Kokoro for synthesis
- Text used for token mapping in the page
- Character positions in playhead updates

### Reading Surface

`reading-surface.ts` builds a token map from page DOM:
- Maps each word to its DOM `Text` node and character offset
- Attaches `MutationObserver`s to detect changes
- Marks tokens as "dirty" when their containing block changes
- Supports selection-based and automatic block detection

### Highlight Rendering

`highlight-renderer.ts` provides:
- **Primary**: CSS Custom Highlight API (`::highlight(shuvgeist-tts-readalong)`)
- **Fallback**: Positioned div overlays with `will-change: transform`

### Scroll Control

`scroll-controller.ts` implements:
- Center band detection (35%-65% of viewport)
- Scroll hysteresis (prevents back-and-forth scrolling)
- `requestAnimationFrame` batching
- Scroll anchoring defense (`overflow-anchor: none`)

## Limitations

- **Top frame only**: Read-along works only in the main page, not iframes
- **Page-bound only**: Read-along requires text captured from the page; typed text is audio-only
- **Kokoro only**: Read-along requires Kokoro with `/dev/captioned_speech` support
- **Non-streaming**: Current MVP uses non-streaming synthesis; streaming for long articles is planned
- **SPA mutations**: Blocks that change during playback are marked dirty and skip highlighting

## Troubleshooting

**No highlight appears:**
- Check that Kokoro health shows "Online with caption support"
- Ensure text was captured from the page (not typed)
- Check browser console for errors

**Wrong word highlighted:**
- Text normalization drift between page and synthesis
- SPA may have mutated the content (check for dirty token warnings)

**Scroll jumps excessively:**
- The scroll controller has hysteresis; if issues persist, the scroll container detection may be incorrect

**Kokoro unreachable:**
- Verify Kokoro is running at the configured base URL
- Check firewall/network settings
- If using authentication, ensure key is configured

## API Compatibility

### Kokoro Endpoint Requirements

For full read-along support, your Kokoro instance must support:

- `GET /v1/audio/voices` - List available voices
- `POST /v1/audio/speech` - Standard speech synthesis
- `POST /dev/captioned_speech` - Synthesis with word timestamps

The captioned endpoint should return:
```json
{
  "audio": "<base64 encoded mp3>",
  "timestamps": [
    {"word": "hello", "start": 0.0, "end": 0.5},
    {"word": "world", "start": 0.6, "end": 1.0}
  ]
}
```

If the captioned endpoint is unavailable, Kokoro will still work for audio-only playback.
