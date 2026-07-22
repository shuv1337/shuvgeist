# Settings and runtime state

Shuvgeist separates durable user configuration from browser-session runtime state. Each durable key has a typed accessor; feature code should not call the underlying generic `SettingsStore` or loose Chrome storage keys directly.

## Persistent application settings

`packages/extension/src/storage/persistent-settings.ts` owns the typed schema for the IndexedDB `settings` object store in the `shuvgeist-storage` database.

| Keys | Owner | Default behavior |
| --- | --- | --- |
| `lastUsedModel` | `loadLastUsedModel()` / `saveLastUsedModel()` | Missing or invalid values return `null`. |
| `agent.plannerValidator.enabled` | `loadPlannerValidatorEnabled()` | Enabled unless explicitly `false`. |
| `proxy.enabled`, `proxy.url` | `loadProxySettings()` / `setProxyEnabled()` | Disabled unless explicitly enabled; an empty URL is treated as absent. |
| `tts.*` | `packages/extension/src/tts/settings.ts` | Normalized through `DEFAULT_TTS_SETTINGS`. |

The proxy keys are retained for compatibility even though current startup explicitly disables the proxy in favor of declarative network rules. Do not remove them without a product decision.

TTS updates use load-merge-normalize-persist semantics. A partial update changes only the supplied fields, including `readAlongEnabled`, and preserves all other stored values.

```typescript
import { loadPlannerValidatorEnabled, saveLastUsedModel } from "./storage/persistent-settings.js";
import { saveTtsSettings } from "./tts/settings.js";

const plannerValidatorEnabled = await loadPlannerValidatorEnabled();
await saveLastUsedModel(model);
await saveTtsSettings({ readAlongEnabled: false });
```

Provider keys, custom providers, sessions, skills, costs, and memories have dedicated IndexedDB stores. They are durable application data, but they are not settings and are not part of this key-value schema.

## Persistent developer settings

`packages/extension/src/storage/developer-settings.ts` owns the existing `chrome.storage.local` keys:

- `debuggerMode`
- `showJsonMode`

Both default to `false`. The accessors preserve the established storage keys so existing developer preferences continue to work.

## Bridge settings

Bridge settings remain a separate, typed `chrome.storage.local["bridge_settings"]` object owned by `packages/extension/src/bridge/settings.ts`. The background service worker requires this store before the sidepanel is open. The owner normalizes defaults and performs the one-time migration from legacy IndexedDB bridge keys.

The stored object contains connection enablement, URL, token, sensitive-access policy, and observability settings. Components should use the bridge settings owner rather than introducing another mirror.

## Transient browser-session state

`packages/extension/src/bridge/runtime-state.ts` types the following `chrome.storage.session` values:

- `agent_runtime_connections`
- `agent_runtime_state`
- `bridge_state`
- `bridge_otel_state`
- `bridge_electron_state`
- `sidepanel_open_windows`
- `session_locks`

The background also owns `shuvgeist.sidepanelWindowAuthority.v2`, a typed, crash-safe authority record for real sidepanel documents. It is intentionally managed by `SidepanelWindowAuthority` rather than the general bridge runtime-state adapter because its prepare/confirm capability ratchet must fail closed on storage absence or persistence failure. Only verifier digests and lease metadata are persisted; raw continuation tokens remain in the sidepanel document's `sessionStorage`.

These values survive Manifest V3 service-worker suspension but are cleared when the browser session ends. They are runtime coordination state, not persistent settings. The background service worker is their sole writer; sidepanel and settings components are read-only consumers.

## Node-side configuration and operational state

`~/.shuvgeist/bridge.json` is persistent CLI/server configuration for connection credentials, manual serve binding, Electron policy, and observability. `~/.shuvgeist/config.json` contains browser and extension discovery preferences. `SHUVGEIST_BRIDGE_CONFIG` and `SHUVGEIST_CONFIG` can override those paths. Their precedence, schema validation, and atomic writes belong to `packages/server/src/node-config.ts`, not the extension settings schema.

The Node owner fails closed for unreadable files, malformed JSON, invalid known fields, and invalid explicit environment or flag values. Mutations merge into the parsed document, preserve unknown top-level and nested fields, write an exclusive temporary file in the same directory, and rename it into place. CLI connection, manual server binding, generated tokens, Node OTEL, Electron policy, doctor output, skill-snapshot placement, and browser/extension discovery all consume the same injected owner.

Client URLs and server binds are separate values. Persisted `url` config controls client connections only. Manual `serve` uses its own host/port precedence, while automatic startup first approves an exact `/ws` URL with no query or fragment, plain WebSocket transport, and one of the three canonical loopback hosts, then passes that endpoint as explicit source-server bind arguments. Remote, TLS, wildcard, non-canonical loopback, and custom-path endpoints are never auto-started.

Generated credentials are persisted only when they belong to the persisted/default client endpoint. If a flag or environment override selects a different local endpoint, its generated token remains process-local so it cannot overwrite an unrelated stored URL. Reusable or concurrent transient endpoints therefore require an explicit `--token` or `SHUVGEIST_BRIDGE_TOKEN`.

Page snapshots, skill snapshots, PID files, browser profiles, and generated output files are caches or operational state rather than settings.

## Adding a durable setting

1. Add the key and value type to `PersistentAppSettingsSchema`.
2. Add a domain accessor that owns validation and defaults.
3. Use only that accessor from feature code.
4. Add focused tests for missing, invalid, and existing values.
5. Document migration behavior if an existing key or value shape changes.

## See also

- [Storage architecture](./storage.md)
- [Bridge architecture](../ARCHITECTURE.md#bridge-runtime-ownership)
- [Dependency policy](./dependencies.md)
