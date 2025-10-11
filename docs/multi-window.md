# Multi-Window Session Management

## Overview

Sitegeist implements window-scoped session locking using Chrome's port API to prevent the same session from being open in multiple windows simultaneously. Each session can only be active in one window at a time.

## Behavior

### Opening Sidepanels

**First Window** (Cmd+Shift+P):
- Opens sidepanel
- Automatically loads last active session
- Session is locked to this window
- Navigation events from tabs in this window are tracked

**Second Window** (Cmd+Shift+P):
- Opens sidepanel
- Last session is locked → shows landing page with welcome message
- Can create new session or select different session from history

**Keyboard Shortcut** (Cmd+Shift+P):
- When sidepanel closed → opens it
- When sidepanel open → closes it
- Works independently per window

### Session List Dialog

Sessions display visual status:
- **Current** badge (blue): Session active in current window
- **Locked** badge (red): Session active in another window (not selectable)
- Locked sessions are dimmed and non-clickable

### Automatic Lock Release

Locks are automatically released when:
- Sidepanel closes (X button click)
- Window closes
- Page navigates (session switch, Cmd+U to debug page)
- Sidepanel crashes
- Extension reloads

No manual cleanup code needed - port disconnect handles everything.

## Architecture

### Port-Based Communication

Uses `chrome.runtime.connect()` for reliable lifecycle tracking. Port disconnects automatically trigger lock cleanup.

**Why Ports vs Messages**:
- `runtime.sendMessage()`: One-shot, unreliable in `beforeunload`
- `runtime.connect()`: Long-lived, `onDisconnect` fires reliably on page unload

### Components

#### Background Service Worker ([background.ts](../src/background.ts))

**State**:
```typescript
const sessionLocks = new Map<string, number>(); // sessionId -> windowId
const windowPorts = new Map<number, Port>(); // windowId -> port
```

**Port Handler**:
```typescript
browserAPI.runtime.onConnect.addListener((port) => {
  // Port name: "sidepanel:${windowId}"
  const windowId = extractWindowId(port.name);
  windowPorts.set(windowId, port);

  port.onMessage.addListener((msg) => {
    if (msg.type === "acquireLock") {
      // Check if owner's port still exists (stale lock detection)
      const ownerWindowId = sessionLocks.get(sessionId);
      const ownerPortAlive = ownerWindowId && windowPorts.has(ownerWindowId);

      if (!ownerWindowId || !ownerPortAlive || ownerWindowId === requestingWindowId) {
        sessionLocks.set(sessionId, requestingWindowId);
        port.postMessage({ type: "lockResult", success: true });
      } else {
        port.postMessage({ type: "lockResult", success: false });
      }
    }
  });

  port.onDisconnect.addListener(() => {
    // Auto-release all locks for this window
    for (const [sid, wid] of sessionLocks.entries()) {
      if (wid === windowId) sessionLocks.delete(sid);
    }
    windowPorts.delete(windowId);
  });
});
```

**Keyboard Shortcut Toggle**:
```typescript
browserAPI.commands.onCommand.addListener(async (command) => {
  const w = await browserAPI.windows.getCurrent();
  const port = windowPorts.get(w.id);

  if (port) {
    // Sidepanel open → close it
    port.postMessage({ type: "close-yourself" });
  } else {
    // Sidepanel closed → open it
    sidePanel.open({ windowId: w.id });
  }
});
```

#### Sidepanel ([sidepanel.ts](../src/sidepanel.ts))

**Port Creation**:
```typescript
async function initApp() {
  const currentWindow = await browserAPI.windows.getCurrent();
  currentWindowId = currentWindow.id;

  // Create port connection
  port = browserAPI.runtime.connect({ name: `sidepanel:${currentWindowId}` });

  // Handle close command from keyboard shortcut
  port.onMessage.addListener((msg) => {
    if (msg.type === "close-yourself") {
      window.close(); // Only way to close sidepanel from within
    }
  });
}
```

**Lock Acquisition (at init)**:
```typescript
// Try to load latest session
const lockResponse = await sendPortMessage({
  type: "acquireLock",
  sessionId: latestSessionId,
  windowId: currentWindowId,
});

if (lockResponse.success) {
  // Load session
} else {
  // Show landing page
}
```

**Lock Acquisition (on new session creation)**:
```typescript
// In agent state subscription handler
if (!currentSessionId && shouldSaveSession(messages)) {
  currentSessionId = crypto.randomUUID();
  updateUrl(currentSessionId);

  // Acquire lock for newly created session
  sendPortMessage({
    type: "acquireLock",
    sessionId: currentSessionId,
    windowId: currentWindowId,
  }, "lockResult");
}
```

New sessions don't have a sessionId until the first successful message exchange (user sends message + valid assistant response). Lock is automatically acquired when the sessionId is assigned.

**No Manual Cleanup**:
```typescript
// Navigation automatically disconnects port and releases locks
const loadSession = (sessionId: string) => {
  window.location.href = `?session=${sessionId}`;
  // Port disconnects → locks released automatically
};
```

**Window ID Filtering**:
```typescript
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.windowId === currentWindowId && /* other conditions */) {
    // Only track navigation in current window
  }
});
```

#### Session List Dialog ([dialogs/SessionListDialog.ts](../src/dialogs/SessionListDialog.ts))

**Lock State Query**:
```typescript
const port = getPort(); // Import from sidepanel
port.postMessage({ type: "getLockedSessions" });

// Wait for response
const lockResponse = await new Promise((resolve) => {
  const listener = (msg) => {
    if (msg.type === "lockedSessions") {
      port.onMessage.removeListener(listener);
      resolve(msg);
    }
  };
  port.onMessage.addListener(listener);
});

this.sessionLocks = lockResponse.locks;
```

**Lock Detection**:
```typescript
private isSessionLocked(sessionId: string): boolean {
  const lockWindowId = this.sessionLocks[sessionId];
  return lockWindowId !== undefined && lockWindowId !== this.currentWindowId;
}
```

## Technical Details

### Port Lifecycle

**Port Creation**: `runtime.connect({ name: "sidepanel:${windowId}" })`
**Port Disconnect**: Fires when page unloads for ANY reason:
- Manual close (X button)
- Window close
- Navigation (`window.location.href`)
- Crash
- Extension reload

**Reliability**: Chrome guarantees `onDisconnect` fires - official API for tracking page lifecycle

### Stale Lock Detection

Background checks if lock owner's port still exists:
```typescript
const ownerWindowId = sessionLocks.get(sessionId);
const ownerPortAlive = ownerWindowId && windowPorts.has(ownerWindowId);

if (!ownerPortAlive) {
  // Stale lock - reassign to requester
  sessionLocks.set(sessionId, requestingWindowId);
}
```

If service worker restarts and loses lock state, no ports exist → all locks treated as available (good default).

### Memory-Only Locks

**Why**: Persisting locks to `chrome.storage` doesn't solve cleanup problem and creates stale locks across extension reloads.

**Trade-off**: Lock loss on service worker restart is acceptable:
- Service worker stays alive while sidepanels are open (ports keep it alive)
- If it restarts, ports reconnect and locks are re-acquired
- User can always reopen session

## Test Scenarios

1. **Basic Isolation**
   - Window A: Open sidepanel (Cmd+Shift+P) → session loads
   - Window B: Open sidepanel → landing page (session locked)
   - Navigate in Window A tabs → only Window A sees events
   - Navigate in Window B tabs → no effect on Window A

2. **New Session Lock**
   - Window A: Create new session, send first message
   - Window A: Wait for response (sessionId assigned, lock acquired)
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
   - Window B: Open sidepanel → session loads (lock released)

6. **Window Close**
   - Window A: Close entire window
   - Window B: Session now available (lock released)

7. **Keyboard Toggle**
   - Sidepanel open: Cmd+Shift+P → closes
   - Sidepanel closed: Cmd+Shift+P → opens
   - Independent per window

8. **Navigation**
   - Cmd+U to debug page → locks released
   - Session switch → locks released
   - All handled by port disconnect

## Edge Cases

### Service Worker Sleep
**Scenario**: Background service worker goes inactive
**Impact**: In-memory locks lost
**Resolution**: Ports keep service worker alive while sidepanels open. If it restarts, ports reconnect and locks are re-acquired.

### Extension Reload
**Scenario**: User reloads extension
**Impact**: All locks cleared, all ports disconnected
**Resolution**: Intentional - prevents stale locks. Users can reopen any session.

### Crashed Sidepanel
**Scenario**: Sidepanel crashes without closing gracefully
**Impact**: Port disconnects
**Resolution**: Lock automatically released via `onDisconnect`

### Direct URL Navigation
**Scenario**: User manually types `?session=123` in URL
**Impact**: Triggers lock acquisition check
**Resolution**: Shows landing page if session is locked, loads if available

## Related Files

- [background.ts](../src/background.ts) - Port handler, lock manager, keyboard shortcut toggle
- [sidepanel.ts](../src/sidepanel.ts) - Port creation, window ID filtering, lock acquisition
- [dialogs/SessionListDialog.ts](../src/dialogs/SessionListDialog.ts) - Lock badges UI
- [utils/i18n-extension.ts](../src/utils/i18n-extension.ts) - "Current" and "Locked" translations
- [problem.md](./problem.md) - Problem analysis and solution evaluation
