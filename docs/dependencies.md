# Dependency policy

Shuvgeist deliberately uses different dependency forms for different ownership and release constraints. Do not normalize them mechanically during workspace or package-boundary work.

## `@mariozechner/mini-lit`

The extension workspace's `file:../../../mini-lit` dependency is intentional for local development. From `packages/extension/`, that path resolves to the sibling checkout next to the Shuvgeist repository. Changes are picked up after rebuilding Mini Lit and then rebuilding Shuvgeist. CI reconstructs the sibling directory from the pinned `MINI_LIT_VERSION` before the root workspace install, so the same layout is exercised without committing generated or vendored sources. Do not silently replace this link with a registry range.

## `@shuv1337/pi-*`

`@shuv1337/pi-agent-core`, `@shuv1337/pi-ai`, and `@shuv1337/pi-web-ui` are exact, lockstep release pins. Update the three direct versions together and regenerate the lockfile. Local upstream development still happens in the sibling `../pi-mono` checkout and must be rebuilt before rebuilding Shuvgeist when testing unpublished changes.

## `xlsx`

`xlsx` in `packages/extension` intentionally uses the exact SheetJS `0.20.3` tarball URL. The root `package-lock.json` records both the resolved URL and its integrity hash. Preserve both the exact URL and lockfile integrity; do not convert it to an unpinned URL or infer that the non-registry source is floating.

## Workspace boundaries

The private root declares `packages/*`, `proxy`, and `site` as npm workspaces. The core graph is deliberately one-way: driver depends on protocol; extension and server depend on protocol plus driver; the public CLI depends on protocol, driver, and server. Internal core dependencies use exact release versions rather than `workspace:` ranges. `scripts/check-workspace-boundaries.mjs` enforces that graph and rejects relative cross-package source imports.

`proxy/` and `site/` retain their existing manifests, independent versions, and nested lockfiles even though they participate in root workspace commands. TTS remains an extension feature, not a separate package.
