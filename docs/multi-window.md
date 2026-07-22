# Multi-Window Session Management

## Overview

Shuvgeist implements window-scoped session locking using Chrome's port API to prevent the same session from being open in multiple windows simultaneously. Each session can only be active in one window at a time.

## Behavior

### Opening Sidepanels

**First Window** (Cmd+Shift+S on Mac, Ctrl+Shift+S on Windows/Linux):
- Opens sidepanel
- Automatically loads last active session
- Session is locked to this window
- Background navigation events from this window are steered only into its streaming session

**Second Window** (Cmd+Shift+S on Mac, Ctrl+Shift+S on Windows/Linux):
- Opens sidepanel
- Last session is locked → shows landing page with welcome message
- Can create new session or select different session from history

**Keyboard Shortcut** (Cmd+Shift+S on Mac, Ctrl+Shift+S on Windows/Linux):
- When sidepanel closed → opens it
- When sidepanel open → closes it
- Works independently per window

### Session List Dialog

Sessions display visual status:
- **Current** badge (blue): Session active in current window
- **Locked** badge (red): Session active in another window (not selectable)
- Locked sessions are dimmed and non-clickable

### Runtime Ownership

Closing, navigating, or crashing the sidepanel tears down only its presentation connection. It does not end the offscreen agent session or release its window lock. Ownership changes when:

- the same window explicitly switches to another session, replacing its prior lock
- the browser window closes, releasing its locks and runtime resources
- the extension or browser session is reset, clearing transient coordination state

## Architecture

### Port-Based Communication

Uses `chrome.runtime.connect()` for authenticated presentation lifecycle tracking. A port disconnect marks the sidepanel presentation closed, but the window-owned offscreen session and lock survive until an explicit session switch or browser-window removal.

**Why Ports vs Messages**:
- `runtime.sendMessage()`: One-shot, unreliable in `beforeunload`
- `runtime.connect()`: Long-lived, `onDisconnect` fires reliably on page unload

### Components

#### Background Service Worker ([background.ts](../packages/extension/src/background.ts))

Manages session locks and port connections. See implementation for details.

**Key responsibilities**:
- **State**: Uses `chrome.storage.session` for transient browser-session state (survives service worker sleep):
  - `session_locks`: sessionId → windowId mapping
  - `sidepanel_open_windows`: array of windowIds with open sidepanels
  - `shuvgeist.sidepanelWindowAuthority.v2`: strict per-window `opened`, `pending`, or `active` document authority with verifier, transaction, and lease metadata; raw continuation tokens are never stored here
  - `openSidepanels`: In-memory Set (windowId) initialized from storage on startup, updated synchronously on port events
- **Initialization**: Populates `openSidepanels` cache from storage when service worker starts
- **Port handler**: Listens for connections with name format `sidepanel:${windowId}:${documentNonce}:${continuationToken}:${transactionId}:${leaseId}`
  - Records `chrome.sidePanel.onOpened` window authority against exactly one newly live sidepanel document
  - Completes a persisted prepare/confirm capability ratchet before admitting either presentation or runtime ports
  - Validates the coarse sender URL with an exact extension path and canonical known query parameters, but never trusts its possibly stale nonce; Chrome can omit document identity and freeze this URL at the pre-`replaceState` commit
  - Joins the canonical port nonce to exactly one raw live sidepanel context, hashes the token transiently, and requires the active document, window, and lease generation to match
  - Rejects ambiguous contexts and claimed window IDs instead of falling back to the focused window
  - Updates cache and marks sidepanel as open in storage on connect
  - `acquireLock` message: Grants an unowned session or renews ownership for the same window
  - `getLockedSessions` message: Reads locks from storage for session list UI
  - `onDisconnect`: Marks the sidepanel presentation closed only when that exact lease is still current, while preserving runtime ownership
- **Window cleanup**: Releases that window's locks, accepted runtime descriptor, offscreen session, and bridge resources
- **Keyboard shortcut**: Checks synchronous `openSidepanels` cache to maintain user gesture context, toggles open/close using `chrome.sidePanel.close()` (Chrome 141+)

#### Port Module ([utils/port.ts](../packages/extension/src/utils/port.ts))

Centralized port communication with automatic reconnection and type-safe messaging. See implementation for details.

**Key features**:
- **Initialization**: Receives the confirmed window, per-document nonce, and continuation token before sending messages
- **Auto-reconnection**: 2-attempt retry with automatic reconnect on failure or ~5min inactivity timeout
- **Type-safe messaging**: `sendMessage<TRequest>` infers response type from request type
- **Message routing**: Dispatches responses to registered handlers
- **Connection management**: Creates port with name `sidepanel:${windowId}:${documentNonce}:${continuationToken}:${transactionId}:${leaseId}`, listens for disconnect, and ignores stale-generation disconnects

#### Sidepanel ([sidepanel.ts](../packages/extension/src/sidepanel.ts))

Uses the port module for session locking and presents a window-scoped remote agent session. See implementation for details.

**Key behaviors**:
- **Port init**: Opens ports only after the background has durably confirmed the current document capability
- **Window identity**: Resolves `currentWindowId` through an authenticated pre-port background exchange; raw current and pending tokens live only in top-level `sessionStorage`, and focus is never used as identity
- **Lock on init**: Tries to acquire the accepted or requested session before attaching its remote presentation
- **Lock on session creation**: Allocates a session ID and acquires its lock before connecting the runtime client
- **Window filtering**: The background tracks tab navigation/activation and steers only this window's streaming session
- **Presentation-only cleanup**: Page unload disconnects UI subscriptions and ports without releasing the offscreen session

#### Session List Dialog ([dialogs/SessionListDialog.ts](../packages/extension/src/dialogs/SessionListDialog.ts))

Displays session list with Current/Locked badges. See implementation for details.

**Key features**:
- **Lock query**: Uses `port.sendMessage({ type: "getLockedSessions" })` to fetch all locks
- **Badge logic**: `isSessionLocked()` and `isCurrentSession()` determine badge display
- **UI rendering**: Locked sessions are dimmed and non-clickable, current session highlighted

## Technical Details

### Port Lifecycle

**Port Creation**: `runtime.connect({ name: "sidepanel:${windowId}:${documentNonce}:${continuationToken}:${transactionId}:${leaseId}" })`
**Port Disconnect**: Fires when page unloads for ANY reason:
- Manual close (X button)
- Window close
- Navigation (`window.location.href`)
- Crash
- Extension reload

**Reliability**: Chrome guarantees `onDisconnect` fires - official API for tracking page lifecycle

Disconnect delivery can lag behind a replacement document's admission. Every tracking and runtime connection is therefore fenced by the active authority lease. A stale disconnect, queued message, asynchronous storage update, or runtime response is ignored after the lease rotates.

### Runtime Ownership and Lock Release

A closed sidepanel is not a stale session: CLI session commands and REPL execution continue through the offscreen runtime. The lock remains bound to its browser window across sidepanel close/reopen and service-worker suspension. Switching that window to a different session replaces its lock; closing the browser window releases its lock and runtime ownership.

**Storage-based state** survives service worker sleep, preventing lock and accepted-descriptor loss during normal operation. The `openSidepanels` cache is rebuilt from storage on service worker startup and tracks presentation state only.

### Session Storage-Based Locks

**Why**: Service workers go to sleep after ~30 seconds in Manifest V3. In-memory state is lost, breaking:
- Session locks (allowing same session in multiple windows)
- Keyboard shortcut toggle (always thinks sidepanel is closed)

**Solution**: Dual-layer state management:
- **Suspension-safe layer**: `chrome.storage.session` survives service worker sleep/wake cycles and is automatically cleared on browser restart (prevents permanent stale locks)
- **Synchronous layer**: `openSidepanels` in-memory Set initialized from storage on startup, updated synchronously on port events
- **User gesture compatibility**: Keyboard shortcut checks synchronous cache to maintain user gesture context (required by `chrome.sidePanel.open()`)
- **Chrome 141+ API**: Uses `chrome.sidePanel.close()` for programmatic sidepanel closing

Port module still handles automatic reconnection after ~5min Chrome inactivity timeout (2-attempt retry logic).

## Test Scenarios

1. **Basic Isolation**
   - Window A: Open sidepanel (Cmd+Shift+S) → session loads
   - Window B: Open sidepanel → landing page (session locked)
   - Navigate in Window A tabs → only Window A sees events
   - Navigate in Window B tabs → no effect on Window A

2. **New Session Lock**
   - Window A: Create a new session (session ID assigned and lock acquired before runtime connection)
   - Window A: Send a first message and wait for its response
   - Window B: Open sidepanel → landing page (Window A's session locked)
   - Window B: Session list → Window A's session shows "Locked" badge

3. **Lock Badges**
   - Window A: Open session list → session has "Current" badge
   - Window B: Open session list → same session has "Locked" badge, not clickable

4. **Session Switching**
   - Window A: Switch to different session
   - Window B: Session list → original session now selectable (lock released)

5. **Sidepanel Close**
   - Window A: Close sidepanel with X button
   - CLI session and REPL commands for Window A continue through the offscreen runtime
   - Window B: Open sidepanel → Window A's session remains locked
   - Window A: Reopen sidepanel → it reattaches to the same session

6. **Window Close**
   - Window A: Close entire window
   - Window B: Session now available (lock released)

7. **Keyboard Toggle**
   - Sidepanel open: Cmd+Shift+S → closes
   - Sidepanel closed: Cmd+Shift+S → opens
   - Independent per window

8. **Navigation**
   - Navigating the sidepanel/debug UI disconnects only presentation ports
   - Reopening the sidepanel reattaches to the window-owned session
   - An explicit session switch replaces the window's prior lock

## Edge Cases

### Service Worker Sleep
**Scenario**: Background service worker goes inactive after ~30 seconds
**Impact**: In-memory state lost (NOT prevented by ports in Manifest V3)
**Resolution**: All coordination state is stored in `chrome.storage.session`, which survives the service worker lifecycle but remains transient to the browser session. Keyboard shortcut and session locks work correctly after sleep.

### Extension Reload
**Scenario**: User reloads extension
**Impact**: All locks cleared, all ports disconnected
**Resolution**: Intentional - prevents stale locks. Users can reopen any session.

### Crashed Sidepanel
**Scenario**: Sidepanel crashes without closing gracefully
**Impact**: Port disconnects
**Resolution**: Presentation is marked closed; the accepted descriptor, lock, and offscreen session remain window-owned

### Direct URL Navigation
**Scenario**: User manually types `?session=123` in URL
**Impact**: Triggers lock acquisition check
**Resolution**: Shows landing page if session is locked, loads if available

## Related Files

**Core Implementation**:
- [background.ts](../packages/extension/src/background.ts) - Port handler, lock manager, keyboard shortcut toggle, window close cleanup
- [utils/port.ts](../packages/extension/src/utils/port.ts) - Centralized port communication with automatic reconnection, type-safe message handling
- [sidepanel.ts](../packages/extension/src/sidepanel.ts) - Port initialization, remote-session presentation, and lock acquisition on init/session creation

**UI Components**:
- [dialogs/SessionListDialog.ts](../packages/extension/src/dialogs/SessionListDialog.ts) - Lock badges UI (Current/Locked), lock state querying
- [utils/i18n-extension.ts](../packages/extension/src/utils/i18n-extension.ts) - "Current" and "Locked" translations

**Configuration**:
- [static/manifest.chrome.json](../static/manifest.chrome.json) - Chrome keyboard shortcut: "toggle-sidepanel" with Cmd+Shift+S (Mac) / Ctrl+Shift+S (Windows/Linux)
