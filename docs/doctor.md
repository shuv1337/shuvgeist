# Shuvgeist doctor

`shuvgeist doctor` is a read-only diagnostic. It reads local configuration and artifacts, probes the configured bridge status and authenticated WebSocket registration, and checks whether `ffmpeg` is available. It does not auto-start the bridge, install the agent skill, or write configuration.

Use `shuvgeist doctor --json` for automation. The JSON contract has `schemaVersion: 1` and these stable top-level fields:

- `ok`: `true` when no check has `status: "fail"`; warnings do not make the report fail.
- `generatedAt`: ISO-8601 report time.
- `cli`: package `version`, exact `build`, and supported protocol range.
- `bridge`: configured WebSocket `url`, `reachable`, `authenticated`, and the status response when reachable. Tokens are never included.
- `extensionArtifact`: discovered path, discovery source, and manifest version when found.
- `checks`: ordered objects with stable `id`, `status`, `code`, and actionable `message` fields.

Check status is one of `pass`, `warn`, or `fail`. Consumers should branch on `code`, not message text.

Build and version codes:

- `CLI_BUILD_IDENTIFIED`
- `BRIDGE_VERSION_MATCH`, `BRIDGE_VERSION_MISMATCH`
- `BRIDGE_BUILD_MATCH`, `BRIDGE_BUILD_MISMATCH`, `BRIDGE_BUILD_UNKNOWN`
- `EXTENSION_VERSION_MATCH`, `EXTENSION_VERSION_MISMATCH`, `EXTENSION_ARTIFACT_VERSION_DIFFERS`
- `EXTENSION_BUILD_MATCH`, `EXTENSION_BUILD_MISMATCH`, `EXTENSION_BUILD_UNKNOWN`

Protocol, connectivity, and dependency codes:

- `BRIDGE_REACHABLE`, `BRIDGE_UNREACHABLE`
- `BRIDGE_PROTOCOL_COMPATIBLE`, `BRIDGE_PROTOCOL_MISMATCH`
- `BRIDGE_REGISTRATION_OK`, `BRIDGE_REGISTRATION_FAILED`
- `EXTENSION_ARTIFACT_FOUND`, `EXTENSION_ARTIFACT_MISSING`
- `EXTENSION_CONNECTED`, `EXTENSION_DISCONNECTED`
- `EXTENSION_PROTOCOL_COMPATIBLE`, `EXTENSION_PROTOCOL_MISMATCH`
- `FFMPEG_AVAILABLE`, `FFMPEG_MISSING`

`BRIDGE_BUILD_MISMATCH` means the running bridge came from different relevant source or lockfile content than the CLI. Rebuild the CLI bridge and restart the automatically managed bridge. `EXTENSION_BUILD_MISMATCH` means the connected browser still has a different build loaded; rebuild the extension and reload it in the browser.

Development identities are content hashes over the runtime source, build scripts, static extension inputs, workspace manifests, and root dependency lock. Paths outside that bounded input set do not change the identity. Release jobs inject the same content-derived identity with a `release` kind, so identical release inputs produce identical identities.
