# Chrome tab-capture recording

The default recording path remains CDP `Page.startScreencast` with CLI-side
ffmpeg encoding. Chrome users can explicitly select native tab media capture:

```bash
shuvgeist record start \
  --mode tab-capture \
  --out /tmp/tab.webm \
  --max-duration 30s
```

Add `--audio` to include the tab's output audio. Audio is never captured by
default and is rejected unless `--mode tab-capture` is present. Electron
recording is unchanged and does not support this mode.

Tab-capture mode asks Chrome for a media stream belonging to the exact selected
tab, records it in the extension's offscreen document with `MediaRecorder`, and
streams WebM chunks directly to the CLI output. It does not require ffmpeg. The
start result reports `mode`, `audio`, `indicator`, and `artifactState`.
If Chrome requires a fresh user invocation, Shuvgeist shows a bounded in-tab
approval control and waits up to 60 seconds for the user to click Start
recording. The explicitly selected CLI mode is the capture request; Chrome can
still require this additional browser-owned user activation.

## Visible ownership and stop

While capture is active, Chrome shows its capture indicator, the extension
action badge reads `REC`, and ordinary web pages receive a fixed Shuvgeist
recording control with a Stop button. The control is restored after same-tab
navigation. Chrome-owned pages cannot host an injected control, so Chrome's
capture indicator and the extension badge remain the visible signal there.

Stop with any of:

```bash
shuvgeist record stop --tab-id 123
```

- press Ctrl-C in the foreground `record start` command
- click Stop in the tab recording control
- close the captured tab
- wait for `--max-duration`

## Lifecycle and artifacts

The offscreen document owns the `MediaRecorder`, so side-panel closure,
same-tab navigation, and service-worker idling do not stop the media stream.
Chrome keeps extension service workers alive while their WebSocket is active
on supported releases. A tab close ends capture with
`stopped_target_closed`.

Extension reload, browser shutdown, permission revocation, or bridge
disconnection are not recoverable transitions. Already received WebM chunks
remain at the requested output path as a partial artifact; callers should
treat an absent final summary or `artifactState: "partial"` as incomplete.
Normal user, duration, and tab-close stops flush the final MediaRecorder chunk
and report `artifactState: "complete"`.

Permission or platform failures are fail-closed and explain how to retry:
focus a user-owned web tab, confirm the extension's `tabCapture` permission,
and invoke the command again. Capture never silently falls back to CDP.
