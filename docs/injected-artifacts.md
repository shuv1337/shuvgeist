# Injected artifacts

Page code that Shuvgeist owns is split by runtime owner. Target-neutral snapshot and ref-action entries live under `packages/driver/src/injected/`; Chrome-only browserjs, page-execution, overlay, and picker entries live under `packages/extension/src/injected/`. The root `scripts/injected-artifacts.mjs` generator bundles each entry with esbuild as a self-contained IIFE and writes ownership-specific descriptors to `packages/driver/src/injected/driver-artifacts.generated.ts` and `packages/extension/src/injected/extension-artifacts.generated.ts`.

The extension build, extension watch build, and CLI build all use the same generator plugin. Electron CDP, direct CDP, and Chrome userScripts embed the same generated snapshot artifact. BrowserJS, the REPL overlay, and the element picker use the same descriptor and typed command/result contracts at their host boundaries. Run `node scripts/injected-artifacts.mjs --check` to verify the tracked module without changing it; `./check.sh` runs this guard automatically.

The browser parity suite has separate driver and extension build surfaces under `tests/e2e/fixtures/`. They are included only when `SHUVGEIST_BUILD_TEST_SURFACES=1`; normal extension, CLI, and release builds omit those entrypoints and globals. `scripts/check-injected-artifact-test-surface.mjs` verifies that Chrome receives both test surfaces, the CLI receives only the driver surface, and production outputs contain neither.

## Compatibility fallback

When `chrome.userScripts` is unavailable, page snapshots retain a `chrome.scripting.executeScript({ func })` fallback. Chrome's API requires a function for that path and performs the serialization itself, so this compatibility path uses the typed snapshot source function. It does not use application-authored `.toString()` transport. Chrome userScripts, Electron, and direct CDP use the compiled snapshot artifact as their primary source-text transport.

## Deliberate source boundaries

String source remains only where the runtime interface requires code rather than a packaged module:

- the user-supplied function passed to `browserjs()`;
- sandbox runtime-provider functions exposed through `SandboxRuntimeProvider#getRuntime()`;
- generated sandbox bridge and skill-library setup code;
- generic function input accepted by page execution, including the Chrome scripting compatibility path.

Static page assertion and ref-action helper migration is owned by the PageDriver work. The TTS overlay uses a separate build path and is outside this artifact set.
