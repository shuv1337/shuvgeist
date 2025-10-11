# Multi-Window Test Plan

## Setup
1. Reload extension
2. Close all Chrome windows
3. Open fresh Chrome window (Window A)

## Test 1: Single Window - New Session
**Steps**:
1. Window A: Press Cmd+Shift+P
2. Verify sidepanel opens
3. Verify welcome message shows
4. Type "hey" and send
5. Wait for response
6. Check DevTools console for errors
7. Click "Sessions" button (history icon)
8. Verify session list opens
9. Verify no errors in console

**Expected**:
- Port created on init
- Session created after first exchange
- Lock acquired for new session
- Session list shows one session with "Current" badge
- No "disconnected port" errors

**Debug if fails**:
- Check console: Is port created?
- Check console: Is session ID assigned?
- Check console: Was lock acquired?
- Check background console: Is port registered in windowPorts?

---

## Test 2: New Session Lock Acquisition
**Steps**:
1. Close all windows and reopen Window A
2. Window A: Press Cmd+Shift+P
3. Verify welcome message shows
4. Type "test message" and send
5. Wait for response
6. Open Window B
7. Window B: Press Cmd+Shift+P
8. Window B: Click "Sessions" button
9. Verify session from Window A shows with "Locked" badge

**Expected**:
- Window A creates new session (no sessionId initially)
- After first message exchange, sessionId assigned
- Lock automatically acquired when sessionId created
- Window B sees session as locked

**Debug if fails**:
- Window A console: Was lock acquired after sessionId creation?
- Window A console: Check for "Failed to acquire lock" warning
- Background console: Check sessionLocks Map
- Window B: Does getLockedSessions return the lock?

---

## Test 3: Two Windows - Latest Session Lock Behavior
**Steps**:
1. Window A: Sidepanel open with session loaded (from Test 2)
2. Open Window B
3. Window B: Press Cmd+Shift+P
4. Verify sidepanel opens
5. Verify **landing page** shows (not the session from Window A)
6. Click "Sessions" button
7. Verify session list shows session with "Locked" badge
8. Try clicking locked session → verify it's not clickable

**Expected**:
- Window B port created
- Window B tries to load latest session
- Lock acquisition FAILS (Window A has it)
- Landing page shown
- Session list works, shows lock badge

**Debug if fails**:
- Window B console: Port created?
- Window B console: Lock request sent?
- Background console: Lock request received?
- Background console: windowPorts has Window B?
- Window B console: Lock response received?

---

## Test 4: Lock Release on Close
**Steps**:
1. Window A: Sidepanel open with session
2. Window B: Sidepanel open with landing page
3. Window A: Click X to close sidepanel
4. Wait 1 second
5. Window B: Press Cmd+Shift+P to reopen
6. Verify session from Window A now loads (not landing page)

**Expected**:
- Window A close → port disconnects
- Background onDisconnect fires → releases lock
- Window B opens → acquires lock → loads session

**Debug if fails**:
- Background console: Did onDisconnect fire for Window A?
- Background console: Was lock released?
- Window B console: Did lock acquisition succeed?
- Background console: Check sessionLocks Map state

---

## Test 5: Keyboard Toggle
**Steps**:
1. Window A: Sidepanel closed
2. Press Cmd+Shift+P → sidepanel opens
3. Press Cmd+Shift+P again → sidepanel closes
4. Press Cmd+Shift+P again → sidepanel opens

**Expected**:
- First press: Opens (no port in windowPorts)
- Second press: Sends "close-yourself" message → window.close() → closes
- Third press: Opens again

**Debug if fails**:
- Background console: Is windowPorts being updated on connect/disconnect?
- Background console: Check Cmd+Shift+P handler logic
- Sidepanel console: Is "close-yourself" message received?

---

## Test 6: Session Switching
**Steps**:
1. Window A: Sidepanel open with Session 1
2. Type "test message for session 2" and send
3. Wait for response
4. Click "New Session" button (+ icon)
5. Verify new session loads (welcome message)
6. Type "hey" in new session
7. Click "Sessions" button
8. Verify two sessions shown
9. Click Session 1 to switch back
10. Verify Session 1 loads

**Expected**:
- New session click → window.location.href changes → port disconnects → new page load → new port created
- Lock for Session 1 released on navigation
- Session 2 created, lock acquired
- Switch back to Session 1 → lock acquired

**Debug if fails**:
- Console: Port disconnect on navigation?
- Console: New port created after navigation?
- Background: Locks being released/acquired correctly?

---

## Test 7: Window Close
**Steps**:
1. Window A: Sidepanel open with session
2. Window B: Sidepanel open with landing page
3. Close entire Window A (Cmd+Q or close window)
4. Window B: Press Cmd+Shift+P to reopen sidepanel
5. Verify session loads

**Expected**:
- Window A closes → windows.onRemoved fires → releases locks
- Window B can acquire lock

**Debug if fails**:
- Background console: Did windows.onRemoved fire?
- Background console: Were locks cleaned up?

---

## Test 8: Navigate to Debug Page
**Steps**:
1. Window A: Sidepanel open with session
2. Press Cmd+U (navigate to debug page)
3. Verify debug page loads
4. Press Cmd+U again (navigate back to sidepanel)
5. Verify sidepanel loads
6. Click "Sessions" button
7. Verify session list works

**Expected**:
- Cmd+U → navigation → port disconnects → lock released
- Debug page has no port (doesn't need locks)
- Navigate back → new port created → lock acquired

---

## Common Errors to Watch For

### "Attempting to use a disconnected port object"
**Cause**: Trying to use port after navigation or close
**Check**:
- Is port being recreated after navigation?
- Is SessionListDialog trying to use port from previous page load?

### "Could not establish connection. Receiving end does not exist"
**Cause**: Background not ready or port name mismatch
**Check**:
- Background console: Is onConnect handler registered?
- Port name format: `sidepanel:${windowId}`

### Session not marked as "Current" or "Locked"
**Cause**: Lock not acquired or getLockedSessions failing
**Check**:
- Background console: sessionLocks Map contents
- Background console: windowPorts Map contents
- Sidepanel console: Lock acquisition response

---

## Debug Console Commands

### In Sidepanel Console:
```javascript
// Check if port exists and is connected
port

// Check current session
currentSessionId

// Check window ID
currentWindowId

// Manually test port message
port.postMessage({ type: "getLockedSessions" })
```

### In Background Console:
```javascript
// Check locks
sessionLocks

// Check ports
windowPorts

// Check what windows exist
chrome.windows.getAll(console.log)
```
